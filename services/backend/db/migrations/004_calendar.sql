-- P1-01: календарь и планирование (docs/02, разделы 3 и 6).
--
-- Событие календаря существует в двух видах: с точным временем (мгновения в
-- timestamptz) и на весь день (локальные даты). Это не одно и то же поле с
-- флагом: событие на весь день не имеет мгновения начала, пока не известен
-- часовой пояс, а событие со временем не зависит от локальной даты.
-- Конец дня хранится исключающей границей, чтобы однодневное событие не
-- требовало вычитания суток.

CREATE TABLE availability_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- Дни недели по ISO: 1 — понедельник, 7 — воскресенье.
  weekdays SMALLINT[] NOT NULL,
  wall_start TIME NOT NULL,
  wall_end TIME NOT NULL,
  timezone TEXT NOT NULL,
  effective_from DATE NOT NULL,
  effective_until DATE,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT availability_rules_kind_known
    CHECK (kind IN ('work', 'sleep', 'commute', 'rest', 'free')),
  -- Проверки wall_end > wall_start здесь намеренно нет: интервал сна обычно
  -- пересекает полночь (docs/02, раздел 3), и такая проверка запретила бы
  -- нормальное правило. Пересечение полуночи определяется сравнением в коде.
  CONSTRAINT availability_rules_weekdays_valid
    CHECK (array_length(weekdays, 1) BETWEEN 1 AND 7
           AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]),
  CONSTRAINT availability_rules_period_valid
    CHECK (effective_until IS NULL OR effective_until >= effective_from)
);

CREATE TABLE calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  local_start_date DATE,
  local_end_date_exclusive DATE,
  timezone TEXT NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT false,
  busy BOOLEAN NOT NULL DEFAULT true,
  origin TEXT NOT NULL DEFAULT 'local',
  external_ref TEXT,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT calendar_events_origin_known
    CHECK (origin IN ('local', 'apple_calendar', 'imported')),
  -- Один из двух видов, а не смесь: иначе появляется событие, у которого и
  -- мгновение, и локальная дата, и они расходятся после смены пояса.
  CONSTRAINT calendar_events_shape_consistent CHECK (
    (all_day = false
      AND starts_at IS NOT NULL AND ends_at IS NOT NULL
      AND local_start_date IS NULL AND local_end_date_exclusive IS NULL)
    OR
    (all_day = true
      AND local_start_date IS NOT NULL AND local_end_date_exclusive IS NOT NULL
      AND starts_at IS NULL AND ends_at IS NULL)
  ),
  -- Диапазоны полуоткрытые [start, end): смежные события не считаются
  -- пересечением, поэтому конец строго больше начала.
  CONSTRAINT calendar_events_timed_order CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT calendar_events_all_day_order
    CHECK (local_end_date_exclusive IS NULL OR local_end_date_exclusive > local_start_date),
  -- Импортированное событие не должно задваиваться при повторной синхронизации.
  CONSTRAINT calendar_events_external_unique UNIQUE (user_id, origin, external_ref)
);

CREATE INDEX calendar_events_busy_window ON calendar_events (user_id, starts_at)
  WHERE busy AND deleted_at IS NULL;

CREATE TABLE plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  -- Версии входных данных и правил: по ним восстанавливается, из чего план был
  -- построен. Без них «почему план такой» становится догадкой.
  input_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  rules_version TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  author TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plan_versions_scope_known CHECK (scope IN ('day', 'week', 'month', 'goal')),
  CONSTRAINT plan_versions_state_known
    CHECK (state IN ('draft', 'proposed', 'accepted', 'superseded')),
  CONSTRAINT plan_versions_author_known CHECK (author IN ('user', 'ai', 'scheduler')),
  CONSTRAINT plan_versions_period_valid CHECK (date_to >= date_from),
  CONSTRAINT plan_versions_owner_identity UNIQUE (user_id, id)
);

-- История размещения задания. Идентичность occurrence при переносе
-- сохраняется, меняется ревизия (docs/02, раздел 8).
CREATE TABLE schedule_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  occurrence_id UUID NOT NULL,
  previous_id UUID,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  assigned_user_day UUID,
  placement_state TEXT NOT NULL,
  variant TEXT,
  reason_code TEXT,
  plan_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_revisions_placement_known
    CHECK (placement_state IN ('unscheduled', 'scheduled', 'rescheduled')),
  CONSTRAINT schedule_revisions_order CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CONSTRAINT schedule_revisions_no_self CHECK (previous_id IS NULL OR previous_id <> id),
  CONSTRAINT schedule_revisions_occurrence_same_owner
    FOREIGN KEY (user_id, occurrence_id)
      REFERENCES quest_occurrences (user_id, id) ON DELETE CASCADE,
  CONSTRAINT schedule_revisions_day_same_owner
    FOREIGN KEY (user_id, assigned_user_day) REFERENCES user_days (user_id, id) ON DELETE SET NULL,
  CONSTRAINT schedule_revisions_plan_same_owner
    FOREIGN KEY (user_id, plan_version_id) REFERENCES plan_versions (user_id, id) ON DELETE SET NULL,
  CONSTRAINT schedule_revisions_owner_identity UNIQUE (user_id, id),
  CONSTRAINT schedule_revisions_previous_same_owner
    FOREIGN KEY (user_id, previous_id)
      REFERENCES schedule_revisions (user_id, id) ON DELETE SET NULL
);

CREATE INDEX schedule_revisions_by_occurrence
  ON schedule_revisions (user_id, occurrence_id, created_at DESC);

ALTER TABLE availability_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY availability_rules_owner ON availability_rules
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_events_owner ON calendar_events
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_versions_owner ON plan_versions
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE schedule_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY schedule_revisions_owner ON schedule_revisions
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  availability_rules, calendar_events, plan_versions, schedule_revisions
  TO app_runtime;
