import type { FastifyInstance } from 'fastify';

import {
  createGoalHandler,
  InvalidCommandPayloadError,
  parseCreateGoalPayload,
} from '../goals/commands.ts';
import {
  correctActivityHandler,
  createQuestTemplateHandler,
  materializeOccurrenceHandler,
  parseCreateQuestTemplate,
  parseMaterializeOccurrence,
  questTransitionHandler,
  stopRecurrenceHandler,
  QuestNotFoundError,
  VersionConflictError,
} from '../quests/commands.ts';
import { InvalidTransitionError } from '../quests/state.ts';
import {
  executeCommand,
  PayloadMismatchError,
  type CommandHandler,
  type CommandRequest,
} from '../../shared/commands/bus.ts';
import { commandEnvelopeSchema, type CommandEnvelope } from '../../shared/commands/envelope.ts';
import {
  assertPayloadMatchesSchema,
  PayloadValidationError,
} from '../../shared/commands/payload-schemas.ts';
import type { Database } from '../../shared/db/pool.ts';

/**
 * Приём команд от клиента.
 *
 * Пользователь берётся из access-токена, а не из тела запроса: в конверте нет
 * поля пользователя, и схема закрыта для посторонних полей, поэтому подставить
 * чужой идентификатор нечем. Это не удобство, а граница доверия — клиент
 * недоверенный вход (docs/09, раздел 1).
 *
 * Цель и ожидаемая версия берутся из полей конверта. Раньше обработчики читали
 * их из нагрузки, а канонические поля молча игнорировались: клиент, собравший
 * запрос точно по контракту, терял оптимистичную блокировку и не знал об этом
 * (R1 в docs/15-backend-review.md).
 */

interface CommandDefinition {
  /**
   * Поле нагрузки, содержащее цель команды. Есть только у изменяющих команд;
   * его наличие и означает «эта команда меняет существующий объект».
   */
  readonly targetField?: string;
  readonly build: (request: CommandRequest) => CommandHandler;
}

/**
 * Реестр — Map, а не обычный объект: поиск по объекту находит унаследованные
 * имена вроде `constructor`, и вместо отказа получается внутренняя ошибка
 * (R6 в docs/15-backend-review.md).
 */
const COMMANDS = new Map<string, CommandDefinition>([
  ['create_goal', { build: (request) => createGoalHandler(parseCreateGoalPayload(request.payload)) }],
  [
    'create_quest_template',
    { build: (request) => createQuestTemplateHandler(parseCreateQuestTemplate(request.payload)) },
  ],
  [
    'materialize_occurrence',
    { build: (request) => materializeOccurrenceHandler(parseMaterializeOccurrence(request.payload)) },
  ],
  [
    'start_quest',
    { targetField: 'occurrence_id', build: (request) => questTransitionHandler('start_quest', request) },
  ],
  [
    'complete_quest',
    {
      targetField: 'occurrence_id',
      build: (request) => questTransitionHandler('complete_quest', request),
    },
  ],
  [
    'record_partial',
    {
      targetField: 'occurrence_id',
      build: (request) => questTransitionHandler('record_partial', request),
    },
  ],
  [
    'cancel_quest',
    {
      targetField: 'occurrence_id',
      build: (request) => questTransitionHandler('cancel_quest', request),
    },
  ],
  [
    'correct_activity',
    { targetField: 'occurrence_id', build: (request) => correctActivityHandler(request) },
  ],
  [
    'stop_recurrence',
    { targetField: 'template_id', build: (request) => stopRecurrenceHandler(request) },
  ],
]);

/**
 * Единственный источник видов команд. Сверка контрактов сравнивает его со
 * схемами нагрузки в обе стороны: команда без схемы прошла бы без проверки,
 * а схема без команды означала бы описанный, но не реализованный вид.
 */
export function commandKinds(): readonly string[] {
  return [...COMMANDS.keys()].sort();
}

class TargetMismatchError extends Error {}
class VersionPolicyError extends Error {}

/**
 * Согласование цели конверта и цели нагрузки. Два разных идентификатора в одном
 * запросе означают, что клиент и сервер понимают команду по-разному; выбрать
 * один молча нельзя — половина запросов тогда изменит не тот объект.
 */
function resolveTarget(envelope: CommandEnvelope, definition: CommandDefinition): string | null {
  const fromEnvelope = envelope.aggregate_id;
  const fromPayload =
    definition.targetField === undefined ? undefined : envelope.payload[definition.targetField];

  if (fromPayload !== undefined && typeof fromPayload !== 'string') {
    throw new InvalidCommandPayloadError(`${definition.targetField} должен быть строкой`);
  }
  if (fromEnvelope !== null && fromPayload !== undefined && fromEnvelope !== fromPayload) {
    throw new TargetMismatchError('Цель конверта не совпадает с целью нагрузки');
  }

  return fromEnvelope ?? fromPayload ?? null;
}

