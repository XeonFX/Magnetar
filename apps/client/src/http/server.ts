import type { Server, ServerWebSocket } from 'bun'
import type { ClientMessage } from '@md/protocol'
import type { App } from '../app.ts'
import { IS_DEV } from '../config.ts'
import { logger } from '../log.ts'
import type { RpcSession } from '../rpc/rpcServer.ts'
import { evaluateAgentRequest, isAgentPath, isAllowedLoopbackOrigin, isLoopbackAddress, isLoopbackHostname, refusal } from './agentAuth.ts'
import { handleMcp } from './mcp.ts'
import { openApiDocument } from './openapi.ts'
import { createRestApi } from './restApi.ts'
import { staticAsset } from './static.ts'

const log = logger('http')
const MAX_WS_MESSAGE = 256 * 1024

interface SocketData {
  session: RpcSession | null
}

/** The Vite dev server's origin, allowed to open the dashboard socket in development only. */
const DEV_ORIGIN = IS_DEV ? (process.env.MD_DEV_ORIGIN ?? 'http://localhost:5173') : null

/**
 * Resolves who is really asking. A TLS reverse proxy on this machine may forward the real client
 * address and scheme; those headers are trusted from a loopback peer only, and only one hop deep,
 * so a LAN caller can't claim to be 127.0.0.1.
 */
function clientFacts(request: Request, peer: string | null): { loopback: boolean; https: boolean; forwarded: boolean } {
  const peerIsLoopback = isLoopbackAddress(peer)
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (peerIsLoopback && forwardedFor) {
    const hops = forwardedFor.split(',').map(h => h.trim()).filter(Boolean)
    return { loopback: hops.length === 1 && isLoopbackAddress(hops[0]), https: request.headers.get('x-forwarded-proto') === 'https', forwarded: true }
  }
  return { loopback: peerIsLoopback, https: false, forwarded: false }
}

const notFound = () => Response.json({ error: 'Not found.' }, { status: 404 })

export function startHttpServer(app: App, preferredPort: number): Server<SocketData> {
  const rest = createRestApi(app.actions, app.settings)

  const fetch = async (request: Request, server: Server<SocketData>): Promise<Response | undefined> => {
    const url = new URL(request.url)
    const facts = clientFacts(request, server.requestIP(request)?.address ?? null)

    if (isAgentPath(url.pathname)) {
      const result = evaluateAgentRequest({
        enabled: app.agent.enabled,
        allowRemote: app.agent.allowRemote,
        token: app.agent.token,
        clientIsLoopback: facts.loopback,
        isHttps: facts.https,
        origin: request.headers.get('origin'),
        host: request.headers.get('host'),
        authorization: request.headers.get('authorization'),
      })
      if (result !== 'allowed') {
        if (result !== 'disabled') log.warn(`Agent request to ${url.pathname} refused (${result})`)
        return refusal(result)
      }
      if (url.pathname === '/mcp') return handleMcp(request, app.actions, app.settings)
      if (url.pathname === '/openapi/v1.json') return Response.json(openApiDocument())
      return rest(request, url)
    }

    // The dashboard, its socket and static files exist for this machine only, and only under a
    // loopback host name — a DNS-rebound name pointing at 127.0.0.1 gets nothing.
    if (!facts.loopback || facts.forwarded || !isLoopbackHostname(url.hostname)) return notFound()

    if (url.pathname === '/ws') {
      const origin = request.headers.get('origin')
      const allowed = origin !== null && (isAllowedLoopbackOrigin(origin, request.headers.get('host')) || origin === DEV_ORIGIN)
      if (!allowed) return new Response('Forbidden', { status: 403 })
      return server.upgrade(request, { data: { session: null } }) ? undefined : new Response('Upgrade required', { status: 426 })
    }
    if (url.pathname === '/health') return Response.json({ ok: true })
    return staticAsset(url.pathname)
  }

  const websocket = {
    maxPayloadLength: MAX_WS_MESSAGE,
    open(ws: ServerWebSocket<SocketData>) {
      ws.data.session = app.rpc.connect({ local: true, send: message => ws.send(JSON.stringify(message)) })
    },
    message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
      let message: ClientMessage
      try {
        message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as ClientMessage
      } catch {
        return
      }
      void ws.data.session?.handle(message)
    },
    close(ws: ServerWebSocket<SocketData>) {
      ws.data.session?.close()
    },
  }

  // Walk forward from the preferred port if another app already holds it.
  for (let port = preferredPort; port < preferredPort + 50; port++) {
    try {
      const server = Bun.serve<SocketData>({ hostname: 'localhost', port, fetch, websocket, idleTimeout: 60 })
      log.info(`Dashboard at http://localhost:${server.port}`)
      return server
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`No free port between ${preferredPort} and ${preferredPort + 49}`)
}
