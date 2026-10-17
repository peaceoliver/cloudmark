-- Accounts (Fiókok): a fourth item type for logins, with end-to-end encrypted secrets.
-- Runs on every start, so every statement is idempotent.
-- The browser encrypts the password and the secret note with a key derived from the user's master
-- password; the server only stores ciphertext and can never decrypt it.

-- Allow 'account' in items.type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'items'::regclass AND conname = 'items_type_check'
      AND pg_get_constraintdef(oid) LIKE '%account%'
  ) THEN
    ALTER TABLE items DROP CONSTRAINT IF EXISTS items_type_check;
    ALTER TABLE items ADD CONSTRAINT items_type_check CHECK (type IN ('command', 'note', 'task', 'account'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'items'::regclass AND conname = 'items_account_has_title') THEN
    ALTER TABLE items ADD CONSTRAINT items_account_has_title CHECK (type <> 'account' OR title IS NOT NULL);
  END IF;
END $$;

-- One vault per user: the random vault key, wrapped (AES-GCM) with a key derived from the master
-- password, and again with the recovery key. Nothing here lets the server derive or unwrap the key.
CREATE TABLE IF NOT EXISTS user_vaults (
  user_id              BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kdf                  VARCHAR(30) NOT NULL DEFAULT 'pbkdf2-sha256',
  kdf_iterations       INTEGER NOT NULL,
  salt                 TEXT NOT NULL,
  wrapped_key          TEXT NOT NULL,
  wrapped_iv           TEXT NOT NULL,
  recovery_salt        TEXT,
  recovery_wrapped_key TEXT,
  recovery_wrapped_iv  TEXT,
  -- SHA-256 of a token the browser derives from the vault key: proves the vault is unlocked before the
  -- wrapping is replaced, without telling the server anything about the key.
  key_check            TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The encrypted part of an account ({ password, secretNote } as JSON), kept out of the items row so
-- list, search and AI queries never touch it.
CREATE TABLE IF NOT EXISTS item_secrets (
  item_id     BIGINT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Closed to Supabase's public REST API like every other table (no policies).
ALTER TABLE user_vaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_secrets ENABLE ROW LEVEL SECURITY;
