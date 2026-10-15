-- Shared storage for non-bookmark content: commands now, notes and other masscode-style types later.
-- Bookmarks keep their own table; nothing in it is touched here.

-- Categories are scoped per content type so command folders never show up among bookmark categories.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'bookmark';
ALTER TABLE categories ADD COLUMN IF NOT EXISTS default_language VARCHAR(30);
DROP INDEX IF EXISTS categories_owner_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS categories_owner_kind_name_unique
  ON categories (COALESCE(owner_user_id, 0), kind, LOWER(name));

CREATE TABLE IF NOT EXISTS items (
  id            BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          VARCHAR(20) NOT NULL CHECK (type IN ('command', 'note')),
  title         TEXT,
  description   TEXT,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  body          TEXT,
  color         VARCHAR(20),
  pinned        BOOLEAN NOT NULL DEFAULT FALSE,
  starred       BOOLEAN NOT NULL DEFAULT FALSE,
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  trashed       BOOLEAN NOT NULL DEFAULT FALSE,
  position      INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0,
  extra         JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT items_command_has_title CHECK (type <> 'command' OR title IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS items_owner_type_idx ON items(owner_user_id, type, trashed, updated_at DESC);
CREATE INDEX IF NOT EXISTS items_category_idx ON items(category_id);

-- Tabs inside one item, each with its own language (a single-tab command has exactly one row).
CREATE TABLE IF NOT EXISTS item_fragments (
  id        BIGSERIAL PRIMARY KEY,
  item_id   BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  label     VARCHAR(80),
  language  VARCHAR(30),
  content   TEXT NOT NULL,
  UNIQUE (item_id, position)
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS item_tags_tag_idx ON item_tags(tag_id);
