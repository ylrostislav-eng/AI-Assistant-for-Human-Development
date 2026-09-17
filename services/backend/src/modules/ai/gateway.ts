import { findTool, toolCatalog, type ToolDefinition } from './catalog.ts';
import type { ToolCall } from './provider.ts';
import { executeEnvelope, type CommandOutcomeReport } from '../sync/routes.ts';
import { derivedCommandId } from '../../shared/commands/derived-id.ts';
import type { Database } from '../../shared/db/pool.ts';
import { withTenantTransaction } from '../../shared/db/tenant.ts';
import { createValidator, describeFailure, type CompiledSchema } from '../../shared/schema/validator.ts';
import { userDayAt } from '../../shared/time/user-day.ts';

export type { ToolCall } from './provider.ts';

/**
 * Шлюз инструментов: единственная дверь модели к данным.
 *
 * Всё, что модель предлагает, проходит здесь три вещи, которых подсказка дать
 * не может: закрытую схему аргументов, подстановку серверных значений вместо
 * предложенных моделью и тот же контракт команд, что у кнопки бота и Mini App
 * (docs/05, раздел 3; docs/14, раздел 4).
 *
 * Модель не выбирает пользователя, идентификатор команды и ожидаемую версию.
 * Первое — граница доверия, второе — идемпотентность, третье — оптимистичная
 * блокировка: версия, присланная моделью, означала бы «выполнено, что бы там
 * сейчас ни было».
 *
 * Объекты называются ссылками, выданными сервером при чтении в этом же ходе, а
 * не идентификаторами. Причина не в удобстве: идентификатор модель способна
 * выдумать или взять из чужого текста, а ссылку — нет, она существует только
 * внутри одного хода и только для тех строк, которые сервер действительно
 * показал. Это тот же приём, что у кнопок бота, где `callback_data` непрозрачна
 * (docs/14, раздел 4).
 */

export interface CommandReceiptSummary {
  readonly tool: string;
  readonly status: 'committed' | 'already_applied';
  readonly title?: string;
  readonly occurrenceId?: string;
  readonly executionStatus?: string;
  readonly committedSeq?: string;
}

export interface ToolResult {
  readonly callId: string;
  readonly name: string;
  readonly status: 'ok' | 'rejected' | 'conflict' | 'not_found';
  /** Что уходит модели. Небольшой JSON: контекст ограничен. */
  readonly content: Record<string, unknown>;
  /**
   * Подтверждённый факт для человека. Есть только у выполненного изменения:
   * ответ человеку строится из квитанций, а не из слов модели, иначе «создано»
   * можно написать, ничего не создав (docs/05, раздел 3, пункт 8).
   */
  readonly receipt?: CommandReceiptSummary;
}

export interface ToolGateway {
  definitions(): readonly ToolDefinition[];
  invoke(call: ToolCall): Promise<ToolResult>;
  receipts(): readonly CommandReceiptSummary[];
}

export interface GatewayLimits {
  /** Сколько вызовов инструментов допускается за ход. */
  readonly maxCalls: number;
  /** Сколько из них изменяющих. Отдельный предел: чтение дёшево и безвредно. */
  readonly maxMutations: number;
}

const DEFAULT_LIMITS: GatewayLimits = { maxCalls: 12, maxMutations: 4 };

/** Сколько заданий показывать. Столько же, сколько показывает `/today` бота. */
const QUEST_LIMIT = 20;

/** Схемы аргументов компилируются один раз: на каждый ход это лишняя работа. */
const ARGUMENT_SCHEMAS = ((): Map<string, CompiledSchema> => {
  const validator = createValidator();
  const compiled = new Map<string, CompiledSchema>();
  for (const tool of toolCatalog()) {
    compiled.set(tool.name, validator.compile(tool.parameters));
  }
  return compiled;
})();

/** Снимок задания, под которым выдана ссылка. */
interface QuestSnapshot {
  readonly occurrenceId: string;
  readonly title: string;
  version: number;
}

interface CreateQuestArguments {
  readonly title: string;
  readonly success_rule: 'duration' | 'amount';
  readonly unit: string;
  readonly duration_seconds: number | null;
  readonly amount: number | null;
}

interface CompleteQuestArguments {
  readonly quest_ref: string;
  readonly variant: 'normal' | 'minimum' | null;
  readonly actual_duration_seconds: number | null;
  readonly actual_amount: number | null;
}

function rejected(call: ToolCall, error: string, detail?: string): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    status: 'rejected',
    content: { error, ...(detail === undefined ? {} : { detail }) },
  };
}

