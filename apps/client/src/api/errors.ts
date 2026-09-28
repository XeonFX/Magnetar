import type { RpcErrorCode } from '@md/protocol'

/** A caller mistake with a message fit to show them — never a stack trace. */
export class ApiError extends Error {
  constructor(message: string, readonly code: RpcErrorCode = 'bad_request') {
    super(message)
    this.name = 'ApiError'
  }

  static notFound(message: string): ApiError {
    return new ApiError(message, 'not_found')
  }

  get httpStatus(): number {
    return { bad_request: 400, not_found: 404, rate_limited: 429, forbidden: 403, internal: 500 }[this.code]
  }
}
