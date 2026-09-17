import { createHash } from 'node:crypto';

/**
 * Идентификатор команды, выведенный из повода, а не случайный.
 *
 * Команда выполняется своей транзакцией. Если внешняя работа (пометить
 * обновление разобранным, сохранить ход) упадёт после неё, повод разберётся
 * второй раз. Со случайным идентификатором это создало бы второй объект; с
 * выведенным шина узнаёт повтор и вернёт прежнюю квитанцию.
 *
 * Форма — UUID версии 4 по битам: колонки объявлены UUID, и любое другое
 * значение туда просто не запишется.
 */
export function derivedCommandId(...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join(':'), 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
