# Load test

k6 script exercising the Graphite API with a sign-up + authenticated read mix.

## Usage

1. Install k6 (https://grafana.com/docs/k6/latest/set-up/install-k6/).
2. Start the stack (`docker compose up -d && pnpm dev`), then:

```bash
k6 run -e BASE_URL=http://localhost:4000 infra/loadtest/k6-load-test.js
```

3. Ramp profile: 10 VUs for 30s, up to 50 VUs for 1m, back to 0. Thresholds
   fail the run when the error rate exceeds 2% or p95 latency exceeds 800 ms.

4. Watch the effect live in Grafana (observability profile): the API health
   dashboard shows request rate/latency while the load runs; the worker
   dashboards show queue depth if you also enqueue jobs.

Notes:
- Users created by the load test accumulate in the dev database; re-run
  `pnpm db:setup` on a fresh volume to reset.
- The script is intentionally read-heavy; agent runs are budgeted and
  quota-limited per org, so a write-heavy load test would just trip quotas.
