-- T-04b-3c: учёт обращений к поставщику с резервированием до запроса.
--
-- Считать после ответа поздно: деньги уже потрачены, и два одновременных хода
-- успевают проскочить мимо предела, потому что оба видят свободный остаток.
-- Поэтому расход резервируется оценкой **до** обращения и уточняется по факту.
--
-- Учитывается попытка, а не ход: ход с перебором запасных моделей стоит
-- столько, сколько было попыток, и считать его одной значит недосчитать ровно
-- в тот день, когда основная модель лежит и перебор работает постоянно.

CREATE TABLE ai_provider_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Ход, ради которого делалась попытка. Для разбора «почему столько», а не
  -- для самого учёта: предел считается по человеку и суткам.
  turn_id UUID NOT NULL,

  provider TEXT NOT NULL,
  model TEXT NOT NULL,

  state TEXT NOT NULL DEFAULT 'reserved',
  -- Оценка, списанная до обращения.
  reserved_tokens BIGINT NOT NULL,
  -- Что списано с бюджета сейчас: оценка, пока факт неизвестен, и факт после
  -- уточнения. Ноль здесь недопустим для незакрытой попытки — см. ниже.
  charged_tokens BIGINT NOT NULL,

  -- NULL означает «поставщик не сказал». Это не ноль: попытка была.
  input_tokens BIGINT,
  output_tokens BIGINT,
  usage_known BOOLEAN NOT NULL DEFAULT false,

  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- До какого момента резерв считается незакрытым. После этого его закрывает
  -- сверка: процесс мог умереть между запросом и уточнением, и оставлять
  -- попытку вечно открытой нельзя.
  expires_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,

  CONSTRAINT ai_attempt_state_known CHECK (state IN ('reserved', 'settled')),
  CONSTRAINT ai_attempt_reserved_positive CHECK (reserved_tokens > 0),
  -- Списание никогда не опускается до нуля: неизвестная стоимость дороже
  -- известной, а не бесплатна.
  CONSTRAINT ai_attempt_charged_positive CHECK (charged_tokens > 0),
  CONSTRAINT ai_attempt_settled_shape CHECK (
    (state = 'settled' AND settled_at IS NOT NULL) OR (state = 'reserved' AND settled_at IS NULL)
  ),
  CONSTRAINT ai_attempt_known_has_counts
    CHECK (usage_known = false OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
  CONSTRAINT ai_attempt_unknown_has_no_counts
    CHECK (usage_known = true OR (input_tokens IS NULL AND output_tokens IS NULL)),
  CONSTRAINT ai_attempt_owner_identity UNIQUE (user_id, id)
);

-- Предел считается по окну в сутки: индекс под него.
CREATE INDEX ai_provider_attempts_window ON ai_provider_attempts (user_id, reserved_at);
-- Сверка ищет незакрытые просроченные.
CREATE INDEX ai_provider_attempts_stale ON ai_provider_attempts (expires_at) WHERE state = 'reserved';

ALTER TABLE ai_provider_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_provider_attempts_owner ON ai_provider_attempts
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON ai_provider_attempts TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON ai_provider_attempts TO app_worker;

-- Сверка просроченных резервов идёт по всем людям, а исполнителю намеренно не
-- выдана сквозная политика на доменные таблицы. Тот же приём, что у закрытия
-- дня (миграция 020_day_close_candidates): узкая функция с одной целью.
--
-- Функция не освобождает бюджет, а закрывает попытку по оценке: процесс мог
-- умереть уже после отправки запроса, и считать такую попытку бесплатной
-- значит открыть способ не платить.
CREATE FUNCTION ai_settle_expired_attempts(max_rows INTEGER)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH stale AS (
    SELECT id FROM ai_provider_attempts
     WHERE state = 'reserved' AND expires_at <= clock_timestamp()
     ORDER BY expires_at
     LIMIT LEAST(GREATEST(max_rows, 1), 1000)
  ), closed AS (
    UPDATE ai_provider_attempts a
       SET state = 'settled', settled_at = clock_timestamp()
      FROM stale WHERE a.id = stale.id
    RETURNING a.id
  )
  -- Именно счёт закрытых: `RETURNING 1` вернул бы единицу независимо от того,
  -- закрылась одна попытка или триста, и отчёт прохода стал бы бессмысленным.
  SELECT count(*)::int FROM closed;
$$;

REVOKE ALL ON FUNCTION ai_settle_expired_attempts(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_settle_expired_attempts(INTEGER) TO app_worker;
