-- P3-01: журнал начислений XP (docs/03, раздел 5).
--
-- Журнал только дописывается. Это не стиль, а условие доверия: начисленное
-- полгода назад должно объясняться правилами, которые действовали тогда, а
-- исправление ошибки — быть отдельной компенсирующей записью, а не тихой
-- правкой строки (AGENTS.md). Права на UPDATE и DELETE ролям приложения не
-- выдаются: запрет держится базой, а не памятью следующего автора.
--
-- Суммы в целых milli-XP. Двоичная плавающая точка запрещена: 0.1 + 0.2 ≠ 0.3,
-- а это баланс, который человек зарабатывает месяцами.

CREATE TABLE xp_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Конкретная запись факта. Одна запись факта — не более одного начисления.
  activity_id UUID NOT NULL,
  -- Корень факта: завершение, уточнение и исправление относятся к одному
  -- действию. Дельта к уже начисленному считается по корню.
  activity_root_id UUID NOT NULL,

  -- На какой день списывается дневной предел: локальная дата пользовательского
  -- дня, а не дата сервера. Смена часового пояса не должна удваивать лимит.
  bucket_key TEXT NOT NULL,
  -- Ведро убывающей отдачи. Пока это идентификатор шаблона: семейства
  -- активностей ещё не связаны с заданиями (docs/13-handoff, раздел 3.27).
  family_key TEXT NOT NULL,

  account_type TEXT NOT NULL DEFAULT 'global',
  -- Отрицательное значение допустимо: так выглядит компенсация.
  amount_mxp BIGINT NOT NULL,
  -- Сколько секунд ушло в счётчики полос, включая неоплаченные: без них
  -- бесплатные минуты не двигали бы полосу.
  counted_seconds INTEGER NOT NULL,

  rule_version TEXT NOT NULL,
  -- Отпечаток входных данных расчёта: по нему видно, что повтор считал то же.
  input_hash TEXT NOT NULL,
  calculation_revision INTEGER NOT NULL DEFAULT 1,

  -- Мгновение начисления: по нему считается скользящее окно 24 часов.
  credited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT xp_ledger_account_known CHECK (account_type IN ('global')),
  CONSTRAINT xp_ledger_counted_non_negative CHECK (counted_seconds >= 0),
  CONSTRAINT xp_ledger_revision_positive CHECK (calculation_revision >= 1),
  -- Одна запись факта — одно начисление. Повторное выполнение команды не
  -- создаёт вторую награду за то же действие.
  CONSTRAINT xp_ledger_one_per_activity UNIQUE (user_id, activity_id, account_type),
  CONSTRAINT xp_ledger_owner_identity UNIQUE (user_id, id),
  -- Составной ключ, а не одиночный: одиночный разрешает сослаться на чужую
  -- запись факта, и такая связь выглядит корректной при любом чтении.
  CONSTRAINT xp_ledger_activity_same_owner
    FOREIGN KEY (user_id, activity_id) REFERENCES activity_records (user_id, id)
);

-- Дневная сумма и сумма по семье за день: считаются при каждом начислении.
CREATE INDEX xp_ledger_day ON xp_ledger (user_id, bucket_key);
CREATE INDEX xp_ledger_family_day ON xp_ledger (user_id, bucket_key, family_key);
-- Скользящее окно 24 часов.
CREATE INDEX xp_ledger_credited ON xp_ledger (user_id, credited_at);
-- Дельта по корню.
CREATE INDEX xp_ledger_root ON xp_ledger (user_id, activity_root_id);

ALTER TABLE xp_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE xp_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY xp_ledger_owner ON xp_ledger
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- Только чтение и дозапись. UPDATE и DELETE не выдаются намеренно: журнал,
-- который можно править, перестаёт быть журналом.
GRANT SELECT, INSERT ON xp_ledger TO app_runtime;
GRANT SELECT, INSERT ON xp_ledger TO app_worker;
