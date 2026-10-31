import { describe, expect, it } from "vitest";
import { AppError, authorize, roleAtLeast, newId } from "@graphite/core";

describe("newId", () => {
  it("prefixes and produces URL-safe ids", () => {
    const id = newId("org");
    expect(id).toMatch(/^org_[23456789abcdefghjkmnpqrstuvwxyz]{21}$/);
  });
});

describe("roleAtLeast", () => {
  it("ranks owner > editor > viewer", () => {
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });
});

describe("authorize", () => {
  const actor = (role: "owner" | "editor" | "viewer", orgId = "org_a") => ({
    userId: "u1",
    orgId,
    role,
  });

  it("viewers can read but not write", () => {
    expect(authorize(actor("viewer"), "dashboard:read", { type: "dashboard", organizationId: "org_a" })).toBe(true);
    expect(authorize(actor("viewer"), "dashboard:write", { type: "dashboard", organizationId: "org_a" })).toBe(false);
    expect(authorize(actor("viewer"), "agent:run", { type: "run", organizationId: "org_a" })).toBe(false);
  });

  it("editors can write content but not manage the org", () => {
    expect(authorize(actor("editor"), "chart:write", { type: "chart", organizationId: "org_a" })).toBe(true);
    expect(authorize(actor("editor"), "org:manage", { type: "organization", organizationId: "org_a" })).toBe(false);
  });

  it("owners can manage the org", () => {
    expect(authorize(actor("owner"), "org:manage", { type: "organization", organizationId: "org_a" })).toBe(true);
  });

  it("rejects cross-organization access", () => {
    expect(authorize(actor("owner"), "project:read", { type: "project", organizationId: "org_b" })).toBe(false);
  });

  it("personal token writes are restricted to the owner or org owner", () => {
    expect(
      authorize(actor("editor"), "token:write", {
        type: "token",
        organizationId: "org_a",
        ownerId: "u1",
      }),
    ).toBe(true);
    expect(
      authorize(actor("editor"), "token:write", {
        type: "token",
        organizationId: "org_a",
        ownerId: "someone_else",
      }),
    ).toBe(false);
    expect(
      authorize(actor("owner"), "token:write", {
        type: "token",
        organizationId: "org_a",
        ownerId: "someone_else",
      }),
    ).toBe(true);
  });
});

describe("AppError", () => {
  it("serializes code and message without internals", () => {
    const e = new AppError("NOT_FOUND", "nope", { cause: new Error("secret stack") });
    expect(e.toJSON()).toEqual({ code: "NOT_FOUND", message: "nope", details: {} });
  });
});
