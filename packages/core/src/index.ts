// Browser-safe barrel: no dotenv, no Node-only modules.
export * from "./ids";
export * from "./logger";
export * from "./errors";
export * from "./authz";
export * from "./events";
export * from "./csv";
export * from "./dataset-types";

/** Reject after `ms` even if the promise never settles. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = "timeout"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms).unref(),
    ),
  ]);
}
