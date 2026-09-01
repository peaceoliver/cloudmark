-- CloudMark enterprise search, tags, import/export and sharing schema.
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS tags (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL, UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id BIGINT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, tag_id)
);
CREATE TABLE IF NOT EXISTS bookmark_shares (
  id BIGSERIAL PRIMARY KEY, bookmark_id BIGINT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  token CHAR(64) UNIQUE NOT NULL, permission VARCHAR(10) NOT NULL DEFAULT 'view',
  expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bookmarks_search_idx ON bookmarks USING gin(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(url,'') || ' ' || coalesce(description,'')));