/**
 * Версия берётся только из конверта. Дубликат в нагрузке допускается лишь при
 * совпадении: расхождение означает, что клиент проверяет одно, а сервер другое.
 */
function resolveExpectedVersion(envelope: CommandEnvelope): number | null {
  const fromPayload = envelope.payload['expected_version'];
  if (fromPayload !== undefined) {
    if (typeof fromPayload !== 'number' || !Number.isInteger(fromPayload)) {
      throw new InvalidCommandPayloadError('expected_version должен быть целым числом');
    }
    if (envelope.expected_version !== null && envelope.expected_version !== fromPayload) {
      throw new TargetMismatchError('Ожидаемая версия конверта не совпадает с версией нагрузки');
    }
    return fromPayload;
  }
  return envelope.expected_version;
}

/**
 * Политика цели и версии, разная для создающих и изменяющих команд.
 *
 * Изменяющая команда обязана назвать версию, от которой клиент отталкивался.
 * Без неё «отметить выполненным» означает «выполнено, что бы там сейчас ни
 * было»: команда, отправленная по экрану двухчасовой давности, применится к
 * состоянию, которого человек не видел. Оптимистичная блокировка, которую
 * можно не присылать, защищает только аккуратных клиентов.
 *
 * Создающей команде версию присылать неоткуда, и цель конверта ей тоже не
 * нужна: собственный идентификатор объекта, если клиент его выбирает, лежит в
 * нагрузке. Молчаливое игнорирование обоих полей вернуло бы ровно ту тишину,
 * из-за которой версия не проверялась (R1 в docs/15-backend-review.md).
 *
 * Фоновые исполнители собственных команд пока не отправляют; когда появятся,
 * им нужна отдельная явно описанная политика, а не исключение из этой.
 */
function assertVersionPolicy(command: CommandRequest, definition: CommandDefinition): void {
  const mutates = definition.targetField !== undefined;

  if (!mutates) {
    if (command.targetId !== null) {
      throw new TargetMismatchError(
        'Создающая команда не изменяет существующий объект: aggregate_id должен быть пустым',
      );
    }
    if (command.expectedVersion !== null) {
      throw new VersionPolicyError('У создающей команды нет предыдущей версии');
    }
    return;
  }

  if (command.targetId === null) {
    throw new InvalidCommandPayloadError('Не указан изменяемый объект');
  }
  if (command.expectedVersion === null) {
    throw new VersionPolicyError('Изменяющая команда обязана назвать ожидаемую версию объекта');
  }
}

/**
 * Итог одной команды в виде, пригодном и для одиночного ответа, и для строки
 * квитанции в пачке.
 *
 * Разбор один на оба пути намеренно. Отдельный разбор для пачки разошёлся бы с
 * одиночным незаметно, и часть проверок действовала бы только на одном из них —
 * ровно так и появляются протоколы «для бота» в обход общего контракта
 * (docs/14, раздел 4).
 */
export interface CommandOutcomeReport {
  readonly status: 'committed' | 'already_applied' | 'rejected' | 'conflict' | 'not_found';
  readonly httpStatus: number;
  readonly error?: string;
  readonly detail?: string;
  readonly committedSeq?: string;
  readonly result?: Record<string, unknown>;
}

function rejection(httpStatus: number, error: string, detail?: string): CommandOutcomeReport {
  const status = httpStatus === 409 ? 'conflict' : httpStatus === 404 ? 'not_found' : 'rejected';
  return { status, httpStatus, error, ...(detail === undefined ? {} : { detail }) };
}

/**
 * Выполнение одной команды: проверка контракта, политика цели и версии,
 * собственно действие и разбор отказов.
 *
 * Отказ возвращается значением, а не исключением: в пачке одна негодная команда
 * не должна отменять остальные. Человек, у которого одно задание успели
 * завершить с другого устройства, иначе теряет все отметки за день разом.
 */
