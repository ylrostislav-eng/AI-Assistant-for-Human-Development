import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { commandKinds } from '../../src/modules/sync/routes.ts';
import {
  FORBIDDEN_TOOL_NAMES,
  findTool,
  toolCatalog,
} from '../../src/modules/ai/catalog.ts';

/**
 * Сверка каталога инструментов с контрактами.
 *
 * Каталог — это то, что видит модель. Инструмент без схемы означает аргументы
 * без проверки; схема без инструмента — описанную, но неработающую
 * возможность. Расхождение в любую сторону обнаруживается здесь, а не тогда,
 * когда модель предложит вызов, которого не существует.
 */

const TOOLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/schemas/tools',
);

const SUFFIX = '.tool.schema.json';

function schemaFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith(SUFFIX))
    .map((name) => name.slice(0, -SUFFIX.length))
    .sort();
}

describe('каталог инструментов', () => {
  it('совпадает со схемами в обе стороны', () => {
    const names = toolCatalog().map((tool) => tool.name).sort();
    expect(names).toEqual(schemaFiles());
  });

  it('у каждого инструмента закрытая схема аргументов', () => {
    for (const tool of toolCatalog()) {
      // Открытая схема означает, что лишнее поле молча пропадёт: модель
      // «передала» объём, а сервер о нём не узнал. Ровно эта тишина уже
      // ломала команды (R6 в docs/15-backend-review.md).
      expect(tool.parameters['additionalProperties'], tool.name).toBe(false);
      expect(tool.parameters['type'], tool.name).toBe('object');
    }
  });

  it('у каждого инструмента есть описание для модели', () => {
    for (const tool of toolCatalog()) {
      // Описание уходит в подсказку; пустое означает, что модель выбирает
      // инструмент по одному имени.
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });

  it('изменяющий инструмент опирается на существующий вид команды', () => {
    const kinds = new Set(commandKinds());
    for (const tool of toolCatalog()) {
      if (!tool.mutates) {
        continue;
      }
      // Инструмент не выполняет ничего сам: он собирает команды шины. Все
      // перечисленные виды обязаны быть зарегистрированы, иначе отказ вылезет
      // на живом ходе.
      expect(tool.commandKinds.length, tool.name).toBeGreaterThan(0);
      for (const kind of tool.commandKinds) {
        expect(kinds, `${tool.name} → ${kind}`).toContain(kind);
      }
    }
  });

  it('читающий инструмент не объявляет команд', () => {
    for (const tool of toolCatalog()) {
      if (tool.mutates) {
        continue;
      }
      expect(tool.commandKinds, tool.name).toEqual([]);
    }
  });

  it('ни один инструмент не трогает прогрессию', () => {
    // AGENTS.md запрещает add_xp, set_level, set_stat, set_rank, произвольный
    // SQL и произвольный HTTP. Награду считает только детерминированный
    // движок; инструмент с таким именем означал бы, что её начисляют словами.
    const names = new Set(toolCatalog().map((tool) => tool.name));
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(names).not.toContain(forbidden);
      expect(findTool(forbidden)).toBeUndefined();
    }
  });

  it('поиск инструмента не находит унаследованные имена', () => {
    // Поиск по обычному объекту вернул бы `constructor` как найденный
    // инструмент, и вместо отказа получилась бы внутренняя ошибка
    // (R6 в docs/15-backend-review.md).
    expect(findTool('constructor')).toBeUndefined();
    expect(findTool('toString')).toBeUndefined();
    expect(findTool('__proto__')).toBeUndefined();
  });
});
