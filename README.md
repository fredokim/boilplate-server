# Server

NestJS + TypeScript + PostgreSQL + Prisma backend for the React boilerplate.

The foundation — configuration, the shared API envelope, validation, error
handling, logging, health probes, OpenAPI — plus the auth, dashboard, graph, and
live/chat modules. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for where they go.

**The frontend is untouched.** MSW still serves the app and no client code points
at this server.

---

## Getting started

```bash
cd server
npm install                 # postinstall runs `prisma generate`
cp .env.example .env        # required: Prisma and the config validator both read it
npm run db:up               # start PostgreSQL in Docker
npm run start:dev
```

The API is at `http://localhost:3001/api` and the docs at
`http://localhost:3001/api/docs`.

`.env` is not optional. The config validator refuses to start without
`DATABASE_URL`, and the Prisma CLI cannot read `schema.prisma` without it —
`prisma validate` fails with `Environment variable not found: DATABASE_URL`.

You do **not** need the database running to start the server. It boots without
one, liveness passes, and readiness reports the failure. That is deliberate; see
ARCHITECTURE.md.

---

## Commands

| Command | Does |
| --- | --- |
| `npm run start:dev` | Watch-mode server |
| `npm start` | Run the built server (`npm run build` first) |
| `npm run build` | Compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit` over src, test, and prisma |
| `npm run lint` | ESLint, zero warnings tolerated |
| `npm test` | Unit tests |
| `npm run test:e2e` | End-to-end tests over real HTTP |
| `npm run openapi:generate` | Build, then write `openapi.json` |
| `npm run db:up` / `db:down` | Local PostgreSQL via Docker Compose |
| `npm run prisma:validate` | Check `schema.prisma` |
| `npm run prisma:migrate` | Create and apply a migration |
| `npm run prisma:deploy` | Apply committed migrations (deployment) |
| `npm run prisma:seed` | Run the seed script |
| `npm run test:integration` | Tests that need a real PostgreSQL (see below) |
| `npm run openapi:check` | Fails when the committed spec drifts from the code |

The same commands are reachable from the repository root as `server:*` — see the
root README.

---

## Auth

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/auth/login` | public | `{ email, password }` to `{ accessToken, user }` |
| `POST /api/auth/refresh` | refresh cookie | Rotates the cookie |
| `POST /api/auth/logout` | public | Idempotent |
| `GET /api/auth/session` | bearer | Re-reads the user from the database |

Login and session responses match the frontend's existing `LoginResultDto` and
`SessionDto` exactly, so the client DTOs need no change to talk to this server.

`JWT_SECRET` is required, at least 32 characters, and has **no default** — a
fallback would ship as a real secret. Generate one:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Create a local demo account by setting `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` in `.env`, then running `npm run prisma:seed`. Leaving them
empty skips it — no password is ever invented. Startup refuses
`SEED_ADMIN_PASSWORD` in production, and refuses `COOKIE_SECURE=false` there too.

Every route is protected by default; opening one is `@Public()`. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for token design, rotation, and the reasoning
behind the login behaviour.

