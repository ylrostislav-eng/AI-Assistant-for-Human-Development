import { findTool } from './catalog.ts';
import { PROMPT_VERSION } from './prompt.ts';
import type { AiMessage, AiTurnRequest } from './provider.ts';

/**
 * Что разрешено покидать сервер (T-04b-2).
 *
 * Оператору шлюза видно всё, что уходит модели, а это личный дневник развития.
 * Обещание «не отправляем лишнего» без проверки не стоит ничего: оно верно
 * ровно до первого нового поля, которое кто-то добавит в ответ инструмента, не
 * подумав, куда это поле поедет.
 *
 * Поэтому политика устроена запретом по умолчанию. Перечислять «что нельзя»
 * бессмысленно — заранее этого не знает никто; перечисляется, что можно, а всё
 * остальное останавливает отправку.
 *
 * Проверка стоит в транспорте, у самого выхода, а не в шлюзе инструментов: так
 * она срабатывает на каждом раунде и на каждом поставщике в цепочке запасных,
 * включая те пути, которые появятся позже и про политику знать не будут.
 */

export const EGRESS_POLICY_VERSION = 'egress-1';

/** Отказ отправки. Содержимого в нём нет — только имя поля и причина. */
export class EgressPolicyError extends Error {
  constructor(reason: string) {
    super(`Исходящие данные не прошли политику ${EGRESS_POLICY_VERSION}: ${reason}`);
    this.name = 'EgressPolicyError';
  }
}

/**
 * Разрешённые поля в результатах инструментов.
 *
 * Список плоский: вложенность у наших результатов одна, и раскрывать его в
 * дерево значило бы усложнить ровно то место, которое должно быть очевидным.
 */
const ALLOWED_RESULT_KEYS = new Set([
  // Чтение заданий.
  'quests',
  'ref',
  'title',
  'status',
  // Итог изменения.
  'execution_status',
  // Отказы: код, пояснение и подсказка модели — всё наше, не пользовательское.
  'error',
  'detail',
  'hint',
]);

/**
 * Идентификаторы наружу не уходят.
 *
 * Модель, увидевшая идентификатор, способна повторить его там, где не должна, а
 * посреднику он даёт возможность связывать записи между собой. Ссылки вида `q1`
 * существуют ровно затем, чтобы идентификаторы оставались внутри (ADR-017).
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/** Метки обрамления недоверенного текста. Без них сообщение не отправляется. */
const UNTRUSTED_OPEN = /<<<ДАННЫЕ .+ [0-9a-f]{12}>>>/u;
const UNTRUSTED_CLOSE = /<<<КОНЕЦ [0-9a-f]{12}>>>/u;

function checkValue(key: string, value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (UUID.test(value)) {
      throw new EgressPolicyError(`поле ${path} содержит идентификатор`);
    }
    return;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      checkValue(key, item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value === 'object') {
    checkObject(value as Record<string, unknown>, path);
    return;
  }
  throw new EgressPolicyError(`поле ${path} имеет неподдерживаемый тип`);
}

function checkObject(value: Record<string, unknown>, path: string): void {
  for (const [key, nested] of Object.entries(value)) {
    if (!ALLOWED_RESULT_KEYS.has(key)) {
      // Имя поля названо, содержимое — нет: отказ попадёт в журнал, и
      // пересказать в нём то, что мы отказались отправлять, значит вынести это
      // в другое место вместо шлюза.
      throw new EgressPolicyError(`поле ${path === '' ? key : `${path}.${key}`} не разрешено`);
    }
    checkValue(key, nested, path === '' ? key : `${path}.${key}`);
  }
}

function checkToolMessage(message: Extract<AiMessage, { role: 'tool' }>): void {
  if (findTool(message.name) === undefined) {
    throw new EgressPolicyError(`результат неизвестного инструмента ${message.name}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content) as unknown;
  } catch {
    // Нечитаемое содержимое не проверить, а значит и отправлять нечего:
    // «наверное, там ничего страшного» — это и есть отсутствие политики.
    throw new EgressPolicyError(`результат инструмента ${message.name} не разбирается`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EgressPolicyError(`результат инструмента ${message.name} не является объектом`);
  }
  checkObject(parsed as Record<string, unknown>, '');
}

/**
 * Проверка перед отправкой.
 *
 * Системная часть должна быть нашей, текст человека — обрамлённым, результаты
 * инструментов — из разрешённого списка. Всё остальное останавливает запрос до
 * того, как он уйдёт.
 */
export function assertOutboundAllowed(request: AiTurnRequest): void {
  if (!request.system.startsWith(`Версия правил: ${PROMPT_VERSION}`)) {
    // Подменённая системная часть — это и есть обход всех остальных правил.
    throw new EgressPolicyError('системная часть не является подсказкой этой версии');
  }

  for (const [index, message] of request.messages.entries()) {
    if (message.role === 'user') {
      if (!UNTRUSTED_OPEN.test(message.content) || !UNTRUSTED_CLOSE.test(message.content)) {
        // Обрамление — граница между данными и указаниями. Сообщение, ушедшее
        // без неё, уже не отличить от системной инструкции.
        throw new EgressPolicyError(`сообщение ${index} отправляется без обрамления данных`);
      }
      continue;
    }
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) {
        if (findTool(call.name) === undefined) {
          throw new EgressPolicyError(`вызов неизвестного инструмента ${call.name}`);
        }
      }
      continue;
    }
    checkToolMessage(message);
  }
}
