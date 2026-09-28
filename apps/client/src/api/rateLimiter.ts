import { ApiError } from './errors.ts'

const BURST = 10
const REFILL_MS = 3000

/**
 * Caps how fast agents make the app hit torrent sites. One search fans out to every source, and
 * these sites answer sustained load with Cloudflare challenges — which is how RARBG stopped
 * working. A token bucket lets a few calls through back to back but not a sustained stream, and
 * refuses fast with a wait hint instead of blocking.
 */
export class RateLimiter {
  private tokens = BURST
  private last: number

  constructor(private readonly now: () => number = Date.now) {
    this.last = now()
  }

  ensureAllowed(operation: string): void {
    const now = this.now()
    this.tokens = Math.min(BURST, this.tokens + (now - this.last) / REFILL_MS)
    this.last = now
    if (this.tokens < 1) {
      const wait = Math.ceil((REFILL_MS * (1 - this.tokens)) / 1000)
      throw new ApiError(
        `Too many ${operation} requests in a short time — each one queries every enabled torrent site, and hammering them gets this app blocked. Wait about ${wait}s and try again.`,
        'rate_limited')
    }
    this.tokens -= 1
  }
}
