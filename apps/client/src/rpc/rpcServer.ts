import {
  LOCAL_ONLY_METHODS, RPC_PARAMS, type ClientMessage, type RpcEventName, type RpcEvents, type RpcMethod, type RpcParsedParams,
  type RpcResults, type ServerMessage,
} from '@md/protocol'
import { ApiError } from '../api/errors.ts'
import type { EventBus } from '../events.ts'
import { logger } from '../log.ts'

const log = logger('rpc')

/** One connected dashboard: the local WebSocket or a relayed, end-to-end encrypted browser. */
export interface RpcChannel {
  readonly local: boolean
  send(message: ServerMessage): void
}

export interface RpcContext {
  readonly local: boolean
  /** Sends an event to this dashboard only (search streaming). */
  emit<E extends RpcEventName>(event: E, data: RpcEvents[E]): void
  /** Aborted when the dashboard disconnects. */
  readonly signal: AbortSignal
  /** Per-connection registry of in-flight searches, for cancellation. */
  readonly searches: Map<string, AbortController>
}

export type RpcHandlers = {
  [M in RpcMethod]: (params: RpcParsedParams<M>, context: RpcContext) => RpcResults[M] | Promise<RpcResults[M]>
}

export interface RpcSession {
  handle(message: ClientMessage): Promise<void>
  close(): void
}

/** Validates, dispatches and answers dashboard calls, and forwards broadcast events. */
export class RpcServer {
  constructor(private readonly handlers: RpcHandlers, private readonly events: EventBus) {}

  connect(channel: RpcChannel): RpcSession {
    const controller = new AbortController()
    const searches = new Map<string, AbortController>()
    const context: RpcContext = {
      local: channel.local,
      emit: (event, data) => channel.send({ event, data }),
      signal: controller.signal,
      searches,
    }
    const unsubscribe = this.events.onAny((event, data) => {
      if (!controller.signal.aborted) channel.send({ event, data })
    })

    return {
      handle: async message => {
        if (!message || typeof message.id !== 'number' || typeof message.method !== 'string') return
        const reply = (result: ServerMessage) => {
          if (!controller.signal.aborted) channel.send(result)
        }
        try {
          reply({ id: message.id, result: await this.dispatch(message.method, message.params, context) })
        } catch (error) {
          if (error instanceof ApiError) {
            reply({ id: message.id, error: { code: error.code, message: error.message } })
          } else {
            log.error(`${message.method} failed`, error)
            reply({ id: message.id, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
          }
        }
      },
      close: () => {
        controller.abort()
        for (const search of searches.values()) search.abort()
        unsubscribe()
      },
    }
  }

  private async dispatch(method: string, params: unknown, context: RpcContext): Promise<unknown> {
    if (!Object.hasOwn(RPC_PARAMS, method)) throw ApiError.notFound(`Unknown method ${method}`)
    const name = method as RpcMethod
    if (!context.local && LOCAL_ONLY_METHODS.has(name)) throw new ApiError(`${method} is only available on the device itself`, 'forbidden')
    const parsed = RPC_PARAMS[name].safeParse(params ?? {})
    if (!parsed.success) throw new ApiError(parsed.error.issues.map(i => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '))
    const handler = this.handlers[name] as (params: unknown, context: RpcContext) => unknown
    return (await handler(parsed.data, context)) ?? null
  }
}
