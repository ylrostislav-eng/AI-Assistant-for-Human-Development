import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Каталог инструментов, которые видит модель.
 *
 * Схемы аргументов лежат в `packages/contracts/schemas/tools` рядом со схемами
 * команд: вторая копия на сервере разошлась бы с контрактом незаметно, и обе
 * стороны были бы уверены, что проверяют одно и то же.
 *
 * Описание инструмента берётся из той же схемы, а не из кода: описание уходит
 * в подсказку модели и является частью контракта. Разъехавшиеся описание и
 * схема — это инструмент, который делает не то, что обещает.
 *
 * Чтение синхронное и однократное при загрузке модуля: без контракта сервер
 * работать не должен, и падение на старте предпочтительнее отказа первого же
 * хода.
 */

// От src/modules/ai до корня репозитория пять уровней.
const TOOLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/contracts/schemas/tools',
);

const SUFFIX = '.tool.schema.json';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Меняет ли инструмент состояние. Изменения идут строго по очереди. */
  readonly mutates: boolean;
  /**
   * Виды команд шины, которые инструмент собирает. Сам он ничего не исполняет:
   * иначе появился бы второй путь изменения данных в обход контракта — ровно
   * то, что запрещено для бота (docs/14, раздел 4).
   */
  readonly commandKinds: readonly string[];
  /** Схема аргументов, закрытая: лишнее поле отвергается, а не теряется. */
  readonly parameters: Record<string, unknown>;
}

/**
 * Имена, которых не может быть.
 *
 * AGENTS.md запрещает инструменты начисления, произвольный SQL и произвольный
 * HTTP. Список нужен не для документации: он проверяется при загрузке, и файл
 * схемы с таким именем остановит сервер. Запрет, который держится только на
 * внимательности следующего автора, не запрет.
 */
export const FORBIDDEN_TOOL_NAMES: readonly string[] = [
  'add_xp',
  'set_level',
  'set_stat',
  'set_rank',
  'run_sql',
  'http_request',
];

/** Что каждый инструмент делает с состоянием. Читающий не собирает команд. */
const BEHAVIOUR = new Map<string, { mutates: boolean; commandKinds: readonly string[] }>([
  ['get_today_quests', { mutates: false, commandKinds: [] }],
  [
    'create_quest',
    // Два вида команд подряд: шаблон задания и его сегодняшний экземпляр.
    // Одной командой это не делается — шаблон переживает день, экземпляр нет.
    { mutates: true, commandKinds: ['create_quest_template', 'materialize_occurrence'] },
  ],
  ['complete_quest', { mutates: true, commandKinds: ['complete_quest'] }],
]);

function load(): Map<string, ToolDefinition> {
  const files = readdirSync(TOOLS_DIR).filter((name) => name.endsWith(SUFFIX)).sort();
  const catalog = new Map<string, ToolDefinition>();

  for (const file of files) {
    const name = file.slice(0, -SUFFIX.length);
    if (FORBIDDEN_TOOL_NAMES.includes(name)) {
      throw new Error(`Инструмент ${name} запрещён: награду считает движок прогрессии`);
    }
    const schema = JSON.parse(readFileSync(path.join(TOOLS_DIR, file), 'utf8')) as Record<
      string,
      unknown
    >;
    const behaviour = BEHAVIOUR.get(name);
    if (behaviour === undefined) {
      // Схема без описанного поведения — это инструмент, о котором сервер не
      // знает, изменяет он что-нибудь или нет. Догадка здесь означала бы, что
      // изменение пройдёт как чтение.
      throw new Error(`Для инструмента ${name} не описано поведение в каталоге`);
    }
    const description = schema['description'];
    if (typeof description !== 'string') {
      throw new Error(`У инструмента ${name} нет описания для модели`);
    }
    catalog.set(name, {
      name,
      description,
      mutates: behaviour.mutates,
      commandKinds: behaviour.commandKinds,
      parameters: schema,
    });
  }

  for (const name of BEHAVIOUR.keys()) {
    if (!catalog.has(name)) {
      throw new Error(`Для инструмента ${name} нет схемы аргументов`);
    }
  }
  return catalog;
}

const CATALOG = load();

export function toolCatalog(): readonly ToolDefinition[] {
  return [...CATALOG.values()];
}

/**
 * Поиск инструмента. Map, а не обычный объект: поиск по объекту находит
 * унаследованные имена вроде `constructor`, и вместо отказа получается
 * внутренняя ошибка (R6 в docs/15-backend-review.md).
 */
export function findTool(name: string): ToolDefinition | undefined {
  return CATALOG.get(name);
}
