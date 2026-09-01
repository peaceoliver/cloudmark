-- Add optional parent links while keeping existing categories and bookmarks intact.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories(parent_id);
