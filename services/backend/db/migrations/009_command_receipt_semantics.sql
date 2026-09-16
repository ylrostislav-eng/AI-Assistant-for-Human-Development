-- T-00a: квитанция команды хранит вид команды и версию схемы хеша.
--
-- Дефект R2 (docs/15-backend-review.md): хеш считался только по нагрузке,
-- поэтому `start_quest` и `complete_quest` с одинаковой нагрузкой и одним
-- command_id выглядели повтором. Клиент получал квитанцию чужой операции и
-- считал задание завершённым, хотя оно было только запущено.
--
-- hash_version = 1 — прежняя схема (хеш только по нагрузке, вид неизвестен).
-- hash_version = 2 — семантический хеш: схема, вид, цель, ожидаемая версия,
-- зависимость и нагрузка.
--
-- Старые квитанции не переписываются и не угадываются: для них вид команды
-- неизвестен, поэтому доказать, что повтор относится к той же операции,
-- невозможно. Такой повтор отклоняется как конфликт, а не принимается на веру —
-- потеря защиты от повторов хуже неудобства.

ALTER TABLE command_receipts ADD COLUMN kind TEXT;
ALTER TABLE command_receipts ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE command_receipts ADD CONSTRAINT command_receipts_hash_version_known
  CHECK (hash_version IN (1, 2));

-- У квитанций новой схемы вид обязателен; у старых его взять неоткуда.
ALTER TABLE command_receipts ADD CONSTRAINT command_receipts_kind_with_version
  CHECK (hash_version = 1 OR kind IS NOT NULL);
