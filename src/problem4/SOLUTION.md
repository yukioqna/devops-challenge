# Problem 4 — Docker Compose Stability Investigation

## Quick start (fixed stack)

```bash
cd src/problem4
docker compose up --build
```

```bash
curl -i http://localhost:8080/           # → 200 "Welcome to the platform"
curl -i http://localhost:8080/api/users  # → 200 {"ok":true,"time":...}
```

Wait for all containers to report `(healthy)` before testing. Before the fixes, every
request to `/api/users` returned `502 Bad Gateway`.

---

## Diagnostic approach

Source was read before running anything. The majority of defects are visible statically.
Read order used:

1. `docker-compose.yml` — service topology, port bindings, volumes, dependency graph
2. `nginx/conf.d/default.conf` — nginx is the only exposed entry point; where it proxies determines what is reachable
3. `api/src/index.js` — application I/O, error handling, dependency connections
4. `api/Dockerfile` — build hygiene and security posture
5. `postgres/init.sql` — database initialization side-effects

Runtime logs were used only to confirm findings from the static pass.

---

## Bugs found and fixed

### Bug 1 — nginx proxy port mismatch (Critical)

**Root cause:** nginx forwards `/api/` requests to `http://api:3001`, but the Express
application binds to port `3000`. Every proxied request receives `ECONNREFUSED` at the
nginx layer, returning `502 Bad Gateway` to all clients.

Because nginx on port `8080` is the only exposed endpoint, the API is **always**
unreachable — not intermittently as reported. The "sometimes" behavior arises from
other bugs on different boot paths (see Bug 2).

**Before:**
```nginx
location /api/ {
    proxy_pass http://api:3001;
}
```

**After:**
```nginx
location /api/ {
    proxy_pass http://api:3000;
}
```

**Prevention:** Source the upstream port from a single place — define `UPSTREAM_PORT=3000`
in `.env` and render it into the nginx config via `envsubst` at container startup. This
makes a port mismatch a compile-time error rather than a runtime one.

---

### Bug 2 — `depends_on` does not wait for service readiness (Critical)

**Root cause:** Docker Compose v3+ list-form `depends_on` waits only for the dependency
container to *start*, not for the service inside to accept connections. PostgreSQL
requires 3–5 seconds on first boot to initialize its data directory. The API container
starts in that window, calls `pool.connect()`, receives `ECONNREFUSED`, and crashes.
With no restart policy in place (Bug 3), it stays down permanently.

The intermittent failure pattern: on fast machines PG initializes before the race window
closes and the stack appears healthy; on slow boots or first-ever runs, the API crashes
and never recovers.

**Before:**
```yaml
api:
  depends_on:
    - postgres
    - redis
```

**After:**
```yaml
api:
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:3000/status"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 15s   # suppress failure counts during normal startup

postgres:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U postgres"]
    interval: 5s
    timeout: 5s
    retries: 10

redis:
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 3s
    retries: 5
```

nginx also gets `condition: service_healthy` on the api dependency so it does not begin
accepting external traffic before the API is ready.

---

### Bug 3 — No restart policy (High)

**Root cause:** Without `restart:`, a container that exits for any reason stays down.
Combined with Bug 2, the API crashes on first boot and stays dead for the lifetime of
the compose session. Even after Bug 2 is fixed, runtime failures (OOM, transient network
error, dependency blip) require a manual `docker compose restart`.

**Fix:** Added `restart: unless-stopped` to all four services.

`unless-stopped` is preferred over `always`: a deliberate `docker compose stop` (e.g.
for maintenance or debugging) will not automatically restart the container, while `always`
would override that operator intent.

---

### Bug 4 — PostgreSQL data volume missing (High)

**Root cause:** The original `postgres` service has no volume declaration for
`/var/lib/postgresql/data`. Docker stores the database files in an anonymous container
layer. Every `docker compose down` or `--force-recreate` destroys all data.

**Fix:**
```yaml
postgres:
  volumes:
    - postgres_data:/var/lib/postgresql/data
    - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql

volumes:
  postgres_data:    # named volume, survives compose down
```

Mounting `init.sql` into `/docker-entrypoint-initdb.d/` ensures it runs only on first
boot of a fresh data directory. Subsequent container restarts skip the init phase.

---

### Bug 5 — `ALTER SYSTEM SET max_connections = 20` in init.sql (Medium)

**Root cause:** Two compounding problems.

1. `ALTER SYSTEM` writes to `postgresql.auto.conf` and takes effect only after a
   PostgreSQL **reload or restart**. Init scripts run while PostgreSQL is already
   started; PostgreSQL does not reload itself after the init phase. On first boot the
   statement is silently a no-op.

