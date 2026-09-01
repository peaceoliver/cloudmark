ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'inbox';
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS trashed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS normalized_url TEXT;
UPDATE bookmarks SET normalized_url = url WHERE normalized_url IS NULL;
CREATE INDEX IF NOT EXISTS bookmarks_normalized_url_idx ON bookmarks(user_id, normalized_url);
