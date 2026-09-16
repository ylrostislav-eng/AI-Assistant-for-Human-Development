-- P1-03: транзакционный outbox и очередь заданий (docs/01, раздел 6).
--
-- Событие записывается в ту же транзакцию, что и команда. Отправлять его
-- отдельным вызовом нельзя: между фиксацией команды и отправкой процесс может
-- умереть, и напоминание не будет создано никогда — либо наоборот, отправка
-- пройдёт, а команда откатится, и придёт напоминание о том, чего не случилось.
--
-- Роль worker отделена от роли API намеренно. Worker обрабатывает задания всех
-- пользователей, и политика «вижу только свои строки» этого не выражает. Вместо
-- отключения RLS для служебных таблиц заведена отдельная политика ровно для
-- этой роли: исключение видно в списке политик, а не спрятано в отсутствии
-- защиты.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    RAISE EXCEPTION 'Роль app_worker не существует. Создать её до миграций: см. ops/README.md';
  END IF;
END
$$;

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- Полный текст переписки сюда не кладётся (docs/01, раздел 6): в payload
  -- только ссылки и минимально необходимые поля.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ
);

CREATE INDEX outbox_events_undispatched ON outbox_events (created_at)
  WHERE dispatched_at IS NULL;

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- Ключ дедупликации: повторный проход диспетчера не создаёт второе задание
  -- по тому же событию.
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  -- Аренда, а не флаг «занято»: упавший worker не может снять флаг, а истёкшая
  -- аренда возвращает задание в работу сама.
  lease_until TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_known
    CHECK (status IN ('pending', 'running', 'done', 'dead_letter')),
  CONSTRAINT jobs_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts > 0)
);

CREATE INDEX jobs_claimable ON jobs (due_at) WHERE status IN ('pending', 'running');

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_owner ON outbox_events
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY outbox_events_worker ON outbox_events TO app_worker USING (true) WITH CHECK (true);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_owner ON jobs
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY jobs_worker ON jobs TO app_worker USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events, jobs TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events, jobs TO app_worker;
GRANT USAGE ON SCHEMA public TO app_worker;
