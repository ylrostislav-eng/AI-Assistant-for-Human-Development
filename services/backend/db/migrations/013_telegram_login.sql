-- T-01: вход через Telegram.
--
-- Две вещи, которых не хватало для входа по подписанной строке Mini App.
--
-- 1. Узкая функция поиска личности. Политика изоляции показывает строку `users`
--    только тому, чей идентификатор уже установлен в контексте транзакции, а до
--    входа его взять неоткуда: получается замкнутый круг. Функция с правами
--    владельца разрывает его, не открывая общего обхода политики — она
--    принимает только subject, жёстко подставляет издателя и возвращает один
--    UUID. Прочитать через неё что-либо ещё нельзя.
--
--    Удалённый или приостановленный аккаунт вход не получает. Удаление пока не
--    реализовано, и воскрешать такую строку молча нельзя: прежние команды и
--    история остались бы привязанными к «новому» входу.
--
-- 2. Отпечатки использованных доказательств. Подписанная строка initData —
--    предъявительское доказательство: подпись не делает украденную строку
--    безопасной (docs/14, раздел 3). Один отпечаток обменивается на одну семью
--    сессий; повторное предъявление отклоняется. Цена политики известна: если
--    ответ обмена потерян, клиент открывает Mini App заново и получает свежее
--    доказательство. Подменять ошибку успехом нельзя.
--
--    В таблице нет ни идентификатора Telegram, ни внутреннего пользователя:
--    отпечаток сам по себе ничего не рассказывает о человеке, и связывать его с
--    аккаунтом незачем.

CREATE TABLE telegram_login_proofs (
  digest TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX telegram_login_proofs_expiry ON telegram_login_proofs (expires_at);

ALTER TABLE telegram_login_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_login_proofs FORCE ROW LEVEL SECURITY;
-- Строка не принадлежит пользователю и не содержит его данных, поэтому политика
-- привязана к роли, а не к `app.user_id`: до входа его ещё не существует.
CREATE POLICY telegram_login_proofs_runtime ON telegram_login_proofs
  TO app_runtime USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, DELETE ON telegram_login_proofs TO app_runtime;

CREATE FUNCTION identity_resolve_telegram(p_subject TEXT)
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
  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION identity_resolve_telegram(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_resolve_telegram(TEXT) TO app_runtime;
