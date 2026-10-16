-- Each user's own AI provider keys (Gemini, Anthropic, OpenAI-compatible) for the "AI kitöltés" buttons.
-- Runs on every start, so it is idempotent.
-- The key is stored only encrypted (AES-256-GCM, master secret in AI_KEY_ENCRYPTION_SECRET) and is
-- never sent back to the browser; key_last4 is what the settings show. Not part of the admin backup.
CREATE TABLE IF NOT EXISTS user_ai_keys (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       VARCHAR(20) NOT NULL,
  base_url       TEXT,
  label          VARCHAR(80),
  model          VARCHAR(120),
  key_ciphertext TEXT NOT NULL,
  key_iv         TEXT NOT NULL,
  key_tag        TEXT NOT NULL,
  key_last4      VARCHAR(4) NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_ai_keys_user_idx ON user_ai_keys(user_id);
-- At most one active key per user.
CREATE UNIQUE INDEX IF NOT EXISTS user_ai_keys_one_active_idx ON user_ai_keys(user_id) WHERE is_active;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_ai_keys_provider_check') THEN
    ALTER TABLE user_ai_keys ADD CONSTRAINT user_ai_keys_provider_check
      CHECK (provider IN ('gemini', 'anthropic', 'openai'));
  END IF;
END $$;

-- Keep the table closed to Supabase's public REST API (anon / authenticated roles): RLS on with no
-- policies. The server connects as the table owner, which RLS does not restrict.
ALTER TABLE user_ai_keys ENABLE ROW LEVEL SECURITY;
