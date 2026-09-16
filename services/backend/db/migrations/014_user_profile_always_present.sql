-- T-06: у каждого пользователя есть профиль.
--
-- Снимок для клиента отдаёт часовой пояс и границу дня — без них нечего
-- показывать. Брать умолчания из кода нельзя: они уже заданы в схеме, и вторая
-- копия разошлась бы с первой незаметно. Поэтому строка профиля создаётся
-- вместе с пользователем, а чтение остаётся чтением.
--
-- Умолчания — это умолчания, а не выдуманные факты: часовой пояс и граница дня
-- помечены в профиле как несогласованные с человеком, пока он их не подтвердит
-- (онбординг, docs/07). Отличать подтверждённое от подставленного нужно с
-- самого начала: потом по значению этого уже не понять.

ALTER TABLE user_profiles ADD COLUMN schedule_confirmed BOOLEAN NOT NULL DEFAULT false;

-- Уже существующие пользователи без профиля: значения те же, что дала бы схема.
INSERT INTO user_profiles (user_id)
SELECT id FROM users
 WHERE NOT EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.user_id = users.id);

-- Функция входа через Telegram заводит профиль вместе с пользователем.
CREATE OR REPLACE FUNCTION identity_resolve_telegram(p_subject TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_id UUID;
  v_status TEXT;
  v_deleted TIMESTAMPTZ;
BEGIN
  IF p_subject IS NULL OR p_subject !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'Некорректный идентификатор Telegram' USING ERRCODE = '22023';
  END IF;

  SELECT id, status, deleted_at INTO v_id, v_status, v_deleted
    FROM users WHERE auth_issuer = 'telegram' AND auth_subject = p_subject;

  IF v_id IS NOT NULL THEN
    IF v_deleted IS NOT NULL OR v_status <> 'active' THEN
      RAISE EXCEPTION 'Аккаунт недоступен для входа' USING ERRCODE = '28000';
    END IF;
    RETURN v_id;
  END IF;

  INSERT INTO users (auth_issuer, auth_subject) VALUES ('telegram', p_subject)
  RETURNING id INTO v_id;

  -- Профиль той же транзакцией: пользователь без профиля — состояние, которого
  -- не должно существовать ни на одном мгновении.
  INSERT INTO user_profiles (user_id) VALUES (v_id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION identity_resolve_telegram(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_resolve_telegram(TEXT) TO app_runtime;
