import { loadPackageDefinition, Server, status } from "@grpc/grpc-js";
import type { ServerUnaryCall, sendUnaryData, ServiceDefinition } from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { AppError } from "@graphite/core";
import { buildServiceImplementation, type DataServiceOptions } from "./handlers.js";

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
    describeDataset: wrap(impl.describeDataset),
    sampleRows: wrap(impl.sampleRows),
    columnStats: wrap(impl.columnStats),
    runQuery: wrap(impl.runQuery),
  });

  return { server, impl };
}

type Handler<TReq, TRes> = (
  call: ServerUnaryCall<TReq, TRes>,
  callback: sendUnaryData<TRes>,
) => Promise<void>;

function wrap<TReq, TRes>(fn: Handler<TReq, TRes>) {
  return (call: ServerUnaryCall<TReq, TRes>, callback: sendUnaryData<TRes>): void => {
    fn(call, callback).catch((e) => {
      callback({ code: grpcStatusFor(e), message: e instanceof Error ? e.message : "internal error" });
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
