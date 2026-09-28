import { decodeHTML } from 'entities'

/** Strips a scraped HTML description block to readable plain text. */
export function htmlToPlainText(html: string | null | undefined): string | null {
  if (!html || !html.trim()) return null
  const withBreaks = html.replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
  const stripped = withBreaks.replace(/<[^>]+>/g, '')
  const collapsed = decodeHTML(stripped).replace(/\n{3,}/g, '\n\n').trim()
  return collapsed || null
}
