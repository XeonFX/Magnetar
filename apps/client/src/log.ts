import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { IS_DEV } from './config.ts'
import { paths } from './paths.ts'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const MIN_LEVEL: Level = IS_DEV ? 'debug' : 'info'
const RETAINED_DAYS = 14

type ErrorSink = (error: unknown, context: string) => void
let errorSink: ErrorSink | null = null

/** Errors logged anywhere are also handed to this sink (telemetry). */
export function setErrorSink(sink: ErrorSink | null): void {
  errorSink = sink
}

let currentFile = ''
function logFile(): string {
  const day = new Date().toISOString().slice(0, 10)
  const file = join(paths.logs, `app-${day}.log`)
  if (file !== currentFile) {
    currentFile = file
    mkdirSync(paths.logs, { recursive: true })
    pruneOldLogs()
  }
  return file
}

function pruneOldLogs(): void {
  try {
    const files = readdirSync(paths.logs).filter(f => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
    for (const old of files.slice(0, Math.max(0, files.length - RETAINED_DAYS))) rmSync(join(paths.logs, old))
  } catch {
    // Pruning is housekeeping; never let it break logging.
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

function write(level: Level, scope: string, message: string, error?: unknown): void {
  if (ORDER[level] < ORDER[MIN_LEVEL]) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${error ? `\n${describe(error)}` : ''}`
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
  try {
    appendFileSync(logFile(), line + '\n')
  } catch {
    // A full or read-only disk must not take the app down with it.
  }
  if (level === 'error' && errorSink) errorSink(error ?? new Error(message), scope)
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
}

export function logger(scope: string): Logger {
  return {
    debug: message => write('debug', scope, message),
    info: message => write('info', scope, message),
    warn: (message, error) => write('warn', scope, message, error),
    error: (message, error) => write('error', scope, message, error),
  }
}
