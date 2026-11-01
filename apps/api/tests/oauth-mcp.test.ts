import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  pollUntil,
  rest,
  signUp,
  startTestApp,
  trpc,
  uploadCsv,
  type TestApp,
} from "./helpers.js";

/**
 * Phase 10: OAuth 2.1 for MCP — the full scripted-client flow:
 * dynamic registration -> authorize (PKCE S256) -> code exchange -> /mcp call
 * -> refresh (rotation) -> revocation -> rejected afterwards. Scopes and org
 * binding must behave exactly like the personal-access-token path.
 */

let app: TestApp;
let alice: string;
let orgAId = "";
let projectId = "";
let datasetId = "";
let dashboardId = "";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

beforeAll(async () => {
  app = await startTestApp();
  alice = await signUp(app.baseUrl, "oauth-alice@test.example", "Alice");
  const org = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "OAuth Org" }, "mutation");
  orgAId = org.id;
  const project = await trpc<{ id: string }>(app.baseUrl, alice, "project.create", { orgId: orgAId, name: "OAuth Project" }, "mutation");
  projectId = project.id;
  const up = await uploadCsv(app.baseUrl, alice, projectId, "oauth.csv", "region,revenue\nnorth,120\nsouth,80");
  datasetId = up.json.dataset!.id;
  await pollUntil(
    async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready",
    30_000,
  );
  const dash = await trpc<{ id: string }>(app.baseUrl, alice, "dashboard.create", { projectId, name: "OAuth Dash" }, "mutation");
  dashboardId = dash.id;
}, 150_000);

afterAll(async () => {
  await app?.close();
});

