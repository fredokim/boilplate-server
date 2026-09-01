# Server Architecture

NestJS backend for the React boilerplate. This document covers how a request is
handled, where each responsibility lives, and what was deliberately left out of
each step.

The frontend is unchanged by this work. MSW still serves the app, and no client
code points at this server yet.

---

## Request flow

```
HTTP request
  │
  ├─ RequestIdMiddleware        assigns or adopts x-request-id, sets it on the response
  │
  ├─ RequestLoggingInterceptor  starts the clock            (outermost interceptor)
  │   └─ ResponseEnvelopeInterceptor
  │       │
  │       ├─ ValidationPipe     plain body → validated DTO instance
  │       │
  │       ├─ Controller         HTTP shape only; calls one service method
  │       │   └─ Service        the use case; returns a domain object
  │       │       └─ PrismaService
  │       │
  │       └─ on success: wraps the return value as { success: true, data }
  │
  └─ on throw: AllExceptionsFilter → { success: false, error: { code, message, details? } }
```

Every global enhancer is registered as a provider in `AppModule` (`APP_PIPE`,
`APP_FILTER`, `APP_INTERCEPTOR`) rather than through `app.useGlobalPipes()` in
`main.ts`. Two consequences, both intended:

- They can be injected with `AppConfig` and `LOGGER`.
- A test built from `AppModule` gets the same pipeline that ships. Wiring them in
  `main.ts` would leave every e2e test exercising a different stack.

`main.ts` is left with transport concerns only: global prefix, body limits, CORS,
shutdown hooks, Swagger, listen.

---

## The API envelope

The contract is defined in `API_CONTRACT.md` at the repository root and shared
with the frontend.

```jsonc
// success
{ "success": true, "data": { } }

// failure
{ "success": false, "error": { "code": "ERROR_CODE", "message": "…", "details": { } } }
```

| Concern | Owner |
| --- | --- |
| Success envelope | `common/interceptors/responseEnvelope.interceptor.ts` |
| Error envelope | `common/filters/allExceptions.filter.ts` |
| Types and helpers | `common/contracts/apiEnvelope.ts` |
| Domain codes | `common/contracts/errorCode.ts` |

No controller writes either half by hand. A controller returns its domain object;
if it throws, the filter renders the failure.

### Status and code are separate

HTTP status tells an intermediary what to do. `error.code` tells the frontend
what happened. Several codes can share a status, and a code keeps its meaning
even if the status changes.

`AUTH_REQUIRED` is load-bearing: `src/core/api/apiClient.ts` on the frontend
branches on that exact string to classify a failure as `kind: 'auth'`. Renaming
it here breaks that branch silently.

### `details` and the frontend DTO

The frontend's `ApiErrorDto` declares only `code` and `message`, and validates
with `whitelist: true`. Extra keys are stripped, not rejected — which is what
makes `details` safe to send today. A client that models it can read it; the
current frontend ignores it.

### Nothing leaks from an unexpected failure

An unhandled error becomes a generic 500 in production: fixed message,
`INTERNAL_ERROR`, no stack, no details. The real cause goes to the log with the
request id, which is how the two are joined. Outside production the cause is
echoed into `details`, because debugging a blank 500 is worse than the exposure
on a developer's machine.

---

## Validation

`common/validation/validationPipe.ts` is the single policy:

- `whitelist` — properties with no decorator are stripped.
- `forbidNonWhitelisted` — an undeclared property is a rejection, not a silent
  drop. A client sending `isAdmin: true` at a DTO that never declared it should
  be told.
- `transform` — handlers receive real DTO instances.

Failures become `VALIDATION_ERROR` with per-field messages:

```jsonc
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": { "fields": { "profile.displayName": ["displayName should not be empty"] } }
  }
}
```

Paths are flattened so the frontend can attach a message to an input: nested
objects use dots, array elements use brackets — `nodes[0].id`.

---

## Configuration

`config/env.validation.ts` validates the environment while `AppConfigModule` is
being imported, before anything listens. A missing or malformed variable stops
the process with every offending variable named at once.

Two rules there are worth keeping:

