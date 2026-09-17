-- T-02b: очередь исходящих сообщений и срок хранения сырых тел.
--
-- Ответ бота не отправляется сразу и не живёт в памяти процесса. Таймаут
-- запроса к Telegram может означать уже доставленное сообщение: без отдельной
-- записи о намерении неизвестный исход не отличить от неотправленного, и
-- повторная попытка рассылает одно и то же (docs/01, раздел 6, пункт 6).
--
-- Состояния: pending — решили сказать; sending — запрос начат, исход неизвестен;
-- sent — Telegram подтвердил и вернул message_id; unknown — запрос оборвался, и
-- доставка не подтверждена и не опровергнута; failed — Telegram отказал
-- окончательно. Различение sent и unknown и есть смысл этой таблицы: unknown
-- не повторяется вслепую.
--
-- dedupe_key выводится из обновления, которое породило ответ. Повторный разбор
-- не создаст второго сообщения, даже если пометка обработки не успела
-- записаться: человек не должен получать два ответа за одно своё действие.

CREATE TABLE telegram_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Пусто, если отвечаем тому, у кого аккаунта нет и не будет: чужому
  -- отправителю тоже нужно ответить, но заводить ему аккаунт нельзя.
  user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  telegram_message_id BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telegram_messages_state_known
    CHECK (state IN ('pending', 'sending', 'sent', 'unknown', 'failed')),
  CONSTRAINT telegram_messages_chat_digits CHECK (chat_id ~ '^-?[0-9]{1,20}$'),
  CONSTRAINT telegram_messages_attempts_non_negative CHECK (attempts >= 0),
  -- Подтверждённая доставка обязана нести идентификатор сообщения: без него
  -- нечего редактировать и не на что ссылаться.
  CONSTRAINT telegram_messages_sent_has_id
    CHECK (state <> 'sent' OR telegram_message_id IS NOT NULL)
);

CREATE INDEX telegram_messages_queue ON telegram_messages (created_at)
  WHERE state IN ('pending', 'unknown');

ALTER TABLE telegram_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_messages FORCE ROW LEVEL SECURITY;
-- Строка может не принадлежать никому (ответ чужому отправителю), поэтому
-- политика привязана к ролям, а не к `app.user_id`.
CREATE POLICY telegram_messages_runtime ON telegram_messages
  TO app_runtime USING (true) WITH CHECK (true);
CREATE POLICY telegram_messages_worker ON telegram_messages
  TO app_worker USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON telegram_messages TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON telegram_messages TO app_worker;

-- Сырое тело обновления — личная переписка. Оно нужно до обработки и недолго
-- после неё, на разбор поломки; хранить дольше незачем. Метаданные
-- дедупликации остаются: без них старое обновление, доставленное повторно,
-- сработает второй раз.
ALTER TABLE telegram_updates ADD COLUMN payload_purged_at TIMESTAMPTZ;

-- Разбор обновлений идёт под ролью worker, а сопоставление личности живёт в
-- функции с правами владельца: до разбора неизвестно, чей это отправитель, и
-- политика изоляции его строку не показывает. Функция по-прежнему узкая —
-- принимает только subject и возвращает один UUID, — поэтому выдать право на
-- неё второй роли безопаснее, чем заводить обходной путь к таблице users.
GRANT EXECUTE ON FUNCTION identity_resolve_telegram(TEXT) TO app_worker;

-- Чтобы ответить на /today, разбор читает задания пользователя. Право выдаётся
-- на таблицу, но **без** отдельной политики для роли worker: действует прежняя
-- политика владельца строки, и worker видит ровно того пользователя, чей
-- контекст он установил в транзакции. Разрешающая политика вида
-- `TO app_worker USING (true)`, как у jobs, открыла бы ему задания всех
-- пользователей — здесь это не нужно и потому недопустимо.
GRANT SELECT ON quest_occurrences TO app_worker;
