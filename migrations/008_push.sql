-- Phone and browser push notifications (Web Push) and one-tap actions from notifications and e-mails.
-- Runs on every start, so it is idempotent.

-- One row per device (browser profile) that switched on notifications. The endpoint is the
-- push service address of that device; it moves to the new user if someone else signs in there.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  device_label VARCHAR(100),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);

-- Single-use tokens behind the „Kész” and „Szundi” buttons of a push notification or an e-mail.
-- Only the SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS notification_action_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notification_action_tokens_expiry_idx ON notification_action_tokens(expires_at);

-- A snooze is a one-off reminder; it is kept out of the task's own reminder list.
ALTER TABLE item_reminders ADD COLUMN IF NOT EXISTS is_snooze BOOLEAN NOT NULL DEFAULT FALSE;