export async function executeEnvelope(
  database: Database,
  userId: string,
  envelope: CommandEnvelope,
): Promise<CommandOutcomeReport> {
  const definition = COMMANDS.get(envelope.kind);
  if (definition === undefined) {
    return rejection(400, 'unknown_command_kind');
  }

  // Зависимость между командами не реализована. Молча выполнить команду,
  // для которой клиент заявил предшественника, значит нарушить порядок,
  // который он считает гарантированным: «отметить выполнение» уехало бы
  // вперёд «создать задание».
  if (envelope.depends_on_command_id !== null) {
    return rejection(400, 'unsupported_dependency');
  }

  let command: CommandRequest;
  let handler: CommandHandler;
  try {
    assertPayloadMatchesSchema(envelope.kind, envelope.payload);
    command = {
      userId,
      commandId: envelope.command_id,
      kind: envelope.kind,
      schemaVersion: envelope.schema_version,
      targetId: resolveTarget(envelope, definition),
      expectedVersion: resolveExpectedVersion(envelope),
      dependsOnCommandId: envelope.depends_on_command_id,
      payload: envelope.payload,
    };
    assertVersionPolicy(command, definition);
    handler = definition.build(command);
  } catch (error) {
    if (error instanceof TargetMismatchError) {
      return rejection(400, 'target_mismatch', error.message);
    }
    if (error instanceof VersionPolicyError) {
      return rejection(400, 'version_required', error.message);
    }
    if (error instanceof PayloadValidationError || error instanceof InvalidCommandPayloadError) {
      return rejection(400, 'invalid_payload', error.message);
    }
    throw error;
  }

  try {
    const receipt = await executeCommand(database, command, handler);
    return {
      status: receipt.duplicate ? 'already_applied' : 'committed',
      httpStatus: 200,
      committedSeq: receipt.committedSeq,
      result: receipt.result,
    };
  } catch (error) {
    if (error instanceof PayloadMismatchError) {
      // 409, а не 400: запрос сам по себе корректен, конфликтует он с уже
      // зафиксированным состоянием.
      return rejection(409, 'command_id_reused');
    }
    if (error instanceof VersionConflictError) {
      // Клиент решал по устаревшему экрану: состояние уже другое.
      return rejection(409, 'version_conflict');
    }
    if (error instanceof InvalidTransitionError) {
      // Повторное завершение приходит сюда: второй награды за одно
      // действие быть не должно.
      return rejection(409, 'invalid_transition');
    }
    if (error instanceof QuestNotFoundError) {
      return rejection(404, 'not_found');
    }
    if (error instanceof InvalidCommandPayloadError) {
      return rejection(400, 'invalid_payload', error.message);
    }
    // 23505 — нарушение уникальности. Запрос корректен, конфликтует он с
    // уже существующей строкой: два экземпляра на один день дали бы две
    // награды за одну задачу. Без этой ветки клиент видит 500 и считает
    // ошибку сервера своей виной.
    if ((error as { code?: string }).code === '23505') {
      return rejection(409, 'already_exists');
    }
    throw error;
  }
}

/** Предел пачки. Больше — отдельными запросами (docs/06, раздел 3). */
const MAX_BATCH = 50;

const pushBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['commands'],
  properties: {
    commands: { type: 'array', items: commandEnvelopeSchema },
  },
} as const;

export function registerCommandRoutes(app: FastifyInstance, database: Database): void {
  app.post('/sync/push', { schema: { body: pushBodySchema } }, async (request, reply) => {
    const userId = request.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const { commands } = request.body as { commands: readonly CommandEnvelope[] };
    if (commands.length === 0) {
      return reply.code(400).send({ error: 'empty_batch' });
    }
    if (commands.length > MAX_BATCH) {
      // Отказ до выполнения, а не после половины: частично применённая пачка
      // оставляет клиента в состоянии, которого он не ожидает.
      return reply.code(400).send({ error: 'batch_too_large' });
    }

    // Последовательно: команды одного пользователя и так выстраиваются в
    // очередь блокировкой счётчика, а параллельный запуск лишь запутал бы
    // порядок квитанций.
    const receipts = [];
    for (const envelope of commands) {
      const outcome = await executeEnvelope(database, userId, envelope);
      receipts.push({
        command_id: envelope.command_id,
        status: outcome.status,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        ...(outcome.committedSeq === undefined ? {} : { committed_seq: outcome.committedSeq }),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
      });
    }

    // 200 на всю пачку: отдельные отказы описаны квитанциями. Общий код ошибки
    // заставил бы клиента считать неудачной и ту часть, что применилась.
    return reply.send({ receipts, server_time: new Date().toISOString() });
  });

  app.post('/commands', { schema: { body: commandEnvelopeSchema } }, async (request, reply) => {
    const userId = request.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const envelope = request.body as CommandEnvelope;
    const outcome = await executeEnvelope(database, userId, envelope);

    if (outcome.httpStatus !== 200) {
      return reply.code(outcome.httpStatus).send({
        error: outcome.error,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      });
    }

    return reply.send({
      command_id: envelope.command_id,
      committed_seq: outcome.committedSeq,
      duplicate: outcome.status === 'already_applied',
      result: outcome.result,
    });
  });
}