## Dashboard

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /api/dashboard/{summary,kpi,chart,table}` | `dashboard:read` | The routes the frontend already calls, unchanged |
| `GET /api/dashboards/:id` | `dashboard:read` | Not visible answers 404, never 403 |
| `PUT /api/dashboards/:id` | `dashboard:write` | Optimistic lock; 409 carries `currentVersion` |
| `GET|PUT /api/dashboards/:id/personalization` | read / write | Created on first read rather than 404 |
| Preset create / rename / select / delete | `dashboard:write` | |

**`dashboard:write` is new.** The frontend fixtures only granted `dashboard:read`,
so the seed and test fixtures now add it to `admin`; without it a real login can
read a dashboard and then fail every save with a 403.

The frontend keeps its localStorage and memory repositories as the default.
`VITE_DASHBOARD_REPOSITORY=server` opts into the HTTP ones.

## Graph and topology

| Endpoint | Permission |
| --- | --- |
| `GET|POST /api/graphs` | `graph:read` / `graph:write` |
| `GET|DELETE /api/graphs/:id` | `graph:read` / `graph:write` |
| `PUT /api/graphs/:id/content` | `graph:write` — whole-document replace, optimistic lock |
| `GET /api/graphs/:id/topology/snapshot` | `graph:read` |
| `GET /api/graphs/:id/topology/resync?lastSequence=` | `graph:read` |
| `POST /api/graphs/:id/topology/events` | `graph:write` |
| `WS /api/topology?token=` | `topology:subscribe` |

`graph:read`, `graph:write`, and `topology:subscribe` are new in this step, added
to the seeded roles for the same reason `dashboard:write` was.

The frontend keeps the mock transport as the default;
`VITE_TOPOLOGY_SOURCE=server` opts into the real one.

## Live and chat

| Endpoint | Permission |
| --- | --- |
| `GET /api/live/broadcasts` · `/:id` | `live:read` |
| `POST /api/live/broadcasts/:id/playback-session` | `live:read` — short-lived manifest grant |
| `POST /api/live/broadcasts/:id/status` | `live:manage` — idempotent, `ended` is terminal |
| `GET /api/live/broadcasts/:id/chat/messages` | `live:read` — sequence cursor |
| `POST /api/live/broadcasts/:id/chat/messages` | `chat:write` — idempotent on `clientMessageId` |
| `DELETE .../chat/messages/:messageId` | `chat:moderate` — tombstone, row retained |
| `POST|DELETE .../chat/mutes` | `chat:moderate` |
| `WS /api/live/chat?token=` | `live:read` — read-only |

The manifest URL is never returned with broadcast metadata and never logged.
`VITE_CHAT_SOURCE=server` opts the frontend into the real chat transport.

## Integration tests

`npm run test:integration` covers the things a stub cannot prove: that the
migrations apply, that the unique constraints exist and are enforced, that
concurrent writers never share a sequence, that cascades delete what they claim
to, and that the client-level `omit` still withholds `passwordHash`.

They need a real PostgreSQL and are **not** part of `npm run check`, so the
default gate stays runnable on a machine with no database.

```bash
DATABASE_URL=postgresql://... RUN_INTEGRATION=1 npm run test:integration
```

`RUN_INTEGRATION=1` is required. Without it the suite skips and exits 0; with it,
an unreachable database **fails**. A suite that silently skips in CI is worse than
no suite — the badge stays green while nothing is checked.

CI runs them against a PostgreSQL service container, along with
`prisma migrate deploy`, `migrate status`, a migrations-versus-schema drift check,
and the seed.

## Limitations

- **These migrations were authored offline.** The machine this was written on has
  neither Docker nor PostgreSQL, so every migration was generated with
  `prisma migrate diff` rather than by applying it. The CI `integration` job is
  what proves they run; until it has run at least once, treat that as unverified
  locally.
- **Login throttling is per-process.** Correct for one instance, wrong for
  several. `LOGIN_ATTEMPTS` is the seam for Redis.
- **A database outage during login answers 500, not 503.** The readiness probe
  reports the real cause; the login endpoint does not yet distinguish "the
  database is down" from any other unexpected failure.
- **The frontend still uses MSW.** No client code points at this server by
  default; both server modes are opt-in environment flags.
- **Realtime fan-out is per-process**, for both topology and chat. An event
  published on one instance never reaches a client connected to another.
  `TopologyBroadcaster` and `ChatBroadcaster` are the seams for Redis.
- **Playback sessions are recorded but not verified on use.** The manifest URL is
  handed out with an expiry; nothing checks the session again when the player
  fetches it, which would need the CDN to participate (signed URLs or a token the
  edge validates).
- **Neither WebSocket gateway has an e2e test over a real socket.** Its behaviour is
  covered by unit tests against a fake socket; a genuine upgrade handshake is
  untested.

## Database

```bash
npm run db:up                              # PostgreSQL on localhost:5432
npm run prisma:migrate -- --name add_auth  # once there are models
npm run prisma:seed
```

The first migration, `20260831000000_add_auth`, creates `Role`, `User`, and
`RefreshSession`. It has not been applied anywhere — see Limitations above.

`prisma migrate reset` will not seed automatically — the `package.json#prisma`
hook that used to do that is deprecated in Prisma 6.19 and removed in Prisma 7.
Run `npm run prisma:seed` after a reset.

---

## Tests

No test touches a real database.

- Unit tests cover the envelope interceptor, the exception filter, validation
  flattening, log redaction, the timeout helper, environment validation, refresh
  token handling, both guards, and every login rule in `AuthService`.
- E2E tests boot the real `AppModule` — same pipe, filter, and interceptors as
  production — and replace exactly two providers: `DATABASE_HEALTH`, so a test can
  state what the database is doing, and `PrismaService`, so nothing waits on a
  socket. See `test/createTestApp.ts`.

The auth suite additionally swaps in an in-memory Prisma fake
(`test/authFixtures.ts`) that stores rows and answers queries, so rotation and
reuse detection are exercised for real rather than asserted against a script of
expected calls. It implements the `omit` contract too, so a service that forgot
to ask for `passwordHash` explicitly would fail there.

The validation, envelope, and guard behaviour is proven over real HTTP against
probe controllers that exist only for those suites, rather than by adding domain
routes to the shipped API just to have something to call.

---

## Environment

See `.env.example` for the full list. `DATABASE_URL` and `JWT_SECRET` are the
variables with no default. Real secrets never enter the repository.

---

## Known environment issue: non-ASCII project paths

**Node cannot resolve `#` subpath imports when the project path contains
non-ASCII characters.** This repository lives under `OneDrive\바탕 화면\…`, so it
is affected. Minimal reproduction on Node v22.17.0:

```bash
mkdir t && cd t
echo '{"name":"t","imports":{"#x":"./x.js"}}' > package.json
echo 'module.exports=42' > x.js
echo 'console.log(require("#x"))' > main.js
node main.js     # prints 42 under an ASCII path; "Cannot find module '#x'" otherwise
```

This is a Node issue, not a Prisma or application one, but it hits Prisma
directly: the implicitly generated client is reached through `#main-entry-point`,
so `require('@prisma/client')` fails.

The schema therefore sets an explicit `output`, which resolves through
`index.js` and works on any path. That is also the direction Prisma itself is
moving — Prisma 7 requires an explicit output — so the setting is not a
workaround the project has to carry apologetically.

Two things to know if you hit related symptoms:

- Jest is unaffected either way; it uses its own resolver. A green test suite does
  not prove the built server can start.
- Other packages that use `#` subpath imports may still fail under this path. If
  one does, the fix is the same as the real fix here: move the checkout to an
  ASCII path.

## Known environment issue: rebuilding while the server runs

`nest build` deletes `dist/` first, and `dist/generated/prisma` contains the
native query engine. On Windows a running server holds that file open and the
build fails with `EPERM: operation not permitted, unlink … query_engine-windows.dll.node`.
Stop the server before building.
