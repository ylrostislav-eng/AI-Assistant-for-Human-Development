import * as ajvFormatsModule from 'ajv-formats';
import * as ajvModule from 'ajv/dist/2020.js';

/**
 * Один настроенный валидатор на весь сервер.
 *
 * Схемы контрактов написаны в JSON Schema 2020-12, а встроенный валидатор
 * Fastify настроен на draft-07 и молча проигнорировал бы часть ключевых слов:
 * закрытая схема выглядела бы применённой, ничего не проверяя.
 *
 * Настройки продублировались бы, если бы конверт и нагрузки собирали свои
 * экземпляры: разойтись достаточно одному флагу. Особенно `coerceTypes`:
 * с приведением типов строка "5" прошла бы как число, и закрытость схемы
 * перестала бы что-либо значить.
 */

/**
 * Ошибка ajv в том виде, в каком её ждёт Fastify: сокращённая форма не подошла
 * бы как валидатор маршрутов, а два разных описания одной ошибки разъехались бы.
 */
export interface ValidationFailure {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly params: Record<string, unknown>;
  readonly message: string;
}

export interface CompiledSchema {
  (data: unknown): boolean;
  errors?: ValidationFailure[] | null;
}

export interface SchemaValidator {
  addSchema(schema: object): void;
  compile(schema: object): CompiledSchema;
}

const Ajv2020 = (ajvModule as unknown as { default: new (options?: object) => SchemaValidator })
  .default;
const addFormats = (ajvFormatsModule as unknown as { default: (ajv: SchemaValidator) => void })
  .default;

export function createValidator(): SchemaValidator {
  const ajv = new Ajv2020({ strict: false, allErrors: false, coerceTypes: false });
  addFormats(ajv);
  return ajv;
}

/** Первая ошибка в виде, пригодном для ответа клиенту, без внутренних деталей. */
export function describeFailure(errors: ValidationFailure[] | null | undefined): string {
  const first = errors?.[0];
  if (first === undefined) {
    return 'нагрузка не соответствует схеме';
  }
  const where = first.instancePath === '' ? 'нагрузка' : first.instancePath;
  return `${where}: ${first.message}`;
}
