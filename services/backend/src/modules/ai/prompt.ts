import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Сборка подсказки и граница между указаниями и данными.
 *
 * Порядок частей: системная политика → схемы инструментов → факты сервера →
 * недоверенный текст последним (docs/05, раздел 11). Сама подсказка
 * безопасности не обеспечивает — её обеспечивают закрытые инструменты, проверка
 * владельца и отсутствие инструментов начисления. Но размытая граница делает
 * подмену бесплатной, поэтому она проведена явно и проверяется.
 */

export const PROMPT_VERSION = 'coach-1';

// От src/modules/ai до корня репозитория пять уровней.
const PROMPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/prompts/coach/v1.md',
);

const BODY = readFileSync(PROMPT_PATH, 'utf8');

export function systemPrompt(): string {
  // Версия идёт в текст, а не только в журнал: она должна быть видна и там,
  // где сохранён сам ход, иначе прошлый ответ не с чем сверить.
  return `Версия правил: ${PROMPT_VERSION}\n\n${BODY}`;
}

/**
 * Метка блока данных, выведенная из хода.
 *
 * Постоянная метка публична: её узнают из первого же ответа бота и повторят в
 * следующем сообщении, закрыв блок раньше времени. Выведенная из идентификатора
 * хода метка автору сообщения неизвестна — он пишет текст до того, как ход
 * существует.
 */
function nonceFor(turnId: string): string {
  return createHash('sha256').update(`prompt:${turnId}`, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Обрамление недоверенного текста.
 *
 * Угловые скобки из текста убираются в дополнение к неизвестной метке: метку
 * можно однажды случайно раскрыть в журнале или в ответе, и тогда остаётся
 * только это. Две независимые причины — потому что цена ошибки здесь не
 * «некрасивый ответ», а выполненное указание из чужого текста.
 *
 * Содержимое при этом сохраняется: вырезать подозрительные фразы значит
 * незаметно менять то, что написал человек.
 */
export function untrustedBlock(options: {
  readonly turnId: string;
  readonly source: string;
  readonly text: string;
}): string {
  const nonce = nonceFor(options.turnId);
  const safe = options.text.replaceAll('<<<', '‹‹‹').replaceAll('>>>', '›››');
  return [
    `<<<ДАННЫЕ ${options.source} ${nonce}>>>`,
    safe,
    `<<<КОНЕЦ ${nonce}>>>`,
  ].join('\n');
}
