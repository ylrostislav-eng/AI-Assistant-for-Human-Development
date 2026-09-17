/**
 * Разбор однострочной команды `/new` (T-02d).
 *
 * Формат намеренно однострочный: диалог в несколько шагов требует хранить
 * состояние разговора на сервере, а это отдельная машинка со своими ошибками.
 * Для первого способа создать задание честнее без неё.
 *
 * Мера — последнее слово строки. Всё до неё — название ровно в том виде, как
 * человек его написал: он будет искать свои слова глазами в списке, и
 * переписывать их за него нельзя.
 */

export interface EffortSpec {
  readonly success_rule: 'duration' | 'amount';
  readonly unit: string;
  readonly duration_seconds?: number;
  readonly amount?: number;
}

export type ParsedNewQuest =
  | { readonly ok: true; readonly title: string; readonly spec: EffortSpec }
  | { readonly ok: false; readonly hint: string };

const MAX_TITLE_LENGTH = 200;

/** Сутки в одном задании — почти наверняка опечатка, а не намерение. */
const MAX_DURATION_SECONDS = 12 * 3600;
const MAX_AMOUNT = 100_000;

const USAGE = [
  'Не разобрал. Формат такой:',
  '',
  '/new Английский 30м',
  '/new Бег 5км',
  '',
  'Последнее слово — мера: время (30м, 1ч30м) или объём с единицей (5км, 20страниц).',
].join('\n');

function refuse(): ParsedNewQuest {
  return { ok: false, hint: USAGE };
}

/** Длительность вида `30м`, `1ч`, `1ч30м`, `45m`, `2h`. */
function parseDuration(token: string): number | null {
  const match = /^(?:(\d+)\s*(?:ч|h))?(?:(\d+)\s*(?:мин|м|min|m))?$/iu.exec(token);
  if (match === null) {
    return null;
  }
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours === 0 && minutes === 0) {
    return null;
  }
  return hours * 3600 + minutes * 60;
}

/** Объём вида `5км`, `7.5км`, `20pages`. */
function parseAmount(token: string): { amount: number; unit: string } | null {
  const match = /^(\d+(?:[.,]\d+)?)\s*([\p{L}]{1,20})$/u.exec(token);
  if (match === null) {
    return null;
  }
  const amount = Number((match[1] as string).replace(',', '.'));
  const unit = match[2] as string;
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return { amount, unit };
}

export function parseNewQuest(line: string): ParsedNewQuest {
  const withoutCommand = line.trim().replace(/^\/new(?:@\S+)?\s*/iu, '');
  const words = withoutCommand.split(/\s+/u).filter((word) => word !== '');

  // Нужны хотя бы название и мера: одно слово — это либо забытая мера, либо
  // забытое название, и угадывать, что именно, нельзя.
  if (words.length < 2) {
    return refuse();
  }

  const measure = words[words.length - 1] as string;
  const title = words.slice(0, -1).join(' ');

  if (title.length > MAX_TITLE_LENGTH) {
    return refuse();
  }

  const seconds = parseDuration(measure);
  if (seconds !== null) {
    if (seconds > MAX_DURATION_SECONDS) {
      return refuse();
    }
    return {
      ok: true,
      title,
      spec: { success_rule: 'duration', unit: 'seconds', duration_seconds: seconds },
    };
  }

  const amount = parseAmount(measure);
  if (amount !== null) {
    if (amount.amount > MAX_AMOUNT) {
      return refuse();
    }
    return {
      ok: true,
      title,
      spec: { success_rule: 'amount', unit: amount.unit, amount: amount.amount },
    };
  }

  return refuse();
}
