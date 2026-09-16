import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Загрузка `.env`.
 *
 * `ops/env.example` предлагает скопировать файл в `.env`, но читать его было
 * некому: конфигурация бралась только из окружения процесса. Человек клал туда
 * значение и считал его заданным, а приложение его не видело — ровно тот
 * молчаливый разрыв, от которого защищает остальной код.
 *
 * Переменные окружения имеют приоритет над файлом: `process.loadEnvFile` не
 * перезаписывает уже заданные. Это важно для команд вида
 * `DATABASE_URL=... npm run migrate` — иначе файл молча увёл бы миграцию в
 * другую базу.
 *
 * Вызывается в начале точки входа, а не при импорте модуля: импорты в ESM
 * поднимаются наверх, и «первая строка файла» ничего не гарантирует.
 *
 * Отдельная зависимость не нужна: `process.loadEnvFile` есть в Node 22.
 */

// От src/shared/config до корня репозитория пять уровней.
const REPO_ROOT_ENV = path.resolve(import.meta.dirname, '../../../../../.env');

export function loadEnvFile(): void {
  for (const candidate of [path.resolve(process.cwd(), '.env'), REPO_ROOT_ENV]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
