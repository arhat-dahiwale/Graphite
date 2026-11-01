import {
  credentials,
  loadPackageDefinition,
  makeGenericClientConstructor,
  type ClientUnaryCall,
  type ServiceDefinition,
  type ServiceError,
} from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROTO_PATH = path.join(dir, "..", "proto", "data.proto");

export interface GrpcContext {
  organizationId: string;
  userId: string;
  requestId: string;
}

export interface DatasetColumnView {
  name: string;
  type: string;
  nullable: boolean;
  statsJson: string;
}

export interface DescribeDatasetResult {
  datasetId: string;
  rowCount: string | number;
  columns: DatasetColumnView[];
}

export interface RowsResult {
  columns: string[];
  /** Each cell is JSON-stringified by the server. */
  rows: Array<{ valuesJson: string[] }>;
  truncated: boolean;
  durationMs: number;
}

type UnaryFn = (req: unknown, cb: (err: ServiceError | null, res?: unknown) => void) => ClientUnaryCall;

interface RawClient {
  DescribeDataset: UnaryFn;
  SampleRows: UnaryFn;
  ColumnStats: UnaryFn;
  RunQuery: UnaryFn;
  close: () => void;
}

export interface DataClient {
  describeDataset(ctx: GrpcContext, datasetId: string): Promise<DescribeDatasetResult>;
  sampleRows(ctx: GrpcContext, datasetId: string, limit: number): Promise<RowsResult>;
  columnStats(ctx: GrpcContext, datasetId: string, column: string): Promise<{ statsJson: string }>;
  runQuery(
    ctx: GrpcContext,
    datasetIds: string[],
    sql: string,
    rowLimit: number,
    timeoutMs: number,
  ): Promise<RowsResult>;
  close(): void;
}

/** Create a typed client for the graphite.data.v1 DataService. */
export function createDataClient(address: string, protoPath = DEFAULT_PROTO_PATH): DataClient {
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = loadPackageDefinition(packageDefinition) as never as {
    graphite: { data: { v1: { DataService: { service: unknown } } } };
  };
  const Ctor = makeGenericClientConstructor(
    proto.graphite.data.v1.DataService.service as ServiceDefinition,
    "DataService",
  );
  const client = new Ctor(address, credentials.createInsecure(), {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
  }) as unknown as RawClient;

  const call = <T>(fn: (cb: (err: ServiceError | null, res?: unknown) => void) => ClientUnaryCall): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      fn((err, res) => {
        if (err) {
          reject(Object.assign(new Error(err.details ?? "gRPC error"), { grpcCode: err.code }));
        } else {
          resolve(res as T);
        }
      });
    });

  return {
    async describeDataset(ctx, datasetId) {
      return call((cb) => client.DescribeDataset({ ctx, datasetId }, cb));
    },
    async sampleRows(ctx, datasetId, limit) {
      return call((cb) => client.SampleRows({ ctx, datasetId, limit }, cb));
    },
    async columnStats(ctx, datasetId, column) {
      return call((cb) => client.ColumnStats({ ctx, datasetId, column }, cb));
    },
    async runQuery(ctx, datasetIds, sql, rowLimit, timeoutMs) {
      return call((cb) =>
        client.RunQuery(
          { ctx, datasetIds, sql, rowLimit, timeoutMs },
          cb,
        ),
      );
    },
    close() {
      client.close();
    },
  };
}
