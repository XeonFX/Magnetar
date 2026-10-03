/**
 * Strips anything that could identify the user or what they download before an error report
 * leaves their device: quoted text (torrent titles), URLs and magnets, paths, e-mail and IP
 * addresses, and long hex/base64 runs (hashes, tokens, ids). What remains is the failure's shape.
 * Used by both the app and the website so the two can't drift apart.
 */
export function scrub(text: string): string {
  return text
    .replace(/https?:\/\/[^\s'")]+/gi, '<url>')
    .replace(/magnet:\?[^\s'")]+/gi, '<magnet>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”/g, '"…"')
    // All of it: a file's own name is often the torrent's.
    .replace(/(?:[A-Za-z]:)?(?:[\\/]+[^\\/\s:'"()]+)+/g, '<path>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
}
