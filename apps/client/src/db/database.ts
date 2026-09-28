import { Database } from 'bun:sqlite'

/**
 * Schema versions, applied in order and recorded in `PRAGMA user_version`. Append only: a shipped
 * migration never changes, a new one is added after it.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE series_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    provider TEXT,
    title_filter TEXT,
    season INTEGER,
    start_episode INTEGER NOT NULL DEFAULT 1,
    end_episode INTEGER,
    download_folder TEXT,
    last_downloaded_episode INTEGER NOT NULL DEFAULT 0,
    check_interval_minutes INTEGER NOT NULL DEFAULT 60,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_checked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_is_placeholder INTEGER NOT NULL DEFAULT 0,
    magnet_uri TEXT NOT NULL,
    info_hash TEXT NOT NULL COLLATE NOCASE UNIQUE,
    save_path TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT,
    start_notification_sent INTEGER NOT NULL DEFAULT 0,
    complete_notification_sent INTEGER NOT NULL DEFAULT 0,
    series_task_id INTEGER REFERENCES series_tasks(id) ON DELETE SET NULL
  );
  CREATE INDEX downloads_series_task ON downloads(series_task_id);
  CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE browser_keys (
    key_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
]

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: Database): void {
  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!)
      db.exec(`PRAGMA user_version = ${version + 1}`)
    })()
  }
}

/** Tiny key/value store for app state that isn't worth a table (device id, import markers…). */
export class KeyValue {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db.query('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | null
    return row?.value ?? null
  }

  set(key: string, value: string | null): void {
    if (value === null) this.db.query('DELETE FROM kv WHERE key = ?').run(key)
    else this.db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }
}
