import { describe, expect, it } from 'vitest';

import { commandKinds } from '../../src/modules/sync/routes.ts';
import { kindsWithSchema } from '../../src/shared/commands/payload-schemas.ts';

/**
 * Сверка реестра команд со схемами нагрузки.
 *
 * Расхождение замечают обычно потребители: команда без схемы принимает любую
 * нагрузку, а схема без команды описывает то, чего сервер не умеет. Ни то, ни
 * другое не видно ни в одном отдельном тесте — только в сравнении двух списков.
 */

describe('схемы нагрузки и реестр команд', () => {
  it('у каждой команды есть закрытая схема нагрузки и наоборот', () => {
    expect(kindsWithSchema()).toEqual(commandKinds());
  });

  it('список команд не пуст', () => {
    // Пустые списки совпали бы друг с другом и сверка прошла бы вхолостую.
    expect(commandKinds().length).toBeGreaterThan(0);
  });
});
