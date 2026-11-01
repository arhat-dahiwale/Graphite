import {
  credentials,
  loadPackageDefinition,
  makeGenericClientConstructor,
  Metadata,
  type ClientUnaryCall,
  type ServiceDefinition,
  type ServiceError,
} from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context as otelContext, propagation } from "@opentelemetry/api";
import { withSpan } from "@graphite/telemetry";

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

type UnaryFn = (
  req: unknown,
  metadata: Metadata,
  options: Record<string, unknown>,
  cb: (err: ServiceError | null, res?: unknown) => void,
) => ClientUnaryCall;

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

  // Trace context travels in gRPC metadata (W3C traceparent) so the data
  // service's spans join the caller's trace.
  const tracedMetadata = (): Metadata => {
    const metadata = new Metadata();
    propagation.inject(otelContext.active(), metadata, {
      set: (carrier: Metadata, key: string, value: string) => carrier.set(key, value),
    });
    return metadata;
  };

  return {
    async describeDataset(ctx, datasetId) {
      return withSpan("grpc.DataService/DescribeDataset", { "graphite.dataset_id": datasetId }, () =>
        call((cb) => client.DescribeDataset({ ctx, datasetId }, tracedMetadata(), {}, cb)),
      );
    },
    async sampleRows(ctx, datasetId, limit) {
      return withSpan("grpc.DataService/SampleRows", { "graphite.dataset_id": datasetId, "graphite.limit": limit }, () =>
        call((cb) => client.SampleRows({ ctx, datasetId, limit }, tracedMetadata(), {}, cb)),
      );
    },
    async columnStats(ctx, datasetId, column) {
      return withSpan("grpc.DataService/ColumnStats", { "graphite.dataset_id": datasetId, "graphite.column": column }, () =>
        call((cb) => client.ColumnStats({ ctx, datasetId, column }, tracedMetadata(), {}, cb)),
      );
    },
    async runQuery(ctx, datasetIds, sql, rowLimit, timeoutMs) {
      return withSpan("grpc.DataService/RunQuery", { "graphite.dataset_ids": datasetIds.join(",") }, () =>
        call((cb) =>
          client.RunQuery(
            { ctx, datasetIds, sql, rowLimit, timeoutMs },
            tracedMetadata(),
            {},
            cb,
          ),
        ),
      );
    },
    close() {
      client.close();
    },
  };
}
