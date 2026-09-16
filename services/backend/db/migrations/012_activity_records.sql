-- P1-06 (остаток R6 из docs/15-backend-review.md): факт выполнения.
--
-- До этой миграции завершение задания меняло только статус. «Сделал» без
-- объёма и времени ничем не отличается от «нажал кнопку»: через неделю
-- восстановить, сколько было на самом деле, неоткуда, а награда считалась бы по
-- запланированному объёму — то есть по намерению, а не по факту.
--
-- Прежние завершения намеренно не переносятся и не досочиняются. У них фактов
-- нет и взять их неоткуда; синтетическая запись задним числом навсегда
-- смешалась бы с измеренной. Задание, завершённое до этой миграции, остаётся
-- без факта — и это видно.

CREATE TABLE activity_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  occurrence_id UUID NOT NULL,

  -- Корень связывает завершение, минимум, добавленные минуты, подтверждение
  -- внешнего адаптера и исправление в один факт (docs/02, раздел 5). Новый
  -- способ доказательства уточняет действие, а не создаёт второе.
  root_activity_id UUID NOT NULL,
  replaces_id UUID,

  occurred_start TIMESTAMPTZ,
  occurred_end TIMESTAMPTZ,
  duration_seconds INTEGER,
  amount NUMERIC,
  unit TEXT,

  -- measured — объём известен; unknown — человек отметил выполнение, не измеряя.
  -- Разделение важнее удобства: без него отметку не отличить от измерения.
  measurement TEXT NOT NULL,
  -- Откуда факт: сам человек, таймер, устройство, импорт. Устройство не
  -- означает криптографического доказательства (docs/02, раздел 5).
  source TEXT NOT NULL DEFAULT 'self',
  variant TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'accepted',

  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT activity_records_measurement_known CHECK (measurement IN ('measured', 'unknown')),
  CONSTRAINT activity_records_source_known
    CHECK (source IN ('self', 'timer', 'device', 'import')),
  CONSTRAINT activity_records_variant_known CHECK (variant IN ('normal', 'minimum', 'partial')),
  CONSTRAINT activity_records_state_known
    CHECK (state IN ('accepted', 'superseded', 'reversed')),

  -- Измеренный факт обязан что-то содержать, иначе он не измерен.
  CONSTRAINT activity_records_measured_has_value
    CHECK (measurement <> 'measured' OR duration_seconds IS NOT NULL OR amount IS NOT NULL),
  -- И обратное, главное: неизвестный объём остаётся пустым. Подстановка
  -- запланированного значения — выдумка, которую потом не отличить от
  -- измерения, поэтому запрет держит и база, а не только код.
  CONSTRAINT activity_records_unknown_has_no_value
    CHECK (measurement <> 'unknown' OR (duration_seconds IS NULL AND amount IS NULL)),

  CONSTRAINT activity_records_duration_non_negative
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CONSTRAINT activity_records_amount_non_negative CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT activity_records_interval_ordered
    CHECK (occurred_start IS NULL OR occurred_end IS NULL OR occurred_end >= occurred_start),
  CONSTRAINT activity_records_no_self_replace CHECK (replaces_id IS NULL OR replaces_id <> id),

  CONSTRAINT activity_records_occurrence_same_owner
    FOREIGN KEY (user_id, occurrence_id)
      REFERENCES quest_occurrences (user_id, id) ON DELETE CASCADE,
  CONSTRAINT activity_records_owner_identity UNIQUE (user_id, id),
  CONSTRAINT activity_records_replaces_same_owner
    FOREIGN KEY (user_id, replaces_id) REFERENCES activity_records (user_id, id)
);

-- Один принятый факт на задание. Два — это две награды за одно действие;
-- уточнение обязано заменить прежний, а не встать рядом.
CREATE UNIQUE INDEX activity_records_one_accepted
  ON activity_records (occurrence_id) WHERE state = 'accepted';

CREATE INDEX activity_records_root ON activity_records (user_id, root_activity_id);

ALTER TABLE activity_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_records FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_records_owner ON activity_records
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON activity_records TO app_runtime;
