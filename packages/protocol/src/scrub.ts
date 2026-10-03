/**
 * Strips anything that could identify the user or what they download before an error report
 * leaves their device: quoted text (torrent titles), URLs and magnets, paths, e-mail and IP
 * addresses, and long hex/base64 runs (hashes, tokens, ids). What remains is the failure's shape.
 * Used by both the app and the website so the two can't drift apart.
 */
export function scrub(text: string): string {
  // As `apps/client/src/protocol/scrub.rs` writes them, with no class whose meaning differs between the two: white space
  // spelled out, and `\b` the ASCII word boundary both have (`(?-u:\b)` there).
  return text
    .replace(/https?:\/\/[^\t\n\v\f\r '")]+/gi, '<url>')
    .replace(/magnet:\?[^\t\n\v\f\r '")]+/gi, '<magnet>')
    .replace(/[^\t\n\v\f\r "'<>()@:,;]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/g, '<email>')
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”/g, '"…"')
    // All of it, names with spaces and relative paths too, up to a colon, quote or bracket: a file's or folder's name
    // is often the torrent's.
    .replace(/(?:[A-Za-z]:|[^\t\n\v\f\r "'():\\/]+)?(?:[\\/][^\n"'():\\/]*)+/g, path => `<path>${/[ \t\r]*$/.exec(path)![0]}`)
    .replace(/\b[0-9]{1,3}(?:\.[0-9]{1,3}){3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
}
