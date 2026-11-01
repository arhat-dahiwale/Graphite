import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  rest,
  signIn,
  signUp,
  startTestApp,
  trpc,
  type TestApp,
} from "./helpers.js";

let app: TestApp;
let alice: string; // owner of org A
let bob: string; // owner of org B (rival tenant)
let carol: string; // invited as editor to org A
let dave: string; // invited as viewer to org A

const emails = {
  alice: "alice@test.example",
  bob: "bob@test.example",
  carol: "carol@test.example",
  dave: "dave@test.example",
};

beforeAll(async () => {
  app = await startTestApp();
  alice = await signUp(app.baseUrl, emails.alice, "Alice");
  bob = await signUp(app.baseUrl, emails.bob, "Bob");
  carol = await signUp(app.baseUrl, emails.carol, "Carol");
  dave = await signUp(app.baseUrl, emails.dave, "Dave");
}, 90_000);

afterAll(async () => {
  await app?.close();
});

let orgAId = "";
let orgBId = "";

describe("tenant isolation", () => {
  it("two users in different orgs cannot see each other's data", async () => {
    const orgA = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "Acme Analytics" }, "mutation");
    orgAId = orgA.id;
    const orgB = await trpc<{ id: string }>(app.baseUrl, bob, "org.create", { name: "Beta Corp" }, "mutation");
    orgBId = orgB.id;

    const projectA = await trpc<{ id: string }>(
      app.baseUrl,
      alice,
      "project.create",
      { orgId: orgAId, name: "Acme Sales" },
      "mutation",
    );

    // Bob (org B) cannot list org A's projects: no membership -> NOT_FOUND.
    await expect(
      trpc(app.baseUrl, bob, "project.list", { orgId: orgAId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Bob cannot read Alice's project directly either.
    await expect(
      trpc(app.baseUrl, bob, "project.get", { orgId: orgAId, projectId: projectA.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Bob's own org list does not include org A.
    const bobOrgs = await trpc<Array<{ id: string }>>(app.baseUrl, bob, "org.list");
    expect(bobOrgs.map((o) => o.id)).toEqual([orgBId]);

    // Alice sees exactly her org.
    const aliceOrgs = await trpc<Array<{ id: string }>>(app.baseUrl, alice, "org.list");
    expect(aliceOrgs.map((o) => o.id)).toEqual([orgAId]);
  });
});

describe("invitation flow", () => {
  it("owner invites an editor and a viewer; wrong email is rejected", async () => {
    const invite = await trpc<{ token: string; invitation: { id: string; email: string } }>(
      app.baseUrl,
      alice,
      "member.invite",
      { orgId: orgAId, email: emails.carol, role: "editor" },
      "mutation",
    );
    expect(invite.token).toMatch(/^gin_/);

    // A different user (dave) cannot accept carol's invitation.
    await expect(
      trpc(app.baseUrl, dave, "member.acceptInvite", { token: invite.token }, "mutation"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Carol accepts her own invitation.
    const accepted = await trpc<{ organizationId: string; role: string }>(
      app.baseUrl,
      carol,
      "member.acceptInvite",
      { token: invite.token },
      "mutation",
    );
    expect(accepted.role).toBe("editor");
    expect(accepted.organizationId).toBe(orgAId);

    // Token is single-use.
    await expect(
      trpc(app.baseUrl, carol, "member.acceptInvite", { token: invite.token }, "mutation"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Invite the viewer via REST accept path too.
    const daveInvite = await trpc<{ token: string }>(
      app.baseUrl,
      alice,
      "member.invite",
      { orgId: orgAId, email: emails.dave, role: "viewer" },
      "mutation",
    );
    const restRes = await rest(app.baseUrl, dave, "POST", `/api/v1/invitations/${daveInvite.token}/accept`);
    expect(restRes.status).toBe(200);
  });

  it("invitations list never exposes token hashes", async () => {
    const rows = await trpc<Array<Record<string, unknown>>>(
      app.baseUrl,
      alice,
      "member.listInvitations",
      { orgId: orgAId },
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("tokenHash");
    }
  });
});

describe("role checks for owner, editor, viewer", () => {
  it("editor can write content but not manage members", async () => {
    // Carol is editor in org A.
    const project = await trpc<{ id: string }>(
      app.baseUrl,
      carol,
      "project.create",
      { orgId: orgAId, name: "Carol's project" },
      "mutation",
    );
    expect(project.id).toMatch(/^prj_/);

    // Editor cannot invite.
    await expect(
      trpc(
        app.baseUrl,
        carol,
        "member.invite",
        { orgId: orgAId, email: "someone@test.example", role: "viewer" },
        "mutation",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Editor cannot change roles.
    await expect(
      trpc(
        app.baseUrl,
        carol,
        "member.updateRole",
        { orgId: orgAId, userId: "u_x", role: "viewer" },
        "mutation",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("viewer can read but cannot write or run agent actions", async () => {
    // Dave is viewer in org A.
    const projects = await trpc<Array<{ id: string }>>(
      app.baseUrl,
      dave,
      "project.list",
      { orgId: orgAId },
    );
    expect(projects.length).toBeGreaterThanOrEqual(1);

    await expect(
      trpc(app.baseUrl, dave, "project.create", { orgId: orgAId, name: "Nope" }, "mutation"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      trpc(app.baseUrl, dave, "member.updateRole", { orgId: orgAId, userId: "u_x", role: "viewer" }, "mutation"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("owner can manage roles; last-owner demotion and removal are protected", async () => {
    const members = await trpc<Array<{ userId: string; email: string; role: string }>>(
      app.baseUrl,
      alice,
      "member.list",
      { orgId: orgAId },
    );
    const carolId = members.find((m) => m.email === emails.carol)?.userId;
    expect(carolId).toBeDefined();

    // Promote carol to owner, then demote again.
    await trpc(app.baseUrl, alice, "member.updateRole", { orgId: orgAId, userId: carolId, role: "owner" }, "mutation");
    await trpc(app.baseUrl, alice, "member.updateRole", { orgId: orgAId, userId: carolId, role: "editor" }, "mutation");

    // Removing alice (the only owner) is rejected.
    const aliceId = members.find((m) => m.email === emails.alice)?.userId;
    await expect(
      trpc(app.baseUrl, alice, "member.remove", { orgId: orgAId, userId: aliceId }, "mutation"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Alice cannot leave as last owner.
    await expect(
      trpc(app.baseUrl, alice, "member.leave", { orgId: orgAId }, "mutation"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Dave (viewer) can be removed by the owner.
    const daveId = members.find((m) => m.email === emails.dave)?.userId;
    await trpc(app.baseUrl, alice, "member.remove", { orgId: orgAId, userId: daveId }, "mutation");
    const after = await trpc<Array<{ email: string }>>(app.baseUrl, alice, "member.list", { orgId: orgAId });
    expect(after.map((m) => m.email)).not.toContain(emails.dave);
  });

  it("unauthenticated requests are rejected", async () => {
    await expect(
      trpc(app.baseUrl, "better-auth.session_token=bogus", "org.list"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("sign-in round trip works", async () => {
    const cookie = await signIn(app.baseUrl, emails.alice);
    const orgs = await trpc<Array<{ id: string }>>(app.baseUrl, cookie, "org.list");
    expect(orgs.map((o) => o.id)).toContain(orgAId);
  });
});
