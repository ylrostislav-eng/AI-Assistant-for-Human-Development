import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Схема конверта команды читается из `packages/contracts/schemas` — того же
 * файла, по которому клиент собирает запрос. Вторая копия схемы в коде сервера
 * разошлась бы с контрактом незаметно: обе стороны были бы уверены, что
 * проверяют одно и то же.
 *
 * Чтение синхронное и однократное при загрузке модуля: без контракта сервер
 * работать не должен, и падение на старте здесь предпочтительнее, чем отказ
 * первого же запроса.
 */

// От src/shared/commands до корня репозитория пять уровней.
const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/contracts/schemas/command-envelope.schema.json',
);

export const commandEnvelopeSchema: Record<string, unknown> = JSON.parse(
  readFileSync(SCHEMA_PATH, 'utf8'),
) as Record<string, unknown>;

export interface CommandEnvelope {
  readonly schema_version: number;
  readonly command_id: string;
  readonly device_id: string;
  readonly kind: string;
  readonly aggregate_id: string | null;
  readonly expected_version: number | null;
  readonly client_created_at: string;
  readonly depends_on_command_id: string | null;
  readonly payload: Record<string, unknown>;
}
