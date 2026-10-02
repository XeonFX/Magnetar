import type {
  ClientMessage, RpcEventName, RpcEvents, RpcMethod, RpcParams, RpcResults, ServerMessage,
} from '@magnetar/protocol'
import { MAX_RELAY_FRAME } from '@magnetar/protocol/relay'

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
 * The largest message a call may be, in UTF-8: what the relay forwards, and what the app's own
 * socket takes too, so the dashboard behaves the same on either.
 */
const MAX_MESSAGE = MAX_RELAY_FRAME
const encoder = new TextEncoder()

/** The size of `text` in UTF-8 bytes, without encoding text that can't be near the limit. */
const tooLarge = (text: string) => text.length > MAX_MESSAGE || (text.length * 3 > MAX_MESSAGE && encoder.encode(text).length > MAX_MESSAGE)

/**
 * Request/response and events over some message transport. The dashboard uses one of these per
 * device, whether it is the local socket or an end-to-end encrypted relay channel.
 */
export abstract class RpcClient {
  /** The key this browser uses through the relay; null on the local dashboard. */
  readonly keyId: string | null = null

  get kind(): 'local' | 'remote' {
    return this.keyId === null ? 'local' : 'remote'
  }
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly eventHandlers = new Map<string, Set<(data: unknown) => void>>()
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>()
  state: ConnectionState = { status: 'connecting' }

  /**
   * Sends one call, serialized as `text`. Throws, or rejects, when it cannot go out, which fails
   * that call at once instead of leaving it to time out.
   */
  protected abstract transmit(text: string): void | Promise<void>
  abstract close(): void

  call<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResults[M]> {
    if (this.state.status !== 'open') return Promise.reject(new RpcError('offline', 'Not connected to the device'))
    const message: ClientMessage = { id: this.nextId++, method, params: params ?? {} }
    const text = JSON.stringify(message)
    if (tooLarge(text)) return Promise.reject(new RpcError('too_large', 'Too large to send to the device in one message'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(message.id, new RpcError('timeout', 'The device did not answer in time')), CALL_TIMEOUT_MS)
      this.pending.set(message.id, { resolve: resolve as (value: unknown) => void, reject, timer })
      const failed = () => this.settle(message.id, new RpcError('offline', 'Could not send to the device'))
      try {
        this.transmit(text)?.catch(failed)
      } catch {
        failed()
      }
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
    if ('error' in message) this.settle(message.id, new RpcError(message.error.code, message.error.message))
    else this.settle(message.id, null, message.result)
  }

  /** Ends a pending call with its result, or with `error`; a call already ended stays as it was. */
  private settle(id: number, error: Error | null, result?: unknown): void {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    if (error) call.reject(error)
    else call.resolve(result)
  }

  private failPending(reason: string): void {
    for (const id of this.pending.keys()) this.settle(id, new RpcError('offline', reason))
  }
}

/** Exponential backoff with jitter, capped. */
export function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 400
}
