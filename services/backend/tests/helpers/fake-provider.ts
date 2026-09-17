import type {
  AiProvider,
  AiTurnRequest,
  AiTurnResponse,
} from '../../src/modules/ai/provider.ts';

/**
 * Подставная модель.
 *
 * Проверки слоя инструментов не должны зависеть ни от сети, ни от денег, ни от
 * настроения живой модели: иначе они перестают запускаться, а вместе с ними
 * перестают проверяться границы, ради которых слой и написан.
 *
 * Ответы задаются заранее по одному на раунд. Запрошенный сверх сценария
 * раунд — это ошибка проверки, а не молчаливый пустой ответ: цикл, ушедший на
 * лишний круг, должен быть виден.
 */
export function scriptedProvider(
  script: readonly AiTurnResponse[],
): AiProvider & { readonly requests: AiTurnRequest[] } {
  const requests: AiTurnRequest[] = [];
  return {
    name: 'подставная',
    requests,
    async generateTurn(request: AiTurnRequest): Promise<AiTurnResponse> {
      const response = script[requests.length];
      requests.push(request);
      if (response === undefined) {
        throw new Error(`Модель запрошена ${requests.length} раз, сценарий короче`);
      }
      return response;
    },
  };
}
