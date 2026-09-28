/**
 * Fetches from a list of mirror hosts, starting with whichever last succeeded.
 *
 * Attempts are staggered rather than sequential: the preferred host goes first and each later one
 * starts only if nothing has answered within `staggerMs`. The first success wins and the rest are
 * aborted. Sequential rotation burned the full timeout on a slow host before trying the next —
 * apibay.org takes ~16s on an uncached query while a mirror answers in 0.4s.
 */
export class MirrorRotator<Host> {
  private preferred = 0

  constructor(private readonly hosts: readonly Host[], private readonly staggerMs = 1500) {
    if (hosts.length === 0) throw new Error('At least one host is required')
  }

  async fetch<T>(
    attempt: (host: Host, signal: AbortSignal) => Promise<T>,
    isRetryable: (error: unknown) => boolean,
    signal: AbortSignal,
  ): Promise<T> {
    const start = this.preferred
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])

    const run = async (offset: number): Promise<{ index: number; value: T }> => {
      const index = (start + offset) % this.hosts.length
      if (offset > 0) await delay(this.staggerMs * offset, combined)
      return { index, value: await attempt(this.hosts[index]!, combined) }
    }

    const pending = new Map(this.hosts.map((_, offset) => [offset, run(offset)] as const))
    let lastError: unknown
    while (pending.size > 0) {
      const settled = await Promise.race([...pending].map(([key, promise]) =>
        promise.then(value => ({ key, ok: true as const, value }), error => ({ key, ok: false as const, error }))))
      pending.delete(settled.key)
      if (settled.ok) {
        this.preferred = settled.value.index
        controller.abort()
        return settled.value.value
      }
      if (signal.aborted) throw settled.error
      if (!isRetryable(settled.error)) {
        controller.abort()
        throw settled.error
      }
      lastError = settled.error
    }
    throw lastError
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}
