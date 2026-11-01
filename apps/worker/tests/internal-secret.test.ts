import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv } from "@graphite/core/config";
import {
  assertInternalMcpSecret,
  signInternalContext,
  verifyInternalContext,
} from "@graphite/mcp-server/internal-auth";
import { createMcpRouter } from "@graphite/mcp-server/server";

/**
 * The internal MCP identity secret must have no default and must refuse to
 * start any process that signs or verifies it when it is missing or shorter
 * than 32 characters.
 */

// Same rule the worker's env schema enforces at boot.
const secretSchema = z.object({ INTERNAL_MCP_SECRET: z.string().min(32) });

describe("INTERNAL_MCP_SECRET", () => {
  it("env parsing fails when the secret is missing", () => {
    expect(() => parseEnv(secretSchema, {})).toThrow(/INTERNAL_MCP_SECRET/);
  });

  it("env parsing fails when the secret is shorter than 32 characters", () => {
    expect(() => parseEnv(secretSchema, { INTERNAL_MCP_SECRET: "too-short" })).toThrow(
      /INTERNAL_MCP_SECRET/,
    );
  });

  it("env parsing succeeds with a 32+ character secret", () => {
    const parsed = parseEnv(secretSchema, {
      INTERNAL_MCP_SECRET: "0123456789abcdef0123456789abcdef",
    });
    expect(parsed.INTERNAL_MCP_SECRET).toHaveLength(32);
  });

  it("assertInternalMcpSecret rejects missing and short secrets with a clear error", () => {
    expect(() => assertInternalMcpSecret(undefined)).toThrow(/INTERNAL_MCP_SECRET is not set/);
    expect(() => assertInternalMcpSecret("")).toThrow(/INTERNAL_MCP_SECRET is not set/);
    expect(() => assertInternalMcpSecret("a".repeat(31))).toThrow(/shorter than 32/);
    expect(assertInternalMcpSecret("a".repeat(32))).toBe("a".repeat(32));
  });

  it("mounting the MCP router fails fast on a missing or short secret", () => {
    const deps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any; // the assertion fires before any dependency is touched
    expect(() => createMcpRouter({ ...deps, secret: undefined })).toThrow(/INTERNAL_MCP_SECRET/);
    expect(() => createMcpRouter({ ...deps, secret: "short" })).toThrow(/shorter than 32/);
  });

  it("sign and verify work with a strong secret and fail with a weak one", () => {
    const strong = "internal-secret-0123456789abcdef-STRONG";
    const ctx = { userId: "u_1", orgId: "org_1", requestId: "req_1" };
    const { context, signature } = signInternalContext(ctx, strong);
    expect(verifyInternalContext(context, signature, strong)).toEqual(ctx);
    // A different secret must not verify.
    expect(() => verifyInternalContext(context, signature, "x".repeat(32))).toThrow();
  });
});
