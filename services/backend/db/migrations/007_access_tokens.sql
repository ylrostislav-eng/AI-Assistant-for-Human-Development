-- P1-02: access-токены сессии (docs/09, раздел 2: access 15 минут,
-- refresh 30 дней с ротацией).
--
-- Access-токен хранится в той же строке сессии: каждая ротация refresh создаёт
-- новую строку и вместе с ней новый короткоживущий access. Отдельная таблица
-- завела бы вторую сущность с тем же жизненным циклом и второй путь отзыва —
-- отзыв семьи тогда пришлось бы дублировать, и рассинхронизация проявилась бы
-- как «отозванная сессия продолжает отвечать».
--
-- Хранится хеш, как и у refresh: утечка базы не должна давать рабочие токены.

ALTER TABLE sessions ADD COLUMN access_hash TEXT UNIQUE;
ALTER TABLE sessions ADD COLUMN access_expires_at TIMESTAMPTZ;

ALTER TABLE sessions ADD CONSTRAINT sessions_access_pair_complete
  CHECK ((access_hash IS NULL) = (access_expires_at IS NULL));

-- Поиск сессии по access-токену до того, как известен пользователь, — та же
-- задача, что и у refresh (миграция 006), и решается так же: видно ровно ту
-- строку, чей токен вызывающий смог предъявить.
CREATE POLICY sessions_lookup_by_access_hash ON sessions
  FOR SELECT
  USING (access_hash = NULLIF(current_setting('app.access_hash', true), ''));
