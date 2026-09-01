# Deployment

No platform is assumed. What the server needs is a process manager that can send
SIGTERM, a PostgreSQL it can reach, and the environment variables below.

---

## Environment

`DATABASE_URL` and `JWT_SECRET` have no defaults and the process refuses to start
without them. See `.env.example` for the rest.

Two variables must be set in production and are enforced at startup:

| Variable | Requirement |
| --- | --- |
| `COOKIE_SECURE` | must be `true` — otherwise the refresh cookie travels in clear text |
| `SEED_ADMIN_PASSWORD` | must be **unset** — it exists to create a local demo account |

`TRUST_PROXY=true` is required behind a load balancer. Without it every request
log and every session records the balancer's address rather than the client's.

Secrets are never baked into the image. They arrive as environment variables at
run time, which is also why the Dockerfile copies no `.env`.

---

## Migrations run as a deployment step, not at startup

```bash
npx prisma migrate deploy
```

**Not** from the application's entrypoint. A rolling deploy starts several
containers at once, and migration-on-boot means several concurrent migrations
racing on the same database — Prisma takes an advisory lock, so the usual outcome
is not corruption but a set of containers waiting on each other during exactly
the window when capacity is needed.

Run it once, from a job or a release step, before the new version starts.

### Expand, migrate, contract

Every migration must be applied while the *previous* version of the application
is still running, because during a rolling deploy both versions are live at once.

1. **Expand** — add the new column, nullable or with a default. Both versions work.
2. **Migrate** — deploy the code that writes it, and backfill.
3. **Contract** — only once no running version reads the old shape, drop it.

A rename is therefore three deploys, not one. Doing it in a single step breaks
whichever version loses the race.

---

## Shutdown

SIGTERM starts a drain, in this order:

1. **Readiness begins failing immediately.** Liveness keeps passing — the process
   is not unhealthy, it is leaving. A liveness failure here would get the
   container killed rather than drained.
2. **A short pause** (2s) so the load balancer notices the readiness change on its
   own polling interval before connections stop being accepted.
3. **`app.close()`** — stops accepting, runs `onModuleDestroy` (which disconnects
   Prisma), and lets in-flight work finish.
4. **Exit 0.**

A 10-second hard timeout sits over the whole thing. A request that will not finish
must not hold the process open, because the orchestrator will send SIGKILL
eventually and that is a worse ending than a controlled one.

Set the platform's termination grace period **above** 10 seconds, or the hard
timeout never gets to run.

---

## Health contract

| Path | Meaning | Use |
| --- | --- | --- |
| `/api/health/live` | The process can serve. Checks nothing else. | liveness probe, container healthcheck |
| `/api/health/ready` | Traffic should be routed here. Checks the database, fails while draining. | readiness probe |
| `/api/health` | Human-facing summary. Always 200; reports `degraded`. | dashboards |

Never point a liveness probe at `/ready`. A database outage would then kill every
container in the fleet, which fixes nothing and removes the capacity needed to
recover.

---

## The client and the API share an origin

This is a constraint, not a preference.

The refresh token is an HttpOnly cookie with `sameSite: 'lax'` and
`path: '/api/auth'`. Serve the frontend from a different origin than the API and
the browser stops sending it: sign-in appears to work, and then the session ends
without explanation the moment the access token expires. The two WebSocket
gateways (`/api/topology`, `/api/live/chat`) fail the same way; a CDN rewrite in
front of a separate API host is usually where the upgrade request stops working.

So the image carries both. `CLIENT_DIR` points the server at the built frontend;
when it is empty the process serves the API alone, which is right for a dev
session, where Vite serves the client and proxies `/api` here -- the same single
origin reached another way.

`sameSite: 'none'` would be the alternative. It costs the CSRF protection that
`lax` gives for free, and it buys nothing if the two ship together.

---

## Image

Built from the repository root, not from `server/`: the frontend build is one of
its stages.

```bash
docker build -t react-boilerplate .
docker run --rm -p 3001:3001 \
  -e DATABASE_URL=... -e JWT_SECRET=... -e COOKIE_SECURE=true -e NODE_ENV=production \
  react-boilerplate
```

Multi-stage: the TypeScript toolchain, the test runner, and the Prisma CLI stay in
the build stages. Runs as the image's non-root `node` user. The healthcheck hits
liveness only, so a container that is up but waiting on the database reports
healthy-but-not-ready — which is what a rolling deploy needs to see.

`NODE_ENV=production` refuses to start when `COOKIE_SECURE` is false, so a
plain-HTTP deployment fails at boot instead of sending the refresh cookie in the
clear.

---

## Scaling limits, stated plainly

Three things are per-process today and will behave incorrectly on more than one
instance. Each has a named seam.

| Concern | Behaviour on N instances | Seam |
| --- | --- | --- |
| Login throttling | N times the attempt budget | `LOGIN_ATTEMPTS` |
| Chat send throttling | N times the message budget | `ChatRateLimiter` |
| Realtime fan-out | An event published on A never reaches a client on B | `TopologyBroadcaster`, `ChatBroadcaster` |

Fan-out is the one that is visibly wrong rather than merely weaker: half the
viewers stop receiving updates. Until a shared adapter exists, run one instance —
or route every WebSocket for a given graph or broadcast to the same one.

---

## What has not been verified

- **The Docker image has never been built locally.** There is no Docker daemon on
  this machine. CI's `docker` job builds it and smoke-tests the container: liveness
  answers without a database, readiness does not, the client is served, a deep link
  reaches the SPA, and an unknown API path still returns 404 rather than HTML.
- **No load testing has been done.** No baseline numbers are claimed. The bounded
  queues, coalescing, and slow-consumer disconnect are argued for in code and
  covered by unit tests; none of that is a measurement.
- **Nothing has been deployed.** The application has run against a hosted
  PostgreSQL from a developer machine, not from a hosting platform. Anything that
  only appears behind a proxy — `TRUST_PROXY`, TLS termination, the platform's own
  idle timeouts on a WebSocket — is untested.

Two items that used to be on this list are now closed:

- Migrations were authored offline, and have since been applied from this machine
  against a hosted PostgreSQL with `migrate deploy`; `migrate status` reports none
  pending, and CI's `integration` job proves replaying them reproduces
  `schema.prisma` exactly.
- Both WebSocket gateways have been exercised over a real socket: handshake
  authentication accepted a valid token and closed 4401 on a missing or forged
  one, a chat message posted over HTTP arrived at a joined subscriber, and a
  published topology event changed the counters in a live browser.
