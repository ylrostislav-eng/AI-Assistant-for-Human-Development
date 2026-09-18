import { ConfigError, type AiConfig } from '../../../config.ts';
import type { AiProvider } from '../provider.ts';
import { createHttpAiProvider, createFallbackAiProvider } from './http.ts';

/**
 * Выбор формата запроса и сборка цепочки провайдеров.
 *
 * Формат определяется семейством модели, а не настройкой. Настройка здесь была
 * бы ловушкой: перепутать её нельзя заметить глазами, потому что запрос
 * выглядит совершенно правильным, а ответ приходит неотличимый от сбоя
 * поставщика. 17 сентября модели Claude через OpenAI-совместимый вход отвечали
 * отказом в ту же секунду, когда родная форма отвечала успехом; на поиск
 * причины ушёл вечер (handoff 3.19 и 6.1).
 */

/** Семейства и их родной формат. Порядок проверки — по длине приставки. */
const FAMILIES: readonly (readonly [prefix: string, protocol: 'anthropic-messages' | 'openai-chat'])[] = [
  ['claude-', 'anthropic-messages'],
  ['gpt-', 'openai-chat'],
  ['codex-', 'openai-chat'],
];

export function protocolFor(model: string): 'anthropic-messages' | 'openai-chat' {
  const found = FAMILIES.find(([prefix]) => model.startsWith(prefix));
  if (found === undefined) {
    // Умолчание здесь означало бы, что новая модель незнакомого семейства
    // молча уедет не в тот вход и вернёт отказ, похожий на недоступность.
    // Отказ на запуске называет причину сразу.
    throw new ConfigError(
      `Неизвестное семейство модели: ${model}. Добавить его в FAMILIES, а не угадывать формат`,
    );
  }
  return found[1];
}

function familyOf(model: string): string {
  return FAMILIES.find(([prefix]) => model.startsWith(prefix))?.[0] ?? '';
}

/**
 * Провайдер по настройкам: основная модель, за ней запасная.
 *
 * Запасная обязана быть другого семейства. Смысл перебора — пережить отказ,
 * который убил основную; 17 сентября вся линия Claude лежала целиком, пока
 * модель другого семейства отвечала. Вторая модель того же семейства ляжет
 * вместе с первой и создаст только видимость запаса, за которую потом
 * заплатят доверием.
 */
export function buildAiProvider(config: AiConfig, model?: string): AiProvider {
  const primary = model ?? config.chatModel;
  const limits = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    // Ответ модели невелик, но ограничение нужно до чтения, а не после:
    // неограниченное тело съедает память раньше, чем мы поймём, что оно чужое.
    maxResponseBytes: 262_144,
  };

  const head = createHttpAiProvider({ ...limits, protocol: protocolFor(primary), model: primary });
  if (config.fallbackModel === null) {
    return head;
  }
  if (familyOf(config.fallbackModel) === familyOf(primary)) {
    throw new ConfigError(
      `Запасная модель ${config.fallbackModel} того же семейства, что основная ${primary}: ` +
        'такой запас падает вместе с основной моделью',
    );
  }

  return createFallbackAiProvider([
    head,
    createHttpAiProvider({
      ...limits,
      protocol: protocolFor(config.fallbackModel),
      model: config.fallbackModel,
    }),
  ]);
}
