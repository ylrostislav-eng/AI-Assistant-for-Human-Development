-- P1-01: задания и пользовательские дни (docs/02, разделы 4, 5 и 8).
--
-- У occurrence две оси состояния, а не один перегруженный статус:
-- execution_status (что с выполнением) и placement_state (что с расписанием).
-- Перенос задачи не является её пропуском, поэтому смешивать оси нельзя.
--
-- Пользовательский день — отдельная сущность с сохранённой границей и
-- часовым поясом. Прибавление 24 часов к предыдущему дню запрещено: при
-- переходе на летнее время сутки не равны 24 часам, и такой расчёт порождает
-- либо пропущенный, либо удвоенный день.

-- Ключ нужен ссылке из quest_templates: шаблон, привязанный и к цели, и к
-- проекту, обязан ссылаться на проект той же цели.
ALTER TABLE projects ADD CONSTRAINT projects_goal_identity UNIQUE (goal_id, id);

-- Семейства активности: одинаковые по сути действия делят лимит награды
-- (docs/02, раздел 5). Таблица нужна уже здесь, потому что на неё ссылается
-- шаблон задания.
CREATE TABLE activity_families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  parent_id UUID,
  kind TEXT NOT NULL DEFAULT 'activity',
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT activity_families_kind_known CHECK (kind IN ('activity', 'routine')),
  CONSTRAINT activity_families_key_unique UNIQUE (user_id, canonical_key),
  CONSTRAINT activity_families_owner_identity UNIQUE (user_id, id),
  CONSTRAINT activity_families_parent_same_owner
    FOREIGN KEY (user_id, parent_id) REFERENCES activity_families (user_id, id) ON DELETE SET NULL,
  CONSTRAINT activity_families_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE user_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  local_date DATE NOT NULL,
  -- Снимки пояса и границы: смена настроек не должна задним числом менять
  -- границы уже прожитых дней.
  zone_snapshot TEXT NOT NULL,
  boundary_snapshot INTEGER NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open',
  -- Эпоха награды меняется при пересчёте и не позволяет начислить дважды за
  -- один и тот же день.
  reward_epoch INTEGER NOT NULL DEFAULT 1,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_days_status_known CHECK (status IN ('open', 'closing', 'closed')),
  CONSTRAINT user_days_boundary_range CHECK (boundary_snapshot BETWEEN 0 AND 1439),
  CONSTRAINT user_days_ends_after_starts CHECK (ends_at > starts_at),
  -- Один день на дату: при переходе на летнее время дубликат не создаётся.
  CONSTRAINT user_days_date_unique UNIQUE (user_id, local_date),
  CONSTRAINT user_days_owner_identity UNIQUE (user_id, id)
);

CREATE TABLE quest_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  goal_id UUID,
  milestone_id UUID,
  project_id UUID,
  activity_family_id UUID,
  title TEXT NOT NULL,
  why TEXT,
  category TEXT NOT NULL DEFAULT 'daily',
  -- Повторение MVP: ежедневно, выбранные дни недели, частота в неделю.
  -- Произвольный RRULE отложен до Phase 5 и здесь не кодируется.
  recurrence JSONB,
  -- Объём и критерий успеха: документ с версией схемы, читается движком.
  normal_spec JSONB NOT NULL,
  minimum_spec JSONB,
  difficulty TEXT,
  challenge_stage INTEGER NOT NULL DEFAULT 0,
  rubric_version INTEGER NOT NULL DEFAULT 1,
  reward_eligible BOOLEAN NOT NULL DEFAULT true,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT quest_templates_category_known
    CHECK (category IN ('main', 'daily', 'skill', 'discipline', 'side', 'boss', 'recovery')),
  -- Standalone Quest без цели допустим (docs/02): цель необязательна, но веха
  -- и проект без цели бессмысленны.
  CONSTRAINT quest_templates_links_need_goal
    CHECK (goal_id IS NOT NULL OR (milestone_id IS NULL AND project_id IS NULL)),
  CONSTRAINT quest_templates_goal_same_owner
    FOREIGN KEY (user_id, goal_id) REFERENCES goals (user_id, id) ON DELETE SET NULL,
  -- Веха и проект обязаны относиться к той же цели.
  CONSTRAINT quest_templates_milestone_same_goal
    FOREIGN KEY (goal_id, milestone_id) REFERENCES milestones (goal_id, id) ON DELETE SET NULL,
  CONSTRAINT quest_templates_project_same_goal
    FOREIGN KEY (goal_id, project_id) REFERENCES projects (goal_id, id) ON DELETE SET NULL,
  CONSTRAINT quest_templates_family_same_owner
    FOREIGN KEY (user_id, activity_family_id)
      REFERENCES activity_families (user_id, id) ON DELETE SET NULL,
  CONSTRAINT quest_templates_owner_identity UNIQUE (user_id, id)
);

