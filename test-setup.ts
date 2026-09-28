import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tests never touch the real per-user data directory.
process.env.MD_DATA_DIRECTORY ??= mkdtempSync(join(tmpdir(), 'md-test-'))
process.env.MD_CLOUD_URL ??= 'http://cloud.invalid'