- **Every property carries an explicit type annotation.** A process environment
  holds only strings.
- **No `enableImplicitConversion`.** It coerces from `design:type` metadata, which
  TypeScript emits from the written annotation rather than the initialiser, and it
  runs ahead of custom transforms. Both of those produced real bugs during this
  work: `PORT=3001` failed `@IsInt()`, and `SWAGGER_ENABLED=false` became `true`
  via `Boolean('false')`. Conversions are now stated outright — `@Type` for
  numbers, `@Transform` for booleans — and pinned by `env.validation.spec.ts`.

`AppConfig` is the typed face over `ConfigService`; nothing else reads
`process.env`.

---

## Database

`PrismaService` owns the connection lifecycle. One decision shapes the health
endpoints:

**A failed connection at startup is logged, not thrown.** If an unreachable
database stopped the process from booting, `/health/live` could never answer
during an outage, and an orchestrator would restart a container whose only
problem is elsewhere. Instead the app starts, liveness passes, and readiness
reports the database as down until it recovers.

`ping()` therefore asks the database now rather than trusting a flag set at boot.

There is no repository layer and no base service. Prisma is already the
data-access abstraction; a second one with nothing behind it is indirection, not
design. Prisma types are not returned from controllers — response DTOs are, so
the schema can change without changing the wire contract.

### Generated client output

`schema.prisma` sets an explicit `output` (`src/generated/prisma`) instead of the
implicit `node_modules/.prisma`. Prisma is moving this way and Prisma 7 requires
it, but there was also a concrete reason: the implicit client is reached through a
`#main-entry-point` subpath import, and **Node cannot resolve `#` imports when the
project path contains non-ASCII characters.** This repository lives under
`OneDrive\바탕 화면\…`, so `require('@prisma/client')` fails here. See the note in
`README.md`.

The generated directory is gitignored, regenerated by `postinstall`, excluded from
the TypeScript root file set and from lint, and copied into `dist` by the
nest-cli `assets` entry so the built server can load it.

### Models

`Role`, `User`, and `RefreshSession` arrived with the auth module. Permissions
live on the role as a `String[]` so a new one is a seed change rather than a
migration, and the strings match what the frontend already checks
(`dashboard:read`, `user:write`).

`passwordHash` and `tokenHash` are excluded from every query by the client-level
`omit` in `PrismaService`. Reading one back requires an explicit
`omit: { passwordHash: false }` at the call site, which makes "this query returns
a password hash" visible in review rather than something that happens by default.

---

## Health

| Endpoint | Question | Dependencies |
| --- | --- | --- |
| `GET /api/health/live` | Is this process able to serve? | none, by design |
| `GET /api/health/ready` | Should traffic be routed here? | database |
| `GET /api/health` | What is the current state? | database, reported not enforced |

Liveness checks nothing on purpose. A liveness probe that fails because the
database is down gets the container killed and restarted, which fixes nothing and
removes capacity during exactly the wrong incident.

Readiness answers 503 with the failing checks in `error.details`. The summary
endpoint always answers 200 and reports `degraded`, so a dashboard polling it does
not have to unpack an error envelope.

### The check is time-bounded

`PrismaHealthIndicator` races the ping against 1,500 ms. Prisma's own connect
timeout is roughly four seconds; a readiness probe is usually given one to three.
Measured against a stopped database, the unbounded probe answered in 4,078 ms —
past the point where its caller has given up — and the bounded one answers in
1,508 ms with `Database did not respond within 1500ms.` Answering "down" quickly
beats answering precisely too late.

### Replaceable dependency

Readiness depends on the `DATABASE_HEALTH` token, never on Prisma directly. The
e2e suite binds a stub to it and asserts both a healthy and an unreachable
database with no PostgreSQL anywhere near the test run.

---

## Logging

`LOGGER` is a four-method port (`common/logging/logger.port.ts`). Only
`nestLogger.adapter.ts` knows Nest's `Logger` exists, so moving to pino or an
OpenTelemetry exporter is one more adapter and a rebound token.

Records are single-line JSON: `method`, `path`, `statusCode`, `durationMs`,
`requestId`.

