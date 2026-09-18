import type { CommandContext, CommandOutcome, CommandRequest } from '../../shared/commands/bus.ts';
import { InvalidCommandPayloadError } from '../goals/commands.ts';
import {
  assertFactMatchesVariant,
  findAcceptedActivity,
  parseActivityFact,
  recordActivity,
  type ActivityVariant,
  type EffortSpec,
} from './activity.ts';
import {
  isCompletionVariant,
  nextStatus,
  type CompletionVariant,
  type ExecutionStatus,
  type QuestCommand,
} from './state.ts';

/**
 * Команды заданий: создание шаблона, материализация экземпляра и переходы
 * выполнения.
 *
 * Все переходы идут через автомат из `state.ts`, а не через прямое присвоение
 * статуса: повторное завершение означало бы вторую награду за одно действие.
 */

export class VersionConflictError extends Error {}
export class QuestNotFoundError extends Error {}

interface TemplateSnapshot {
  readonly normal_spec: EffortSpec;
  readonly minimum_spec: EffortSpec | null;
}

/**
 * Спецификации берутся из снимка экземпляра, а не из текущего шаблона: правка
 * шаблона задним числом не должна менять условия уже прожитого дня.
 */
function specsOf(snapshot: Record<string, unknown>): TemplateSnapshot {
  const taken = snapshot as unknown as TemplateSnapshot;
  return { normal_spec: taken.normal_spec, minimum_spec: taken.minimum_spec ?? null };
}

/** Строка экземпляра, заблокированная на время перехода. */
interface LockedOccurrence {
  readonly id: string;
  readonly execution_status: ExecutionStatus;
  readonly version: string;
  readonly template_snapshot: Record<string, unknown>;
}

async function lockOccurrence(
  context: CommandContext,
  occurrenceId: string,
  expectedVersion: number | null,
): Promise<LockedOccurrence> {
  const current = await context.client.query<LockedOccurrence>(
    `SELECT id, execution_status, version, template_snapshot
       FROM quest_occurrences WHERE id = $1 FOR UPDATE`,
    [occurrenceId],
  );

  const occurrence = current.rows[0];
  if (occurrence === undefined) {
    throw new QuestNotFoundError('Экземпляр задания не найден');
  }
  if (expectedVersion !== null && Number(occurrence.version) !== expectedVersion) {
    throw new VersionConflictError(
      `Экземпляр изменился: ожидалась версия ${expectedVersion}, текущая ${occurrence.version}`,
    );
  }
  return occurrence;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidCommandPayloadError(`${key} обязателен`);
  }
  return value;
}

export interface CreateQuestTemplatePayload {
  readonly title: string;
  readonly normal_spec: Record<string, unknown>;
  readonly goal_id?: string;
  readonly minimum_spec?: Record<string, unknown>;
  readonly category?: string;
  /** Повторение. Отсутствие означает разовое задание, а не «ежедневное по умолчанию». */
  readonly recurrence?: Record<string, unknown>;
}

/**
 * Объём спецификации в её собственной мере. Сравнивать duration с amount
 * бессмысленно: «5 километров меньше 1800 секунд» — не утверждение.
 */
function specVolume(spec: Record<string, unknown>): number {
  return spec['success_rule'] === 'duration'
    ? Number(spec['duration_seconds'])
    : Number(spec['amount']);
}

/**
 * Минимум должен быть меньше нормы и мерить то же самое (docs/02, раздел 4).
 *
 * Иначе «минимальным выполнением» объявляется что угодно: открыть приложение
 * вместо тренировки. Награда за минимум меньше, но она есть, и без этой
 * проверки её можно получать каждый день, ничего не делая.
 */
function assertMinimumFitsNormal(
  normalSpec: Record<string, unknown>,
  minimumSpec: Record<string, unknown>,
): void {
  if (minimumSpec['success_rule'] !== normalSpec['success_rule']) {
    throw new InvalidCommandPayloadError('minimum_spec должен мерить то же, что normal_spec');
  }
  if (minimumSpec['unit'] !== normalSpec['unit']) {
    throw new InvalidCommandPayloadError('minimum_spec должен быть в тех же единицах');
  }
  if (!(specVolume(minimumSpec) < specVolume(normalSpec))) {
    throw new InvalidCommandPayloadError('minimum_spec должен быть меньше normal_spec');
  }
}

