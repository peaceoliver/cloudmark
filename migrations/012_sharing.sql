-- Sharing items with other users (by e-mail address) and the contacts list built from it.
-- Runs on every start, so it is idempotent. RLS is switched on for the new tables by 010.

-- One row per (item, recipient). The recipient's own state (category, pin, star, archive) lives here,
-- so it never mixes with the owner's. recipient_user_id stays NULL while the address has no account.
CREATE TABLE IF NOT EXISTS shares (
  id                    BIGSERIAL PRIMARY KEY,
  owner_user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id               BIGINT REFERENCES items(id) ON DELETE CASCADE,
  bookmark_id           BIGINT REFERENCES bookmarks(id) ON DELETE CASCADE,
  recipient_user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  recipient_email       VARCHAR(255) NOT NULL,
  permission            VARCHAR(10) NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit')),
  status                VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  recipient_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  recipient_pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  recipient_starred     BOOLEAN NOT NULL DEFAULT FALSE,
  recipient_archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at           TIMESTAMPTZ,
  CONSTRAINT shares_one_target CHECK ((item_id IS NULL) <> (bookmark_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS shares_item_recipient_unique ON shares(item_id, recipient_email) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shares_bookmark_recipient_unique ON shares(bookmark_id, recipient_email) WHERE bookmark_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shares_recipient_idx ON shares(recipient_user_id, status);
CREATE INDEX IF NOT EXISTS shares_pending_email_idx ON shares(recipient_email) WHERE recipient_user_id IS NULL;

-- People a user shared with or got shares from. auto_accept: shares from this contact skip the
-- „Elfogadom” step (set when the user accepts that person's first share).
CREATE TABLE IF NOT EXISTS contacts (
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auto_accept     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, contact_user_id),
  CONSTRAINT contacts_not_self CHECK (user_id <> contact_user_id)
);

-- Bell entries for shares: an invitation (with Elfogadom / Elutasítom) and plain share news.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS share_id BIGINT REFERENCES shares(id) ON DELETE CASCADE;
DO $$
DECLARE
  definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_kind_check';
  IF definition IS NULL OR position('share_invite' IN definition) = 0 THEN
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
    ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
      CHECK (kind IN ('task_reminder', 'daily_digest', 'test', 'share_invite', 'share_info'));
  END IF;
END $$;
