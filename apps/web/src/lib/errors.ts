/** What went wrong, as text to show. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
