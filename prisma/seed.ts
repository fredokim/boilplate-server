/**
 * Loads `.env` before anything reads `process.env`.
 *
 * The Prisma CLI does this for its own commands, which is why `migrate deploy`
 * works from a bare shell — but this script runs under plain ts-node, which does
 * not. Without it the seed fails with "Environment variable not found:
 * DATABASE_URL" on any machine that keeps its configuration in a file.
 *
 * CI could never have caught this: the workflow sets DATABASE_URL directly, so
 * the seed passed there while failing locally.
 */
import 'dotenv/config';

import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaClient } from '../src/generated/prisma';

/**
 * Creates the roles the application checks against, and — only when explicitly
 * asked — a local demo account.
 *
 * The account is created from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. There
 * is no default password and none is invented: a seed that quietly created
 * `admin/admin` would eventually run somewhere it should not, and the account it
 * left behind would be indistinguishable from a real one. Config validation also
 * refuses to start production with `SEED_ADMIN_PASSWORD` set at all.
 */

const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The same names and permission strings the frontend fixtures use, so a locally
 * seeded database behaves like the MSW mocks the UI was built against.
 */
/**
 * `dashboard:write` is new in this step.
 *
 * The frontend's own fixtures grant only `dashboard:read` — nothing there ever
 * needed a write permission, because personalization was saved to localStorage.
 * Pointing the client at the real server without adding this would let a user
 * load a dashboard and then fail every save with a 403, which is a worse failure
 * than not being able to load it at all.
 * `graph:*` and `topology:subscribe` are new in step 4, for the same reason
 * `dashboard:write` was new in step 3: the frontend fixtures never needed them.
 */
const ROLES = [
  {
    name: 'admin',
    permissions: [
      'dashboard:read',
      'dashboard:write',
      'graph:read',
      'graph:write',
      'topology:subscribe',
      'live:read',
      'live:manage',
      'chat:write',
      'chat:moderate',
      'user:read',
      'user:write',
      'settings:read',
    ],
  },
  {
    name: 'designer',
    permissions: ['dashboard:read', 'graph:read', 'topology:subscribe', 'live:read', 'chat:write', 'user:read'],
  },
  { name: 'viewer', permissions: ['dashboard:read', 'graph:read', 'live:read'] },
];

/**
 * Matches `liveChatRoomId` in the frontend. The two are a contract: change one
 * and the demo page joins a room nobody created.
 */
const DEMO_BROADCAST = {
  id: 'summer-stage',
  title: 'Summer Stage',
  description: 'Live rehearsal — the demo broadcast the example page joins.',
  status: 'live',
  // Progressive rather than HLS: the demo player is a plain <video>, and an HLS
  // manifest would need a media-source library the boilerplate does not ship.
  sourceType: 'progressive',
  manifestUrl: 'https://example.invalid/summer-stage/source.mp4',
  dvrEnabled: true,
} as const;

/**
 * The topology the graph example subscribes to. Ids match `networkGraph.ts` and
 * `networkTopologyId` in the frontend exactly — the demo page overlays runtime
 * status onto its own static document by node id, so a mismatch shows an empty
 * health picture rather than an error.
 */
