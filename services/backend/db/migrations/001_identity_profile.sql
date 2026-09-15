-- P1-01: таблицы identity и profile (docs/02, раздел 3).
--
-- Соглашения документа 02: идентификаторы UUID; мгновения — timestamptz;
-- часовой пояс IANA хранится отдельно; изменяемые записи несут version для
-- оптимистичной блокировки.
--
-- Связи между пользовательскими объектами проверяются составным ключом
-- (user_id, id), а не одним UUID: одиночный внешний ключ разрешает связать
-- свою запись с чужой записью другого пользователя, и такая связь выглядит
-- корректной при любом чтении.
--
-- RLS включается здесь же и обязательно с FORCE: без FORCE владелец таблиц
-- обходит политики, и запуск приложения под владельцем снимает изоляцию молча
-- (проверено в docs/security-prototype-tenant-isolation.md).

-- Роль времени выполнения создаётся вне миграций (ops, scripts/dev_db.sh):
-- создание ролей требует прав, которых у мигратора может не быть в managed
-- PostgreSQL. Здесь только выдача прав, и отсутствие роли останавливает
-- миграцию с понятной ошибкой.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'Роль app_runtime не существует. Создать её до миграций: см. ops/README.md';
  END IF;
END
$$;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_issuer TEXT NOT NULL,
  auth_subject TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ru',
  status TEXT NOT NULL DEFAULT 'active',
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT users_status_known CHECK (status IN ('active', 'suspended', 'deleting')),
  -- Почта не является первичной личностью: пара издатель+subject от Apple.
  CONSTRAINT users_identity_unique UNIQUE (auth_issuer, auth_subject)
);

CREATE TABLE user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Профиль ровно один на пользователя.
  user_id UUID NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  display_name TEXT,
  onboarding_state TEXT NOT NULL DEFAULT 'not_started',
  system_style TEXT NOT NULL DEFAULT 'system',
  -- Часовой пояс IANA строкой: смещение хранить нельзя, оно меняется дважды в
  -- год и не определяет правила перехода.
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  -- Граница пользовательского дня в минутах от полуночи: прибавление 24 часов
  -- к предыдущей границе запрещено (AGENTS.md), день определяется этой меткой.
  day_boundary_minutes INTEGER NOT NULL DEFAULT 240,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_boundary_range CHECK (day_boundary_minutes BETWEEN 0 AND 1439),
  CONSTRAINT user_profiles_style_known
    CHECK (system_style IN ('mentor', 'commander', 'companion', 'system')),
  CONSTRAINT user_profiles_onboarding_known
    CHECK (onboarding_state IN ('not_started', 'in_progress', 'completed'))
);

CREATE TABLE user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  -- JSONB только для значения с версией схемы: структура ключей задаётся
  -- реестром в коде, а не произвольным документом.
  value JSONB NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_preferences_key_unique UNIQUE (user_id, key)
);

-- Согласия только добавляются: действующим считается последняя запись по
-- области. Изменение записи на месте стёрло бы историю того, на что
-- пользователь соглашался раньше.
CREATE TABLE consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  granted BOOLEAN NOT NULL,
  policy_version TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX consent_records_current ON consent_records (user_id, scope, recorded_at DESC);

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  -- Токен push хранится зашифрованным и меняется у одного устройства.
  push_token_encrypted BYTEA,
  sync_state TEXT NOT NULL DEFAULT 'active',
  revoked_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT devices_platform_known CHECK (platform IN ('ios', 'ipados', 'watchos')),
  CONSTRAINT devices_installation_unique UNIQUE (user_id, installation_id),
  -- Цель, а не украшение: на этот ключ ссылается составной FK из sessions.
  CONSTRAINT devices_owner_identity UNIQUE (user_id, id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id UUID,
  family_id UUID NOT NULL,
  -- Хранится только хеш: утечка базы не должна давать рабочие токены
  -- (docs/security-prototype-session-rotation.md).
  refresh_hash TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  CONSTRAINT sessions_expiry_after_issue CHECK (expires_at > issued_at),
  -- Составной ключ: сессия не может ссылаться на устройство чужого
  -- пользователя. Простого REFERENCES devices (id) для этого недостаточно.
  CONSTRAINT sessions_device_same_owner
    FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, id) ON DELETE SET NULL
);

CREATE INDEX sessions_family ON sessions (user_id, family_id);

-- Изоляция пользователей.
--
-- Политика читает app.user_id, который выставляется транзакционно
-- (set_config(..., true)). NULLIF нужен, потому что пустая строка иначе роняет
-- приведение к uuid, и отсутствие контекста выглядело бы сбоем базы вместо
-- отказа в доступе.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_profiles_owner ON user_profiles
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY user_preferences_owner ON user_preferences
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_records_owner ON consent_records
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY devices_owner ON devices
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_owner ON sessions
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, user_profiles, user_preferences, consent_records, devices, sessions
  TO app_runtime;
