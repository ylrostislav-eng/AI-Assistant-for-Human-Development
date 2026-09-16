import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createValidator,
  describeFailure,
  type CompiledSchema,
} from '../schema/validator.ts';

/**
 * Закрытые схемы нагрузки по видам команд.
 *
 * Схема конверта проверяет только транспорт и прямо требует отдельной проверки
 * нагрузки. Без неё лишнее поле молча пропадало: клиент отправлял, например,
 * фактический объём при завершении и считал его учтённым, а сервер о нём
 * ничего не знал (R6 в docs/15-backend-review.md). Отказ лучше тишины —
 * незаписанный факт обнаруживается недели спустя, когда восстановить его
 * неоткуда.
 *
 * Схемы лежат в `packages/contracts/schemas/commands` рядом с конвертом: вторая
 * копия на сервере разошлась бы с клиентом незаметно.
 *
 * Чтение синхронное и однократное при загрузке модуля: без контракта сервер
 * работать не должен, и падение на старте предпочтительнее отказа первого же
 * запроса.
 */

// От src/shared/commands до корня репозитория пять уровней.
const SCHEMAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/contracts/schemas/commands',
);

const PAYLOAD_SUFFIX = '.payload.schema.json';

/** Вид команды зарегистрирован, а схемы для него нет: ошибка сервера, не клиента. */
export class PayloadSchemaError extends Error {}

/** Нагрузка не прошла закрытую схему: ошибка клиента. */
export class PayloadValidationError extends Error {}

function loadSchemas(): Map<string, CompiledSchema> {
  const validator = createValidator();
  const files = readdirSync(SCHEMAS_DIR).filter((name) => name.endsWith('.json')).sort();

  // Сначала регистрируются все схемы, включая общие фрагменты с именем на
  // подчёркивании: ссылка на ещё не зарегистрированный фрагмент не разрешится.
  const sources = new Map<string, object>();
  for (const file of files) {
    sources.set(file, JSON.parse(readFileSync(path.join(SCHEMAS_DIR, file), 'utf8')) as object);
  }
  for (const [file, schema] of sources) {
    if (!file.endsWith(PAYLOAD_SUFFIX)) {
      validator.addSchema(schema);
    }
  }

  const compiled = new Map<string, CompiledSchema>();
  for (const [file, schema] of sources) {
    if (!file.endsWith(PAYLOAD_SUFFIX)) {
      continue;
    }
    compiled.set(file.slice(0, -PAYLOAD_SUFFIX.length), validator.compile(schema));
  }
  return compiled;
}

const SCHEMAS = loadSchemas();

/** Виды команд, для которых есть закрытая схема; используется сверкой реестра. */
export function kindsWithSchema(): readonly string[] {
  return [...SCHEMAS.keys()].sort();
}

/**
 * Проверка нагрузки перед разбором.
 *
 * Отсутствие схемы — не повод пропустить нагрузку без проверки: вид команды
 * зарегистрирован, значит контракт обязан существовать. Тихий пропуск вернул бы
 * ровно то поведение, ради исправления которого схемы и появились.
 */
export function assertPayloadMatchesSchema(kind: string, payload: Record<string, unknown>): void {
  const schema = SCHEMAS.get(kind);
  if (schema === undefined) {
    throw new PayloadSchemaError(`Для команды ${kind} не зарегистрирована схема нагрузки`);
  }
  if (!schema(payload)) {
    throw new PayloadValidationError(describeFailure(schema.errors));
  }
}
