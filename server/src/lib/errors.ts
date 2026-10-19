// A single error shape for every failure: { error: { code, message } }.
// Messages are written for API clients and never include internals.

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'internal_error'
  | 'unavailable';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal_error: 500,
  unavailable: 503,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new ApiError('not_found', `${what} not found`);
