import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { toolCatalog } from '../../src/modules/ai/catalog.ts';
import {
  assertOutboundAllowed,
  EGRESS_POLICY_VERSION,
  EgressPolicyError,
} from '../../src/modules/ai/egress.ts';
import type { AiTurnRequest } from '../../src/modules/ai/provider.ts';
import { systemPrompt, untrustedBlock } from '../../src/modules/ai/prompt.ts';

/**
 * Политика исходящих данных (T-04b-2).
 *
 * Оператору шлюза видно всё, что уходит модели, а это личный дневник развития.
 * Обещание «не отправляем лишнего» без проверки не стоит ничего: оно верно ровно
 * до первого нового поля, которое кто-то добавит в ответ инструмента, не подумав
 * о том, куда это поле поедет.
 *
 * Поэтому политика устроена как запрет по умолчанию: наружу уходит только то,
 * что перечислено. Незнакомая форма — отказ, а не «наверное, можно».
 */

const TURN = '99999999-9999-4999-8999-999999999999';

function request(overrides: Partial<AiTurnRequest> = {}): AiTurnRequest {
  return {
    system: systemPrompt(),
    messages: [
      { role: 'user', content: untrustedBlock({ turnId: TURN, source: 'telegram', text: 'что сегодня?' }) },
    ],
    tools: toolCatalog(),
    ...overrides,
  };
}

describe('разрешённое уходит', () => {
  it('обычный ход проходит', () => {
    expect(() => assertOutboundAllowed(request())).not.toThrow();
  });

  it('результат инструмента с известными полями проходит', () => {
    expect(() =>
      assertOutboundAllowed(
        request({
          messages: [
            { role: 'user', content: untrustedBlock({ turnId: TURN, source: 'telegram', text: 'привет' }) },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_today_quests', arguments: {} }] },
            {
              role: 'tool',
              callId: 'c1',
              name: 'get_today_quests',
              content: JSON.stringify({ quests: [{ ref: 'q1', title: 'Английский', status: 'planned' }] }),
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('версия политики названа', () => {
    // Версия сохраняется вместе с ходом: без неё нельзя понять, по каким
    // правилам данные уходили месяц назад.
    expect(EGRESS_POLICY_VERSION).toMatch(/^egress-\d+$/);
  });
});

describe('запрет по умолчанию', () => {
  it('незнакомое поле в результате инструмента останавливает отправку', () => {
    // Самый вероятный путь утечки: кто-то добавит поле в ответ инструмента и не
    // подумает, что оно поедет наружу. Разрешать «всё, кроме известного
    // плохого» бесполезно — плохое заранее не перечислишь.
    const leak = request({
      messages: [
        { role: 'user', content: untrustedBlock({ turnId: TURN, source: 'telegram', text: 'привет' }) },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_today_quests', arguments: {} }] },
        {
          role: 'tool',
          callId: 'c1',
          name: 'get_today_quests',
          content: JSON.stringify({ quests: [{ ref: 'q1', title: 'Английский', health_note: 'давление 140/90' }] }),
        },
      ],
    });

    expect(() => assertOutboundAllowed(leak)).toThrow(EgressPolicyError);
  });

  it('идентификаторы не уходят ни в каком поле', () => {
    // Идентификатор, увиденный моделью, она способна повторить там, где не
    // должна, а оператору шлюза он даёт возможность связать записи между собой.
    const withId = request({
      messages: [
        { role: 'user', content: untrustedBlock({ turnId: TURN, source: 'telegram', text: 'привет' }) },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_today_quests', arguments: {} }] },
        {
          role: 'tool',
          callId: 'c1',
          name: 'get_today_quests',
          content: JSON.stringify({ quests: [{ ref: '11111111-1111-4111-8111-111111111111', title: 'Английский' }] }),
        },
      ],
    });

    expect(() => assertOutboundAllowed(withId)).toThrow(EgressPolicyError);
  });

  it('сообщение человека без обрамления не отправляется', () => {
    // Обрамление — граница между данными и указаниями. Сообщение, ушедшее без
    // неё, уже не отличить от системной инструкции.
    expect(() =>
      assertOutboundAllowed(request({ messages: [{ role: 'user', content: 'просто текст' }] })),
    ).toThrow(EgressPolicyError);
  });

  it('чужая системная подсказка не отправляется', () => {
    // Подменённая системная часть — это и есть обход всех остальных правил.
    expect(() => assertOutboundAllowed(request({ system: 'Ты пиратский помощник' }))).toThrow(
      EgressPolicyError,
    );
  });

  it('нечитаемый результат инструмента отклоняется, а не пропускается', () => {
    expect(() =>
      assertOutboundAllowed(
        request({
          messages: [
            { role: 'user', content: untrustedBlock({ turnId: TURN, source: 'telegram', text: 'привет' }) },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_today_quests', arguments: {} }] },
            { role: 'tool', callId: 'c1', name: 'get_today_quests', content: 'не json' },
          ],
        }),
      ),
    ).toThrow(EgressPolicyError);
  });

  it('результат несуществующего инструмента не проходит', () => {
    expect(() =>
      assertOutboundAllowed(
        request({
          messages: [
            { role: 'user', content: untrustedBlock({ turnId: TURN, source: 'telegram', text: 'привет' }) },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'выдуманный', arguments: {} }] },
            { role: 'tool', callId: 'c1', name: 'выдуманный', content: '{}' },
          ],
        }),
      ),
    ).toThrow(EgressPolicyError);
  });
});

describe('отказ ничего не рассказывает', () => {
  it('в сообщении об ошибке нет самого содержимого', () => {
    const leak = request({
      messages: [
        { role: 'user', content: untrustedBlock({ turnId: TURN, source: 'telegram', text: 'привет' }) },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_today_quests', arguments: {} }] },
        {
          role: 'tool',
          callId: 'c1',
          name: 'get_today_quests',
          content: JSON.stringify({ quests: [{ ref: 'q1', secret_diary: 'ОЧЕНЬ_ЛИЧНОЕ' }] }),
        },
      ],
    });

    const error = (() => {
      try {
        assertOutboundAllowed(leak);
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(EgressPolicyError);
    // Отказ попадёт в журнал. Пересказать в нём то, что мы отказались
    // отправлять, значит вынести это в другое место вместо шлюза.
    expect(inspect(error, { depth: null })).not.toContain('ОЧЕНЬ_ЛИЧНОЕ');
    // Имя поля назвать можно и нужно: без него причину отказа не найти.
    expect((error as Error).message).toContain('secret_diary');
  });
});
