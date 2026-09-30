import services from './push-services.json'

export const MAX_PUSH_ENDPOINT_LENGTH = services.maxEndpointLength

/** Whether a push subscription's endpoint is a browser push service (the Rust device reads the same list). */
export function isPushService(endpoint: string): boolean {
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return false
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.port === ''
    && services.hosts.some(host => (host.startsWith('.') ? url.hostname.endsWith(host) : url.hostname === host))
}
