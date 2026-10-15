-- In-app notifications (the bell) and the check the database scheduler uses to decide
-- whether the app has notification work to do. Runs on every start, so it is idempotent.

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       VARCHAR(30) NOT NULL CHECK (kind IN ('task_reminder', 'daily_digest', 'test')),
  title      TEXT NOT NULL,
  body       TEXT,
  item_id    BIGINT REFERENCES items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

-- TRUE when a task reminder is due or a user's daily digest time has come and it was not sent today.
-- The Supabase pg_cron job calls this every minute and only wakes the web service when it is TRUE,
-- so a sleeping free-tier instance is not woken up for nothing.
CREATE OR REPLACE FUNCTION notification_work_pending() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM item_reminders r JOIN items i ON i.id = r.item_id
    WHERE r.sent_at IS NULL AND r.remind_at <= NOW()
      AND i.type = 'task' AND i.trashed = FALSE AND i.status <> 'done'
  ) OR EXISTS (
    SELECT 1
    FROM settings_user digest
    LEFT JOIN settings_user zone ON zone.user_id = digest.user_id AND zone.setting_key = 'timezone'
    LEFT JOIN settings_user last_sent ON last_sent.user_id = digest.user_id AND last_sent.setting_key = 'dailyDigestLastSent'
    CROSS JOIN LATERAL (SELECT NOW() AT TIME ZONE COALESCE(zone.value #>> '{}', 'Europe/Budapest') AS local_now) l
    WHERE digest.setting_key = 'dailyDigestTime'
      -- A CASE garantálja, hogy érvénytelen (pl. 'off') értéket ne próbáljon időponttá alakítani.
      AND CASE WHEN (digest.value #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
               THEN l.local_now::time >= (digest.value #>> '{}')::time ELSE FALSE END
      AND COALESCE(last_sent.value #>> '{}', '') <> l.local_now::date::text
  );
$$;
