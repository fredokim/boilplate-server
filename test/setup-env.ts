/**
 * Decorators evaluate at module load, and class-transformer reaches for
 * `Reflect.getMetadata` while doing so. `main.ts` imports this for the running
 * server; a unit test that imports a decorated class directly never goes through
 * `main.ts`, so it has to be loaded here too.
 */
import 'reflect-metadata';

/**
 * Environment defaults for the test run.
 *
 * `DATABASE_URL` has to be present because config validation refuses to boot
 * without it and `PrismaClient` refuses to construct without it — but it does not
 * have to be reachable. No test here talks to a real database: the readiness
 * suite binds a stub to `DATABASE_HEALTH` instead. That is the whole point of
 * that token existing.
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test_unreachable?schema=public';
process.env.PORT ??= '3999';
process.env.CORS_ORIGINS ??= 'http://localhost:5173';
process.env.BODY_LIMIT ??= '1mb';
process.env.SWAGGER_ENABLED ??= 'false';
process.env.LOG_LEVEL ??= 'error';

// Long enough to satisfy the MinLength guard. Not a secret — nothing signed with
// it ever leaves the test process.
process.env.JWT_SECRET ??= 'test-secret-value-that-is-long-enough-32';
