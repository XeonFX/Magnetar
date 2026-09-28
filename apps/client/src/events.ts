import type { RpcEventName, RpcEvents } from '@md/protocol'

type Handler<E extends RpcEventName> = (data: RpcEvents[E]) => void

/**
 * In-process bus for everything the dashboard is told about without asking. Services publish,
 * the RPC server forwards to every connected local or relayed dashboard, the tray listens too.
 */
export class EventBus {
  private readonly handlers = new Map<RpcEventName, Set<Handler<RpcEventName>>>()
  private readonly anyHandlers = new Set<(event: RpcEventName, data: unknown) => void>()

  on<E extends RpcEventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event)
    if (!set) this.handlers.set(event, (set = new Set()))
    set.add(handler as Handler<RpcEventName>)
    return () => set.delete(handler as Handler<RpcEventName>)
  }

  onAny(handler: (event: RpcEventName, data: unknown) => void): () => void {
    this.anyHandlers.add(handler)
    return () => this.anyHandlers.delete(handler)
  }

  emit<E extends RpcEventName>(event: E, data: RpcEvents[E]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(data)
      } catch (error) {
        console.error(`Event handler for ${event} failed`, error)
      }
    }
    for (const handler of this.anyHandlers) {
      try {
        handler(event, data)
      } catch (error) {
        console.error(`Event forwarder for ${event} failed`, error)
      }
    }
  }
}
