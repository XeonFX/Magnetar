/** Limits the dashboard checks before calling the device; plain constants, free of the zod schemas. */

/** The engine refuses caps below this (bytes per second); 0 is no cap. */
export const MIN_SPEED_LIMIT = 32 * 1024

/** Largest .torrent file accepted, before base64. */
export const MAX_TORRENT_FILE = 4 * 1024 * 1024

/**
 * A .torrent file larger than this goes to the device in pieces of this size (`downloads.upload`):
 * base64 in JSON in a sealed frame stays well under the relay's 1 MiB (`MAX_RELAY_FRAME`).
 */
export const TORRENT_UPLOAD_CHUNK = 512 * 1024

/** Entries one `fs.browse` page holds at most (`system::folders::MAX_PAGE` on the device). */
export const FOLDER_PAGE_MAX = 200
