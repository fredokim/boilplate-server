import { LogLevel, NodeEnvironment, validateEnvironment } from './env.validation';

const minimal = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  JWT_SECRET: 'a-secret-that-is-at-least-32-characters',
};

describe('validateEnvironment', () => {
  it('accepts a minimal environment and fills in defaults', () => {
    const env = validateEnvironment({ ...minimal });

    expect(env.NODE_ENV).toBe(NodeEnvironment.Development);
    expect(env.PORT).toBe(3001);
    expect(env.SWAGGER_ENABLED).toBe(true);
    expect(env.LOG_LEVEL).toBe(LogLevel.Log);
  });

  /**
   * The regression this file exists for. Process environments are all strings,
   * and coercion depends on `design:type` metadata, which TypeScript emits from
   * the written annotation rather than the initialiser. Dropping an annotation in
   * EnvironmentVariables makes every numeric or boolean variable fail at boot —
   * silently in review, loudly in production.
   */
  it('coerces the string values a real process environment provides', () => {
    const env = validateEnvironment({ ...minimal, PORT: '8080', SWAGGER_ENABLED: 'false' });

    expect(env.PORT).toBe(8080);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it.each([
    ['1', true],
    ['0', false],
    ['true', true],
    ['false', false],
  ])('reads SWAGGER_ENABLED=%s as %s', (raw, expected) => {
    expect(validateEnvironment({ ...minimal, SWAGGER_ENABLED: raw }).SWAGGER_ENABLED).toBe(expected);
  });

  it('refuses to start without DATABASE_URL', () => {
    expect(() => validateEnvironment({})).toThrow(/DATABASE_URL/);
  });

  describe('JWT_SECRET', () => {
    it('refuses to start without one', () => {
      const { JWT_SECRET: _omitted, ...withoutSecret } = minimal;

      expect(() => validateEnvironment(withoutSecret)).toThrow(/JWT_SECRET/);
    });

    /**
     * There is deliberately no development default. A fallback would ship as a
     * real secret: any deployment that forgot the variable would sign tokens with
     * a value published in this repository, and nothing would fail loudly.
     */
    it('rejects a short secret rather than accepting a weak one', () => {
      expect(() => validateEnvironment({ ...minimal, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
    });
  });

  describe('production invariants', () => {
    const production = { ...minimal, NODE_ENV: 'production' };

    it('refuses a refresh cookie without Secure', () => {
      expect(() => validateEnvironment({ ...production, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    });

    it('accepts production once the cookie is secured', () => {
      expect(validateEnvironment({ ...production, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    });

    it('refuses seed credentials in production', () => {
      expect(() =>
        validateEnvironment({ ...production, COOKIE_SECURE: 'true', SEED_ADMIN_PASSWORD: 'anything' }),
      ).toThrow(/SEED_ADMIN_PASSWORD/);
    });

    it('leaves development alone', () => {
      expect(validateEnvironment({ ...minimal, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
    });
  });

  it('names every offending variable at once rather than one per restart', () => {
    expect(() => validateEnvironment({ PORT: 'not-a-port', NODE_ENV: 'staging' })).toThrow(
      /DATABASE_URL[\s\S]*NODE_ENV|NODE_ENV[\s\S]*DATABASE_URL/,
    );
  });

  it.each([['0'], ['70000'], ['3.5']])('rejects an out-of-range or non-integer PORT (%s)', (port) => {
    expect(() => validateEnvironment({ ...minimal, PORT: port })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnvironment({ ...minimal, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('points the reader at .env.example', () => {
    expect(() => validateEnvironment({})).toThrow(/\.env\.example/);
  });
});
