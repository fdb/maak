-- One row per object in R2: projects/<project_id>/<hash>. A save adds a row, the cleanup removes it
-- with the object. Snapshots keep objects alive for 30 days, so this is what a person really holds.
CREATE TABLE blobs (
  project_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, hash)
);

-- The sum of blobs.size over a person's projects, the trash included. A save adds to it; the
-- cleanup counts it again from blobs.
ALTER TABLE users ADD COLUMN held_bytes INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO blobs (project_id, hash, size, created_at)
  SELECT project_id, hash, size, updated_at FROM files WHERE kind = 'file';

INSERT OR IGNORE INTO blobs (project_id, hash, size, created_at)
  SELECT s.project_id, json_extract(j.value, '$.hash'), json_extract(j.value, '$.size'), s.created_at
  FROM snapshots s, json_each(s.manifest) j
  WHERE json_extract(j.value, '$.kind') = 'file';

UPDATE users SET held_bytes = COALESCE(
  (SELECT SUM(b.size) FROM blobs b JOIN projects p ON p.id = b.project_id WHERE p.owner_id = users.id), 0);
