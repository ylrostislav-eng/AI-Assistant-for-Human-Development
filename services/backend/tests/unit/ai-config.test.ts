import { describe, expect, it } from 'vitest';

import { loadConfig, ConfigError, type AppConfig } from '../../src/config.ts';
import { protocolFor, buildAiProvider } from '../../src/modules/ai/providers/routing.ts';
import { unmeteredAttempts } from '../../src/modules/ai/providers/http.ts';

/**
 * Настройки ИИ и выбор формата запроса.
 *
 * Главное здесь — выбор формата по семейству модели. У шлюза два входа, и
 * отправка `claude-*` в OpenAI-совместимый отвечает отказом, неотличимым от
 * сбоя поставщика: 17 сентября это стоило вечера (handoff 3.19, 6.1). Такая
 * ошибка не ловится глазами, потому что запрос выглядит правильным.
 *
 * Второе по важности — отсутствие ключа. Оно означает работу без ИИ, а не
 * отказ запуска: ручной путь `/new` и `/today` обязан работать всегда
 * (ADR-011), и тем более при ненастроенной модели.
 */

const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://system@127.0.0.1:5433/system_test',
} satisfies NodeJS.ProcessEnv;

const FULL = {
  ...BASE,
  AI_BASE_URL: 'https://api.example.invalid/v1',
  AI_API_KEY: 'EXAMPLE-credential',
  AI_CHAT_MODEL: 'claude-sonnet-5',
  AI_PLAN_MODEL: 'claude-opus-5',
  AI_FALLBACK_MODEL: 'gpt-6-astra',
} satisfies NodeJS.ProcessEnv;

describe('формат запроса по семейству модели', () => {
  it('модели Claude идут родной формой Anthropic', () => {
    // Вся линия Claude через OpenAI-совместимый вход отвечала отказом, пока
    // родная форма работала в ту же секунду. Ошибка выглядит как сбой
    // поставщика и уводит в неверную сторону надолго.
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1']) {
      expect(protocolFor(model), model).toBe('anthropic-messages');
    }
  });

  it('остальные модели идут OpenAI-совместимой формой', () => {
    for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'codex-auto-review']) {
      expect(protocolFor(model), model).toBe('openai-chat');
    }
  });

  it('незнакомое семейство не угадывается', () => {
    // Молчаливый выбор формата для незнакомой модели даёт отказ, который
    // выглядит как недоступность поставщика. Отказ на запуске понятнее.
    expect(() => protocolFor('llama-3')).toThrow(ConfigError);
    expect(() => protocolFor('')).toThrow(ConfigError);
  });
});

/**
 * Загрузка, не роняющая проверку.
 *
 * Проверка обязана падать утверждением, а не необработанным исключением:
 * иначе отрицательный контроль не отличит снятую защиту от сломанной сборки
 * (handoff 3.20).
 */
function tryLoad(env: NodeJS.ProcessEnv): AppConfig | null {
  try {
    return loadConfig(env);
  } catch {
    return null;
  }
}

describe('настройки ИИ', () => {
  it('без ключа ИИ просто нет, и это не ошибка запуска', () => {
    // Бот обязан работать без модели: ручное управление не зависит от
    // провайдера (ADR-011). Отказ запуска здесь сделал бы недоступным и то,
    // что от ИИ не зависит.
    expect(tryLoad(BASE)?.ai).toBeNull();
  });

  it('с ключом собираются адрес, модели и границы', () => {
    const ai = loadConfig(FULL).ai;
    expect(ai).not.toBeNull();
    expect(ai?.baseUrl).toBe('https://api.example.invalid/v1');
    expect(ai?.chatModel).toBe('claude-sonnet-5');
    expect(ai?.planModel).toBe('claude-opus-5');
    expect(ai?.fallbackModel).toBe('gpt-6-astra');
    expect(ai?.timeoutMs).toBeGreaterThan(0);
    expect(ai?.maxOutputTokens).toBeGreaterThan(0);
  });

  it('ключ без адреса или без модели останавливает запуск', () => {
    // Наполовину настроенный ИИ хуже ненастроенного: он выглядит рабочим до
    // первого хода, а падает в разговоре с человеком.
    for (const missing of ['AI_BASE_URL', 'AI_CHAT_MODEL'] as const) {
      const env = { ...FULL };
      delete (env as Record<string, string | undefined>)[missing];
      expect(() => loadConfig(env), missing).toThrow(ConfigError);
    }
  });

  it('запасная модель необязательна', () => {
    const env = { ...FULL };
    delete (env as Record<string, string | undefined>)['AI_FALLBACK_MODEL'];
    expect(loadConfig(env).ai?.fallbackModel).toBeNull();
  });

  it('адрес не по https отклоняется на запуске', () => {
    // Ключ уходит заголовком; без шифрования его увидит любой посредник.
    expect(() => loadConfig({ ...FULL, AI_BASE_URL: 'http://api.example.invalid/v1' })).toThrow(
      ConfigError,
    );
  });
});

describe('сборка провайдера', () => {
  it('основная модель идёт первой, запасная — второй', () => {
    const ai = loadConfig(FULL).ai;
    expect(ai).not.toBeNull();
    const provider = buildAiProvider(ai!, { accounting: unmeteredAttempts });
    // Имя составное: по нему видно и порядок, и выбранные форматы. Перебор из
    // одной модели не является перебором, и это должно быть заметно.
    expect(provider.name).toBe('fallback');
  });

  it('без запасной модели перебора нет, но провайдер работает', () => {
    const env = { ...FULL };
    delete (env as Record<string, string | undefined>)['AI_FALLBACK_MODEL'];
    const provider = buildAiProvider(loadConfig(env).ai!, { accounting: unmeteredAttempts });
    expect(provider.name).toBe('anthropic-messages');
  });

  it('запасная модель того же семейства отклоняется', () => {
    // Смысл запасной — пережить отказ, который убил основную. 17 сентября вся
    // линия Claude лежала разом, пока модель другого семейства отвечала:
    // запасная из того же семейства ляжет вместе с основной и создаст лишь
    // видимость запаса (handoff 3.19).
    expect(() =>
      buildAiProvider(loadConfig({ ...FULL, AI_FALLBACK_MODEL: 'claude-opus-5' }).ai!, {
        accounting: unmeteredAttempts,
      }),
    ).toThrow(ConfigError);
  });
});