**Never logged**: `authorization`, `cookie`, `set-cookie`, `x-api-key` and
friends; fields named like `password`, `token`, `secret`, `apiKey`, `cvv`. See
`common/logging/redact.ts`. Query strings are dropped from logged paths for the
same reason — they routinely carry tokens.

### Who logs what

- **Access log** (`RequestLoggingInterceptor`) — one line per request, always.
- **Error log** (`AllExceptionsFilter`) — a stack only for a genuinely unexpected
  failure. A deliberate 5xx gets a line without one: a readiness probe polling
  every few seconds during an outage would otherwise bury the log in identical
  traces. Deliberate 4xx responses are left to the access log.

---

## Where the next modules go

```
src/
  auth/          implemented: login, refresh, logout, session, guards
  dashboard/     implemented: widget data, definitions, personalization, presets
  graph/         implemented: CRUD, snapshot, replay, WebSocket gateway
  live/          implemented: broadcasts, playback sessions, chat, moderation
  chat/          live chat
```

Each is a self-contained Nest module: controller, service, DTOs, and its own
Prisma models. They inherit the envelope, validation, error mapping, and logging
without doing anything — that is what `common/` is for. Nothing domain-specific
belongs in `common/`.

### Connection points for the auth module

| Point | Where |
| --- | --- |
| 401 envelope | `AppException.unauthorized()` → `AUTH_REQUIRED`, already matched by the frontend |
| Bearer scheme | already declared in `swagger.ts`; add `@ApiBearerAuth('bearer')` to guarded routes |
| Guards | `common/guards/` exists for cross-cutting guards; strategy-specific ones live in `auth/` |
| User model | first real Prisma model; first migration |
| Request user | extend the request type alongside `RequestWithId` |

---

## Deliberately not in this step

- **Redis, CQRS, Kafka, microservices** — nothing here needs them.
- **A repository abstraction or a generic base service** — no second data source
  to justify either.
- **Switching the frontend off MSW** — the client still talks to mocks.
- **A CI workflow for the server** — the root CI still covers the frontend only.

### Two differences from the frontend tsconfig

| Setting | Frontend | Server | Why |
| --- | --- | --- | --- |
| `exactOptionalPropertyTypes` | on | off | Nest and Swagger decorator metadata types are not written for it |
| `incremental` | — | off | nest-cli deletes `outDir` but leaves `.tsbuildinfo`, so the next build sees a valid cache, believes the outputs exist, and emits nothing |

The second one is not a preference. It produced a clean build that silently
produced no `dist`.

Tests use Jest rather than the frontend's Vitest. Nest's testing utilities,
`ts-jest`, and decorator metadata work together without configuration; the two
packages are independent, so the toolchains do not have to match.

---

## Auth

### Two tokens, two jobs

The **access token** is a short-lived HS256 JWT carrying the user's id, name,
email, role, and permissions. Because it is self-contained, `AuthenticationGuard`
verifies a signature and nothing more — no database round trip on any request.
The cost is staleness: a permission revoked mid-session stays effective until the
token expires, which is why the TTL is capped at an hour and defaults to fifteen
minutes.

The **refresh token** is 256 random bits, stored only as a SHA-256 digest.
Argon2 is deliberately *not* used for it. Argon2's cost exists to make guessing a
low-entropy secret expensive, and there is nothing here to guess — the only way to
use one is to have stolen it. What the hash must do is ensure a leaked database
yields no working tokens, and a fast one-way function does that completely.
Argon2 would add hundreds of milliseconds to every refresh for no gain.

It is delivered as an `HttpOnly`, `SameSite=Lax` cookie scoped to `/api/auth`. It
never appears in a response body and never reaches browser storage, so script
running on the page cannot read it. `Lax` rather than `Strict` because the cookie
has to survive a top-level navigation back into the app; it is not a CSRF control
on its own, and none is needed — the refresh endpoint returns a token in its body
rather than acting on the request, so a cross-site form post gains nothing.

### Rotation and reuse detection

