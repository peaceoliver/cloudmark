-- Tasks: a third item type with due dates, priorities, repeats, subtasks, reminders and links.
-- Runs on every start, so every statement is idempotent.

-- Allow 'task' in items.type (the original inline check only knew command and note).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'items'::regclass AND conname = 'items_type_check'
      AND pg_get_constraintdef(oid) LIKE '%task%'
  ) THEN
    ALTER TABLE items DROP CONSTRAINT IF EXISTS items_type_check;
    ALTER TABLE items ADD CONSTRAINT items_type_check CHECK (type IN ('command', 'note', 'task'));
  END IF;
END $$;

ALTER TABLE items ADD COLUMN IF NOT EXISTS status          VARCHAR(20);
ALTER TABLE items ADD COLUMN IF NOT EXISTS priority        SMALLINT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS due_at          TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN IF NOT EXISTS due_all_day     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS parent_item_id  BIGINT REFERENCES items(id) ON DELETE CASCADE;

-- Task-only columns stay empty on commands and notes; tasks always have a status.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'items'::regclass AND conname = 'items_task_fields') THEN
    ALTER TABLE items ADD CONSTRAINT items_task_fields CHECK (
      (type = 'task' AND status IN ('todo', 'doing', 'done') AND (priority IS NULL OR priority BETWEEN 1 AND 4)
        AND (recurrence_rule IS NULL OR due_at IS NOT NULL))
      OR (type <> 'task' AND status IS NULL AND priority IS NULL AND due_at IS NULL AND completed_at IS NULL
        AND recurrence_rule IS NULL AND parent_item_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'items'::regclass AND conname = 'items_task_has_title') THEN
    ALTER TABLE items ADD CONSTRAINT items_task_has_title CHECK (type <> 'task' OR title IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS items_task_due_idx ON items(owner_user_id, due_at)
  WHERE type = 'task' AND trashed = FALSE AND status <> 'done';
CREATE INDEX IF NOT EXISTS items_parent_idx ON items(parent_item_id) WHERE parent_item_id IS NOT NULL;

-- Reminders: either relative to the due time (offset_minutes before it) or at a fixed moment.
-- remind_at is always filled in, so the scheduler only has to look at one column.
CREATE TABLE IF NOT EXISTS item_reminders (
  id             BIGSERIAL PRIMARY KEY,
  item_id        BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  offset_minutes INTEGER CHECK (offset_minutes IS NULL OR offset_minutes BETWEEN 0 AND 525600),
  remind_at      TIMESTAMPTZ NOT NULL,
  channels       TEXT[] NOT NULL DEFAULT '{in_app,push,email}',
  sent_at        TIMESTAMPTZ,
  attempts       SMALLINT NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS item_reminders_item_idx ON item_reminders(item_id);
CREATE INDEX IF NOT EXISTS item_reminders_due_idx ON item_reminders(remind_at) WHERE sent_at IS NULL;

-- Links from an item to another item (note, command, task) or to a bookmark.
-- target_id is not a foreign key because it points into two tables; readers skip missing targets.
CREATE TABLE IF NOT EXISTS item_links (
  item_id     BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('item', 'bookmark')),
  target_id   BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS item_links_target_idx ON item_links(target_type, target_id);