2. The setting is not harmless to ignore: if PostgreSQL is later restarted — or if the
   container is recreated while the named volume (Bug 4's fix) persists — the setting
   activates. `max_connections = 20` is a tenth of the PostgreSQL default. The
   application pool alone requests up to 10 connections (`max: 10` in the PG pool config);
   with any concurrency the limit is exhausted and queries begin queuing or failing.

This is a latent defect: safe on the very first boot, dangerous the first time the
container restarts.

**Fix:** Remove `ALTER SYSTEM` from `init.sql`. Set `max_connections` via the postgres
command flag, which is applied at startup time and is visible in version control:

```yaml
postgres:
  command: postgres -c max_connections=100
```

---

### Bug 6 — Redis client has no error handler (Medium)

**Root cause:** `ioredis` extends `EventEmitter`. When the Redis connection is lost or
refused, it emits an `error` event. Node.js terminates a process when an `error` event
is emitted on an `EventEmitter` with no registered listener. A transient Redis restart
or network hiccup therefore crashes the API process entirely.

**Before:**
```js
const redis = new Redis({ host: process.env.REDIS_HOST, port: 6379 });
```

**After:**
```js
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  retryStrategy: (times) => Math.min(times * 100, 3000), // backoff: 100ms → 3s
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err.message);  // log, don't crash
});
```

The `retryStrategy` provides automatic reconnection with exponential backoff capped at
3 seconds. The `error` listener converts the event from a process-terminating unhandled
exception into a recoverable log entry.

A `connectionTimeoutMillis` is also added to the PG pool:

```js
const pool = new Pool({
  ...,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000, // fail fast if PG is unreachable
});
```

Without this, a slow or unavailable PG causes client HTTP requests to hang indefinitely
until the OS TCP timeout (~minutes), stacking up and exhausting the event loop.

---

### Bug 7 — Dockerfile runs as root (Low)

**Root cause:** The Node process runs as `root` inside the container. While not a
functional defect, it widens the blast radius of any application-layer compromise: root
access in a container is more exploitable for escape via kernel vulnerabilities or
privileged bind-mount abuse.

**Fix:** The official `node:20-alpine` image ships with a built-in unprivileged user
`node` (uid 1000, gid 1000). Switch to it before the entrypoint:

```dockerfile
USER node
CMD ["node", "src/index.js"]
```

No directory ownership changes are needed because this application performs no filesystem
writes.

---

### Bug 8 — Redis down causes entire API to hang (Critical)

**Root cause:** `await redis.set("last_call", Date.now())` sits in the main request handler
after a successful DB query. When Redis loses connection, ioredis by default **queues**
the command internally and waits for reconnection. The request handler never resolves,
nginx hits its `proxy_read_timeout` (60 s default), and every single `/api/users` call
returns `504 Gateway Time-out` for as long as Redis is down.

Redis is used here as a non-critical audit log (`last_call`), not as a cache serving the
response. A Redis outage should degrade gracefully, not take the API down entirely.

**Confirmed via runtime test:** stopping the Redis container caused 100% of `/api/users`
requests to return `504` within seconds.

**Before:**
```js
await redis.set("last_call", Date.now());
res.json({ ok: true, time: result.rows[0] });
```

**After:**
```js
// fire-and-forget — Redis failure never blocks the HTTP response
redis.set("last_call", Date.now()).catch((err) => {
  console.error("Redis set failed (non-fatal):", err.message);
});
res.json({ ok: true, time: result.rows[0] });
```

Also add `enableOfflineQueue: false` to the Redis client so commands are rejected
immediately rather than queued when the connection is down:

```js
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  enableOfflineQueue: false,
});
```

---

### Bug 9 — PostgreSQL pool emits unhandled `error` event, crashing Node.js (Critical)

**Root cause:** `pg.Pool` emits an `error` event on idle connections when the database
drops. Node.js terminates any process that emits `error` on an `EventEmitter` with no
registered listener (identical mechanism to Bug 6 for Redis, but on the PG pool).

**Confirmed via runtime test:** stopping the PostgreSQL container caused the API container
to crash immediately, as shown in the logs:

```
Node.js v20.20.2
API running on 3000      ← process restarted by docker
```

**Fix:**
```js
pool.on("error", (err) => {
  console.error("Unexpected pool error:", err.message);
});
```

---

### Bug 10 — nginx caches upstream DNS at startup; stale IP after API restart causes 502 (Critical)

**Root cause:** nginx resolves the hostname `api` once at startup and caches the IP for
the lifetime of the process. When the API container crashes and restarts it receives a new
IP from Docker's internal DHCP. nginx continues sending requests to the old IP, receives
`ECONNREFUSED`, and returns `502 Bad Gateway` to all clients — even though the API is
healthy again.

**Confirmed via runtime test:** after the API restarted following a postgres-induced crash,
nginx logs showed:

```
connect() failed (111: Connection refused) while connecting to upstream,
upstream: "http://172.18.0.4:3000/api/users"
```

while `docker inspect` reported the API's actual IP had changed to `172.18.0.2`.

**Fix:** use Docker's embedded DNS resolver (`127.0.0.11`) with a short TTL and a
`set $upstream` variable. nginx only skips re-resolution when the upstream is a literal
string; using a variable forces a DNS lookup on every request cycle:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
set $upstream_api http://api:3000;

location /api/ {
    proxy_pass $upstream_api;
    proxy_connect_timeout 5s;
    proxy_read_timeout    30s;
    proxy_send_timeout    30s;
}
```

---

### Bug 11 — PostgreSQL connection never released on query error (Medium)

**Root cause:** `db.release()` is called in the happy path only. If `db.query()` throws,
execution jumps to the `catch` block and the connection is leaked back into the pool.
With `max: 10`, ten consecutive query failures exhaust the pool permanently; subsequent
requests block until `connectionTimeoutMillis` (2 s) elapses and fail with a timeout.

**Before:**
```js
const db = await pool.connect();
const result = await db.query("SELECT NOW()");
db.release();                      // skipped if query throws
```

**After:**
```js
let db;
try {
  db = await pool.connect();
  const result = await db.query("SELECT NOW()");
  // ...
} catch (err) {
  // ...
} finally {
  if (db) db.release();            // always released
}
```

---

## Change summary

| File | Change | Severity |
|---|---|---|
| `nginx/conf.d/default.conf` | Proxy port `3001` → `3000` | Critical |
| `nginx/conf.d/default.conf` | Docker DNS resolver + `set $upstream` variable for dynamic re-resolution (Bug 10) | Critical |
| `docker-compose.yml` | Health checks on all services; `service_healthy` dependency conditions; `restart: unless-stopped`; named postgres volume; `max_connections=100` via command flag | Critical / High |
| `api/src/index.js` | Redis error handler; retry strategy; PG `connectionTimeoutMillis` | Medium |
| `api/src/index.js` | `pool.on("error")` handler to prevent Node.js crash (Bug 9) | Critical |
| `api/src/index.js` | Redis write made fire-and-forget; `enableOfflineQueue: false` (Bug 8) | Critical |
| `api/src/index.js` | `db.release()` moved to `finally` block (Bug 11) | Medium |
| `api/Dockerfile` | `USER node` before `CMD` | Low |
| `postgres/init.sql` | Removed `ALTER SYSTEM` | Medium |

---

## Monitoring and alerting recommendations

The stack currently has no observability beyond `console.log` to stdout.

### Container health

Add resource limits and monitor via cAdvisor + Prometheus (or Docker Desktop metrics):

```yaml
# docker-compose.yml additions per service
deploy:
  resources:
    limits:
      memory: 256m
      cpus: "0.5"
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Key container-level alerts:
- Memory usage > 80% of limit
- CPU throttling (`container_cpu_cfs_throttled_periods_total > 0`)
- Restart count > 3 in 5 minutes (crash loop)

### Application metrics

Expose a Prometheus `/metrics` endpoint from the Express app (via `prom-client`):

- `http_requests_total{method, route, status}` — error rate = RED method
- `http_request_duration_seconds` histogram — p50 / p95 / p99 latency
- `pg_pool_waiting` gauge — connection pool pressure; alert if > 0 for over 30s
- `redis_errors_total` counter — Redis connection instability

### Deeper health endpoint

The existing `/status` always returns `ok` regardless of dependency state. Add `/healthz`
that actually probes both:

```js
app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "down", error: err.message });
  }
});
```

Use `/healthz` for external uptime monitoring and load balancer readiness probes.
Keep `/status` as the Docker health check target — it is lightweight and does not
create recursive health-check → DB query pressure under load.

### Alerting rules (Prometheus / Alertmanager)

```yaml
# 5xx error rate > 1% over 5 minutes
- alert: HighErrorRate
  expr: rate(http_requests_total{status=~"5.."}[5m])
        / rate(http_requests_total[5m]) > 0.01

# p99 latency exceeds 1s
- alert: HighLatency
  expr: histogram_quantile(0.99, http_request_duration_seconds) > 1

# PG pool saturated
- alert: PGPoolPressure
  expr: pg_pool_waiting > 0
  for: 30s

# Container crash loop
- alert: CrashLoop
  expr: increase(container_restarts_total[5m]) > 3
```

### Production prevention checklist

| Control | Action |
|---|---|
| Port consistency | Single `UPSTREAM_PORT` env var, both nginx and app read from it |
| Secrets | Move `POSTGRES_PASSWORD: postgres` to `.env` (excluded from git) |
| Image pinning | Pin `node:20-alpine`, `postgres:15`, `redis:7` to digest hashes in CI |
| CI smoke test | Post-deploy `curl -f http://localhost:8080/api/users` as a pipeline gate |
| Log rotation | `json-file` driver with `max-size` and `max-file` on every service |
| Centralized logs | Vector or Fluent Bit sidecar shipping to Loki / CloudWatch |

---

## Observed items not changed

Items noted during review but left unchanged to keep the diff focused on reliability
defects:

- **Hardcoded DB credentials** — `postgres` / `postgres` visible in compose and
  `index.js`. Should be injected via `.env` or Docker secrets.
- **`/api/users` returns `SELECT NOW()`** — the route name implies a users query; the
  implementation tests DB connectivity only. Misleading but functional for a demo.
- **`nginx/nginx.conf` is empty and not mounted** — NGINX falls back to its base image
  default, which includes `conf.d/`. Harmless now; will require explicit mounting if
  global directives (worker processes, gzip, rate limiting) need tuning.
- **No `.dockerignore`** — with the current file tree this is harmless; a local
  `node_modules/` directory would bloat the build context significantly.