Every refresh revokes the presented token and issues a replacement in the same
family, inside one transaction. There is no moment where both work and none where
neither does, so two concurrent refreshes with the same token cannot both succeed.

Presenting an already-revoked token revokes **the entire family**. That is the
signature of a copied token: someone is using one the legitimate holder already
spent. The legitimate user is signed out too — the correct trade once a token has
provably leaked.

### What login guarantees

Three properties are load-bearing, and each is pinned by a test.

- **A wrong password and an unknown address are indistinguishable.** Same status,
  same code, same message. Anything else turns the login form into an
  account-existence oracle.
- **They take the same time.** An unknown address is still verified against a real
  Argon2 hash — of 32 random bytes that were discarded — because returning early
  would answer through timing what the status code refuses to answer. The constant
  has to be a genuine parseable hash: an invented string would fail to parse and
  return immediately, restoring the fast path it exists to remove.
- **A disabled account is reported only after the password was correct.** Saying
  it earlier would be the same oracle by another route.

Passwords use Argon2id at the OWASP baseline (19 MiB, t=2, p=1) via
`@node-rs/argon2`, which ships prebuilt binaries and needs no C toolchain. Login
is the only moment the plaintext exists, so it is also where a hash written under
weaker parameters is upgraded — and only upwards, never down.

### Guards

Both are global, registered in this order:

1. `AuthenticationGuard` — verifies the bearer token, attaches the user.
2. `PermissionGuard` — reads what the first one attached.

The order is a dependency, not a preference; Nest runs `APP_GUARD` providers in
registration order.

**Everything is protected by default.** Opening a route is `@Public()` — a
deliberate, greppable act. The opposite arrangement, protecting routes as you
remember to, fails silently, and what it fails at is leaving an endpoint open.
The health controller and the login/refresh/logout routes carry `@Public()`.

`@RequirePermissions('user:write')` requires every listed permission. A denial
returns `AUTH_FORBIDDEN` with `details.missingPermissions`, which tells an
authenticated caller what to ask an administrator for and discloses nothing they
could not learn by trying.

### Login throttling

`LOGIN_ATTEMPTS` is a token bound to an in-process fixed-window counter. Two
properties worth stating plainly: it is per-process, so N instances allow N times
the attempts; and a fixed window lets a caller who times requests around the
boundary get roughly twice the budget in a burst. Both are acceptable for slowing
credential stuffing on a single node. Neither would be acceptable as the only
control in production. The port is where Redis goes.

### Not implemented

Registration, email verification, password reset, OAuth, MFA, tenancy, and admin
user CRUD are all out of scope for this step.

---

## Dashboard

### Two surfaces, on purpose

`/dashboard/*` holds the four routes the frontend already calls — summary, kpi,
chart, table — at exactly the paths and shapes it calls them with, including the
legacy `metric` alias the MSW handlers branch on. `/dashboards/:id/*` holds the
domain routes: definitions, personalization, presets.

They are not merged. The first exists so the client can be pointed at the real
server without editing `dashboardDataSourceApi.ts` or the MSW scenarios; the
second is the contract worth keeping. Collapsing them would have meant changing
the client to prove the server works, which is the opposite of the point.

### Storage: shared definition, per-user difference

`Dashboard` holds the definition everyone sees. `DashboardPersonalization` holds
one row per user per dashboard containing only the difference — hidden widgets,
per-widget overrides, added widgets, filters — matching the frontend's own
override model.

Storing a whole copy of the dashboard per user would mean a change to the shared
definition never reaching anyone who had personalised it.

Both store versioned JSON rather than relational widget rows. A widget is a
discriminated union whose `config` differs per variant, and the frontend already
owns that shape; modelling it relationally would mean a migration every time a
widget gains a field, and two definitions of the same thing to keep in step.

### The database cannot validate JSON, so the server does

`dashboardSchema.ts` is the only thing between a malformed payload and a row that
every later read has to cope with. It runs **on the way in and on the way out** —
a row written by an older server, or edited by hand, must not reach a client as
unchecked JSON, because the failure would then surface as a DTO error in the
browser pointing at the wrong layer.

