import type { CommandReceiptSummary, ToolGateway } from './gateway.ts';
import { systemPrompt, untrustedBlock } from './prompt.ts';
import type { AiMessage, AiProvider, AiTurnResponse } from './provider.ts';

/**
 * Один ход разговора.
 *
 * Цикл обязан быть конечным по двум причинам сразу: модель, зациклившаяся на
 * инструментах, тратит деньги и время человека, а ход без предела изменений
 * способен перепахать день целиком. Пределы проверяются до выполнения, а не
 * после (docs/05, раздел 3).
 *
 * Возвращаются и текст модели, и квитанции шлюза. Это не дублирование: текст
 * показывают как есть, а «создано/выполнено» разрешено говорить только по
 * квитанции. Модель, написавшая «готово» без квитанции, соврала — и различить
 * это можно только здесь.
 */

export interface TurnLimits {
  /** Сколько раз разрешено обращаться к модели за один ход. */
  readonly maxRounds: number;
  /** Сколько вызовов инструментов разрешено выполнить за один ход. */
  readonly maxToolCalls: number;
}

const DEFAULT_LIMITS: TurnLimits = { maxRounds: 6, maxToolCalls: 12 };

/**
 * Неудавшийся вызов инструмента.
 *
 * Нужен не для журнала, а для ответа человеку: модель, чей вызов отказал, может
 * всё равно написать «готово». Квитанций при этом нет, и отличить «ничего не
 * просили» от «просили, но не вышло» без этого списка нечем.
 */
export interface TurnFailure {
  readonly tool: string;
  readonly status: 'rejected' | 'conflict' | 'not_found';
  readonly error: string;
}

export interface TurnResult {
  readonly text: string;
  readonly receipts: readonly CommandReceiptSummary[];
  readonly failures: readonly TurnFailure[];
  readonly rounds: number;
  /**
   * `budget_exhausted` отделён от `provider_error` намеренно: «предел исчерпан»
   * и «поставщик лежит» требуют от человека разного, а один текст на оба случая
   * заставляет ждать восстановления того, что и не ломалось.
   */
  readonly stopReason:
    | 'answered'
    | 'round_limit'
    | 'call_limit'
    | 'provider_error'
    | 'budget_exhausted';
}

export async function runTurn(options: {
  readonly provider: AiProvider;
  readonly gateway: ToolGateway;
  readonly turnId: string;
  readonly message: string;
  readonly source?: string;
  readonly limits?: Partial<TurnLimits>;
}): Promise<TurnResult> {
  const limits: TurnLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const system = systemPrompt();
  const messages: AiMessage[] = [
    {
      role: 'user',
      // Текст человека — данные, а не указания модели. Обрамление ставится
      // здесь, в единственном месте сборки хода: оставленное на усмотрение
      // вызывающего, оно будет забыто в первом же новом канале
      // (docs/05, раздел 11).
      content: untrustedBlock({
        turnId: options.turnId,
        source: options.source ?? 'сообщение человека',
        text: options.message,
      }),
    },
  ];

  const failures: TurnFailure[] = [];
  let rounds = 0;
  let executed = 0;
  let text = '';

  while (rounds < limits.maxRounds) {
    // Only provider failure is handled here. A previous command may already
    // be committed in its own transaction: return its receipt even if the
    // next model request fails. Do not retry the turn or show the old draft.
    const request = { system, messages, tools: options.gateway.definitions() };
    let response: AiTurnResponse;
    try {
      response = await options.provider.generateTurn(request);
    } catch {
      return { text: '', receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };
    }
    rounds += 1;
    text = response.text;

    if (response.toolCalls.length === 0) {
      return { text, receipts: options.gateway.receipts(), failures, rounds, stopReason: 'answered' };
    }

    messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

    for (const call of response.toolCalls) {
      if (executed >= limits.maxToolCalls) {
        // Возврат сразу, а не ещё один раунд: модели нечего добавить к ходу,
        // который уже упёрся в предел, а каждый лишний раунд — оплаченный
        // запрос.
        return { text, receipts: options.gateway.receipts(), failures, rounds, stopReason: 'call_limit' };
      }
      executed += 1;

      // Изменения строго по очереди: параллельный запуск двух отметок
      // выполнения дал бы две награды за одно действие (docs/05, раздел 3).
      const result = await options.gateway.invoke(call);
      if (result.status !== 'ok') {
        const error = result.content['error'];
        failures.push({
          tool: call.name,
          status: result.status,
          error: typeof error === 'string' ? error : result.status,
        });
      }
      messages.push({
        role: 'tool',
        callId: call.id,
        name: call.name,
        content: JSON.stringify(result.content),
      });
    }
  }

  return { text, receipts: options.gateway.receipts(), failures, rounds, stopReason: 'round_limit' };
}
