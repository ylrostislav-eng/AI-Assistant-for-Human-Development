-- T-02b (часть 2): отсрочка, предел попыток и отметка начала отправки.
--
-- Отсрочку при 429 назначает сам Telegram заголовком `retry_after`.
-- Игнорировать её значит получить запрет подольше, поэтому следующая попытка
-- имеет собственное время, а не берётся сразу.
--
-- sending_since нужен, чтобы отличить идущую отправку от оборванной. Процесс,
-- умерший после запроса, оставляет строку в состоянии `sending`: доставка не
-- подтверждена и не опровергнута. Такая строка уходит в `unknown`, а не
-- обратно в очередь — вернуть её в очередь значит отправить второй раз.

ALTER TABLE telegram_messages ADD COLUMN next_attempt_at TIMESTAMPTZ;
ALTER TABLE telegram_messages ADD COLUMN sending_since TIMESTAMPTZ;
ALTER TABLE telegram_messages ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5;

ALTER TABLE telegram_messages ADD CONSTRAINT telegram_messages_max_attempts_positive
  CHECK (max_attempts > 0);

-- Индекс очереди пересобирается под отсрочку: без учёта времени следующая
-- попытка выбиралась бы сразу и отсрочка ничего не значила.
DROP INDEX telegram_messages_queue;
CREATE INDEX telegram_messages_queue
  ON telegram_messages (next_attempt_at NULLS FIRST, created_at)
  WHERE state = 'pending';
