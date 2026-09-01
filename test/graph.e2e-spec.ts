import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ErrorCode } from '../src/common/contracts/errorCode';
import { createTestApp, httpServer } from './createTestApp';
import { type AuthFixtures, seedAuthFixtures } from './authFixtures';

const GRAPH_ID = 'graph-1';
const FOREIGN_GRAPH_ID = 'graph-owned-by-viewer';

function node(nodeId: string) {
  return { nodeId, type: 'router', label: nodeId, position: { x: 0, y: 0 }, metadata: {} };
}

function edge(edgeId: string, sourceNodeId: string, targetNodeId: string) {
  return { edgeId, sourceNodeId, targetNodeId, metadata: {} };
}

describe('Graph and topology (e2e)', () => {
  let app: INestApplication;
  let fixtures: AuthFixtures;

  async function tokenFor(email: string): Promise<string> {
    const login = await request(httpServer(app))
      .post('/api/auth/login')
      .send({ email, password: 'demo-password' })
      .expect(200);

    return (login.body as { data: { accessToken: string } }).data.accessToken;
  }

  async function auth(email = 'demo@example.com'): Promise<{ Authorization: string }> {
    return { Authorization: `Bearer ${await tokenFor(email)}` };
  }

  beforeEach(async () => {
    fixtures = seedAuthFixtures();

    const demo = fixtures.prisma.userByEmail('demo@example.com');
    const viewer = fixtures.prisma.userByEmail('viewer@example.com');

    fixtures.prisma.addGraph({ id: GRAPH_ID, title: 'Core network', ownerId: demo.id });
    fixtures.prisma.addGraph({ id: FOREIGN_GRAPH_ID, title: 'Viewer only', ownerId: viewer.id });

    app = await createTestApp({ prisma: fixtures.prisma });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('graph editing', () => {
    it('401s without a token', async () => {
      await request(httpServer(app)).get('/api/graphs').expect(401);
    });

    it('lists only graphs the caller can see', async () => {
      const response = await request(httpServer(app)).get('/api/graphs').set(await auth()).expect(200);

      const ids = (response.body as { data: { id: string }[] }).data.map((graph) => graph.id);
      expect(ids).toEqual([GRAPH_ID]);
    });

    /** Same rule as dashboards: not-visible and not-there are one answer. */
    it('hides another user private graph behind the same 404 as a missing one', async () => {
      const headers = await auth();

      const foreign = await request(httpServer(app)).get(`/api/graphs/${FOREIGN_GRAPH_ID}`).set(headers).expect(404);
      const missing = await request(httpServer(app)).get('/api/graphs/nope').set(headers).expect(404);

      expect(foreign.body).toEqual(missing.body);
      expect(foreign.body).toMatchObject({ error: { code: ErrorCode.GRAPH_NOT_FOUND } });
    });

    it('requires graph:write to edit', async () => {
      const response = await request(httpServer(app))
        .put(`/api/graphs/${GRAPH_ID}/content`)
        .set(await auth('viewer@example.com'))
        .send({ expectedVersion: 1, nodes: [], edges: [] })
        .expect(403);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.AUTH_FORBIDDEN } });
    });

    it('replaces content and bumps the structure version', async () => {
      const response = await request(httpServer(app))
        .put(`/api/graphs/${GRAPH_ID}/content`)
        .set(await auth())
        .send({ expectedVersion: 1, nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')] })
        .expect(200);

      expect(response.body).toMatchObject({ data: { version: 2, nodeCount: 2, edgeCount: 1 } });
    });

    it('answers 409 with the current version when someone edited first', async () => {
      const headers = await auth();
      const body = { expectedVersion: 1, nodes: [node('a')], edges: [] };

      await request(httpServer(app)).put(`/api/graphs/${GRAPH_ID}/content`).set(headers).send(body).expect(200);

      const conflict = await request(httpServer(app))
        .put(`/api/graphs/${GRAPH_ID}/content`)
        .set(headers)
        .send(body)
        .expect(409);

      expect(conflict.body).toMatchObject({
        error: { code: ErrorCode.GRAPH_VERSION_CONFLICT, details: { currentVersion: 2 } },
      });
    });

    it.each([
      ['a dangling edge', { nodes: [node('a')], edges: [edge('e1', 'a', 'ghost')] }],
      ['a self-loop', { nodes: [node('a')], edges: [edge('e1', 'a', 'a')] }],
      ['a duplicate edge', { nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b'), edge('e2', 'a', 'b')] }],
    ])('refuses %s with GRAPH_INVALID_EDGE', async (_label, content) => {
      const response = await request(httpServer(app))
        .put(`/api/graphs/${GRAPH_ID}/content`)
        .set(await auth())
        .send({ expectedVersion: 1, ...content })
        .expect(422);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.GRAPH_INVALID_EDGE } });
    });

    /**
     * The version must not move when the content was rejected — the check runs
     * before the transaction, so a bad payload costs nothing.
     */
    it('leaves the version untouched after an invalid edit', async () => {
      const headers = await auth();

      await request(httpServer(app))
        .put(`/api/graphs/${GRAPH_ID}/content`)
        .set(headers)
        .send({ expectedVersion: 1, nodes: [node('a')], edges: [edge('e1', 'a', 'ghost')] })
        .expect(422);

      const after = await request(httpServer(app)).get(`/api/graphs/${GRAPH_ID}`).set(headers).expect(200);
      expect(after.body).toMatchObject({ data: { version: 1 } });
    });

    it('creates and deletes a graph', async () => {
      const headers = await auth();

      await request(httpServer(app))
        .post('/api/graphs')
        .set(headers)
        .send({ id: 'graph-new', title: 'Fresh' })
        .expect(201);

      await request(httpServer(app)).get('/api/graphs/graph-new').set(headers).expect(200);
      await request(httpServer(app)).delete('/api/graphs/graph-new').set(headers).expect(200);
      await request(httpServer(app)).get('/api/graphs/graph-new').set(headers).expect(404);
    });
  });

  describe('topology runtime', () => {
    it('returns an empty snapshot for an untouched graph', async () => {
      const response = await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/snapshot`)
        .set(await auth())
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { topologyId: GRAPH_ID, revision: 0, nodes: {}, edges: {} },
      });
    });

    it('publishes an event and reflects it in the snapshot', async () => {
      const headers = await auth();

      const published = await request(httpServer(app))
        .post(`/api/graphs/${GRAPH_ID}/topology/events`)
        .set(headers)
        .send({ type: 'NODE_STATUS_CHANGED', entityId: 'node-1', status: 'warning' })
        .expect(202);

      expect(published.body).toMatchObject({ data: { sequence: 1 } });

      const snapshot = await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/snapshot`)
        .set(headers)
        .expect(200);

      expect(snapshot.body).toMatchObject({
        data: { revision: 1, nodes: { 'node-1': { status: 'warning', sequence: 1 } } },
      });
    });

    /**
     * A metric event carries only what changed. Overwriting the map would delete
     * every metric the event did not mention.
     */
    it('merges metrics rather than replacing them, and leaves status alone', async () => {
      const headers = await auth();
      const publish = (body: Record<string, unknown>) =>
        request(httpServer(app))
          .post(`/api/graphs/${GRAPH_ID}/topology/events`)
          .set(headers)
          .send(body)
          .expect(202);

      await publish({ type: 'NODE_STATUS_CHANGED', entityId: 'node-1', status: 'healthy' });
      await publish({ type: 'NODE_METRIC_UPDATED', entityId: 'node-1', metrics: { cpu: 40 } });
      await publish({ type: 'NODE_METRIC_UPDATED', entityId: 'node-1', metrics: { memory: 70 } });

      const snapshot = await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/snapshot`)
        .set(headers)
        .expect(200);

      expect(snapshot.body).toMatchObject({
        data: { nodes: { 'node-1': { status: 'healthy', metrics: { cpu: 40, memory: 70 } } } },
      });
    });

    /** Sequences are the ordering guarantee the client depends on. */
    it('never issues the same sequence twice', async () => {
      const headers = await auth();

      for (let i = 0; i < 10; i += 1) {
        await request(httpServer(app))
          .post(`/api/graphs/${GRAPH_ID}/topology/events`)
          .set(headers)
          .send({ type: 'NODE_METRIC_UPDATED', entityId: `node-${String(i)}`, metrics: { cpu: i } })
          .expect(202);
      }

      const sequences = fixtures.prisma.allTopologyEvents().map((entry) => entry.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect([...sequences].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('replays events after a client sequence', async () => {
      const headers = await auth();

      for (let i = 0; i < 5; i += 1) {
        await request(httpServer(app))
          .post(`/api/graphs/${GRAPH_ID}/topology/events`)
          .set(headers)
          .send({ type: 'NODE_STATUS_CHANGED', entityId: 'node-1', status: 'healthy' })
          .expect(202);
      }

      const response = await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/resync?lastSequence=3`)
        .set(headers)
        .expect(200);

      const body = response.body as { data: { decision: string; events: { sequence: number }[] } };
      expect(body.data.decision).toBe('replay');
      expect(body.data.events.map((entry) => entry.sequence)).toEqual([4, 5]);
    });

    it('reports up-to-date when the client is level', async () => {
      const headers = await auth();

      await request(httpServer(app))
        .post(`/api/graphs/${GRAPH_ID}/topology/events`)
        .set(headers)
        .send({ type: 'NODE_STATUS_CHANGED', entityId: 'node-1', status: 'healthy' })
        .expect(202);

      const response = await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/resync?lastSequence=1`)
        .set(headers)
        .expect(200);

      expect(response.body).toMatchObject({ data: { decision: 'up-to-date', events: [] } });
    });

    /** A client holding state from a stream that no longer exists must resync. */
    it('tells a client ahead of the server to resync', async () => {
      const response = await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/resync?lastSequence=99`)
        .set(await auth())
        .expect(200);

      expect(response.body).toMatchObject({ data: { decision: 'resync' } });
    });

    it('rejects a malformed lastSequence rather than replaying everything', async () => {
      await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/resync?lastSequence=-1`)
        .set(await auth())
        .expect(400);
    });

    it('hides topology for a graph the caller cannot see', async () => {
      await request(httpServer(app))
        .get(`/api/graphs/${FOREIGN_GRAPH_ID}/topology/snapshot`)
        .set(await auth())
        .expect(404);
    });

    /**
     * Duplicate delivery is expected — the server is at-least-once. Applying the
     * same event twice must leave the same state, which is what makes the
     * client's eventId dedup a safety net rather than a requirement.
     */
    it('converges to the same snapshot when an event is applied twice', async () => {
      const headers = await auth();
      const body = { type: 'NODE_METRIC_UPDATED', entityId: 'node-1', metrics: { cpu: 55 } };

      await request(httpServer(app)).post(`/api/graphs/${GRAPH_ID}/topology/events`).set(headers).send(body).expect(202);
      const first = await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/snapshot`)
        .set(headers)
        .expect(200);

      await request(httpServer(app)).post(`/api/graphs/${GRAPH_ID}/topology/events`).set(headers).send(body).expect(202);
      const second = await request(httpServer(app))
        .get(`/api/graphs/${GRAPH_ID}/topology/snapshot`)
        .set(headers)
        .expect(200);

      const nodesOf = (response: { body: unknown }) =>
        (response.body as { data: { nodes: Record<string, { status: string; metrics: unknown }> } }).data.nodes;

      expect(nodesOf(second)['node-1']?.metrics).toEqual(nodesOf(first)['node-1']?.metrics);
      expect(nodesOf(second)['node-1']?.status).toEqual(nodesOf(first)['node-1']?.status);
    });
  });
});
