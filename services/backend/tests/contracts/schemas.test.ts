import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ajvModule from 'ajv/dist/2020.js';
import * as ajvFormatsModule from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Проверка схем контрактов.
 *
 * Схема, которая не компилируется или пропускает лишнее поле, обнаруживается
 * обычно на чужих данных: сервер принимает запрос, о котором не договаривались.
 * Поэтому проверяются и принятие правильного конверта, и отказ на неправильном.
 */

const SCHEMAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/schemas',
);

type Validator = (data: unknown) => boolean;

interface AjvLike {
  compile(schema: unknown): Validator;
}

/**
 * ajv и ajv-formats собраны как CommonJS: под ESM сам класс приходит в свойстве
 * default, а типы описывают пространство имён модуля. Прямой вызов не
 * компилируется, поэтому приведение выполняется один раз здесь.
 */
const Ajv2020 = (ajvModule as unknown as { default: new (options?: object) => AjvLike }).default;
const addFormats = (ajvFormatsModule as unknown as { default: (ajv: AjvLike) => void }).default;

/**
 * Пример берётся из общего файла, а не из константы в проверке: тот же файл
 * будет использовать клиент. Пример, живущий только в тесте, расходится со
 * схемой незаметно — что и случилось при первом написании этой проверки.
 */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/fixtures',
);

let VALID_ENVELOPE: Record<string, unknown>;

let validateEnvelope: Validator;

beforeAll(async () => {
  const raw = await readFile(path.join(SCHEMAS_DIR, 'command-envelope.schema.json'), 'utf8');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  validateEnvelope = ajv.compile(JSON.parse(raw));

  const fixture = await readFile(path.join(FIXTURES_DIR, 'command-envelope.valid.json'), 'utf8');
  VALID_ENVELOPE = JSON.parse(fixture) as Record<string, unknown>;
});

describe('схема конверта команды', () => {
  it('компилируется в строгом режиме', () => {
    // Строгий режим ajv отвергает опечатки в ключевых словах схемы: без него
    // «maxLenght» просто не проверяется, и ограничение существует только на
    // бумаге.
    expect(validateEnvelope).toBeTypeOf('function');
  });

  it('принимает корректный конверт', () => {
    expect(validateEnvelope(VALID_ENVELOPE)).toBe(true);
  });

  it('отклоняет посторонние поля', () => {
    // Конверт закрыт: неизвестное поле означает, что клиент и сервер понимают
    // команду по-разному.
    expect(validateEnvelope({ ...VALID_ENVELOPE, user_id: 'подставленный' })).toBe(false);
  });

  it('отклоняет конверт без идентификатора команды', () => {
    const { command_id: _omitted, ...withoutId } = VALID_ENVELOPE;

    // Без command_id повторная доставка неотличима от новой команды.
    expect(validateEnvelope(withoutId)).toBe(false);
  });

  it('отклоняет идентификатор команды не в формате uuid', () => {
    expect(validateEnvelope({ ...VALID_ENVELOPE, command_id: 'не-uuid' })).toBe(false);
  });
});

describe('схема инструмента ИИ', () => {
  it('не содержит полей начисления награды', async () => {
    const raw = await readFile(path.join(SCHEMAS_DIR, 'complete-quest.tool.json'), 'utf8');
    const tool = JSON.parse(raw) as {
      strict: boolean;
      parameters: { properties: Record<string, unknown>; additionalProperties: boolean };
    };

    // Награду считает детерминированный движок на сервере. Появление здесь
    // xp/level/rank означало бы, что модель может назначить награду словами.
    expect(tool.strict).toBe(true);
    expect(tool.parameters.additionalProperties).toBe(false);
    for (const forbidden of ['xp', 'level', 'rank', 'user_id']) {
      expect(Object.keys(tool.parameters.properties)).not.toContain(forbidden);
    }
  });
});
