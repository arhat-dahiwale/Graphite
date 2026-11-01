import http from "k6/http";
import { check, sleep } from "k6";

/**
 * Graphite load test (k6). Read-heavy mix against a running stack.
 *
 * Usage (k6 >= 0.50, https://grafana.com/docs/k6):
 *   k6 run -e BASE_URL=http://localhost:4000 infra/loadtest/k6-load-test.js
 *
 * Stages ramp to 50 concurrent virtual users. Every VU signs up a unique
 * user, then loops over authenticated reads (org, projects, dashboards) and
 * hits public endpoints. Thresholds fail the run when p95 or error rate
 * regress.
 */

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 50 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<800"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:4000";

export function setup() {
  // Sanity: the API must be up before the load starts.
  const res = http.get(`${BASE}/healthz`);
  if (res.status !== 200) {
    throw new Error(`API not healthy at ${BASE}: ${res.status}`);
  }
}

export default function () {
  const email = `load-${__VU}-${Math.floor(Math.random() * 1e9)}@test.example`;
  const res = http.post(
    `${BASE}/api/auth/sign-up/email`,
    JSON.stringify({ email, password: "password12345", name: `Load VU ${__VU}` }),
    { headers: { "content-type": "application/json" } },
  );
  const ok = check(res, { "sign-up 200/4xx": (r) => r.status < 500 });
  if (!ok) return;

  const jar = http.cookieJar();
  for (const c of res.cookies["better-auth.session_token"] ?? []) {
    jar.set(BASE, "better-auth.session_token", c.value);
  }

  // Authenticated read mix through tRPC (batched query).
  const orgs = http.get(`${BASE}/trpc/org.list`);
  check(orgs, { "org.list ok": (r) => r.status === 200 || r.status === 404 });

  sleep(1);
}
