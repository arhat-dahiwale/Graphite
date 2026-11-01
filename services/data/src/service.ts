import {
  loadPackageDefinition,
  Server,
  status,
  type Metadata,
  type ServerUnaryCall,
  type sendUnaryData,
  type ServiceDefinition,
} from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { context as otelContext, propagation, SpanStatusCode } from "@opentelemetry/api";
import { startSpanFor } from "@graphite/telemetry";
import { AppError } from "@graphite/core";
import { buildServiceImplementation, type DataServiceOptions } from "./handlers";

export type { DataServiceOptions };
interface ProtoShape {
  graphite: {
    data: {
      v1: { DataService: { service: ServiceDefinition; serviceName: string } };
    };
  };
}

/**
 * Create the gRPC server with the DataService implementation.
 * `options.metadataSql` resolves dataset ids to physical tables (app role);
 * `options.readonlySql` executes all user-visible SQL (read-only role).
 */
export function createDataService(options: DataServiceOptions): {
  server: Server;
  impl: ReturnType<typeof buildServiceImplementation>;
} {
  const packageDefinition = protoLoader.loadSync(options.protoPath, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = loadPackageDefinition(packageDefinition) as never as ProtoShape;
  const impl = buildServiceImplementation(options);

  const server = new Server();
  server.addService(proto.graphite.data.v1.DataService.service, {
    describeDataset: wrap("DescribeDataset", impl.describeDataset),
    sampleRows: wrap("SampleRows", impl.sampleRows),
    columnStats: wrap("ColumnStats", impl.columnStats),
    runQuery: wrap("RunQuery", impl.runQuery),
  });

  return { server, impl };
}

type Handler<TReq, TRes> = (call: ServerUnaryCall<TReq, TRes>) => Promise<TRes>;

/**
 * Wrap a gRPC handler: extract the caller's W3C trace context from the
 * request metadata (injected by the DataClient) and run under a server span,
 * so data-service spans join the caller's trace.
 */
function wrap<TReq, TRes>(methodName: string, fn: Handler<TReq, TRes>) {
  return (
    call: ServerUnaryCall<TReq, TRes>,
    callback: sendUnaryData<TRes>,
  ): void => {
    const parentCtx = propagation.extract(otelContext.active(), call.metadata, {
      // grpc Metadata values are string[]; propagation needs string | string[].
      get: (carrier: Metadata, key: string) => {
        const v = carrier.get(key) as unknown;
        return Array.isArray(v) ? (v as string[]) : (v as string | undefined);
      },
      keys: (carrier: Metadata) => Object.keys(carrier.getMap() as Record<string, unknown>),
    });
    const { span, ctx } = startSpanFor(parentCtx, `grpc.server DataService/${methodName}`);
    otelContext.with(ctx, () => fn(call))
      .then((res) => {
        span.end();
        callback(null, res);
      })
      .catch((e: unknown) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : "error" });
        span.end();
        callback({
          code: grpcStatusFor(e),
          message: e instanceof Error ? e.message : "internal error",
        });
      });
  };
}

function grpcStatusFor(e: unknown): status {
  if (e instanceof AppError) {
    switch (e.code) {
      case "BAD_REQUEST":
      case "UNPROCESSABLE":
        return status.INVALID_ARGUMENT;
      case "UNAUTHORIZED":
      case "FORBIDDEN":
        return status.PERMISSION_DENIED;
      case "NOT_FOUND":
        return status.NOT_FOUND;
      default:
        return status.INTERNAL;
    }
  }
  return status.INTERNAL;
}