export function parseCreateQuestTemplate(
  payload: Record<string, unknown>,
): CreateQuestTemplatePayload {
  // Форму спецификаций уже проверила закрытая схема нагрузки; здесь остаётся
  // то, что схемой не выражается, — соотношение двух объектов между собой.
  const normalSpec = payload['normal_spec'] as Record<string, unknown>;
  const minimumSpec = payload['minimum_spec'] as Record<string, unknown> | undefined;
  if (minimumSpec !== undefined) {
    assertMinimumFitsNormal(normalSpec, minimumSpec);
  }

  const goalId = payload['goal_id'];
  const category = payload['category'];
  const recurrence = payload['recurrence'] as Record<string, unknown> | undefined;

  return {
    title: requireString(payload, 'title'),
    normal_spec: normalSpec,
    ...(typeof goalId === 'string' ? { goal_id: goalId } : {}),
    ...(minimumSpec === undefined ? {} : { minimum_spec: minimumSpec }),
    ...(typeof category === 'string' ? { category } : {}),
    ...(recurrence === undefined ? {} : { recurrence }),
  };
}

export function createQuestTemplateHandler(payload: CreateQuestTemplatePayload) {
  return async (context: CommandContext): Promise<CommandOutcome> => {
    const inserted = await context.client.query<{ id: string }>(
      `INSERT INTO quest_templates
         (user_id, goal_id, title, category, normal_spec, minimum_spec, recurrence)
       VALUES ($1, $2::uuid, $3, COALESCE($4, 'daily'), $5::jsonb, $6::jsonb, $7::jsonb)
       RETURNING id`,
      [
        context.userId,
        payload.goal_id ?? null,
        payload.title,
        payload.category ?? null,
        JSON.stringify(payload.normal_spec),
        payload.minimum_spec === undefined ? null : JSON.stringify(payload.minimum_spec),
        // NULL, а не пустой объект: отсутствие повторения и «повторение,
        // про которое ничего не сказано» — разные вещи при чтении.
        payload.recurrence === undefined ? null : JSON.stringify(payload.recurrence),
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('Шаблон задания не создан');
    }
    return {
      result: { template_id: row.id },
      changes: [{ entity: 'quest_template', id: row.id, operation: 'created' }],
    };
  };
}

export interface MaterializeOccurrencePayload {
  readonly template_id: string;
  readonly recurrence_key: string;
  readonly timezone: string;
  readonly user_day_id?: string;
}

export function parseMaterializeOccurrence(
  payload: Record<string, unknown>,
): MaterializeOccurrencePayload {
  const userDayId = payload['user_day_id'];
  return {
    template_id: requireString(payload, 'template_id'),
    recurrence_key: requireString(payload, 'recurrence_key'),
    timezone: requireString(payload, 'timezone'),
    ...(typeof userDayId === 'string' ? { user_day_id: userDayId } : {}),
  };
}

/**
 * Экземпляр сохраняет снимок правил шаблона: поздняя правка шаблона не меняет
 * уже прожитое прошлое (docs/02, раздел 4).
 */
export function materializeOccurrenceHandler(payload: MaterializeOccurrencePayload) {
  return async (context: CommandContext): Promise<CommandOutcome> => {
    const template = await context.client.query<{
      id: string;
      title: string;
      category: string;
      normal_spec: Record<string, unknown>;
      minimum_spec: Record<string, unknown> | null;
    }>(
      'SELECT id, title, category, normal_spec, minimum_spec FROM quest_templates WHERE id = $1',
      [payload.template_id],
    );

    const found = template.rows[0];
    if (found === undefined) {
      throw new QuestNotFoundError('Шаблон задания не найден');
    }

    const snapshot = {
      title: found.title,
      category: found.category,
      normal_spec: found.normal_spec,
      minimum_spec: found.minimum_spec,
    };

    const inserted = await context.client.query<{ id: string; version: string }>(
      `INSERT INTO quest_occurrences
         (user_id, template_id, recurrence_key, timezone_snapshot, template_snapshot,
          assigned_user_day, placement_state)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid,
               CASE WHEN $6::uuid IS NULL THEN 'unscheduled' ELSE 'scheduled' END)
       RETURNING id, version`,
      [
        context.userId,
        payload.template_id,
        payload.recurrence_key,
        payload.timezone,
        JSON.stringify(snapshot),
        payload.user_day_id ?? null,
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('Экземпляр задания не создан');
    }
    return {
      result: { occurrence_id: row.id, version: row.version },
      changes: [{ entity: 'quest_occurrence', id: row.id, operation: 'created' }],
    };
  };
}


/**
 * Переход выполнения.
 *
 * Строка берётся `FOR UPDATE`: без блокировки две одновременные команды
 * прочитали бы одно состояние и обе сочли переход допустимым.
 *
 * Версия проверяется, если клиент её прислал: он мог принимать решение по
 * устаревшему экрану, и тогда переход относится к состоянию, которого уже нет.
 */
export function questTransitionHandler(command: QuestCommand, request: CommandRequest) {
  const occurrenceId = request.targetId;
  if (occurrenceId === null) {
    // Цель берётся из конверта или из нагрузки; её отсутствие означает, что
    // клиент не сказал, что именно менять.
    throw new InvalidCommandPayloadError('occurrence_id обязателен');
  }

  const variant = request.payload['variant'];
  if (variant !== undefined && !isCompletionVariant(variant)) {
    throw new InvalidCommandPayloadError('variant должен быть normal или minimum');
  }

  return async (context: CommandContext): Promise<CommandOutcome> => {
    const occurrence = await lockOccurrence(context, occurrenceId, request.expectedVersion);
    const target = nextStatus(occurrence.execution_status, command);
    const completionVariant =
      command === 'complete_quest' ? ((variant as CompletionVariant | undefined) ?? 'normal') : null;

    // Факт записывается только там, где что-то действительно сделано. Отмена и
    // запуск объёма не порождают.
    const factVariant: ActivityVariant | null =
      command === 'complete_quest'
        ? (completionVariant as ActivityVariant)
        : command === 'record_partial'
          ? 'partial'
          : null;

    let activityId: string | null = null;
    if (factVariant !== null) {
      const specs = specsOf(occurrence.template_snapshot);
      const fact = parseActivityFact(request.payload, specs.normal_spec);
      assertFactMatchesVariant(fact, factVariant, specs.normal_spec, specs.minimum_spec);
      const stored = await recordActivity(
        context.client,
        context.userId,
        occurrenceId,
        fact,
        factVariant,
      );
      activityId = stored.id;
    }

    const updated = await context.client.query<{ version: string }>(
      `UPDATE quest_occurrences
          SET execution_status = $2,
              completion_variant = $3,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING version`,
      [occurrenceId, target, completionVariant],
    );

    const row = updated.rows[0];
    if (row === undefined) {
      throw new Error('Состояние задания не обновлено');
    }

    return {
      result: {
        occurrence_id: occurrenceId,
        execution_status: target,
        version: row.version,
        ...(completionVariant === null ? {} : { variant: completionVariant }),
        ...(activityId === null ? {} : { activity_id: activityId }),
      },
      changes: [
        {
          entity: 'quest_occurrence',
          id: occurrenceId,
          operation: 'status_changed',
          execution_status: target,
        },
      ],
      // Награда считается отдельно детерминированным движком (Phase 3); здесь
      // фиксируется только факт выполнения.
      events: [
        {
          kind: 'quest_status_changed',
          payload: { occurrence_id: occurrenceId, execution_status: target },
        },
      ],
    };
  };
}

/**
 * Исправление уже записанного факта.
 *
 * Отдельная команда, а не повторное завершение: статус не меняется, меняется
 * только то, что известно о сделанном. Новый способ доказательства — таймер,
 * данные устройства, уточнение человека — уточняет действие, а не создаёт
 * второе (docs/02, раздел 5).
 */
export function correctActivityHandler(request: CommandRequest) {
  const occurrenceId = request.targetId;
  if (occurrenceId === null) {
    throw new InvalidCommandPayloadError('occurrence_id обязателен');
  }

  return async (context: CommandContext): Promise<CommandOutcome> => {
    const occurrence = await lockOccurrence(context, occurrenceId, request.expectedVersion);

    const prior = await findAcceptedActivity(context.client, occurrenceId);
    if (prior === undefined) {
      // Исправлять нечего. Создать факт здесь значило бы завершить задание в
      // обход автомата состояний.
      throw new QuestNotFoundError('У задания нет записанного факта выполнения');
    }

    const specs = specsOf(occurrence.template_snapshot);
    const fact = parseActivityFact(request.payload, specs.normal_spec);
    // Вариант остаётся прежним: исправление уточняет объём, а не пересматривает
    // решение о том, полное это выполнение или минимум.
    assertFactMatchesVariant(fact, prior.variant, specs.normal_spec, specs.minimum_spec);

    const stored = await recordActivity(
      context.client,
      context.userId,
      occurrenceId,
      fact,
      prior.variant,
    );

    const updated = await context.client.query<{ version: string }>(
      `UPDATE quest_occurrences SET version = version + 1, updated_at = now()
        WHERE id = $1 RETURNING version`,
      [occurrenceId],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new Error('Версия задания не обновлена');
    }

    return {
      result: {
        occurrence_id: occurrenceId,
        activity_id: stored.id,
        root_activity_id: stored.rootActivityId,
        version: row.version,
      },
      changes: [
        { entity: 'quest_occurrence', id: occurrenceId, operation: 'activity_corrected' },
      ],
      events: [
        {
          kind: 'activity_corrected',
          payload: { occurrence_id: occurrenceId, activity_id: stored.id },
        },
      ],
    };
  };
}

/**
 * Прекращение повторения.
 *
 * Трогает только шаблон: уже созданные экземпляры остаются на своих днях. В
 * них записан прожитый день, и стирать его значило бы терять факт ради
 * будущего решения. «Убрать» — это про один день, «не повторять» — про все
 * следующие; человек пропускает день гораздо чаще, чем бросает дело.
 *
 * Отдельная команда, а не правка шаблона вообще: сузить её до одного поля
 * значит гарантировать, что название и мера не изменятся заодно.
 */
export function stopRecurrenceHandler(request: CommandRequest) {
  const templateId = request.targetId;
  if (templateId === null) {
    throw new InvalidCommandPayloadError('template_id обязателен');
  }

  return async (context: CommandContext): Promise<CommandOutcome> => {
    const current = await context.client.query<{ version: string; recurrence: unknown }>(
      'SELECT version, recurrence FROM quest_templates WHERE id = $1 FOR UPDATE',
      [templateId],
    );
    const template = current.rows[0];
    if (template === undefined) {
      throw new QuestNotFoundError('Шаблон задания не найден');
    }
    if (request.expectedVersion !== null && Number(template.version) !== request.expectedVersion) {
      throw new VersionConflictError(
        `Шаблон изменился: ожидалась версия ${request.expectedVersion}, текущая ${template.version}`,
      );
    }

    const updated = await context.client.query<{ version: string }>(
      `UPDATE quest_templates SET recurrence = NULL, version = version + 1, updated_at = now()
        WHERE id = $1 RETURNING version`,
      [templateId],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new Error('Повторение не остановлено');
    }

    return {
      result: { template_id: templateId, version: row.version },
      changes: [{ entity: 'quest_template', id: templateId, operation: 'recurrence_stopped' }],
      events: [{ kind: 'recurrence_stopped', payload: { template_id: templateId } }],
    };
  };
}
