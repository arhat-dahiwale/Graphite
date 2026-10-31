/**
 * Typed application errors. Codes map 1:1 to the error table in API.md.
 * Never leak internals to clients: only `message`, `code`, and `details`
 * are serialized; `cause` stays in logs.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNPROCESSABLE"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      details?: Record<string, unknown>;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = options?.details;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      details: this.details ?? {},
    };
  }
}

export const badRequest = (msg: string, details?: Record<string, unknown>) =>
  new AppError("BAD_REQUEST", msg, { details });
export const unauthorized = (msg = "Missing or invalid credentials") =>
  new AppError("UNAUTHORIZED", msg);
export const forbidden = (msg = "You do not have permission to perform this action") =>
  new AppError("FORBIDDEN", msg);
export const notFound = (msg = "Resource not found") => new AppError("NOT_FOUND", msg);
export const conflict = (msg: string, details?: Record<string, unknown>) =>
  new AppError("CONFLICT", msg, { details });
export const payloadTooLarge = (msg: string) => new AppError("PAYLOAD_TOO_LARGE", msg);
export const unprocessable = (msg: string, details?: Record<string, unknown>) =>
  new AppError("UNPROCESSABLE", msg, { details });
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError("RATE_LIMITED", "Too many requests", { retryAfterSeconds });
export const quotaExceeded = (msg = "Usage quota reached") =>
  new AppError("QUOTA_EXCEEDED", msg);
export const internalError = (msg = "Unexpected error", cause?: unknown) =>
  new AppError("INTERNAL", msg, { cause });

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
