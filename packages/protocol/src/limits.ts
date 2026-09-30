/** Limits the dashboard checks before calling the device; plain constants, free of the zod schemas. */

/** The engine refuses caps below this (bytes per second); 0 is no cap. */
export const MIN_SPEED_LIMIT = 32 * 1024

/** Largest .torrent file accepted, before base64. */
export const MAX_TORRENT_FILE = 4 * 1024 * 1024
