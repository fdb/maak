-- Site-wide settings an admin changes on /admin. signup is open (anyone with a verified address may
-- make an account) or closed (only the allow-list and invitations; existing accounts still sign in).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('signup', 'open');
