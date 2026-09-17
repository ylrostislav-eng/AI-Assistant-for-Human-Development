-- T-02a: приём обновлений Telegram.
--
-- Вебхук — отдельная граница доверия: сюда стучится не наш клиент, а Telegram,
-- и access-токена здесь нет. Обновление сохраняется до ответа, потому что
-- Telegram не повторяет то, что мы подтвердили успехом: ответ «принято» за
-- несохранённое обновление теряет его навсегда.
--
-- Дедупликация по паре «бот + номер обновления». Telegram повторяет доставку
-- при обрыве связи, и без этого одно нажатие кнопки сработало бы дважды. Номер
-- растёт в пределах бота, поэтому в ключ входит и бот: два бота на одной базе
-- иначе затирали бы обновления друг друга.
--
-- Отправитель хранится отдельным полем, вынутым из подписанного `from`, а не из
-- `chat.id`: в пересланном сообщении это разные люди, и перепутать их значит
-- выполнить чужую команду от имени владельца. Само пересланное содержимое —
-- данные, а не полномочия его автора.
--
-- Сырое тело хранится целиком и намеренно недолго: срок удержания ≤24 часов
-- после обработки (docs/14, раздел 4). Отдельного задания очистки пока нет —
-- это остаток T-02, и он записан как невыполненный, а не подразумевается.
--
-- Строка не принадлежит пользователю: на момент приёма он ещё не сопоставлен, и
-- сопоставлять его здесь нельзя — это работа обработчика. Поэтому политика
-- привязана к роли, а не к `app.user_id`.

CREATE TABLE telegram_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id TEXT NOT NULL,
  update_id BIGINT NOT NULL,
  payload JSONB NOT NULL,
  -- Вид обновления, если он нам знаком. NULL означает «Telegram прислал то,
  -- чего мы пока не умеем разбирать»: такое обновление всё равно сохраняется,
  -- потому что отбросить незнакомое значит молча потерять важное.
  kind TEXT,
  sender_telegram_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT telegram_updates_identity UNIQUE (bot_id, update_id),
  CONSTRAINT telegram_updates_sender_digits
    CHECK (sender_telegram_id IS NULL OR sender_telegram_id ~ '^[0-9]{1,20}$')
);

CREATE INDEX telegram_updates_unprocessed
  ON telegram_updates (received_at) WHERE processed_at IS NULL;

ALTER TABLE telegram_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY telegram_updates_runtime ON telegram_updates
  TO app_runtime USING (true) WITH CHECK (true);
CREATE POLICY telegram_updates_worker ON telegram_updates
  TO app_worker USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_updates TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_updates TO app_worker;