const DEMO_GRAPH = {
  id: 'seoul-production',
  title: 'Seoul Production Network',
  nodes: [
    { nodeId: 'core-router', type: 'router', label: 'Core Router', positionX: 40, positionY: 150, metadata: { hostname: 'rt-core-01', ipAddress: '10.0.0.1', location: 'Seoul DC' } },
    { nodeId: 'edge-firewall', type: 'firewall', label: 'Edge Firewall', positionX: 330, positionY: 150, metadata: { hostname: 'fw-edge-01', ipAddress: '10.0.1.1', location: 'Seoul DC' } },
    { nodeId: 'api-server', type: 'server', label: 'API Server', positionX: 650, positionY: 40, metadata: { hostname: 'api-prod-01', ipAddress: '10.0.2.21', location: 'Zone A' } },
    { nodeId: 'worker-server', type: 'server', label: 'Worker Server', positionX: 650, positionY: 270, metadata: { hostname: 'worker-prod-01', ipAddress: '10.0.2.31', location: 'Zone B' } },
  ],
  edges: [
    { edgeId: 'router-to-firewall', sourceNodeId: 'core-router', targetNodeId: 'edge-firewall', label: 'uplink', metadata: { protocol: 'BGP', bandwidthMbps: 10000, interface: 'xe-0/0/1', status: 'up' } },
    { edgeId: 'firewall-to-api', sourceNodeId: 'edge-firewall', targetNodeId: 'api-server', label: 'api lane', metadata: { protocol: 'HTTPS', bandwidthMbps: 1000, interface: 'eth0', status: 'up' } },
    { edgeId: 'firewall-to-worker', sourceNodeId: 'edge-firewall', targetNodeId: 'worker-server', label: 'worker lane', metadata: { protocol: 'TLS', bandwidthMbps: 1000, interface: 'eth1', status: 'degraded' } },
  ],
  /** A mixed starting picture, so the first paint is not uniformly green. */
  nodeRuntime: [
    { nodeId: 'core-router', status: 'healthy', metrics: { cpu: 31, memory: 44 } },
    { nodeId: 'edge-firewall', status: 'healthy', metrics: { cpu: 38, memory: 51 } },
    { nodeId: 'api-server', status: 'healthy', metrics: { cpu: 46, memory: 60 } },
    { nodeId: 'worker-server', status: 'warning', metrics: { cpu: 82, memory: 74 } },
  ],
  edgeRuntime: [
    { edgeId: 'router-to-firewall', status: 'active', metrics: { latency: 6, throughput: 820 } },
    { edgeId: 'firewall-to-api', status: 'active', metrics: { latency: 9, throughput: 540 } },
    { edgeId: 'firewall-to-worker', status: 'degraded', metrics: { latency: 48, throughput: 120 } },
  ],
} as const;

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();

    for (const role of ROLES) {
      await prisma.role.upsert({
        where: { name: role.name },
        update: { permissions: role.permissions },
        create: role,
      });
      console.log(`[seed] role ${role.name}`);
    }

    const email = (process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD ?? '';

    if (email === '' || password === '') {
      console.log('[seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are not set — no demo account created.');
      return;
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error('Refusing to seed a demo account in production.');
    }

    const admin = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });

    await prisma.user.upsert({
      where: { email },
      // The password is reset on every run so a forgotten local credential is
      // recoverable by re-seeding rather than by editing rows.
      update: { passwordHash: await hash(password, ARGON_OPTIONS), isActive: true, roleId: admin.id },
      create: {
        email,
        name: 'Demo Maker',
        passwordHash: await hash(password, ARGON_OPTIONS),
        roleId: admin.id,
      },
    });

    console.log(`[seed] demo account ${email} (role: admin)`);

    /**
     * The broadcast the live demo page joins.
     *
     * Its id is fixed rather than generated because the frontend names it as a
     * constant (`liveChatRoomId`). Without this row, server mode connects, is
     * authenticated, and then joins a broadcast that does not exist — the page
     * sits on "Waiting for the first message…" forever with nothing to explain
     * why. Seeding it is what makes a fresh database demonstrable.
     *
     * `chatSequence` is left alone on update: it is the room's monotonic
     * counter, and resetting it on a re-seed would make already-delivered
     * sequences repeat.
     */
    await prisma.broadcast.upsert({
      where: { id: DEMO_BROADCAST.id },
      update: {
        title: DEMO_BROADCAST.title,
        description: DEMO_BROADCAST.description,
        status: DEMO_BROADCAST.status,
        sourceType: DEMO_BROADCAST.sourceType,
        manifestUrl: DEMO_BROADCAST.manifestUrl,
        dvrEnabled: DEMO_BROADCAST.dvrEnabled,
      },
      create: DEMO_BROADCAST,
    });

    console.log(`[seed] broadcast ${DEMO_BROADCAST.id} (${DEMO_BROADCAST.status})`);

    /**
     * The demo topology.
     *
     * Nodes and edges are replaced rather than merged: the seed defines the
     * whole graph, and a leftover node from an earlier shape would appear in
     * snapshots as a node the frontend's document does not contain.
     *
     * `sequence` is deliberately not reset. It is the graph's monotonic event
     * counter, and rewinding it would make a connected client discard the next
     * real events as stale.
     */
    const owner = await prisma.user.findUniqueOrThrow({ where: { email } });

    await prisma.graph.upsert({
      where: { id: DEMO_GRAPH.id },
      update: { title: DEMO_GRAPH.title, ownerId: owner.id },
      create: { id: DEMO_GRAPH.id, title: DEMO_GRAPH.title, ownerId: owner.id, visibility: 'private' },
    });

    await prisma.graphNode.deleteMany({ where: { graphId: DEMO_GRAPH.id } });
    await prisma.graphEdge.deleteMany({ where: { graphId: DEMO_GRAPH.id } });

    await prisma.graphNode.createMany({
      data: DEMO_GRAPH.nodes.map((node) => ({ ...node, graphId: DEMO_GRAPH.id })),
    });
    await prisma.graphEdge.createMany({
      data: DEMO_GRAPH.edges.map((edge) => ({ ...edge, graphId: DEMO_GRAPH.id })),
    });

    for (const runtime of DEMO_GRAPH.nodeRuntime) {
      await prisma.graphNodeRuntime.upsert({
        where: { graphId_nodeId: { graphId: DEMO_GRAPH.id, nodeId: runtime.nodeId } },
        update: { status: runtime.status, metrics: runtime.metrics },
        create: { graphId: DEMO_GRAPH.id, nodeId: runtime.nodeId, status: runtime.status, metrics: runtime.metrics },
      });
    }

    for (const runtime of DEMO_GRAPH.edgeRuntime) {
      await prisma.graphEdgeRuntime.upsert({
        where: { graphId_edgeId: { graphId: DEMO_GRAPH.id, edgeId: runtime.edgeId } },
        update: { status: runtime.status, metrics: runtime.metrics },
        create: { graphId: DEMO_GRAPH.id, edgeId: runtime.edgeId, status: runtime.status, metrics: runtime.metrics },
      });
    }

    console.log(`[seed] graph ${DEMO_GRAPH.id} (${String(DEMO_GRAPH.nodes.length)} nodes, ${String(DEMO_GRAPH.edges.length)} edges)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
