import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ErrorCode } from '../src/common/contracts/errorCode';
import { createTestApp, httpServer } from './createTestApp';

describe('Health (e2e)', () => {
  describe('with a healthy database', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp({ database: { status: 'up', latencyMs: 1.2 } });
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /api/health reports the aggregate state', async () => {
      const response = await request(httpServer(app)).get('/api/health').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { status: 'ok', checks: { database: { status: 'up' } } },
      });
      expect(typeof (response.body as { data: { uptimeSeconds: unknown } }).data.uptimeSeconds).toBe('number');
    });

    it('GET /api/health/live succeeds without touching a dependency', async () => {
      const response = await request(httpServer(app)).get('/api/health/live').expect(200);

      expect(response.body).toMatchObject({ success: true, data: { status: 'ok' } });
      expect(response.body).not.toHaveProperty('data.checks');
    });

    it('GET /api/health/ready succeeds', async () => {
      const response = await request(httpServer(app)).get('/api/health/ready').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { status: 'ok', checks: { database: { status: 'up' } } },
      });
    });

    it('echoes a caller-supplied request id', async () => {
      const response = await request(httpServer(app))
        .get('/api/health/live')
        .set('x-request-id', 'trace-abc-123')
        .expect(200);

      expect(response.headers['x-request-id']).toBe('trace-abc-123');
    });

    it('generates a request id when the caller supplies none', async () => {
      const response = await request(httpServer(app)).get('/api/health/live').expect(200);

      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects an unsafe inbound request id instead of echoing it', async () => {
      const response = await request(httpServer(app))
        .get('/api/health/live')
        .set('x-request-id', 'bad value with spaces')
        .expect(200);

      expect(response.headers['x-request-id']).not.toBe('bad value with spaces');
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('with an unreachable database', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createTestApp({ database: { status: 'down', error: 'connection refused' } });
    });

    afterAll(async () => {
      await app.close();
    });

    // The whole point of splitting the probes: a database outage must not get the
    // process killed and restarted by a liveness probe that cannot help.
    it('keeps liveness passing', async () => {
      const response = await request(httpServer(app)).get('/api/health/live').expect(200);

      expect(response.body).toMatchObject({ success: true, data: { status: 'ok' } });
    });

    it('fails readiness with 503 and the failing check in details', async () => {
      const response = await request(httpServer(app)).get('/api/health/ready').expect(503);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          message: 'One or more dependencies are unavailable.',
          details: { checks: { database: { status: 'down', error: 'connection refused' } } },
        },
      });
    });

    it('still answers 200 on the summary, reporting degraded', async () => {
      const response = await request(httpServer(app)).get('/api/health').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { status: 'degraded', checks: { database: { status: 'down' } } },
      });
    });
  });
});