It also enforces the bounds the shape does not: at most 60 widgets, 20 presets,
and 256 KB serialised. Widget `config` is an open object, so without a byte
ceiling one request can store a megabyte of strings.

The data source allowlist is checked here too, not only at the query endpoints. A
widget naming an unknown source would otherwise be written happily and fail much
later, when something tried to render it.

### Optimistic concurrency

Every write takes the `version` the client last read and puts it in the WHERE
clause:

```ts
updateMany({ where: { id, version: expectedVersion }, data: { ..., version: { increment: 1 } } })
```

The check and the write are one statement, so two writers who both read version 3
cannot both succeed — the second matches no rows. That case answers **409
`DASHBOARD_VERSION_CONFLICT` with `details.currentVersion`**, because without the
current version the client's only recovery is a blind refetch.

### Who can see what

`dashboard:read` and `dashboard:write`. **`dashboard:write` is new in this step** —
the frontend's fixtures only ever granted `dashboard:read`, because personalization
was saved to localStorage and nothing needed a write permission. The seed and the
test fixtures now grant it to `admin`; without that, a real login can load a
dashboard and then fail every save with a 403.

Two decisions about hiding things:

- **Another user's private dashboard answers 404, not 403.** A distinct 403 would
  confirm the id exists, which is enough to enumerate other people's dashboards
  one guess at a time. The same applies to a preset that does not exist.
- **403 is reserved for a dashboard the caller can see but does not own.** The
  existence is already established by the read, so hiding it would only confuse.

The user id comes from the access token on every route. No handler reads a user id
from a path, a body, or a query string, so there is no request a caller could
shape to reach someone else's personalization.

### Data sources are an allowlist

Six ids, each with a declared kind. A client names one of them; it never names a
table, a query, or a metric expression. Asking a KPI route for a table source is
refused rather than answered, because the wrong shape would fail the client's own
DTO validation with no indication of where it came from.

`scope` is an enum and `limit` is capped at 100 — a table source generates rows on
demand, and an uncapped limit is a request-sized denial of service.

### Frontend wiring

`httpDashboardRepository.ts` implements both existing repository contracts against
the server. The localStorage and memory versions are untouched and remain the
default: `VITE_DASHBOARD_REPOSITORY=server` opts in, and everything else — tests,
stories, dev sessions — keeps running against MSW with no backend at all.

`DashboardRepository.load` is synchronous because localStorage is. HTTP is not, so
fetching is a separate async function and the repository closes over what it
returned. The version travels with the repository rather than with the caller, and
a failed save does **not** advance it — otherwise the next attempt would send a
version the server never issued and fail for a second, misleading reason.

---

## Graph and topology

### Structure and runtime are different clocks

`Graph.version` is the optimistic lock on the **structure** — it moves when
someone edits nodes or edges. `Graph.sequence` is the monotonic counter for the
**runtime event stream** — it moves when a status or a metric changes. They are
separate columns because sharing one would make every metric tick invalidate
every open editor.

The routes are split the same way: `/graphs/:id` is what a person edits,
`/graphs/:id/topology/*` is what changes on its own.

### Editing is a whole-document replace

`PUT /graphs/:id/content` replaces every node and edge in one transaction rather
than applying a stream of adds and removes. The editor works on a whole document
and sends it back; applying that incrementally would leave the graph momentarily
invalid — an edge whose node has been deleted but whose replacement has not
arrived. Replacing atomically means the invariants hold at every point a reader
could observe.

Invariants are checked **before** the transaction opens, so a bad payload costs
nothing and the version does not move.

### Invariants the database cannot express

`(graphId, nodeId)` and `(graphId, edgeId)` uniqueness are constraints. These are
not, and are enforced in `graphInvariants.ts`:

- **Dangling edges are refused.** An edge to a node that does not exist renders as
  nothing and silently distorts every route calculation.
- **Self-loops are refused.** The layout engine has no placement for one and in a
  network topology it means nothing.
- **A second edge over the same ordered pair is refused** — invisible on the
  canvas, and it doubles every traversal. Direction is meaningful: A→B and B→A are
  both allowed.

