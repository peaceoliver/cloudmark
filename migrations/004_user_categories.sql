-- Keep default categories global and scope user-created categories to their owner.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE categories
  DROP CONSTRAINT IF EXISTS categories_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS categories_owner_name_unique
  ON categories (COALESCE(owner_user_id, 0), LOWER(name));

CREATE INDEX IF NOT EXISTS categories_owner_idx
  ON categories(owner_user_id);
