import { unprocessable, type AppError } from "@graphite/core";
import type { Sql } from "postgres";

export interface DataServiceOptions {
  /** App-role pool for dataset metadata (id -> table resolution). */
  metadataSql: Sql;
  /** Read-only pool for all user-visible SQL. */
  readonlySql: Sql;
  protoPath: string;
  maxQueryRows: number;
  statementTimeoutMs: number;
}

/**
 * Phase 0 skeleton: the service is live and responds with a structured error
 * until the query engine lands in Phase 2.
 */
export function buildServiceImplementation(_options: DataServiceOptions) {
  const notYet = (): AppError => unprocessable("Query execution is not available yet");

  return {
    async describeDataset(_call: unknown): Promise<never> {
      throw notYet();
    },
    async sampleRows(_call: unknown): Promise<never> {
      throw notYet();
    },
    async columnStats(_call: unknown): Promise<never> {
      throw notYet();
    },
    async runQuery(_call: unknown): Promise<never> {
      throw notYet();
    },
  };
}
