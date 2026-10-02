-- `index` is the website's own word too: the static assets answer /index with a redirect to /, so a device named
-- that could never open its own page. It gets `-device` after its name, as 0002 did for the other words, and the
-- first free -2, -3… when the account already has that name (as uniqueDeviceName in packages/protocol). An account
-- with n devices has a free one among the first n.
UPDATE devices SET name = (
  WITH RECURSIVE candidates(i, name) AS (
    SELECT 1, devices.name || '-device'
    UNION ALL
    SELECT i + 1, devices.name || '-device-' || (i + 1) FROM candidates
    WHERE i < (SELECT count(*) FROM devices mine WHERE mine.user_id = devices.user_id)
  )
  SELECT candidates.name FROM candidates
  WHERE NOT EXISTS (SELECT 1 FROM devices other WHERE other.user_id = devices.user_id AND other.name = candidates.name COLLATE NOCASE)
  ORDER BY i LIMIT 1
)
WHERE name = 'index' COLLATE NOCASE;
