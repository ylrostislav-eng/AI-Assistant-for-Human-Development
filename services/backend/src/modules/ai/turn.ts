import type { CommandReceiptSummary, ToolGateway } from './gateway.ts';
import { systemPrompt, untrustedBlock } from './prompt.ts';
import type { AiMessage, AiProvider } from './provider.ts';

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

export interface TurnResult {
  readonly text: string;
  readonly receipts: readonly CommandReceiptSummary[];
  readonly rounds: number;
  readonly stopReason: 'answered' | 'round_limit' | 'call_limit';
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

  let rounds = 0;
  let executed = 0;
  let text = '';

  while (rounds < limits.maxRounds) {
    const response = await options.provider.generateTurn({
      system,
      messages,
      tools: options.gateway.definitions(),
    });
    rounds += 1;
    text = response.text;

    if (response.toolCalls.length === 0) {
      return { text, receipts: options.gateway.receipts(), rounds, stopReason: 'answered' };
    }

    messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

    for (const call of response.toolCalls) {
      if (executed >= limits.maxToolCalls) {
        // Возврат сразу, а не ещё один раунд: модели нечего добавить к ходу,
        // который уже упёрся в предел, а каждый лишний раунд — оплаченный
        // запрос.
        return { text, receipts: options.gateway.receipts(), rounds, stopReason: 'call_limit' };
      }
      executed += 1;

      // Изменения строго по очереди: параллельный запуск двух отметок
      // выполнения дал бы две награды за одно действие (docs/05, раздел 3).
      const result = await options.gateway.invoke(call);
      messages.push({
        role: 'tool',
        callId: call.id,
        name: call.name,
        content: JSON.stringify(result.content),
      });
    }
  }

  return { text, receipts: options.gateway.receipts(), rounds, stopReason: 'round_limit' };
}
