-- A suspended person cannot sign in, and their shared sites answer 404 until the suspension ends.
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
ALTER TABLE users ADD COLUMN suspended_reason TEXT NOT NULL DEFAULT '';

-- A blocked project cannot be shared. The owner sees the reason. NULL means not blocked.
ALTER TABLE projects ADD COLUMN blocked_reason TEXT;

-- Every moderation action, with its reason: the statement of reasons the DSA asks for.
-- action is block, unblock, suspend or restore. target is a project name or a user email.
CREATE TABLE moderation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT NOT NULL
);
