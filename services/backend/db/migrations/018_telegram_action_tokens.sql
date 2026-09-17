-- T-02c: кнопки бота и завершение заданий нажатием.
--
-- В `callback_data` помещается 1–64 байта (Bot API), и класть туда состояние
-- нельзя: клиент может подменить его чем угодно. Поэтому кнопка несёт короткий
-- непрозрачный ключ, а всё остальное — на сервере.
--
-- Главное поле здесь — `command_id`. Он выдаётся при создании кнопки и потом не
-- меняется, поэтому повторное нажатие приходит с тем же идентификатором
-- команды, и шина команд возвращает прежнюю квитанцию вместо второго эффекта.
-- Двойное нажатие порождает разные callback ID, и дедупликации по обновлению
-- для этого недостаточно (docs/14, раздел 4) — защищает именно стабильный
-- command_id.
--
-- `expected_version` снимается в момент показа кнопки. Нажатие по вчерашнему
-- списку тогда честно упирается в конфликт версий, а не меняет то, чего человек
-- не видел.
--
-- `consumed_at` ограничивает срок жизни ключа: он нужен не для защиты от
-- второго эффекта (за неё отвечает command_id), а чтобы ключ не жил вечно.

CREATE TABLE telegram_action_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Непрозрачная строка из callback_data. Короткая: лимит Bot API — 64 байта.
  token TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  occurrence_id UUID NOT NULL,
  action TEXT NOT NULL,
  expected_version BIGINT NOT NULL,
  -- Идентификатор команды выдаётся здесь и не меняется: на нём держится
  -- защита от второго эффекта при повторном нажатии.
  command_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telegram_action_tokens_action_known
    CHECK (action IN ('complete_quest', 'start_quest', 'record_partial', 'cancel_quest')),
  CONSTRAINT telegram_action_tokens_token_short CHECK (length(token) BETWEEN 8 AND 64),
  CONSTRAINT telegram_action_tokens_version_non_negative CHECK (expected_version >= 0),
  CONSTRAINT telegram_action_tokens_occurrence_same_owner
    FOREIGN KEY (user_id, occurrence_id)
      REFERENCES quest_occurrences (user_id, id) ON DELETE CASCADE
);

CREATE INDEX telegram_action_tokens_expiry ON telegram_action_tokens (expires_at);

ALTER TABLE telegram_action_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_action_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY telegram_action_tokens_owner ON telegram_action_tokens
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON telegram_action_tokens TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON telegram_action_tokens TO app_worker;

-- Ответ на нажатие кнопки идёт другим методом Bot API, чем обычное сообщение.
-- Без него кнопка «крутится» у человека на экране; при этом «принято» не
-- означает «выполнено», и подтверждать надо честно.
ALTER TABLE telegram_messages ADD COLUMN method TEXT NOT NULL DEFAULT 'sendMessage';
ALTER TABLE telegram_messages ADD COLUMN callback_query_id TEXT;
ALTER TABLE telegram_messages ADD COLUMN reply_markup JSONB;

ALTER TABLE telegram_messages ADD CONSTRAINT telegram_messages_method_known
  CHECK (method IN ('sendMessage', 'answerCallbackQuery'));
ALTER TABLE telegram_messages ADD CONSTRAINT telegram_messages_callback_needs_id
  CHECK (method <> 'answerCallbackQuery' OR callback_query_id IS NOT NULL);

-- Подтверждение нажатия не возвращает message_id: ограничение «отправленное
-- несёт идентификатор» относится только к обычным сообщениям.
ALTER TABLE telegram_messages DROP CONSTRAINT telegram_messages_sent_has_id;
ALTER TABLE telegram_messages ADD CONSTRAINT telegram_messages_sent_has_id
  CHECK (state <> 'sent' OR method <> 'sendMessage' OR telegram_message_id IS NOT NULL);

-- Нажатие кнопки — это команда пользователя, и она идёт через ту же шину, что и
-- команды Mini App. Выполняет её worker, поэтому ему нужны права на таблицы
-- шины и домена.
--
-- Права выдаются **без** разрешающих политик для роли. Действуют прежние
-- политики владельца строки, и worker может действовать только от имени того
-- пользователя, чей контекст установил в транзакции. Расширенный доступ ко
-- всем пользователям остаётся только там, где он объявлен явной политикой —
-- jobs, outbox_events, telegram_updates, telegram_messages. Домен в этот
-- список не входит и входить не должен.
GRANT SELECT, INSERT, UPDATE ON user_change_counters TO app_worker;
GRANT SELECT, INSERT ON command_receipts TO app_worker;
GRANT SELECT, INSERT ON sync_change_batches TO app_worker;
GRANT SELECT, INSERT, UPDATE ON goals TO app_worker;
GRANT SELECT, INSERT, UPDATE ON quest_templates TO app_worker;
GRANT INSERT, UPDATE ON quest_occurrences TO app_worker;
GRANT SELECT, INSERT, UPDATE ON activity_records TO app_worker;
