-- A device's name is the first part of its address on the website (/MacBook-Pro/search/dragon): ASCII letters
-- and digits joined by single hyphens, at most 40 characters, not one of the website's own paths, and unique per
-- account in any case (packages/protocol/src/device-names.json). New names are spelled by the Worker; this
-- rewrites the existing ones the same way, as far as SQL can: it knows fewer accented letters than the Worker.

CREATE TABLE device_names (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, name TEXT NOT NULL);

-- Common accented letters lose their accent, apostrophes go ("Krystian's" → "Krystians"), and every other
-- character that is not an ASCII letter or digit becomes a hyphen.
WITH RECURSIVE letters(letter, ascii) AS (VALUES
  ('ą', 'a'), ('ć', 'c'), ('ę', 'e'), ('ł', 'l'), ('ń', 'n'), ('ó', 'o'), ('ś', 's'), ('ź', 'z'), ('ż', 'z'),
  ('Ą', 'A'), ('Ć', 'C'), ('Ę', 'E'), ('Ł', 'L'), ('Ń', 'N'), ('Ó', 'O'), ('Ś', 'S'), ('Ź', 'Z'), ('Ż', 'Z'),
  ('ä', 'a'), ('ö', 'o'), ('ü', 'u'), ('Ä', 'A'), ('Ö', 'O'), ('Ü', 'U'), ('ß', 'ss'),
  ('á', 'a'), ('à', 'a'), ('â', 'a'), ('é', 'e'), ('è', 'e'), ('ê', 'e'), ('í', 'i'), ('ú', 'u'), ('ç', 'c'), ('ñ', 'n'),
  ('É', 'E'), ('Ç', 'C'), ('Ñ', 'N'), ('''', ''), ('’', '')
),
spelled(id, i, source, name) AS (
  SELECT id, 1, name, '' FROM devices
  UNION ALL
  SELECT id, i + 1, source, name || CASE
    WHEN substr(source, i, 1) GLOB '[A-Za-z0-9]' THEN substr(source, i, 1)
    ELSE coalesce((SELECT ascii FROM letters WHERE letter = substr(source, i, 1)), '-')
  END
  FROM spelled WHERE i <= length(source)
)
INSERT INTO device_names (id, user_id, created_at, name)
SELECT d.id, d.user_id, d.created_at, s.name FROM spelled s JOIN devices d ON d.id = s.id WHERE s.i = length(s.source) + 1;

-- Runs of hyphens become one (names were at most 60 characters), none at either end, at most 40 characters.
UPDATE device_names SET name = replace(replace(replace(replace(replace(replace(name, '--', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-');
UPDATE device_names SET name = trim(substr(trim(name, '-'), 1, 40), '-');
UPDATE device_names SET name = 'Magnetar' WHERE name = '';
UPDATE device_names SET name = name || '-device' WHERE lower(name) IN (
  'about', 'account', 'add', 'admin', 'api', 'app', 'assets', 'd', 'device', 'devices', 'download', 'downloads',
  'help', 'link', 'login', 'logout', 'new', 'pair', 'search', 'series', 'settings', 'static', 'www'
);

-- The oldest device keeps a name it shares with others on the account; the next get -2, -3…
UPDATE device_names SET name = trim(substr(name, 1, 40 - length(ranked.suffix)), '-') || ranked.suffix
FROM (
  SELECT id, '-' || row_number() OVER (PARTITION BY user_id, lower(name) ORDER BY created_at, id) AS suffix
  FROM device_names
) AS ranked
WHERE ranked.id = device_names.id AND ranked.suffix <> '-1';

UPDATE devices SET name = (SELECT name FROM device_names WHERE device_names.id = devices.id);
DROP TABLE device_names;

CREATE UNIQUE INDEX devices_user_name ON devices(user_id, name COLLATE NOCASE);
