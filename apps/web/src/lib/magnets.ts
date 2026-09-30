/** Every magnet link in a block of text, one per line or run together. */
export function magnetsIn(text: string): string[] {
  return [...new Set(text.match(/magnet:\?[^\s"'<>]+/gi) ?? [])]
}
