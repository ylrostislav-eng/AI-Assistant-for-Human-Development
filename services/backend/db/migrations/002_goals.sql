-- P1-01: слой целей (docs/02, раздел 4).
--
-- Milestone — измеримая проверка, Project — контейнер работы. Это разные
-- сущности, а не синонимы: у простой цели может не быть ни одного Project.
--
-- Все связи — составными ключами. Одиночный внешний ключ разрешает связать
-- свою запись с чужой; такая строка выглядит корректной при любом чтении и
-- обнаруживается только на чужих данных.

CREATE TABLE goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  why TEXT,
  start_date DATE NOT NULL,
  target_date DATE,
  success_criterion TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  difficulty_hint TEXT,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  -- Цель завершается по критерию, а не по накопленному XP (docs/02).
  CONSTRAINT goals_status_known
    CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  CONSTRAINT goals_target_after_start CHECK (target_date IS NULL OR target_date >= start_date),
  CONSTRAINT goals_owner_identity UNIQUE (user_id, id)
);

CREATE INDEX goals_by_status ON goals (user_id, status);

CREATE TABLE goal_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  baseline NUMERIC,
  target NUMERIC,
  direction TEXT NOT NULL,
  aggregation TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT goal_metrics_direction_known CHECK (direction IN ('increase', 'decrease', 'maintain')),
  CONSTRAINT goal_metrics_aggregation_known
    CHECK (aggregation IN ('count', 'sum', 'latest', 'pass_fail')),
  CONSTRAINT goal_metrics_goal_same_owner
    FOREIGN KEY (user_id, goal_id) REFERENCES goals (user_id, id) ON DELETE CASCADE
);

CREATE TABLE milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  target_date DATE,
  -- Рубрика — документ с версией, поэтому JSONB. Статус и связи в JSON не
  -- прячутся: по ним идут выборки и ограничения.
  rubric JSONB,
  rubric_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'blocked',
  evidence_policy TEXT NOT NULL DEFAULT 'self',
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- waived не даёт награды за веху (docs/02); это состояние, а не удаление.
  CONSTRAINT milestones_status_known
    CHECK (status IN ('blocked', 'available', 'achieved', 'waived')),
  CONSTRAINT milestones_goal_same_owner
    FOREIGN KEY (user_id, goal_id) REFERENCES goals (user_id, id) ON DELETE CASCADE,
  CONSTRAINT milestones_ordinal_unique UNIQUE (goal_id, ordinal),
  -- Цель ключа: на него ссылается projects, чтобы веха и проект принадлежали
  -- одной цели.
  CONSTRAINT milestones_goal_identity UNIQUE (goal_id, id)
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  goal_id UUID NOT NULL,
  milestone_id UUID,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT projects_status_known CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  CONSTRAINT projects_goal_same_owner
    FOREIGN KEY (user_id, goal_id) REFERENCES goals (user_id, id) ON DELETE CASCADE,
  -- «При указанных project_id и milestone_id все связанные Goal должны
  -- совпадать» (docs/02, раздел 4). Ссылка на (goal_id, milestone_id) делает
  -- это ограничением базы, а не договорённостью в коде.
  CONSTRAINT projects_milestone_same_goal
    FOREIGN KEY (goal_id, milestone_id) REFERENCES milestones (goal_id, id) ON DELETE SET NULL
);

CREATE TABLE goal_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  predecessor_goal_id UUID NOT NULL,
  successor_goal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Петля из одной вершины ловится здесь. Циклы длиннее одной связи база
  -- дёшево не проверяет: по docs/02, раздел 9, структура DAG проверяется при
  -- изменении под блокировкой пользователя. Это ограничение закрывает только
  -- самый частый случай и не заменяет ту проверку.
  CONSTRAINT goal_dependencies_no_self CHECK (predecessor_goal_id <> successor_goal_id),
  CONSTRAINT goal_dependencies_unique UNIQUE (predecessor_goal_id, successor_goal_id),
  CONSTRAINT goal_dependencies_predecessor_same_owner
    FOREIGN KEY (user_id, predecessor_goal_id) REFERENCES goals (user_id, id) ON DELETE CASCADE,
  CONSTRAINT goal_dependencies_successor_same_owner
    FOREIGN KEY (user_id, successor_goal_id) REFERENCES goals (user_id, id) ON DELETE CASCADE
);

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
CREATE POLICY goals_owner ON goals
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE goal_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY goal_metrics_owner ON goal_metrics
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones FORCE ROW LEVEL SECURITY;
CREATE POLICY milestones_owner ON milestones
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_owner ON projects
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE goal_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY goal_dependencies_owner ON goal_dependencies
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  goals, goal_metrics, milestones, projects, goal_dependencies
  TO app_runtime;
