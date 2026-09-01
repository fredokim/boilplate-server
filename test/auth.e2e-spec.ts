import { Controller, Get, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ErrorCode } from '../src/common/contracts/errorCode';
import { REFRESH_COOKIE_NAME } from '../src/auth/auth.constants';
import { CurrentUser, RequirePermissions } from '../src/auth/decorators/auth.decorators';
import type { AuthenticatedUser } from '../src/auth/types/authenticatedUser';
import { createTestApp, httpServer } from './createTestApp';
import { ADMIN_PERMISSIONS, seedAuthFixtures, type AuthFixtures } from './authFixtures';

/**
 * Routes that exist only for this suite, to exercise the guards over real HTTP
 * without adding a domain endpoint to the shipped API.
 */
@Controller('protected')
class ProtectedController {
  @Get('any')
  any(@CurrentUser() user: AuthenticatedUser | undefined) {
    return { seenBy: user?.email };
  }

  @Get('write')
  @RequirePermissions('user:write')
  write() {
    return { wrote: true };
  }
}

/** Reads the refresh cookie out of a Set-Cookie header list, which supertest types loosely. */
function refreshCookie(headers: Record<string, unknown>): string | undefined {
  const raw: unknown = headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];

  return cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
}

function cookieValue(cookie: string): string {
  return cookie.split(';')[0] ?? '';
}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let fixtures: AuthFixtures;

  beforeEach(async () => {
    fixtures = seedAuthFixtures();
    app = await createTestApp({ prisma: fixtures.prisma });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('login', () => {
    it('returns the shape the frontend DTO validates', async () => {
      const response = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email: 'demo@example.com', password: 'demo-password' })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: {
          accessToken: expect.any(String) as unknown,
          user: {
            id: expect.any(String) as unknown,
            email: 'demo@example.com',
            name: 'Demo Maker',
            permissions: [...ADMIN_PERMISSIONS],
          },
        },
      });
    });

    it('normalises the email so case and spacing do not create a miss', async () => {
      await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email: '  DEMO@Example.COM  ', password: 'demo-password' })
        .expect(200);
    });

    it('never puts the refresh token in the body', async () => {
      const response = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email: 'demo@example.com', password: 'demo-password' })
        .expect(200);

      const cookie = refreshCookie(response.headers);
      const token = cookieValue(cookie ?? '').split('=')[1] ?? '';

      expect(token).not.toBe('');
      expect(JSON.stringify(response.body)).not.toContain(token);
    });

    /**
     * The cookie attributes are the whole protection. A refresh token readable by
     * script, or sent to unrelated paths, would undo the reason for using a cookie
     * at all.
     */
    it('sets the refresh cookie HttpOnly, SameSite=Lax, and scoped to /api/auth', async () => {
      const response = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email: 'demo@example.com', password: 'demo-password' })
        .expect(200);

      const cookie = refreshCookie(response.headers) ?? '';

      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/api/auth');
      // Secure is off in test, matching development over plain HTTP. The
      // production invariant is enforced by config validation and covered there.
      expect(cookie).not.toContain('Secure');
    });

    it.each([
      ['a wrong password', { email: 'demo@example.com', password: 'wrong-password' }],
      ['an unknown account', { email: 'nobody@example.com', password: 'demo-password' }],
    ])('answers %s with the same code and message', async (_label, body) => {
      const response = await request(httpServer(app)).post('/api/auth/login').send(body).expect(401);

      expect(response.body).toEqual({
        success: false,
        error: { code: ErrorCode.AUTH_INVALID_CREDENTIALS, message: 'Email or password is incorrect.' },
      });
    });

    it('reports a disabled account distinctly', async () => {
      const response = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email: 'disabled@example.com', password: 'demo-password' })
        .expect(403);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.AUTH_ACCOUNT_DISABLED } });
    });

    it('rejects a malformed body with the standard validation envelope', async () => {
      const response = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email: 'not-an-email', password: 'short' })
        .expect(400);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.VALIDATION_ERROR } });

      const fields = (response.body as { error: { details: { fields: Record<string, string[]> } } }).error.details
        .fields;
      expect(fields.email).toBeDefined();
      expect(fields.password).toBeDefined();
    });

    it('locks out after the configured number of failures', async () => {
      const attempt = () =>
        request(httpServer(app)).post('/api/auth/login').send({ email: 'demo@example.com', password: 'wrong-but-long-enough' });

      for (let i = 0; i < 10; i += 1) await attempt().expect(401);

      const blocked = await attempt().expect(429);
      expect(blocked.body).toMatchObject({ error: { code: ErrorCode.TOO_MANY_REQUESTS } });
    });

    it('does not lock out a user who eventually gets it right', async () => {
      for (let i = 0; i < 3; i += 1) {
        await request(httpServer(app))
          .post('/api/auth/login')
          .send({ email: 'demo@example.com', password: 'wrong-but-long-enough' })
          .expect(401);
      }

      await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email: 'demo@example.com', password: 'demo-password' })
        .expect(200);

      await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email: 'demo@example.com', password: 'demo-password' })
        .expect(200);
    });
  });

  describe('the full flow', () => {
    it('logs in, reads the session, refreshes, and logs out', async () => {
      const agent = request.agent(httpServer(app));

      const login = await agent
        .post('/api/auth/login')
        .send({ email: 'demo@example.com', password: 'demo-password' })
        .expect(200);
      const firstToken = (login.body as { data: { accessToken: string } }).data.accessToken;

      const session = await agent.get('/api/auth/session').set('Authorization', `Bearer ${firstToken}`).expect(200);
      expect(session.body).toMatchObject({ success: true, data: { user: { email: 'demo@example.com' } } });

      const refreshed = await agent.post('/api/auth/refresh').expect(200);
      expect(refreshed.body).toMatchObject({ success: true, data: { user: { email: 'demo@example.com' } } });

      const logout = await agent.post('/api/auth/logout').expect(200);
      expect(logout.body).toEqual({ success: true, data: { revoked: true } });

      // The session is gone, so refreshing again fails.
      await agent.post('/api/auth/refresh').expect(401);
    });

    it('rotates the refresh cookie on every refresh', async () => {
      const agent = request.agent(httpServer(app));

      const login = await agent
        .post('/api/auth/login')
        .send({ email: 'demo@example.com', password: 'demo-password' })
        .expect(200);
      const first = cookieValue(refreshCookie(login.headers) ?? '');

      const refreshed = await agent.post('/api/auth/refresh').expect(200);
      const second = cookieValue(refreshCookie(refreshed.headers) ?? '');

      expect(second).not.toBe(first);
    });

    /**
     * The reason rotation is worth the complexity: a token that has already been
     * spent is evidence of a copy, and using it ends the whole family rather than
     * quietly issuing another token to whoever presented it.
     */
    it('revokes the whole session family when a used token comes back', async () => {
      const agent = request.agent(httpServer(app));

      const login = await agent
        .post('/api/auth/login')
        .send({ email: 'demo@example.com', password: 'demo-password' })
        .expect(200);
      const stolen = cookieValue(refreshCookie(login.headers) ?? '');

      // The legitimate holder refreshes, which spends `stolen`.
      await agent.post('/api/auth/refresh').expect(200);

      // The attacker replays the copy they took earlier.
      const replay = await request(httpServer(app)).post('/api/auth/refresh').set('Cookie', stolen).expect(401);
      expect(replay.body).toMatchObject({ error: { code: ErrorCode.AUTH_SESSION_REVOKED } });

      // And the legitimate session is ended too — the correct trade once a token
      // has provably leaked.
      await agent.post('/api/auth/refresh').expect(401);
    });

    it('clears the cookie when a refresh fails', async () => {
      const response = await request(httpServer(app))
        .post('/api/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=not-a-real-token`)
        .expect(401);

      const cookie = refreshCookie(response.headers) ?? '';
      expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    });

    it('treats logout without a cookie as a success', async () => {
      const response = await request(httpServer(app)).post('/api/auth/logout').expect(200);

      expect(response.body).toEqual({ success: true, data: { revoked: false } });
    });
  });

  describe('guards over HTTP', () => {
    beforeEach(async () => {
      await app.close();
      app = await createTestApp({ prisma: fixtures.prisma, controllers: [ProtectedController] });
    });

    async function accessTokenFor(email: string): Promise<string> {
      const login = await request(httpServer(app))
        .post('/api/auth/login')
        .send({ email, password: 'demo-password' })
        .expect(200);

      return (login.body as { data: { accessToken: string } }).data.accessToken;
    }

    it('401s without a token', async () => {
      const response = await request(httpServer(app)).get('/api/protected/any').expect(401);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.AUTH_REQUIRED } });
    });

    it('allows an authenticated user', async () => {
      const token = await accessTokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .get('/api/protected/any')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toEqual({ success: true, data: { seenBy: 'demo@example.com' } });
    });

    it('403s a user without the required permission, naming it', async () => {
      const token = await accessTokenFor('viewer@example.com');
      const response = await request(httpServer(app))
        .get('/api/protected/write')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(response.body).toMatchObject({
        error: { code: ErrorCode.AUTH_FORBIDDEN, details: { missingPermissions: ['user:write'] } },
      });
    });

    it('allows a user who holds it', async () => {
      const token = await accessTokenFor('demo@example.com');

      await request(httpServer(app))
        .get('/api/protected/write')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });
});
