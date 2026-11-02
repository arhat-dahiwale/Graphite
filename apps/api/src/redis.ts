import Redis from "ioredis";

/** Create a Redis connection for pub/sub or commands. */
export function createRedis(url: string): Redis {
  const conn = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  return conn;
}
