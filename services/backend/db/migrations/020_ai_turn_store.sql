-- T-04b-3b1: internal durable turn storage, not yet used by the live bot.
-- Source identity is tenant + channel + scope (bot/installation) + request ID.
-- Checkpoint contains private transcript/refs; never expose it as AI context.
CREATE TABLE ai_turns (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id UUID NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'miniapp')),
  source_scope TEXT NOT NULL CHECK (length(source_scope) BETWEEN 1 AND 256),
  source_request_id TEXT NOT NULL CHECK (length(source_request_id) BETWEEN 1 AND 256),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 128),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  checkpoint_version TEXT NOT NULL CHECK (length(checkpoint_version) BETWEEN 1 AND 128),
  checkpoint JSONB NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'finished')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  CONSTRAINT ai_turn_source_identity UNIQUE (user_id, channel, source_scope, source_request_id),
  CONSTRAINT ai_turn_attempts_bound CHECK (attempts BETWEEN 0 AND max_attempts),
  CONSTRAINT ai_turn_lease_shape CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX ai_turn_expired ON ai_turns (lease_expires_at) WHERE status = 'running';
ALTER TABLE ai_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_turn_owner ON ai_turns
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON ai_turns TO app_runtime, app_worker;
-- No broad worker policy. Account cascade/privileged retention handle deletion.
