# НАБРОСОК, НЕ ПРОВЕРЕН СБОРКОЙ: в среде разработки не было демона Docker.
# Перед использованием собрать образ и исправить найденное; см. ops/README.md.

# Версия совпадает с .nvmrc и полем engines в package.json. Расхождение здесь
# означало бы, что проверки идут на одной версии, а продукт работает на другой.
FROM node:22.22.2-bookworm-slim

WORKDIR /app

# Зависимости ставятся отдельным слоем: пересборка при правке исходников не
# должна тянуть повторную установку пакетов.
COPY package.json package-lock.json ./
COPY services/backend/package.json ./services/backend/
RUN npm ci

COPY services ./services

ENV NODE_ENV=production
EXPOSE 3000

# Запуск не под root: процесс в контейнере не должен иметь прав, которые ему
# не нужны. Образ node содержит пользователя node.
USER node

# tsx, а не собранный dist: сборка tsc в проекте не настроена и эмиссия
# TypeScript 7 не проверялась (docs/toolchain.md). Когда появится сборка,
# заменить на запуск скомпилированного кода.
CMD ["npm", "run", "start", "--workspace", "services/backend"]
