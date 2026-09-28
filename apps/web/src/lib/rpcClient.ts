import type {
  ClientMessage, RpcEventName, RpcEvents, RpcMethod, RpcParams, RpcResults, ServerMessage,
} from '@md/protocol'

export type ConnectionState =
  | { status: 'connecting' }
  | { status: 'open' }
  | { status: 'reconnecting' }
  /** Relay only: signed in and linked, but the device isn't connected to the relay right now. */
  | { status: 'device-offline' }
  /** Relay only: refused for good; `reason` is a translation key. */
  | { status: 'rejected'; reason: string }
  | { status: 'closed' }

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RpcError'
  }
}

const CALL_TIMEOUT_MS = 120_000

/**
 * Request/response and events over some message transport. The dashboard uses one of these per
 * device, whether it is the local socket or an end-to-end encrypted relay channel.
 */
export abstract class RpcClient {
  abstract readonly kind: 'local' | 'remote'
  /** The key this browser uses through the relay; null on the local dashboard. */
  readonly keyId: string | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly eventHandlers = new Map<string, Set<(data: unknown) => void>>()
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>()
  state: ConnectionState = { status: 'connecting' }

  protected abstract transmit(message: ClientMessage): void
  abstract close(): void

  call<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResults[M]> {
    if (this.state.status !== 'open') return Promise.reject(new RpcError('offline', 'Not connected to the device'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError('timeout', 'The device did not answer in time'))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.transmit({ id, method, params: params ?? {} })
    })
  }

  on<E extends RpcEventName>(event: E, handler: (data: RpcEvents[E]) => void): () => void {
    let set = this.eventHandlers.get(event)
    if (!set) this.eventHandlers.set(event, (set = new Set()))
    set.add(handler as (data: unknown) => void)
    return () => set.delete(handler as (data: unknown) => void)
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }

  protected setState(state: ConnectionState): void {
    this.state = state
    if (state.status !== 'open') this.failPending(state.status === 'closed' ? 'Connection closed' : 'Connection lost')
    for (const handler of this.stateHandlers) handler(state)
  }

  protected receive(message: ServerMessage): void {
    if ('event' in message) {
      for (const handler of this.eventHandlers.get(message.event) ?? []) handler(message.data)
      return
    }
    const call = this.pending.get(message.id)
    if (!call) return
    this.pending.delete(message.id)
    clearTimeout(call.timer)
    if ('error' in message) call.reject(new RpcError(message.error.code, message.error.message))
    else call.resolve(message.result)
  }

  private failPending(reason: string): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new RpcError('offline', reason))
      this.pending.delete(id)
    }
  }
}

/** Exponential backoff with jitter, capped. */
export function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 400
}
