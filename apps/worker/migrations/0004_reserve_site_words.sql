-- Words the website may use for its own pages next (/changelog, /pricing, /status…), reserved now so a new page
-- never needs a migration or meets a device of that name (packages/protocol/src/device-names.json). A device named
-- one of them gets `-device` after its name, or the first free -2, -3… on its account, as 0003 did for `index`.
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
WHERE lower(name) IN (
  'auth', 'billing', 'blog', 'callback', 'changelog', 'community', 'console', 'contact', 'cookies', 'dashboard',
  'docs', 'faq', 'features', 'feedback', 'forum', 'get', 'guide', 'guides', 'health', 'home', 'imprint',
  'install', 'invite', 'join', 'legal', 'me', 'news', 'oauth', 'press', 'pricing', 'privacy', 'profile',
  'register', 'releases', 'roadmap', 'security', 'share', 'signin', 'signup', 'sitemap', 'start', 'status',
  'support', 'team', 'terms', 'updates', 'user', 'users', 'version', 'welcome'
);
