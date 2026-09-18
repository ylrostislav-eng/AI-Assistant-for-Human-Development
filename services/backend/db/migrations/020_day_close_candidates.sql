-- P4-01: кандидаты на закрытие дня для фонового исполнителя.
--
-- Исполнителю намеренно не выдана сквозная политика на доменные таблицы: он
-- привязан к `app.user_id`, и это и есть изоляция пользователей для фоновой
-- работы (docs/09). Чтобы закрыть прошедшие дни, ему нужно заглянуть за
-- пределы одного человека — ровно для этого в проекте уже есть приём: узкая
-- функция SECURITY DEFINER с одной явной целью, как identity_resolve_telegram.
--
-- Функция **не решает**, прошёл ли день. Граница пользовательского дня
-- считается календарной арифметикой в одном месте (shared/time/user-day.ts) и
-- проверена по каждой минуте разрыва и наложения при переходе на летнее время
-- (T-00c). Вторая реализация той же арифметики на SQL разошлась бы с первой
-- незаметно и именно в тех днях, которые бывают дважды в год.
CREATE FUNCTION scheduling_day_close_candidates(max_rows INTEGER)
RETURNS TABLE (
  user_id UUID,
  occurrence_id UUID,
  version BIGINT,
  recurrence_key TEXT,
  timezone TEXT,
  day_boundary_minutes INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Явный search_path обязателен для SECURITY DEFINER: иначе вызывающий может
-- подставить свою схему и подменить таблицы, к которым функция обращается.
SET search_path = pg_catalog, public
AS $$
  SELECT o.user_id, o.id, o.version, o.recurrence_key,
         p.timezone, p.day_boundary_minutes
    FROM quest_occurrences o
    JOIN user_profiles p ON p.user_id = o.user_id
    JOIN users u ON u.id = o.user_id
   WHERE o.execution_status IN ('planned', 'active')
     AND u.deleted_at IS NULL
     AND u.status = 'active'
     -- Ключ повторения — локальная дата. Ключи, датой не являющиеся, к
     -- пользовательскому дню не относятся, и закрывать их нечем.
     AND o.recurrence_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   ORDER BY o.recurrence_key, o.id
   LIMIT LEAST(GREATEST(max_rows, 1), 1000);
$$;

-- Доступ только исполнителю. Роль времени выполнения обслуживает запросы
-- человека и заглядывать за пределы его данных не должна.
REVOKE ALL ON FUNCTION scheduling_day_close_candidates(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduling_day_close_candidates(INTEGER) TO app_worker;
