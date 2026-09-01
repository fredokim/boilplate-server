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

## Image

```bash
docker build -t react-boilerplate-server ./server
docker run --rm -p 3001:3001 \
  -e DATABASE_URL=... -e JWT_SECRET=... -e COOKIE_SECURE=true -e NODE_ENV=production \
  react-boilerplate-server
```

Multi-stage: the TypeScript toolchain, the test runner, and the Prisma CLI stay in
the build stage. Runs as the image's non-root `node` user. The healthcheck hits
liveness only, so a container that is up but waiting on the database reports
healthy-but-not-ready — which is what a rolling deploy needs to see.

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

- **No migration has been applied from this machine.** Every migration in
  `prisma/migrations/` was generated offline with `prisma migrate diff`, because
  there is neither Docker nor PostgreSQL here. CI's `integration` job applies them
  against a real PostgreSQL service container and checks that replaying them
  reproduces `schema.prisma` exactly — so the first CI run is what closes this.
- **The Docker image has never been built locally.** No Docker daemon was
  available. CI's `docker` job builds it and smoke-tests the container.
- **Neither WebSocket gateway has been exercised over a real socket.** Both are
  covered by unit tests against a fake socket.
- **No load testing has been done.** No baseline numbers are claimed.

These are gaps in verification, not known failures — but they are the four things
to do first on a machine that has a database and a Docker daemon.
