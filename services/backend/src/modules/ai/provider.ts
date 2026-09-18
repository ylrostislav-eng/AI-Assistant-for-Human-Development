import type { ToolDefinition } from './catalog.ts';

/**
 * Граница с поставщиком модели.
 *
 * Domain не знает ни об одном конкретном поставщике: модель — настройка, а не
 * встроенное решение. Шлюз, через который куплен доступ, может исчезнуть,
 * подорожать или начать отвечать иначе; переезд не должен переписывать слой
 * инструментов (docs/05, раздел 2).
 *
 * Поток ответа здесь не описан намеренно. Первому каналу — боту — он не нужен:
 * отдельное сообщение Telegram на каждый кусочек текста отправлять нельзя
 * (docs/14, раздел 12). Mini App с постепенным выводом получит отдельный метод,
 * когда появится; выдуманный сейчас интерфейс потока проверить нечем.
 */

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Разобранные аргументы. Частичный JSON сюда не попадает: неполный объект не исполняется. */
  readonly arguments: unknown;
}

export type AiMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly callId: string; readonly name: string; readonly content: string };

export interface AiTurnRequest {
  readonly system: string;
  readonly messages: readonly AiMessage[];
  readonly tools: readonly ToolDefinition[];
}

export interface AiTurnResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  /** Input includes cached tokens. Counts are not prices or a spending limit. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface AiProvider {
  readonly name: string;
  generateTurn(request: AiTurnRequest): Promise<AiTurnResponse>;
}
