import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ErrorCode } from '../src/common/contracts/errorCode';
import { createTestApp, httpServer } from './createTestApp';
import { type AuthFixtures, seedAuthFixtures } from './authFixtures';

const DASHBOARD_ID = 'dash-1';
const OTHER_DASHBOARD_ID = 'dash-private-to-viewer';

function widget(id = 'w-1'): Record<string, unknown> {
  return {
    id,
    type: 'kpi',
    position: { x: 0, y: 0 },
    width: 4,
    height: 2,
    config: { title: 'Revenue' },
    dataSource: { type: 'api', sourceId: 'sales-summary', parameters: { scope: 'month' } },
    filterConfig: { useGlobalFilters: true, acceptCrossWidgetFilters: false },
    localFilters: {},
    crossWidgetFilters: {},
  };
}

function definition(id: string, ownerId: string): Record<string, unknown> {
  return {
    version: 1,
    metadata: { id, title: 'Ops', ownerId, visibility: 'private', updatedAt: '2026-08-31T00:00:00.000Z' },
    globalFilters: {},
    widgets: [widget()],
  };
}

describe('Dashboard (e2e)', () => {
  let app: INestApplication;
  let fixtures: AuthFixtures;

  async function tokenFor(email: string): Promise<string> {
    const login = await request(httpServer(app))
      .post('/api/auth/login')
      .send({ email, password: 'demo-password' })
      .expect(200);

    return (login.body as { data: { accessToken: string } }).data.accessToken;
  }

  beforeEach(async () => {
    fixtures = seedAuthFixtures();

    const demo = fixtures.prisma.userByEmail('demo@example.com');
    const viewer = fixtures.prisma.userByEmail('viewer@example.com');

    fixtures.prisma.addDashboard({
      id: DASHBOARD_ID,
      title: 'Ops',
      ownerId: demo.id,
      definition: definition(DASHBOARD_ID, demo.id),
    });

    // Owned by someone else and private — the case that must not be
    // distinguishable from "no such dashboard".
    fixtures.prisma.addDashboard({
      id: OTHER_DASHBOARD_ID,
      title: 'Viewer only',
      ownerId: viewer.id,
      definition: definition(OTHER_DASHBOARD_ID, viewer.id),
    });

    app = await createTestApp({ prisma: fixtures.prisma });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('widget data, the routes the frontend already calls', () => {
    it('answers 401 without a token', async () => {
      const response = await request(httpServer(app)).get('/api/dashboard/kpi').expect(401);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.AUTH_REQUIRED } });
    });

    it('returns the KPI shape the frontend DTO validates', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .get('/api/dashboard/kpi')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { kind: 'kpi', label: expect.any(String) as unknown, value: expect.any(Number) as unknown },
      });
    });

    /** The MSW handlers branch on this exact parameter; the server has to as well. */
    it('honours the legacy metric alias', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .get('/api/dashboard/kpi?metric=active-users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect((response.body as { data: { label: string } }).data.label).toBe('Active users');
    });

    it('returns series and table shapes', async () => {
      const token = await tokenFor('demo@example.com');

      const chart = await request(httpServer(app))
        .get('/api/dashboard/chart?scope=week')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(chart.body).toMatchObject({ data: { kind: 'series' } });
      expect((chart.body as { data: { points: unknown[] } }).data.points).toHaveLength(7);

      const table = await request(httpServer(app))
        .get('/api/dashboard/table?limit=3')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((table.body as { data: { rows: unknown[] } }).data.rows).toHaveLength(3);
    });

    it('counts users for the summary card', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Two active fixture users, one disabled.
      expect(response.body).toMatchObject({ data: { activeUsers: 2, blockedUsers: 1 } });
    });

    it.each([
      ['an unknown source id', '/api/dashboard/kpi?sourceId=drop-tables'],
      ['a limit past the cap', '/api/dashboard/table?limit=5000'],
      ['an unknown scope', '/api/dashboard/chart?scope=century'],
    ])('rejects %s', async (_label, url) => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app)).get(url).set('Authorization', `Bearer ${token}`).expect(400);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.VALIDATION_ERROR } });
    });

    /**
     * Asking a KPI route for a table source would otherwise return a shape the
     * client's DTO rejects, and the failure would surface in the browser with no
     * indication of where it came from.
     */
    it('refuses a source that produces the wrong kind for the route', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .get('/api/dashboard/kpi?sourceId=recent-events')
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(response.body).toMatchObject({
        error: { code: ErrorCode.DASHBOARD_INVALID_SCHEMA, details: { produces: 'table', expected: 'kpi' } },
      });
    });
  });

  describe('definitions', () => {
    it('returns a dashboard the caller owns', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .get(`/api/dashboards/${DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toMatchObject({ data: { id: DASHBOARD_ID, version: 1 } });
    });

    /**
     * The decision this pins: another user's private dashboard is a 404, not a
     * 403. A distinct 403 would confirm the id exists and let someone enumerate
     * dashboards one guess at a time.
     */
    it('hides another user private dashboard behind the same 404 as a missing one', async () => {
      const token = await tokenFor('demo@example.com');

      const foreign = await request(httpServer(app))
        .get(`/api/dashboards/${OTHER_DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      const missing = await request(httpServer(app))
        .get('/api/dashboards/does-not-exist')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(foreign.body).toEqual(missing.body);
      expect(foreign.body).toMatchObject({ error: { code: ErrorCode.DASHBOARD_NOT_FOUND } });
    });

    it('requires dashboard:write to save', async () => {
      const token = await tokenFor('viewer@example.com');
      const response = await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, definition: definition(DASHBOARD_ID, 'anyone') })
        .expect(403);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.AUTH_FORBIDDEN } });
    });

    it('saves and bumps the version', async () => {
      const token = await tokenFor('demo@example.com');
      const demo = fixtures.prisma.userByEmail('demo@example.com');

      const saved = await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          expectedVersion: 1,
          definition: { ...definition(DASHBOARD_ID, demo.id), widgets: [widget('w-1'), widget('w-2')] },
        })
        .expect(200);

      expect(saved.body).toMatchObject({ data: { version: 2 } });
    });

    it('answers 409 with the current version when someone wrote first', async () => {
      const token = await tokenFor('demo@example.com');
      const demo = fixtures.prisma.userByEmail('demo@example.com');
      const body = { expectedVersion: 1, definition: definition(DASHBOARD_ID, demo.id) };

      await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(200);

      // The second writer still holds version 1.
      const conflict = await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(409);

      expect(conflict.body).toMatchObject({
        error: { code: ErrorCode.DASHBOARD_VERSION_CONFLICT, details: { currentVersion: 2 } },
      });
    });

    it('refuses a definition whose metadata id does not match the path', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, definition: definition('some-other-id', 'user-1') })
        .expect(422);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.DASHBOARD_INVALID_SCHEMA } });
    });

    it('refuses a widget naming a data source that is not allowlisted', async () => {
      const token = await tokenFor('demo@example.com');
      const demo = fixtures.prisma.userByEmail('demo@example.com');
      const rogue = { ...widget(), dataSource: { type: 'api', sourceId: 'drop-tables', parameters: {} } };

      const response = await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, definition: { ...definition(DASHBOARD_ID, demo.id), widgets: [rogue] } })
        .expect(422);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.DASHBOARD_INVALID_SCHEMA } });
    });

    /** Ownership comes from the row, never the payload. */
    it('ignores an ownerId supplied in the body', async () => {
      const token = await tokenFor('demo@example.com');
      const demo = fixtures.prisma.userByEmail('demo@example.com');
      const viewer = fixtures.prisma.userByEmail('viewer@example.com');

      const saved = await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, definition: definition(DASHBOARD_ID, viewer.id) })
        .expect(200);

      expect((saved.body as { data: { ownerId: string } }).data.ownerId).toBe(demo.id);
    });
  });

  describe('personalization', () => {
    it('creates a default on first read rather than answering 404', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .get(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toMatchObject({
        data: { activePresetId: 'default', version: 1, presets: [{ id: 'default', name: 'My dashboard' }] },
      });
    });

    it('saves and reads back', async () => {
      const token = await tokenFor('demo@example.com');
      const current = await request(httpServer(app))
        .get(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const presets = (current.body as { data: { presets: Record<string, unknown>[] } }).data.presets;
      const updated = presets.map((preset) => ({
        ...preset,
        override: { hiddenWidgetIds: ['w-1'], widgetOverrides: {}, addedWidgets: [] },
      }));

      await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, activePresetId: 'default', presets: updated })
        .expect(200);

      const reread = await request(httpServer(app))
        .get(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(reread.body).toMatchObject({
        data: { version: 2, presets: [{ override: { hiddenWidgetIds: ['w-1'] } }] },
      });
    });

    it('answers 409 when the personalization moved on', async () => {
      const token = await tokenFor('demo@example.com');
      const current = await request(httpServer(app))
        .get(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const presets = (current.body as { data: { presets: unknown[] } }).data.presets;
      const body = { expectedVersion: 1, activePresetId: 'default', presets };

      await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(200);

      const conflict = await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(409);

      expect(conflict.body).toMatchObject({ error: { details: { currentVersion: 2 } } });
    });

    /**
     * Isolation. The user id is taken from the token on every route, so there is
     * no request shape that reaches another person's row — including a dashboard
     * both users can see.
     */
    it('keeps one user personalization out of another user view', async () => {
      const demoToken = await tokenFor('demo@example.com');

      await request(httpServer(app))
        .post(`/api/dashboards/${DASHBOARD_ID}/presets`)
        .set('Authorization', `Bearer ${demoToken}`)
        .send({ expectedVersion: 1, name: 'Demo only' })
        .expect(201);

      // The viewer cannot even see this dashboard, so the attempt is a 404 —
      // never a peek at the other user's presets.
      const viewerToken = await tokenFor('viewer@example.com');
      await request(httpServer(app))
        .get(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(404);
    });

    it('refuses presets that fail schema validation', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, activePresetId: 'default', presets: [{ id: 'default', name: '' }] })
        .expect(422);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.DASHBOARD_INVALID_SCHEMA } });
    });

    it('refuses an activePresetId that names no supplied preset', async () => {
      const token = await tokenFor('demo@example.com');
      const current = await request(httpServer(app))
        .get(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(httpServer(app))
        .put(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          expectedVersion: 1,
          activePresetId: 'nope',
          presets: (current.body as { data: { presets: unknown[] } }).data.presets,
        })
        .expect(422);
    });
  });

  describe('preset lifecycle', () => {
    async function readVersion(token: string): Promise<number> {
      const response = await request(httpServer(app))
        .get(`/api/dashboards/${DASHBOARD_ID}/personalization`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      return (response.body as { data: { version: number } }).data.version;
    }

    it('creates, renames, selects, and deletes', async () => {
      const token = await tokenFor('demo@example.com');
      const auth = { Authorization: `Bearer ${token}` };

      const created = await request(httpServer(app))
        .post(`/api/dashboards/${DASHBOARD_ID}/presets`)
        .set(auth)
        .send({ expectedVersion: await readVersion(token), name: 'Incident review' })
        .expect(201);

      const body = created.body as { data: { presets: { id: string; name: string }[]; activePresetId: string } };
      const newPreset = body.data.presets.find((preset) => preset.name === 'Incident review');
      expect(newPreset).toBeDefined();
      // A new preset becomes the active one — "save this view under a new name".
      expect(body.data.activePresetId).toBe(newPreset?.id);

      const presetId = newPreset?.id ?? '';

      const renamed = await request(httpServer(app))
        .patch(`/api/dashboards/${DASHBOARD_ID}/presets/${presetId}`)
        .set(auth)
        .send({ expectedVersion: await readVersion(token), name: 'Renamed' })
        .expect(200);
      expect(JSON.stringify(renamed.body)).toContain('Renamed');

      await request(httpServer(app))
        .post(`/api/dashboards/${DASHBOARD_ID}/presets/default/select`)
        .set(auth)
        .send({ expectedVersion: await readVersion(token) })
        .expect(200);

      const deleted = await request(httpServer(app))
        .delete(`/api/dashboards/${DASHBOARD_ID}/presets/${presetId}`)
        .set(auth)
        .send({ expectedVersion: await readVersion(token) })
        .expect(200);

      expect((deleted.body as { data: { presets: unknown[] } }).data.presets).toHaveLength(1);
    });

    it('refuses to delete the last preset', async () => {
      const token = await tokenFor('demo@example.com');
      const response = await request(httpServer(app))
        .delete(`/api/dashboards/${DASHBOARD_ID}/presets/default`)
        .set('Authorization', `Bearer ${token}`)
        .send({ expectedVersion: await readVersion(token) })
        .expect(422);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.DASHBOARD_INVALID_SCHEMA } });
    });

    it('answers 404 for a preset that does not exist', async () => {
      const token = await tokenFor('demo@example.com');

      await request(httpServer(app))
        .patch(`/api/dashboards/${DASHBOARD_ID}/presets/ghost`)
        .set('Authorization', `Bearer ${token}`)
        .send({ expectedVersion: await readVersion(token), name: 'x' })
        .expect(404);
    });
  });
});
