-- `features` is the website's features page (/features, /features/<language>): a device named that, in any case,
-- steps aside as 0003 did for `index`, with `-device` after its name or the first free -2, -3… on its account.
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
WHERE name = 'features' COLLATE NOCASE;