export function createToolGateway(options: {
  readonly database: Database;
  readonly userId: string;
  /** Идентификатор хода: из него выводятся идентификаторы команд. */
  readonly turnId: string;
  readonly limits?: Partial<GatewayLimits>;
  readonly now?: () => Date;
}): ToolGateway {
  const limits: GatewayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? ((): Date => new Date());

  const byRef = new Map<string, QuestSnapshot>();
  const refByOccurrence = new Map<string, string>();
  const receipts: CommandReceiptSummary[] = [];
  let calls = 0;
  let mutations = 0;

  /**
   * Ссылка закрепляется за заданием на весь ход. Выдавать её заново по порядку
   * строк нельзя: между двумя чтениями список меняется, и «q1» второго чтения
   * оказался бы другим заданием — а модель уже решила, что делает с «q1».
   */
  function refFor(occurrenceId: string, title: string, version: number): string {
    const existing = refByOccurrence.get(occurrenceId);
    if (existing !== undefined) {
      const snapshot = byRef.get(existing);
      if (snapshot !== undefined) {
        snapshot.version = version;
      }
      return existing;
    }
    const ref = `q${refByOccurrence.size + 1}`;
    refByOccurrence.set(occurrenceId, ref);
    byRef.set(ref, { occurrenceId, title, version });
    return ref;
  }

  function envelope(kind: string, step: string, payload: Record<string, unknown>, target?: {
    readonly id: string;
    readonly expectedVersion: number;
  }) {
    return {
      schema_version: 1,
      // Идентификатор выведен из хода и шага, а не случайный: повтор хода
      // (потерянный ответ, повторный разбор обновления) обязан вернуть прежнюю
      // квитанцию, а не создать второе задание.
      command_id: derivedCommandId('ai', options.turnId, step),
      device_id: derivedCommandId('ai', options.turnId, 'device'),
      kind,
      aggregate_id: target?.id ?? null,
      expected_version: target?.expectedVersion ?? null,
      client_created_at: now().toISOString(),
      depends_on_command_id: null,
      payload,
    };
  }

  async function readQuests(): Promise<{ ref: string; title: string; status: string }[]> {
    const found = await withTenantTransaction(options.database, options.userId, async (client) =>
      client.query<{ id: string; version: string; execution_status: string; template_snapshot: { title?: string } }>(
        `SELECT id, version, execution_status, template_snapshot
           FROM quest_occurrences
          WHERE execution_status IN ('planned', 'active', 'partial')
          ORDER BY created_at
          LIMIT $1`,
        [QUEST_LIMIT],
      ),
    );

    return found.rows.map((row) => {
      const title = row.template_snapshot.title ?? 'без названия';
      return {
        ref: refFor(row.id, title, Number(row.version)),
        title,
        status: row.execution_status,
      };
    });
  }

  /** Разбор итога команды в общий вид результата инструмента. */
  function report(
    call: ToolCall,
    outcome: CommandOutcomeReport,
    extra: { readonly title?: string } = {},
  ): ToolResult {
    if (outcome.status === 'committed' || outcome.status === 'already_applied') {
      const result = outcome.result ?? {};
      const occurrenceId = result['occurrence_id'];
      const executionStatus = result['execution_status'];
      const receipt: CommandReceiptSummary = {
        tool: call.name,
        status: outcome.status,
        ...(extra.title === undefined ? {} : { title: extra.title }),
        ...(typeof occurrenceId === 'string' ? { occurrenceId } : {}),
        ...(typeof executionStatus === 'string' ? { executionStatus } : {}),
        ...(outcome.committedSeq === undefined ? {} : { committedSeq: outcome.committedSeq }),
      };
      receipts.push(receipt);
      return {
        callId: call.id,
        name: call.name,
        status: 'ok',
        // Модели возвращается итог без идентификаторов: они ей не нужны, а
        // увиденный идентификатор она способна повторить там, где не должна.
        content: {
          status: outcome.status,
          ...(extra.title === undefined ? {} : { title: extra.title }),
          ...(typeof executionStatus === 'string' ? { execution_status: executionStatus } : {}),
        },
        receipt,
      };
    }

    const status = outcome.status === 'conflict' ? 'conflict' : outcome.status === 'not_found' ? 'not_found' : 'rejected';
    return {
      callId: call.id,
      name: call.name,
      status,
      content: {
        error: outcome.error ?? status,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        // Прямое указание вместо догадки: иначе модель отвечает «выполнено»
        // на конфликт, потому что вызов «прошёл».
        hint:
          status === 'conflict'
            ? 'Состояние изменилось в другом месте. Прочитайте задания заново и не объявляйте выполнение.'
            : 'Действие не выполнено.',
      },
    };
  }

  async function createQuest(call: ToolCall, args: CreateQuestArguments): Promise<ToolResult> {
    const profile = await withTenantTransaction(options.database, options.userId, async (client) =>
      client.query<{ timezone: string; day_boundary_minutes: number }>(
        'SELECT timezone, day_boundary_minutes FROM user_profiles WHERE user_id = $1',
        [options.userId],
      ),
    );
    const settings = profile.rows[0];
    if (settings === undefined) {
      throw new Error('У пользователя нет профиля');
    }

    const spec: Record<string, unknown> = {
      success_rule: args.success_rule,
      unit: args.unit,
      ...(args.duration_seconds === null ? {} : { duration_seconds: args.duration_seconds }),
      ...(args.amount === null ? {} : { amount: args.amount }),
    };

    const template = await executeEnvelope(
      options.database,
      options.userId,
      envelope('create_quest_template', `${call.id}:template`, {
        title: args.title,
        normal_spec: spec,
      }),
    );
    const templateId = template.result?.['template_id'];
    if (typeof templateId !== 'string') {
      return report(call, template, { title: args.title });
    }

    // Ключ повторения — локальная дата пользовательского дня, а не дата
    // сервера: задание, созданное в час ночи по Москве, относится к сегодняшнему
    // дню человека, а не к следующему по UTC.
    const day = userDayAt(now(), settings.timezone, settings.day_boundary_minutes);
    const occurrence = await executeEnvelope(
      options.database,
      options.userId,
      envelope('materialize_occurrence', `${call.id}:occurrence`, {
        template_id: templateId,
        recurrence_key: day.localDate,
        timezone: settings.timezone,
      }),
    );
    return report(call, occurrence, { title: args.title });
  }

  async function completeQuest(call: ToolCall, args: CompleteQuestArguments): Promise<ToolResult> {
    const snapshot = byRef.get(args.quest_ref);
    if (snapshot === undefined) {
      // Незнакомая ссылка не угадывается «ближайшим» заданием: угадать здесь
      // значит отметить выполненным не то, что человек имел в виду.
      return rejected(
        call,
        'unknown_quest_ref',
        'Такой ссылки в этом разговоре не выдавали. Прочитайте задания заново.',
      );
    }

    const outcome = await executeEnvelope(
      options.database,
      options.userId,
      envelope(
        'complete_quest',
        `${call.id}:complete`,
        {
          ...(args.variant === null ? {} : { variant: args.variant }),
          ...(args.actual_duration_seconds === null
            ? {}
            : { actual_duration_seconds: args.actual_duration_seconds }),
          ...(args.actual_amount === null ? {} : { actual_amount: args.actual_amount }),
        },
        // Версия — из снимка, под которым выдана ссылка, а не из аргументов
        // модели. Задание, завершённое кнопкой минуту назад, даст честный
        // конфликт вместо второй отметки.
        { id: snapshot.occurrenceId, expectedVersion: snapshot.version },
      ),
    );

    const version = outcome.result?.['version'];
    if (typeof version === 'string' || typeof version === 'number') {
      snapshot.version = Number(version);
    }
    return report(call, outcome, { title: snapshot.title });
  }

  return {
    definitions: () => toolCatalog(),
    receipts: () => receipts,

    async invoke(call: ToolCall): Promise<ToolResult> {
      const tool = findTool(call.name);
      if (tool === undefined) {
        // Незнакомое имя — не повод искать похожее: инструментов начисления не
        // существует, и «почти подходящий» здесь опаснее отказа.
        return rejected(call, 'unknown_tool', `Инструмента ${call.name} не существует`);
      }

      calls += 1;
      if (calls > limits.maxCalls) {
        return rejected(call, 'call_budget_exhausted');
      }

      const schema = ARGUMENT_SCHEMAS.get(call.name);
      if (schema === undefined) {
        throw new Error(`Для инструмента ${call.name} не скомпилирована схема`);
      }
      if (!schema(call.arguments)) {
        return rejected(call, 'invalid_arguments', describeFailure(schema.errors));
      }

      if (tool.mutates) {
        // Предел проверяется до выполнения: посчитать и всё равно выполнить
        // значит не иметь предела.
        if (mutations >= limits.maxMutations) {
          return rejected(
            call,
            'mutation_budget_exhausted',
            'За один ход больше изменений не делается. Скажите об этом человеку.',
          );
        }
        mutations += 1;
      }

      if (call.name === 'get_today_quests') {
        return {
          callId: call.id,
          name: call.name,
          status: 'ok',
          content: { quests: await readQuests() },
        };
      }
      if (call.name === 'create_quest') {
        return createQuest(call, call.arguments as CreateQuestArguments);
      }
      if (call.name === 'complete_quest') {
        return completeQuest(call, call.arguments as CompleteQuestArguments);
      }

      // Инструмент есть в каталоге, но не исполняется здесь. Тихий «успех» в
      // этом месте означал бы, что модель считает сделанным то, чего никто не
      // делал.
      throw new Error(`Инструмент ${call.name} не реализован в шлюзе`);
    },
  };
}
