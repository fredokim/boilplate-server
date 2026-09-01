/**
 * Environment defaults for the OpenAPI generator, applied as an import side
 * effect.
 *
 * `AppModule` validates configuration while it is being imported, not when
 * `main()` runs, so anything set inside `main()` arrives too late. This module is
 * imported first for that reason — the ordering is load-bearing.
 *
 * Writing the spec must not require a configured environment or a reachable
 * database: it is a build artefact, produced in CI and on a fresh checkout. The
 * placeholder URL is never connected to — `PrismaService` tolerates a failed
 * connection, and the generator never issues a query.
 */
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused?schema=public';
process.env.SWAGGER_ENABLED ??= 'true';
process.env.LOG_LEVEL ??= 'error';
process.env.JWT_SECRET ??= 'openapi-placeholder-secret-not-used-here';
