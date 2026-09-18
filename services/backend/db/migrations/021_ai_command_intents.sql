-- Immutable server-prepared commands. Private snapshots are not AI context.
CREATE TABLE ai_command_intents (
  user_id UUID NOT NULL,
  turn_id UUID NOT NULL,
  step TEXT NOT NULL CHECK (length(step) BETWEEN 1 AND 160),
  call_id TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 128),
  phase TEXT NOT NULL CHECK (phase IN ('template', 'occurrence', 'complete')),
  command_id UUID NOT NULL,
  intent_hash TEXT NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  command_hash TEXT NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  hash_version INTEGER NOT NULL CHECK (hash_version = 2),
  document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 524288),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, turn_id, step),
  UNIQUE (user_id, command_id),
  FOREIGN KEY (user_id, turn_id) REFERENCES ai_turns(user_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ai_tool_call_identity ON ai_command_intents(user_id, turn_id, call_id) WHERE phase <> 'occurrence';
ALTER TABLE ai_command_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_command_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_command_intent_owner ON ai_command_intents
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
-- Append-only for BOTH application roles. Account deletion uses parent cascade.
GRANT SELECT, INSERT ON ai_command_intents TO app_runtime, app_worker;