describe("OAuth 2.1 for MCP", () => {
  it("serves discovery metadata for resource and authorization server", async () => {
    const res = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; scopes_supported: string[] };
    expect(body.resource).toContain("/mcp");
    expect(body.scopes_supported).toContain("charts:write");

    const as = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
    const meta = (await as.json()) as { code_challenge_methods_supported: string[]; grant_types_supported: string[] };
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.grant_types_supported).toContain("authorization_code");
  });

  it("full flow: register -> authorize(PKCE) -> exchange -> /mcp -> refresh -> revoke", async () => {
    // 1. Dynamic client registration (session required).
    const reg = await rest(app.baseUrl, alice, "POST", "/oauth/register", {
      client_name: "Scripted MCP client",
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      organizationId: orgAId,
    });
    expect(reg.status).toBe(201);
    const { client_id } = reg.json as { client_id: string };
    expect(client_id).toMatch(/^mcp_/);

    // 2. Authorize with PKCE (session cookie in the browser-like request).
    const { verifier, challenge } = pkce();
    const state = "st_" + randomBytes(6).toString("hex");
    const redirect = new URL("http://127.0.0.1/callback");
    const authUrl = new URL(`${app.baseUrl}/oauth/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set("redirect_uri", redirect.toString());
    authUrl.searchParams.set("scope", "datasets:read charts:read charts:write");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("organizationId", orgAId);

    const authRes = await fetch(authUrl, { headers: { cookie: alice }, redirect: "manual" });
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(redirect.toString());
    const code = location.searchParams.get("code");
    expect(location.searchParams.get("state")).toBe(state);
    expect(code).toBeTruthy();

    // 3. Exchange the code (+ verifier) for tokens.
    const tokenRes = await rest(app.baseUrl, alice, "POST", "/oauth/token", {
      grant_type: "authorization_code",
      client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirect.toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = tokenRes.json as { access_token: string; refresh_token: string; token_type: string; scope: string };
    expect(tokens.access_token).toMatch(/^gphat_/);
    expect(tokens.refresh_token).toMatch(/^gphrt_/);
    expect(tokens.token_type).toBe("Bearer");

    // 4. Call /mcp with the access token.
    const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: "oauth-e2e-client", version: "1.0.0" }, {});
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(10);
    const created = await client.callTool({
      name: "create_chart_spec",
      arguments: {
        spec: {
          version: 1,
          type: "bar",
          title: "OAuth chart",
          datasetId,
          query: { select: [{ field: "region" }], limit: 50 },
          encoding: { x: { field: "region", type: "category" } },
          style: { palette: "graphite", legend: false, stack: false },
        },
        dashboardId,
      },
    });
    expect(created.isError).toBeFalsy();
    await client.close();

    // 5. Refresh rotates: new tokens work, the old access token dies.
    const refreshRes = await rest(app.baseUrl, alice, "POST", "/oauth/token", {
      grant_type: "refresh_token",
      client_id,
      refresh_token: tokens.refresh_token,
    });
    expect(refreshRes.status).toBe(200);
    const rotated = refreshRes.json as { access_token: string; refresh_token: string };
    expect(rotated.access_token).not.toBe(tokens.access_token);

    const oldTransport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    });
    const oldClient = new Client({ name: "rotated-out", version: "1.0.0" }, {});
    await expect(oldClient.connect(oldTransport)).rejects.toThrow();

    // New access token still works.
    const newTransport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${rotated.access_token}` } },
    });
    const newClient = new Client({ name: "rotated-in", version: "1.0.0" }, {});
    await newClient.connect(newTransport);
    await newClient.close();

    // 6. Revoke -> the whole family dies; next request rejected.
    const revokeRes = await rest(app.baseUrl, alice, "POST", "/oauth/revoke", {
      token: rotated.access_token,
      client_id,
    });
    expect(revokeRes.status).toBe(200);
    const deadTransport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${rotated.access_token}` } },
    });
    const deadClient = new Client({ name: "revoked", version: "1.0.0" }, {});
    await expect(deadClient.connect(deadTransport)).rejects.toThrow();
  });

  it("scope enforcement and org binding match the PAT path", async () => {
    // Register + authorize with ONLY datasets:read.
    const reg = await rest(app.baseUrl, alice, "POST", "/oauth/register", {
      client_name: "Read-only OAuth",
      redirect_uris: ["http://127.0.0.1/callback"],
      organizationId: orgAId,
    });
    const { client_id } = reg.json as { client_id: string };
    const { verifier, challenge } = pkce();
    const authUrl = new URL(`${app.baseUrl}/oauth/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    authUrl.searchParams.set("scope", "datasets:read");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("organizationId", orgAId);
    const authRes = await fetch(authUrl, { headers: { cookie: alice }, redirect: "manual" });
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await rest(app.baseUrl, alice, "POST", "/oauth/token", {
      grant_type: "authorization_code",
      client_id,
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1/callback",
    });
    const { access_token } = tokenRes.json as { access_token: string };

    const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    });
    const client = new Client({ name: "oauth-ro", version: "1.0.0" }, {});
    await client.connect(transport);
    const denied = await client.callTool({
      name: "create_chart_spec",
      arguments: {
        spec: {
          version: 1,
          type: "bar",
          title: "Should not exist",
          datasetId,
          query: { select: [{ field: "region" }], limit: 50 },
          encoding: { x: { field: "region", type: "category" } },
          style: { palette: "graphite", legend: false, stack: false },
        },
      },
    });
    expect(denied.isError).toBe(true);
    const text = (denied.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("Missing scope: charts:write");
    await client.close();

    // Cross-tenant: the OAuth token is bound to org A; org B resources 404.
    const bobSigned = await signUp(app.baseUrl, "oauth-bob@test.example", "Bob");
    const orgB = await trpc<{ id: string }>(app.baseUrl, bobSigned, "org.create", { name: "OAuth Org B" }, "mutation");
    const bobProject = await trpc<{ id: string }>(app.baseUrl, bobSigned, "project.create", { orgId: orgB.id, name: "B" }, "mutation");
    const bobUp = await uploadCsv(app.baseUrl, bobSigned, bobProject.id, "b.csv", "x,y\n1,2");
    const bobDataset = bobUp.json.dataset!.id;
    await pollUntil(
      async () => (await rest(app.baseUrl, bobSigned, "GET", `/api/v1/datasets/${bobDataset}`)).json as { dataset: { status: string } },
      (v) => v.dataset.status === "ready",
      30_000,
    );
    const t2 = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    });
    const c2 = new Client({ name: "oauth-cross", version: "1.0.0" }, {});
    await c2.connect(t2);
    const cross = await c2.callTool({ name: "describe_dataset", arguments: { datasetId: bobDataset } });
    expect(cross.isError).toBe(true);
    const crossText = (cross.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(crossText).toContain("Dataset not found");
    await c2.close();
  }, 120_000);

  it("rejects PKCE 'plain' and a wrong verifier", async () => {
    const reg = await rest(app.baseUrl, alice, "POST", "/oauth/register", {
      client_name: "Bad PKCE",
      redirect_uris: ["http://127.0.0.1/callback"],
      organizationId: orgAId,
    });
    const { client_id } = reg.json as { client_id: string };

    const plain = new URL(`${app.baseUrl}/oauth/authorize`);
    plain.searchParams.set("response_type", "code");
    plain.searchParams.set("client_id", client_id);
    plain.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    plain.searchParams.set("scope", "datasets:read");
    plain.searchParams.set("code_challenge", "challenge-value");
    plain.searchParams.set("code_challenge_method", "plain");
    plain.searchParams.set("organizationId", orgAId);
    const plainRes = await fetch(plain, { headers: { cookie: alice }, redirect: "manual" });
    expect(plainRes.status).toBe(400);

    const { challenge } = pkce();
    const authUrl = new URL(`${app.baseUrl}/oauth/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    authUrl.searchParams.set("scope", "datasets:read");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("organizationId", orgAId);
    const authRes = await fetch(authUrl, { headers: { cookie: alice }, redirect: "manual" });
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    const badExchange = await rest(app.baseUrl, alice, "POST", "/oauth/token", {
      grant_type: "authorization_code",
      client_id,
      code,
      code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-wrong-verifier",
      redirect_uri: "http://127.0.0.1/callback",
    });
    expect(badExchange.status).toBe(400);
    expect((badExchange.json as { error: string }).error).toBe("invalid_grant");
  });
});