Each failure answers `GRAPH_INVALID_EDGE` naming the offending id. A foreign key
would have produced a constraint violation the client cannot act on.

### Sequence allocation

`publish` runs in one transaction: increment `Graph.sequence`, insert the event
with that number, apply it to the runtime row. The increment is
`{ increment: 1 }` rather than a read followed by a write, so two concurrent
publishes cannot be handed the same number — and the unique constraint on
`(graphId, sequence)` is the backstop if that reasoning is ever wrong.

Fan-out happens **after** the transaction commits. Publishing inside it would let
a subscriber see an event that a rollback then un-happened.

### Metrics merge, status replaces

A metric event carries only what changed, so overwriting the map would delete
every metric the event did not mention. A status event carries the whole status,
so there is nothing to merge.

### The event table is a replay buffer, not a log

Current runtime state lives in `GraphNodeRuntime` / `GraphEdgeRuntime`, and a
snapshot is a read of those rows — never a fold of events. That is what makes
pruning safe: dropping old events cannot change the answer.

Retention is 1,000 events or 15 minutes, whichever comes first, pruned after a
write rather than on a timer — a graph nobody writes to needs no pruning, and a
timer would hold the process awake for it.

### What a reconnecting client is told

`decideReplay` has three outcomes and the client acts differently on each:

| Client sequence | Answer |
| --- | --- |
| Equal to the server's | `up-to-date` |
| Behind, and the first missing event is retained | `replay` |
| Behind, and that event is pruned | `resync` (`behind-retention`) |
| **Ahead of the server** | `resync` (`ahead-of-server`) |

The last row is the one worth naming. A client ahead of the server is not up to
date — it holds state from a stream that no longer exists (a different instance,
a reset database) and continuing would leave it discarding every future event as
stale.

Delivery is **at-least-once and the server does not claim otherwise.** A replayed
event may arrive twice; the client dedupes on `eventId` and orders on `sequence`,
and that pair is what makes the two converge.

### The WebSocket gateway

Authentication happens at the handshake. The token arrives as a query parameter
because a browser cannot set headers on a WebSocket upgrade — a real trade, since
the token can appear in proxy access logs, and the reason it is the short-lived
access token and never the refresh token.

Permission is checked **per graph**, not once at connect: the token grants access
to the stream, not to everything on it. A graph the caller cannot see answers
`GRAPH_NOT_FOUND`, the same as one that does not exist.

Per connection: at most 8 subscriptions, 60 messages per 10 seconds, 4 KB per
message. Close codes are in the 4000 range so a client can decide whether
reconnecting is worth trying.

**A slow consumer is disconnected, not queued.** Buffering for it moves the
problem into server memory and makes one bad client everyone's; a disconnect is
recoverable, because the client reconnects with its last sequence and replays.

One heartbeat timer for the whole gateway, stopped when the last client leaves so
an idle process is not held awake.

### Scaling

`TopologyBroadcaster` is an in-process emitter. That is correct for one instance
and wrong for several: an event published on instance A never reaches a client
connected to instance B. The indirection exists so a Redis pub/sub adapter is a
replacement of that one class. Redis is deliberately not introduced here; the
place it goes is.

### Frontend wiring

`serverTopologySource.ts` adds a real transport alongside the mock one.
`VITE_TOPOLOGY_SOURCE=server` opts in; the default stays `mock` so tests,
Storybook, and a backend-free dev session behave exactly as before.

The transport deliberately does **not** reconnect and does **not** buffer. The
controller already owns backoff with jitter, and buffering here would duplicate
the pending cap one layer up — and hide it. The store's enqueue/flush batching,
coalescing, hidden-tab intervals, and generation guard are untouched by this
work, which is the property the layering exists for.

---

## Live experience and chat

### A control plane, not a media server

Nothing here encodes, proxies, or serves a segment. The server holds the manifest
URL an external packager produced and the policy around who may have it.

### The manifest URL is a capability

It is never returned with broadcast metadata. Anyone holding it can play the
stream, so returning it alongside the title would make it permanent and
unrevocable. It is issued only through `POST /playback-session`, which is
authenticated, short-lived (5 minutes), and recorded — and it is never logged,
because an access log is exactly the sort of place a capability leaks from.

