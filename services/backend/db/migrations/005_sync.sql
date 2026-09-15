-- P1-01: команды и синхронизация (docs/02, раздел 7; docs/01, раздел 5).
--
-- Задача этих таблиц одна: повторная доставка команды не должна приводить ко
-- второму бизнес-эффекту. Клиент повторяет команду при обрыве сети, не зная,
-- дошла ли она, поэтому сервер обязан узнать её и вернуть прежний результат.
--
-- Порядок изменений задаёт серверный счётчик, а не время телефона: часы
-- устройства переводятся, а курсор синхронизации обязан двигаться монотонно.

-- Один счётчик на пользователя. Нагрузка одного пользователя сериализуется,
-- разные пользователи не мешают друг другу (docs/09, раздел 7).
CREATE TABLE user_change_counters (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  seq BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT user_change_counters_seq_non_negative CHECK (seq >= 0)
);

CREATE TABLE command_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  command_id UUID NOT NULL,
  -- Хеш полезной нагрузки: тот же command_id с другим содержимым означает
  -- ошибку клиента, а не повтор, и молча возвращать прежнюю квитанцию нельзя.
  payload_hash TEXT NOT NULL,
  result JSONB,
  committed_seq BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT command_receipts_seq_positive CHECK (committed_seq > 0),
  -- Ключ идемпотентности. Уникальность в пределах пользователя: одинаковый
  -- command_id у разных пользователей — обычное совпадение, а не конфликт.
  CONSTRAINT command_receipts_command_unique UNIQUE (user_id, command_id)
);

CREATE TABLE sync_change_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  changes JSONB NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sync_change_batches_seq_positive CHECK (seq > 0),
  -- Номер пачки уникален: две пачки с одним номером сделали бы курсор
  -- неоднозначным, и часть изменений устройство никогда бы не получило.
  CONSTRAINT sync_change_batches_seq_unique UNIQUE (user_id, seq)
);

CREATE TABLE device_sync_cursors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  cursor_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_sync_cursors_seq_non_negative CHECK (cursor_seq >= 0),
  CONSTRAINT device_sync_cursors_device_unique UNIQUE (user_id, device_id),
  CONSTRAINT device_sync_cursors_device_same_owner
    FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, id) ON DELETE CASCADE
);

ALTER TABLE user_change_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_change_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY user_change_counters_owner ON user_change_counters
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY command_receipts_owner ON command_receipts
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE sync_change_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_change_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY sync_change_batches_owner ON sync_change_batches
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE device_sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sync_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY device_sync_cursors_owner ON device_sync_cursors
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  user_change_counters, command_receipts, sync_change_batches, device_sync_cursors
  TO app_runtime;
