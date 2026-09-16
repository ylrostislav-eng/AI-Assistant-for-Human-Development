import { randomUUID } from 'node:crypto';

import type { CommandRequest } from '../../src/shared/commands/bus.ts';

/**
 * Сборка нормализованной команды для проверок шины.
 *
 * Шина получает команду уже разобранной: цель и ожидаемая версия вынесены из
 * нагрузки в отдельные поля (R1 в docs/15-backend-review.md). Здесь заполняются
 * те же умолчания, что подставляет маршрут для команды без цели и без
 * оптимистичной блокировки, — иначе каждая проверка повторяла бы четыре поля,
 * к которым она не имеет отношения.
 *
 * Проверки самого контракта конверта идут через HTTP в
 * `command-contract.test.ts`: здесь этот помощник их не заменяет.
 */
export function commandRequest(
  overrides: Partial<CommandRequest> & Pick<CommandRequest, 'userId' | 'kind'>,
): CommandRequest {
  return {
    commandId: randomUUID(),
    schemaVersion: 1,
    targetId: null,
    expectedVersion: null,
    dependsOnCommandId: null,
    payload: {},
    ...overrides,
  };
}
