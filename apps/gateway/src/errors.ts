export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_LICENSED'
  | 'PAYMENT_REQUIRED'
  | 'INTERNAL'

export const apiError = <D extends Record<string, unknown>>(
  code: ApiErrorCode,
  message: string,
  details: D,
) => ({ error: { code, message, details } })
