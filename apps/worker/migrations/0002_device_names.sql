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

-- The oldest device keeps a name it shares with others on the account; the next get -2, -3…: the first numbers no
-- kept name on the account has. Numbered names are cut to 36 characters before their number, so two devices whose
-- names a cut makes one share one row of numbers.
WITH RECURSIVE numbers(k) AS (
  SELECT 2
  UNION ALL
  SELECT k + 1 FROM numbers WHERE k <= (SELECT max(n) FROM (SELECT count(*) AS n FROM device_names GROUP BY user_id))
),
ranked AS (
  SELECT id, user_id, name, created_at, row_number() OVER (PARTITION BY user_id, lower(name) ORDER BY created_at, id) AS rank
  FROM device_names
),
numbered AS (
  SELECT id, user_id, trim(substr(name, 1, 36), '-') AS stem,
    row_number() OVER (PARTITION BY user_id, lower(trim(substr(name, 1, 36), '-')) ORDER BY created_at, id) AS nth
  FROM ranked WHERE rank > 1
),
free AS (
  SELECT numbered.id, numbered.nth, numbered.stem || '-' || numbers.k AS name,
    row_number() OVER (PARTITION BY numbered.id ORDER BY numbers.k) AS position
  FROM numbered JOIN numbers
  WHERE NOT EXISTS (
    SELECT 1 FROM ranked kept WHERE kept.rank = 1 AND kept.user_id = numbered.user_id AND lower(kept.name) = lower(numbered.stem || '-' || numbers.k)
  )
)
UPDATE device_names SET name = free.name FROM free WHERE free.id = device_names.id AND free.position = free.nth;

UPDATE devices SET name = (SELECT name FROM device_names WHERE device_names.id = devices.id);
DROP TABLE device_names;

CREATE UNIQUE INDEX devices_user_name ON devices(user_id, name COLLATE NOCASE);
