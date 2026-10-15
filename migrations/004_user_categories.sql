-- Assign the existing categories to their creators and scope future categories to their owner.
-- Owners are looked up from the data instead of fixed user ids, so this runs on any database.
-- Only rows without an owner are touched, so running it again never reassigns a category.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

-- MAIN is the public category shown to anonymous visitors: it belongs to the administrator.
UPDATE categories
  SET owner_user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
  WHERE name = 'MAIN'
    AND owner_user_id IS NULL;

-- Every other category goes to the user with the most bookmarks in it.
-- bookmarks.user_id holds either the username or the numeric user id as text.
UPDATE categories c
  SET owner_user_id = usage.user_id
  FROM (
    SELECT DISTINCT ON (b.category) b.category, u.id AS user_id
    FROM bookmarks b
    JOIN users u
      ON LOWER(CAST(b.user_id AS TEXT)) IN (LOWER(u.username), CAST(u.id AS TEXT))
    GROUP BY b.category, u.id
    ORDER BY b.category, COUNT(*) DESC, u.id
  ) AS usage
  WHERE usage.category = c.name
    AND c.name <> 'MAIN'
    AND c.owner_user_id IS NULL;

-- Categories nobody has bookmarked yet fall back to the administrator so they stay visible.
UPDATE categories
  SET owner_user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
  WHERE owner_user_id IS NULL;

ALTER TABLE categories
  DROP CONSTRAINT IF EXISTS categories_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS categories_owner_name_unique
  ON categories (COALESCE(owner_user_id, 0), LOWER(name));

CREATE INDEX IF NOT EXISTS categories_owner_idx
  ON categories(owner_user_id);
