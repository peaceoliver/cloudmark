-- Assign the existing categories to their creators and scope future categories to their owner.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

UPDATE categories
  SET owner_user_id = 3
  WHERE name <> 'MAIN';

UPDATE categories
  SET owner_user_id = 5
  WHERE name = 'MAIN';

ALTER TABLE categories
  DROP CONSTRAINT IF EXISTS categories_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS categories_owner_name_unique
  ON categories (COALESCE(owner_user_id, 0), LOWER(name));

CREATE INDEX IF NOT EXISTS categories_owner_idx
  ON categories(owner_user_id);