Only a **live** broadcast is playable. A scheduled one has no stream yet and an
ended one has none any more; issuing a URL for either would produce a player
failing with a manifest error rather than a clear reason.

### Status is authoritative, never inferred

`scheduled → live → ended`, and `ended` is terminal. Liveness is read from the
stored status, never derived from timestamps: a broadcast that started late or
overran would otherwise be reported wrongly by the clock, and "is this live?" is
not a question the player should get a guess at.

Transitions are idempotent — asking for the status a broadcast already has
succeeds and changes nothing, so an operator double-click or a retried request is
not an error. Reopening an ended broadcast is refused: every client that saw it
end has torn down its player and its chat, and restarting is a new broadcast.

### Chat ordering and idempotency

Three properties, in order of how easily they are lost.

- **Idempotent on `clientMessageId`.** The client generates it and reuses it
  across retries; the unique constraint on `(broadcastId, clientMessageId)` is
  what makes a retry after a timeout return the stored message rather than post a
  second one. The check runs *before* the rate limit, so a retry is not counted
  as a new send.
- **Server-ordered.** The sequence and the timestamp are both allocated here. A
  client clock is trivially wrong and trivially forged, and ordering depends on
  it — so the client's timestamp is neither trusted nor stored.
- **Atomic.** The sequence increment and the insert are one transaction, backed by
  a unique constraint on `(broadcastId, sequence)`.

History is paginated by **sequence cursor, not offset**. An offset shifts under a
live chat — messages arrive between pages and rows get skipped or repeated — and
the sequence is the same number a reconnecting client already holds.

### Message normalisation

In order, and the order matters:

1. **NFC**, because the same visible text has several encodings and a length check
   before normalising measures the wrong string.
2. **Control characters stripped, not rejected.** They are invisible, so a
   rejection would tell the sender their message is invalid while showing them
   nothing wrong with it. This includes the bidi overrides — `U+202E` re-orders
   how text renders without changing what it contains.
3. **Length**, last, on what will actually be stored.

HTML is deliberately **not** escaped. Escaping belongs at the point of rendering,
where the target syntax is known; doing it here would store `&amp;` and
double-escape the moment anything else read it. Output escaping is the client's
responsibility.

### Moderation

Nothing is hard-deleted. A removed message keeps its row — the body included —
because a moderation action has to be auditable and "what was removed" is the
part that matters. What clients receive is a **tombstone**, so anyone who already
had the message drops it without refetching history. What clients read back from
history is the same row with an empty body and `deleted: true`.

A mute is an action row, and an unmute is *another* action row rather than a
deletion, so the history of who did what survives. Mute state is the most recent
of the two, which is what makes that work.

There is no automatic profanity filter or AI moderation. Both need a stated
policy before they need an implementation, and a wrong one is worse than none.

### Rate limiting

Per broadcast *and* per user, so a busy room does not throttle a quiet one. A
refused attempt is not counted, so a throttled sender retrying cannot extend
their own lockout. In-process, with the same limitation and the same seam as
every other limiter here.

### The chat gateway is read-only

Sending goes over HTTP, where the idempotency key, the rate limit, and the mute
check already live. Putting a send path on the socket would mean two
implementations of "may this person post?" that have to agree forever.

On join the client sends the sequence it already has and receives the history
after it, bounded to one page — a client further behind gets a cursor and fetches
the rest over HTTP rather than the server streaming a whole room down a socket.

Slow-consumer policy is identical to the topology gateway: disconnect, not queue.

### Frontend wiring

`serverChatTransport.ts` sits alongside the mock transport;
`VITE_CHAT_SOURCE=server` opts in and the default stays `mock`. The chat store's
bounded retention (300), pending cap (500), processed-id LRU (2000), timestamp
ordering, and flush batching are upstream and untouched — this layer only
produces messages for them to consume.

HLS engine selection and live-edge calculation remain entirely on the frontend.
The server states `sourceType` and `dvrEnabled` and stops there.
