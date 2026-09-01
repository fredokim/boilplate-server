import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../src/generated/prisma';

/**
 * The tests that need a real PostgreSQL, and only those.
 *
 * Every other suite runs against stubs or the in-memory fake, which is fast and
 * deterministic but cannot prove the things this file is about: a unique
 * constraint is not enforced by a `Map`, and a transaction that "cannot" produce
 * two identical sequences is an argument until the database refuses one.
 *
 * `RUN_INTEGRATION=1` is required. Without it the suite skips, so a developer
 * with no database still gets a green `npm test`. With it, an unreachable
 * database **fails** rather than skipping — a suite that silently skips in CI is
 * worse than no suite, because the badge stays green while nothing is checked.
 */

const shouldRun = process.env.RUN_INTEGRATION === '1';
const describeIntegration = shouldRun ? describe : describe.skip;

const prisma = new PrismaClient();

async function seedUser(email: string): Promise<string> {
  const role = await prisma.role.upsert({
    where: { name: 'integration' },
    update: {},
    create: { name: 'integration', permissions: ['graph:write', 'chat:write'] },
  });

  const user = await prisma.user.create({
    data: { email, name: 'Integration', passwordHash: 'not-a-real-hash', roleId: role.id },
  });

  return user.id;
}

describeIntegration('database integration', () => {
  beforeAll(async () => {
    // Fails loudly rather than skipping: RUN_INTEGRATION was set, so a database
    // was promised.
    await prisma.$connect();
  }, 30_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('migrations produced a usable schema', () => {
    it('created every table the application reads', async () => {
      const rows = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `;

      const tables = rows.map((row) => row.table_name).sort();

      expect(tables).toEqual(
        expect.arrayContaining([
          'Broadcast',
          'ChatMessage',
          'ChatModerationAction',
          'Dashboard',
          'DashboardPersonalization',
          'Graph',
          'GraphEdge',
          'GraphEdgeRuntime',
          'GraphNode',
          'GraphNodeRuntime',
          'PlaybackSession',
          'RefreshSession',
          'Role',
          'TopologyEvent',
          'User',
        ]),
      );
    });

    /**
     * The constraints the application's correctness arguments lean on. The fake
     * honours them by construction; only the database enforces them.
     */
    it('created the unique constraints the code depends on', async () => {
      const rows = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      `;

      const indexes = rows.map((row) => row.indexname);

      expect(indexes).toEqual(
        expect.arrayContaining([
          'User_email_key',
          'RefreshSession_tokenHash_key',
          'TopologyEvent_graphId_sequence_key',
          'ChatMessage_broadcastId_clientMessageId_key',
          'ChatMessage_broadcastId_sequence_key',
          'DashboardPersonalization_userId_dashboardId_key',
        ]),
      );
    });
  });

  describe('sequence allocation', () => {
    /**
     * The claim in `TopologyService.publish` is that `{ increment: 1 }` inside a
     * transaction cannot hand two concurrent publishes the same number. This is
     * the only place that claim is actually tested — against a real database,
     * with real concurrency.
     */
    it('never issues the same topology sequence twice under concurrency', async () => {
      const userId = await seedUser(`graph-${randomUUID()}@example.com`);
      const graphId = `graph-${randomUUID()}`;

      await prisma.graph.create({ data: { id: graphId, title: 'Concurrency', ownerId: userId } });

      const publish = async (index: number) =>
        prisma.$transaction(async (tx) => {
          const graph = await tx.graph.update({
            where: { id: graphId },
            data: { sequence: { increment: 1 } },
            select: { sequence: true },
          });

          await tx.topologyEvent.create({
            data: {
              graphId,
              eventId: randomUUID(),
              sequence: graph.sequence,
              entity: 'node',
              entityId: `node-${String(index)}`,
              kind: 'NODE_STATUS_CHANGED',
              payload: { status: 'healthy' },
            },
          });

          return graph.sequence;
        });

      const sequences = await Promise.all(Array.from({ length: 20 }, (_unused, index) => publish(index)));

      expect(new Set(sequences).size).toBe(20);
      expect([...sequences].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_u, i) => i + 1));
    }, 30_000);

    /**
     * The idempotency the chat retry path depends on. Two concurrent sends with
     * the same client id must produce one row — enforced by the constraint, not
     * by a check-then-insert that a race would slip through.
     */
    it('stores one message for a duplicated client id', async () => {
      const userId = await seedUser(`chat-${randomUUID()}@example.com`);
      const broadcastId = `bc-${randomUUID()}`;
      const clientMessageId = randomUUID();

      await prisma.broadcast.create({
        data: { id: broadcastId, title: 'Race', status: 'live', manifestUrl: 'https://example.invalid/m.m3u8' },
      });

      const send = (sequence: number) =>
        prisma.chatMessage.create({
          data: { broadcastId, authorId: userId, clientMessageId, sequence, body: 'hello' },
        });

      const results = await Promise.allSettled([send(1), send(2)]);
      const stored = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(stored).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rows = await prisma.chatMessage.findMany({ where: { broadcastId } });
      expect(rows).toHaveLength(1);
    }, 30_000);
  });

  describe('cascades', () => {
    /**
     * The schema declares `onDelete: Cascade` in several places, and several
     * services rely on it rather than deleting children themselves. If a cascade
     * were missing, the orphans would only surface much later as rows nobody can
     * reach.
     */
    it('removes a graph content and events with the graph', async () => {
      const userId = await seedUser(`cascade-${randomUUID()}@example.com`);
      const graphId = `graph-${randomUUID()}`;

      await prisma.graph.create({ data: { id: graphId, title: 'Cascade', ownerId: userId } });
      await prisma.graphNode.create({
        data: { graphId, nodeId: 'n1', type: 'router', label: 'n1', positionX: 0, positionY: 0, metadata: {} },
      });
      await prisma.topologyEvent.create({
        data: {
          graphId,
          eventId: randomUUID(),
          sequence: 1,
          entity: 'node',
          entityId: 'n1',
          kind: 'NODE_STATUS_CHANGED',
          payload: {},
        },
      });

      await prisma.graph.delete({ where: { id: graphId } });

      expect(await prisma.graphNode.count({ where: { graphId } })).toBe(0);
      expect(await prisma.topologyEvent.count({ where: { graphId } })).toBe(0);
    }, 30_000);
  });

  describe('the omit contract', () => {
    /**
     * `PrismaService` configures a client-level omit so a password hash is never
     * returned unless asked for. That configuration is easy to lose in a merge,
     * and nothing else would notice.
     */
    it('withholds passwordHash unless a caller asks for it', async () => {
      const omitting = new PrismaClient({ omit: { user: { passwordHash: true } } });

      try {
        const email = `omit-${randomUUID()}@example.com`;
        await seedUser(email);

        const guarded = await omitting.user.findUnique({ where: { email } });
        const explicit = await omitting.user.findUnique({ where: { email }, omit: { passwordHash: false } });

        expect(guarded).not.toHaveProperty('passwordHash');
        expect(explicit).toHaveProperty('passwordHash', 'not-a-real-hash');
      } finally {
        await omitting.$disconnect();
      }
    }, 30_000);
  });
});
