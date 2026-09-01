import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsString, Max, Min, MinLength, validateSync } from 'class-validator';

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum LogLevel {
  Error = 'error',
  Warn = 'warn',
  Log = 'log',
  Debug = 'debug',
  Verbose = 'verbose',
}

/**
 * Reads the raw value off the source object rather than the `value` argument.
 *
 * A process environment only ever holds strings, and `Boolean('false')` is
 * `true` — so any coercion that runs before this one turns "disabled" into
 * "enabled". Going back to `obj[key]` makes this transform the only thing that
 * decides what the string meant.
 */
const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }): unknown => {
  const raw: unknown = obj[key];
  if (typeof raw === 'boolean') return raw;

  if (typeof raw === 'string') {
    const normalised = raw.trim().toLowerCase();
    if (normalised === 'true' || normalised === '1') return true;
    if (normalised === 'false' || normalised === '0') return false;
  }

  // Anything else is left alone so @IsBoolean() rejects it by name.
  return raw;
};

/**
 * Every value arriving here is a string, because that is all a process
 * environment holds. Each conversion is therefore declared explicitly —
 * `@Type(() => Number)` for numbers, `@Transform` for booleans — rather than
 * left to `enableImplicitConversion`, which infers from `design:type` metadata
 * and gets both cases wrong. See the note in validateEnvironment.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT: number = 3001;

  /**
   * Required with no default. A missing value must stop the process at boot
   * rather than surface later as a confusing connection error under load.
   */
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  CORS_ORIGINS: string = 'http://localhost:5173';

  @IsString()
  @IsNotEmpty()
  BODY_LIMIT: string = '1mb';

  @IsBoolean()
  @Transform(toBoolean)
  SWAGGER_ENABLED: boolean = true;

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Log;

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Required with no default, and no fallback like `'dev-secret'`.
   *
   * A default here would ship as a real one: every deployment that forgot to set
   * the variable would sign tokens with a value published in this repository, and
   * nothing would fail loudly enough to notice. Refusing to boot is the only
   * behaviour that cannot be ignored.
   */
  @IsString()
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters.' })
  JWT_SECRET!: string;

  /** Short by design — a leaked access token expires on its own. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3_600)
  JWT_ACCESS_TTL_SECONDS: number = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  REFRESH_TTL_DAYS: number = 30;

  /**
   * Off in development because the Vite dev server is plain HTTP and a `Secure`
   * cookie would simply never be stored. Production must not run without it.
   */
  @IsBoolean()
  @Transform(toBoolean)
  COOKIE_SECURE: boolean = false;

  @IsString()
  COOKIE_DOMAIN: string = '';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_MAX_LOGIN_ATTEMPTS: number = 10;

  @Type(() => Number)
  @IsInt()
  @Min(10)
  AUTH_LOGIN_WINDOW_SECONDS: number = 300;

  /**
   * Development seed credentials. Empty means the seed refuses to create the
   * demo account rather than inventing a password — see prisma/seed.ts.
   */
  @IsString()
  SEED_ADMIN_EMAIL: string = '';

  @IsString()
  SEED_ADMIN_PASSWORD: string = '';
}

/**
 * Runs at module initialisation, before anything listens on a port.
 *
 * Nest would otherwise start happily and fail on the first request that needed
 * the missing value, which is both later and much harder to read. The thrown
 * message names every offending variable at once so a misconfigured environment
 * takes one restart to fix, not one per variable.
 */
export function validateEnvironment(raw: Record<string, unknown>): EnvironmentVariables {
  // No `enableImplicitConversion`. It coerces from `design:type` metadata, which
  // TypeScript emits only for written annotations, and it runs ahead of custom
  // transforms — which is how `SWAGGER_ENABLED=false` became `true`. Every
  // conversion here is stated outright instead: @Type on numbers, @Transform on
  // booleans, nothing at all on strings and enums.
  const parsed = plainToInstance(EnvironmentVariables, raw, {
    exposeDefaultValues: true,
    excludeExtraneousValues: false,
  });

  const errors = validateSync(parsed, { skipMissingProperties: false, whitelist: false });

  if (errors.length > 0) {
    const problems = errors
      .map((error) => {
        const reasons = Object.values(error.constraints ?? {}).join('; ');
        return `  - ${error.property}: ${reasons || 'is invalid'}`;
      })
      .join('\n');

    throw new Error(
      `Invalid environment configuration. The server cannot start.\n${problems}\n\n` +
        'Copy server/.env.example to server/.env and fill in the values above.',
    );
  }

  assertProductionInvariants(parsed);

  return parsed;
}

/**
 * Rules that depend on more than one variable, so a per-field decorator cannot
 * express them.
 *
 * A refresh cookie sent without `Secure` travels in clear text on any plain-HTTP
 * request to the same host. Development needs it off because the dev server is
 * HTTP; production getting the development default is the failure this catches.
 */
function assertProductionInvariants(env: EnvironmentVariables): void {
  if (env.NODE_ENV !== NodeEnvironment.Production) return;

  const problems: string[] = [];

  if (!env.COOKIE_SECURE) {
    problems.push(
      '  - COOKIE_SECURE must be true in production; the refresh cookie would otherwise travel over plain HTTP.',
    );
  }

  if (env.SEED_ADMIN_PASSWORD !== '') {
    problems.push(
      '  - SEED_ADMIN_PASSWORD must not be set in production; it exists only to create a local demo account.',
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid production configuration. The server cannot start.\n${problems.join('\n')}`);
  }
}
