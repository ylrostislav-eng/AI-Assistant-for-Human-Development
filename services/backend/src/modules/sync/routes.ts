import type { FastifyInstance } from 'fastify';

import {
  createGoalHandler,
  InvalidCommandPayloadError,
  parseCreateGoalPayload,
} from '../goals/commands.ts';
import {
  createQuestTemplateHandler,
  materializeOccurrenceHandler,
  parseCreateQuestTemplate,
  parseMaterializeOccurrence,
  questTransitionHandler,
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
  /** Поле нагрузки, содержащее цель команды; отсутствует у создающих команд. */
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

export function registerCommandRoutes(app: FastifyInstance, database: Database): void {
  app.post('/commands', { schema: { body: commandEnvelopeSchema } }, async (request, reply) => {
    const userId = request.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const envelope = request.body as CommandEnvelope;
    const definition = COMMANDS.get(envelope.kind);
    if (definition === undefined) {
      return reply.code(400).send({ error: 'unknown_command_kind' });
    }

    // Зависимость между командами не реализована. Молча выполнить команду,
    // для которой клиент заявил предшественника, значит нарушить порядок,
    // который он считает гарантированным: «отметить выполнение» уехало бы
    // вперёд «создать задание».
    if (envelope.depends_on_command_id !== null) {
      return reply.code(400).send({ error: 'unsupported_dependency' });
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
      handler = definition.build(command);
    } catch (error) {
      if (error instanceof TargetMismatchError) {
        return reply.code(400).send({ error: 'target_mismatch', detail: error.message });
      }
      if (error instanceof PayloadValidationError || error instanceof InvalidCommandPayloadError) {
        return reply.code(400).send({ error: 'invalid_payload', detail: error.message });
      }
      throw error;
    }

    try {
      const receipt = await executeCommand(database, command, handler);

      return reply.send({
        command_id: envelope.command_id,
        committed_seq: receipt.committedSeq,
        duplicate: receipt.duplicate,
        result: receipt.result,
      });
    } catch (error) {
      if (error instanceof PayloadMismatchError) {
        // 409, а не 400: запрос сам по себе корректен, конфликтует он с уже
        // зафиксированным состоянием.
        return reply.code(409).send({ error: 'command_id_reused' });
      }
      if (error instanceof VersionConflictError) {
        // Клиент решал по устаревшему экрану: состояние уже другое.
        return reply.code(409).send({ error: 'version_conflict' });
      }
      if (error instanceof InvalidTransitionError) {
        // Повторное завершение приходит сюда: второй награды за одно
        // действие быть не должно.
        return reply.code(409).send({ error: 'invalid_transition' });
      }
      if (error instanceof QuestNotFoundError) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (error instanceof InvalidCommandPayloadError) {
        return reply.code(400).send({ error: 'invalid_payload', detail: error.message });
      }
      // 23505 — нарушение уникальности. Запрос корректен, конфликтует он с
      // уже существующей строкой: два экземпляра на один день дали бы две
      // награды за одну задачу. Без этой ветки клиент видит 500 и считает
      // ошибку сервера своей виной.
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'already_exists' });
      }
      throw error;
    }
  });
}
