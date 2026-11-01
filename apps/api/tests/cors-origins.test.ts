import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { parseAllowedOrigins } from "@graphite/core/config";
import { signUp, startTestApp, type TestApp } from "./helpers.js";

/**
 * Browser origins for CORS and Socket.IO come from CORS_ORIGINS (explicit
 * list; "*" is rejected because credentials are enabled). A disallowed
 * origin must be rejected and an allowed one accepted, on both surfaces.
 */

let app: TestApp;
let cookie = "";

beforeAll(async () => {
  app = await startTestApp();
  cookie = await signUp(app.baseUrl, "cors-alice@test.example", "Alice");
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("parseAllowedOrigins", () => {
  it("defaults to the local dev origins when unset", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
    expect(parseAllowedOrigins("  ")).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
  });

  it("parses a comma-separated list with trimming", () => {
    expect(parseAllowedOrigins(" https://a.example , https://b.example ")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("rejects a wildcard because credentials are enabled", () => {
    expect(() => parseAllowedOrigins("*")).toThrow(/\*/);
    expect(() => parseAllowedOrigins("http://localhost:3000,*")).toThrow(/\*/);
  });
});

describe("Express CORS", () => {
  it("accepts an allowed origin", async () => {
    const res = await fetch(`${app.baseUrl}/healthz`, {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("rejects a disallowed origin (no CORS headers)", async () => {
    const res = await fetch(`${app.baseUrl}/healthz`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // Preflight for a disallowed origin must not succeed either.
    const pre = await fetch(`${app.baseUrl}/healthz`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("Socket.IO CORS", () => {
  function tryConnect(baseUrl: string, origin: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = io(`${baseUrl}/collab`, {
        transports: ["websocket"],
        extraHeaders: { origin, cookie },
        reconnection: false,
        timeout: 5000,
      });
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", (e) => reject(e));
    });
  }

  it("accepts an allowed origin", async () => {
    const sock = await tryConnect(app.baseUrl, "http://localhost:3000");
    sock.disconnect();
  });

  it("rejects a disallowed origin", async () => {
    await expect(tryConnect(app.baseUrl, "https://evil.example")).rejects.toThrow();
  });
});
