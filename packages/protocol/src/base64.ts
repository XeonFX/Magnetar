/** Standard base64 (RFC 4648 §4) for file contents in calls: natively where the runtime can. */

/** Bytes to standard base64. */
export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (native) return native.call(bytes)
  let binary = ''
  // String.fromCharCode takes its bytes as arguments: a slice at a time stays under the stack limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Standard base64 to bytes (a `stream.read` is ~450 KB). Throws on text that isn't base64. */
export function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64
  if (native) return native(data)
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