CREATE TABLE quest_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  template_id UUID NOT NULL,
  -- Ключ повторения: для разовой задачи один экземпляр, для ежедневной — по
  -- одному на пользовательский день.
  recurrence_key TEXT NOT NULL,
  assigned_user_day UUID,
  timezone_snapshot TEXT NOT NULL,
  -- Снимок правил шаблона: поздняя правка шаблона не меняет завершённое
  -- прошлое (docs/02, раздел 4).
  template_snapshot JSONB NOT NULL,
  execution_status TEXT NOT NULL DEFAULT 'planned',
  placement_state TEXT NOT NULL DEFAULT 'unscheduled',
  completion_variant TEXT,
  required_amount NUMERIC,
  unit TEXT,
  deadline TIMESTAMPTZ,
  deadline_kind TEXT NOT NULL DEFAULT 'soft',
  closed_incomplete BOOLEAN NOT NULL DEFAULT false,
  supersedes_id UUID,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quest_occurrences_execution_known
    CHECK (execution_status IN
      ('planned', 'active', 'partial', 'completed', 'missed', 'excused', 'cancelled')),
  CONSTRAINT quest_occurrences_placement_known
    CHECK (placement_state IN ('unscheduled', 'scheduled', 'rescheduled')),
  CONSTRAINT quest_occurrences_variant_known
    CHECK (completion_variant IS NULL OR completion_variant IN ('normal', 'minimum')),
  -- Вариант завершения имеет смысл только у завершённого задания.
  CONSTRAINT quest_occurrences_variant_needs_completion
    CHECK (completion_variant IS NULL OR execution_status = 'completed'),
  CONSTRAINT quest_occurrences_deadline_kind_known CHECK (deadline_kind IN ('soft', 'hard')),
  CONSTRAINT quest_occurrences_amount_non_negative
    CHECK (required_amount IS NULL OR required_amount >= 0),
  CONSTRAINT quest_occurrences_key_unique UNIQUE (user_id, template_id, recurrence_key),
  CONSTRAINT quest_occurrences_template_same_owner
    FOREIGN KEY (user_id, template_id) REFERENCES quest_templates (user_id, id) ON DELETE CASCADE,
  CONSTRAINT quest_occurrences_day_same_owner
    FOREIGN KEY (user_id, assigned_user_day) REFERENCES user_days (user_id, id) ON DELETE SET NULL,
  CONSTRAINT quest_occurrences_supersedes_same_owner
    FOREIGN KEY (user_id, supersedes_id)
      REFERENCES quest_occurrences (user_id, id) ON DELETE SET NULL,
  CONSTRAINT quest_occurrences_no_self_supersede CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT quest_occurrences_owner_identity UNIQUE (user_id, id)
);

CREATE INDEX quest_occurrences_day_status
  ON quest_occurrences (user_id, assigned_user_day, execution_status);

-- Шаги задания без отдельной награды: это чеклист, а не вторая система
-- начисления XP (docs/02, раздел 4).
CREATE TABLE quest_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  occurrence_id UUID NOT NULL,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  required BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'pending',
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quest_actions_status_known CHECK (status IN ('pending', 'done', 'skipped')),
  CONSTRAINT quest_actions_ordinal_unique UNIQUE (occurrence_id, ordinal),
  CONSTRAINT quest_actions_occurrence_same_owner
    FOREIGN KEY (user_id, occurrence_id)
      REFERENCES quest_occurrences (user_id, id) ON DELETE CASCADE
);

CREATE TABLE quest_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  predecessor_occurrence_id UUID NOT NULL,
  successor_occurrence_id UUID NOT NULL,
  dependency_type TEXT NOT NULL DEFAULT 'soft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quest_dependencies_type_known CHECK (dependency_type IN ('hard', 'soft')),
  CONSTRAINT quest_dependencies_no_self
    CHECK (predecessor_occurrence_id <> successor_occurrence_id),
  CONSTRAINT quest_dependencies_unique
    UNIQUE (predecessor_occurrence_id, successor_occurrence_id),
  CONSTRAINT quest_dependencies_predecessor_same_owner
    FOREIGN KEY (user_id, predecessor_occurrence_id)
      REFERENCES quest_occurrences (user_id, id) ON DELETE CASCADE,
  CONSTRAINT quest_dependencies_successor_same_owner
    FOREIGN KEY (user_id, successor_occurrence_id)
      REFERENCES quest_occurrences (user_id, id) ON DELETE CASCADE
);

-- Обязательства дня: основа расчёта выполнения. Ожидаемый объём фиксируется
-- утром, поэтому вечернее удаление задачи не улучшает утренний знаменатель
-- (docs/02, раздел 6).
CREATE TABLE day_commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_day_id UUID NOT NULL,
  occurrence_id UUID NOT NULL,
  frozen_expected_amount NUMERIC,
  minimum_amount NUMERIC,
  priority INTEGER NOT NULL DEFAULT 0,
  excused_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT day_commitments_amounts_non_negative
    CHECK ((frozen_expected_amount IS NULL OR frozen_expected_amount >= 0)
       AND (minimum_amount IS NULL OR minimum_amount >= 0)),
  CONSTRAINT day_commitments_minimum_not_greater
    CHECK (minimum_amount IS NULL OR frozen_expected_amount IS NULL
           OR minimum_amount <= frozen_expected_amount),
  CONSTRAINT day_commitments_unique UNIQUE (user_day_id, occurrence_id),
  CONSTRAINT day_commitments_day_same_owner
    FOREIGN KEY (user_id, user_day_id) REFERENCES user_days (user_id, id) ON DELETE CASCADE,
  CONSTRAINT day_commitments_occurrence_same_owner
    FOREIGN KEY (user_id, occurrence_id)
      REFERENCES quest_occurrences (user_id, id) ON DELETE CASCADE
);

ALTER TABLE activity_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_families FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_families_owner ON activity_families
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE user_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_days FORCE ROW LEVEL SECURITY;
CREATE POLICY user_days_owner ON user_days
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE quest_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY quest_templates_owner ON quest_templates
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE quest_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY quest_occurrences_owner ON quest_occurrences
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE quest_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY quest_actions_owner ON quest_actions
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE quest_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY quest_dependencies_owner ON quest_dependencies
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE day_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_commitments FORCE ROW LEVEL SECURITY;
CREATE POLICY day_commitments_owner ON day_commitments
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  activity_families, user_days, quest_templates, quest_occurrences,
  quest_actions, quest_dependencies, day_commitments
  TO app_runtime;
