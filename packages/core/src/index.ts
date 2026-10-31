// Browser-safe barrel: no dotenv, no Node-only modules.
export * from "./ids.js";
export * from "./logger.js";
export * from "./errors.js";
export * from "./authz.js";
export * from "./events.js";

/** Reject after `ms` even if the promise never settles. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = "timeout"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms).unref(),
    ),
  ]);
}
