import { randomUUID } from 'node:crypto';
import { Algorithm, hashSync } from '@node-rs/argon2';

/**
 * An in-memory stand-in for the two tables the auth module touches.
 *
 * It is a fake rather than a mock: it stores rows and answers queries, so the
 * rotation and reuse logic in `RefreshSessionService` is exercised for real
 * rather than asserted against a script of expected calls. What it does not
 * provide is PostgreSQL's guarantees — the unique constraint on `tokenHash` and
 * the transaction boundary are honoured here by construction, not enforced. The
 * prompt's Docker-based integration test is what would prove those.
 *
 * The `omit` contract is implemented deliberately: `passwordHash` is withheld
 * unless a caller explicitly asks for it, exactly as the real client is
 * configured. A service that forgot to ask would fail here rather than in
 * production.
 */

const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const FIXTURE_PASSWORD = 'demo-password';

/**
 * Exported so a test asserting on a login response follows this list rather than
 * repeating it. Every step that added a permission previously broke that
 * assertion for a reason that had nothing to do with auth.
 */
export const ADMIN_PERMISSIONS = [
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
  ] as const;

// Hashed once for the whole test file. Argon2 is deliberately slow, and hashing
// per test would spend seconds proving nothing.
const FIXTURE_PASSWORD_HASH = hashSync(FIXTURE_PASSWORD, ARGON_OPTIONS);

type RoleRow = { id: string; name: string; permissions: string[] };

type UserRow = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  isActive: boolean;
  roleId: string;
  lastLoginAt: Date | null;
};

type SessionRow = {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  lastUsedAt: Date | null;
  userAgent: string | null;
  ipAddress: string | null;
};

type DashboardRow = {
  id: string;
  title: string;
  ownerId: string;
  visibility: string;
  schemaVersion: number;
  definition: unknown;
  version: number;
  updatedAt: Date;
};

type PersonalizationRow = {
  id: string;
  userId: string;
  dashboardId: string;
  schemaVersion: number;
  activePresetId: string;
  presets: unknown;
  version: number;
  updatedAt: Date;
};

type GraphRow = {
  id: string;
  title: string;
  ownerId: string;
  visibility: string;
  version: number;
  sequence: number;
  updatedAt: Date;
};

type GraphNodeRow = {
  graphId: string;
  nodeId: string;
  type: string;
  label: string;
  positionX: number;
  positionY: number;
  metadata: unknown;
};

type GraphEdgeRow = {
  graphId: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
  metadata: unknown;
};

type TopologyEventRow = {
  graphId: string;
  eventId: string;
  sequence: number;
  entity: string;
  entityId: string;
  kind: string;
  payload: unknown;
  occurredAt: Date;
};

type RuntimeRow = {
  graphId: string;
  nodeId?: string;
  edgeId?: string;
  status: string;
  metrics: unknown;
  sequence: number;
  lastUpdated: Date;
};

type BroadcastRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  sourceType: string;
  manifestUrl: string;
  dvrEnabled: boolean;
  chatSequence: number;
  startedAt: Date | null;
  endedAt: Date | null;
  scheduledFor: Date | null;
  createdAt: Date;
};

type ChatMessageRow = {
  id: string;
  broadcastId: string;
  authorId: string;
  clientMessageId: string;
  sequence: number;
  body: string;
  sentAt: Date;
  deletedAt: Date | null;
  deletedBy: string | null;
};

type ModerationRow = {
  id: string;
  broadcastId: string;
  action: string;
  moderatorId: string;
  targetId: string;
  reason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
};

export type AuthFixtures = {
  prisma: FakePrisma;
  sessions: () => SessionRow[];
};

export class FakePrisma {
  private readonly roles: RoleRow[] = [];
  private readonly users: UserRow[] = [];
  private readonly refreshSessions: SessionRow[] = [];
  private readonly dashboards: DashboardRow[] = [];
  private readonly graphs: GraphRow[] = [];
  private graphNodes: GraphNodeRow[] = [];
  private graphEdges: GraphEdgeRow[] = [];
  private topologyEvents: TopologyEventRow[] = [];
  private readonly nodeRuntime: RuntimeRow[] = [];
  private readonly broadcasts: BroadcastRow[] = [];
  private readonly chatMessages: ChatMessageRow[] = [];
  private readonly moderationActions: ModerationRow[] = [];
  private readonly edgeRuntime: RuntimeRow[] = [];
  private readonly personalizations: PersonalizationRow[] = [];

  readonly user = {
    findUnique: ({
      where,
      omit,
    }: {
      where: { id?: string; email?: string };
      include?: unknown;
      omit?: { passwordHash?: boolean };
    }) => {
      const row = this.users.find(
        (candidate) =>
          (where.id !== undefined && candidate.id === where.id) ||
          (where.email !== undefined && candidate.email === where.email),
      );

      if (!row) return Promise.resolve(null);

      const role = this.roles.find((candidate) => candidate.id === row.roleId);
      const includePasswordHash = omit?.passwordHash === false;
      const { passwordHash, ...rest } = row;

      return Promise.resolve({
        ...rest,
        ...(includePasswordHash ? { passwordHash } : {}),
        role,
      });
    },

    update: ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
      const row = this.users.find((candidate) => candidate.id === where.id);
      if (row) Object.assign(row, data);
      return Promise.resolve(row);
    },

    count: (args?: { where?: { isActive?: boolean } }) =>
      Promise.resolve(
        this.users.filter((row) => args?.where?.isActive === undefined || row.isActive === args.where.isActive).length,
      ),
  };

  readonly refreshSession = {
    findUnique: ({ where }: { where: { tokenHash: string } }) =>
      Promise.resolve(this.refreshSessions.find((row) => row.tokenHash === where.tokenHash) ?? null),

    create: ({ data }: { data: Omit<SessionRow, 'id' | 'revokedAt' | 'replacedById' | 'lastUsedAt'> }) => {
      const row: SessionRow = {
        id: randomUUID(),
        revokedAt: null,
        replacedById: null,
        lastUsedAt: null,
        ...data,
      };
      this.refreshSessions.push(row);
      return Promise.resolve(row);
    },

    update: ({ where, data }: { where: { id: string }; data: Partial<SessionRow> }) => {
      const row = this.refreshSessions.find((candidate) => candidate.id === where.id);
      if (row) Object.assign(row, data);
      return Promise.resolve(row);
    },

    updateMany: ({
      where,
      data,
    }: {
      where: { familyId?: string; userId?: string; revokedAt?: null };
      data: Partial<SessionRow>;
    }) => {
      const matches = this.refreshSessions.filter(
        (row) =>
          (where.familyId === undefined || row.familyId === where.familyId) &&
          (where.userId === undefined || row.userId === where.userId) &&
          (where.revokedAt === undefined || row.revokedAt === where.revokedAt),
      );

      for (const row of matches) Object.assign(row, data);
      return Promise.resolve({ count: matches.length });
    },
  };

  readonly dashboard = {
    findUnique: ({ where }: { where: { id: string } }) =>
      Promise.resolve(this.dashboards.find((row) => row.id === where.id) ?? null),

    /**
     * Mirrors the real optimistic lock: the version is part of the match, so a
     * stale writer updates nothing and gets count 0 rather than overwriting.
     */
    updateMany: ({
      where,
      data,
    }: {
      where: { id: string; version?: number };
      data: Record<string, unknown>;
    }) => {
      const row = this.dashboards.find(
        (candidate) => candidate.id === where.id && (where.version === undefined || candidate.version === where.version),
      );

      if (!row) return Promise.resolve({ count: 0 });

      applyUpdate(row, data);
      row.updatedAt = new Date();
      return Promise.resolve({ count: 1 });
    },
  };

  readonly dashboardPersonalization = {
    findUnique: ({ where }: { where: { userId_dashboardId: { userId: string; dashboardId: string } } }) => {
      const { userId, dashboardId } = where.userId_dashboardId;
      return Promise.resolve(
        this.personalizations.find((row) => row.userId === userId && row.dashboardId === dashboardId) ?? null,
      );
    },

    create: ({ data }: { data: Omit<PersonalizationRow, 'id' | 'version' | 'updatedAt'> }) => {
      const row: PersonalizationRow = { id: randomUUID(), version: 1, updatedAt: new Date(), ...data };
      this.personalizations.push(row);
      return Promise.resolve(row);
    },

    updateMany: ({
      where,
      data,
    }: {
      where: { userId: string; dashboardId: string; version?: number };
      data: Record<string, unknown>;
    }) => {
      const row = this.personalizations.find(
        (candidate) =>
          candidate.userId === where.userId &&
          candidate.dashboardId === where.dashboardId &&
          (where.version === undefined || candidate.version === where.version),
      );

      if (!row) return Promise.resolve({ count: 0 });

      applyUpdate(row, data);
      row.updatedAt = new Date();
      return Promise.resolve({ count: 1 });
    },
  };

  readonly graph = {
    findUnique: ({ where, include, select }: { where: { id: string }; include?: unknown; select?: unknown }) => {
      const row = this.graphs.find((candidate) => candidate.id === where.id);
      if (!row) return Promise.resolve(null);

      if (select) return Promise.resolve(row);

      if (include) {
        return Promise.resolve({
          ...row,
          nodes: this.graphNodes.filter((node) => node.graphId === row.id),
          edges: this.graphEdges.filter((edge) => edge.graphId === row.id),
        });
      }

      return Promise.resolve(row);
    },

    findMany: ({ where }: { where?: { OR?: { ownerId?: string; visibility?: string }[] } } = {}) => {
      const rows = this.graphs.filter((row) =>
        !where?.OR
          ? true
          : where.OR.some(
              (clause) =>
                (clause.ownerId !== undefined && row.ownerId === clause.ownerId) ||
                (clause.visibility !== undefined && row.visibility === clause.visibility),
            ),
      );

      return Promise.resolve(
        rows.map((row) => ({
          ...row,
          _count: {
            nodes: this.graphNodes.filter((node) => node.graphId === row.id).length,
            edges: this.graphEdges.filter((edge) => edge.graphId === row.id).length,
          },
        })),
      );
    },

    create: ({ data }: { data: { id: string; title: string; ownerId: string; visibility?: string } }) => {
      const row: GraphRow = {
        id: data.id,
        title: data.title,
        ownerId: data.ownerId,
        visibility: data.visibility ?? 'private',
        version: 1,
        sequence: 0,
        updatedAt: new Date(),
      };
      this.graphs.push(row);
      return Promise.resolve(row);
    },

    update: ({ where, data, select }: { where: { id: string }; data: Record<string, unknown>; select?: unknown }) => {
      const row = this.graphs.find((candidate) => candidate.id === where.id);
      if (!row) return Promise.reject(new Error('graph not found'));

      applyUpdate(row, data);
      row.updatedAt = new Date();

      return Promise.resolve(select ? { sequence: row.sequence } : row);
    },

    updateMany: ({ where, data }: { where: { id: string; version?: number }; data: Record<string, unknown> }) => {
      const row = this.graphs.find(
        (candidate) => candidate.id === where.id && (where.version === undefined || candidate.version === where.version),
      );

      if (!row) return Promise.resolve({ count: 0 });

      applyUpdate(row, data);
      row.updatedAt = new Date();
      return Promise.resolve({ count: 1 });
    },

    delete: ({ where }: { where: { id: string } }) => {
      const index = this.graphs.findIndex((row) => row.id === where.id);
      const [removed] = this.graphs.splice(index, 1);

      // The schema cascades; the fake has to as well or later reads see orphans.
      this.graphNodes = this.graphNodes.filter((node) => node.graphId !== where.id);
      this.graphEdges = this.graphEdges.filter((edge) => edge.graphId !== where.id);
      this.topologyEvents = this.topologyEvents.filter((entry) => entry.graphId !== where.id);

      return Promise.resolve(removed);
    },
  };

  readonly graphNode = {
    deleteMany: ({ where }: { where: { graphId: string } }) => {
      const before = this.graphNodes.length;
      this.graphNodes = this.graphNodes.filter((row) => row.graphId !== where.graphId);
      return Promise.resolve({ count: before - this.graphNodes.length });
    },
    createMany: ({ data }: { data: GraphNodeRow[] }) => {
      this.graphNodes.push(...data);
      return Promise.resolve({ count: data.length });
    },
  };

  readonly graphEdge = {
    deleteMany: ({ where }: { where: { graphId: string } }) => {
      const before = this.graphEdges.length;
      this.graphEdges = this.graphEdges.filter((row) => row.graphId !== where.graphId);
      return Promise.resolve({ count: before - this.graphEdges.length });
    },
    createMany: ({ data }: { data: GraphEdgeRow[] }) => {
      this.graphEdges.push(...data);
      return Promise.resolve({ count: data.length });
    },
  };

  readonly topologyEvent = {
    create: ({ data }: { data: TopologyEventRow }) => {
      // The real table has a unique constraint on (graphId, sequence). Honouring
      // it here is what makes the "two mutations never share a sequence" test
      // meaningful rather than vacuous.
      const clash = this.topologyEvents.find(
        (row) => row.graphId === data.graphId && row.sequence === data.sequence,
      );
      if (clash) return Promise.reject(new Error('Unique constraint failed on (graphId, sequence)'));

      this.topologyEvents.push(data);
      return Promise.resolve(data);
    },

    findFirst: ({ where, orderBy }: { where: { graphId: string }; orderBy: { sequence: 'asc' | 'desc' } }) => {
      const rows = this.topologyEvents
        .filter((row) => row.graphId === where.graphId)
        .sort((left, right) => (orderBy.sequence === 'asc' ? left.sequence - right.sequence : right.sequence - left.sequence));

      return Promise.resolve(rows[0] ?? null);
    },

    findMany: ({ where, take }: { where: { graphId: string; sequence?: { gt: number } }; take?: number }) => {
      const rows = this.topologyEvents
        .filter((row) => row.graphId === where.graphId && (where.sequence === undefined || row.sequence > where.sequence.gt))
        .sort((left, right) => left.sequence - right.sequence);

      return Promise.resolve(take ? rows.slice(0, take) : rows);
    },

    deleteMany: ({ where }: { where: { graphId: string; OR?: unknown } }) => {
      const before = this.topologyEvents.length;
      // Retention is exercised by the unit tests; the fake keeps everything so an
      // e2e replay assertion is not silently emptied by pruning.
      this.topologyEvents = this.topologyEvents.filter((row) => row.graphId !== where.graphId || true);
      return Promise.resolve({ count: before - this.topologyEvents.length });
    },
  };

  readonly graphNodeRuntime = this.createRuntimeStore('nodeId', () => this.nodeRuntime);
  readonly graphEdgeRuntime = this.createRuntimeStore('edgeId', () => this.edgeRuntime);

  readonly broadcast = {
    findUnique: ({ where }: { where: { id: string }; select?: unknown }) =>
      Promise.resolve(this.broadcasts.find((row) => row.id === where.id) ?? null),

    findMany: () => Promise.resolve([...this.broadcasts]),

    update: ({ where, data, select }: { where: { id: string }; data: Record<string, unknown>; select?: unknown }) => {
      const row = this.broadcasts.find((candidate) => candidate.id === where.id);
      if (!row) return Promise.reject(new Error('broadcast not found'));

      applyUpdate(row, data);
      return Promise.resolve(select ? { chatSequence: row.chatSequence } : row);
    },
  };

  readonly playbackSession = {
    create: ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: randomUUID(), ...data }),
  };

  readonly chatMessage = {
    findUnique: ({
      where,
      include,
    }: {
      where: { id?: string; broadcastId_clientMessageId?: { broadcastId: string; clientMessageId: string } };
      include?: unknown;
    }) => {
      const row = this.chatMessages.find((candidate) =>
        where.id !== undefined
          ? candidate.id === where.id
          : candidate.broadcastId === where.broadcastId_clientMessageId?.broadcastId &&
            candidate.clientMessageId === where.broadcastId_clientMessageId.clientMessageId,
      );

      if (!row) return Promise.resolve(null);
      return Promise.resolve(include ? { ...row, author: this.authorOf(row.authorId) } : row);
    },

    findMany: ({
      where,
      take,
      include,
    }: {
      where: { broadcastId: string; sequence?: { gt: number } };
      take?: number;
      include?: unknown;
    }) => {
      const rows = this.chatMessages
        .filter(
          (row) =>
            row.broadcastId === where.broadcastId &&
            (where.sequence === undefined || row.sequence > where.sequence.gt),
        )
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, take);

      return Promise.resolve(include ? rows.map((row) => ({ ...row, author: this.authorOf(row.authorId) })) : rows);
    },

    create: ({ data, include }: { data: Omit<ChatMessageRow, 'id' | 'sentAt' | 'deletedAt' | 'deletedBy'>; include?: unknown }) => {
      // The real table has a unique constraint on (broadcastId, sequence).
      const clash = this.chatMessages.find(
        (row) => row.broadcastId === data.broadcastId && row.sequence === data.sequence,
      );
      if (clash) return Promise.reject(new Error('Unique constraint failed on (broadcastId, sequence)'));

      const row: ChatMessageRow = { id: randomUUID(), sentAt: new Date(), deletedAt: null, deletedBy: null, ...data };
      this.chatMessages.push(row);

      return Promise.resolve(include ? { ...row, author: this.authorOf(row.authorId) } : row);
    },

    update: ({ where, data }: { where: { id: string }; data: Partial<ChatMessageRow> }) => {
      const row = this.chatMessages.find((candidate) => candidate.id === where.id);
      if (row) Object.assign(row, data);
      return Promise.resolve(row);
    },
  };

  readonly chatModerationAction = {
    create: ({ data }: { data: Omit<ModerationRow, 'id' | 'createdAt' | 'expiresAt' | 'reason'> & Partial<ModerationRow> }) => {
      const row: ModerationRow = {
        id: randomUUID(),
        createdAt: new Date(),
        reason: null,
        expiresAt: null,
        ...data,
      };
      this.moderationActions.push(row);
      return Promise.resolve(row);
    },

    findFirst: ({ where }: { where: { broadcastId: string; targetId: string; action?: { in: string[] } } }) => {
      const rows = this.moderationActions
        .filter(
          (row) =>
            row.broadcastId === where.broadcastId &&
            row.targetId === where.targetId &&
            (where.action === undefined || where.action.in.includes(row.action)),
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

      return Promise.resolve(rows[0] ?? null);
    },
  };

  private authorOf(authorId: string): { name: string } {
    return { name: this.users.find((row) => row.id === authorId)?.name ?? 'Unknown' };
  }

  /**
   * Node and edge runtime tables differ only in their key column, so one factory
   * builds both rather than duplicating upsert logic that must stay in step.
   */
  private createRuntimeStore(key: 'nodeId' | 'edgeId', rows: () => RuntimeRow[]) {
    const match = (row: RuntimeRow, where: Record<string, string>) =>
      row.graphId === where.graphId && row[key] === where[key];

    return {
      findUnique: ({ where }: { where: Record<string, Record<string, string>> }) => {
        const criteria = Object.values(where)[0] ?? {};
        return Promise.resolve(rows().find((row) => match(row, criteria)) ?? null);
      },

      findMany: ({ where }: { where: { graphId: string } }) =>
        Promise.resolve(rows().filter((row) => row.graphId === where.graphId)),

      upsert: ({
        where,
        create,
        update,
      }: {
        where: Record<string, Record<string, string>>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const criteria = Object.values(where)[0] ?? {};
        const existing = rows().find((row) => match(row, criteria));

        if (existing) {
          Object.assign(existing, update);
          return Promise.resolve(existing);
        }

        const row = create as unknown as RuntimeRow;
        rows().push(row);
        return Promise.resolve(row);
      },
    };
  }

  /** Runs the callback against this same store — no isolation, no rollback. */
  $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }

  onModuleInit(): Promise<void> {
    return Promise.resolve();
  }

  onModuleDestroy(): Promise<void> {
    return Promise.resolve();
  }

  $connect(): Promise<void> {
    return Promise.resolve();
  }

  $disconnect(): Promise<void> {
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  addRole(name: string, permissions: string[]): RoleRow {
    const role = { id: randomUUID(), name, permissions };
    this.roles.push(role);
    return role;
  }

  addUser(user: { email: string; name: string; roleId: string; isActive?: boolean }): UserRow {
    const row: UserRow = {
      id: randomUUID(),
      email: user.email,
      name: user.name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      isActive: user.isActive ?? true,
      roleId: user.roleId,
      lastLoginAt: null,
    };
    this.users.push(row);
    return row;
  }

  allSessions(): SessionRow[] {
    return [...this.refreshSessions];
  }

  addDashboard(dashboard: {
    id: string;
    title: string;
    ownerId: string;
    visibility?: string;
    definition: unknown;
  }): DashboardRow {
    const row: DashboardRow = {
      id: dashboard.id,
      title: dashboard.title,
      ownerId: dashboard.ownerId,
      visibility: dashboard.visibility ?? 'private',
      schemaVersion: 1,
      definition: dashboard.definition,
      version: 1,
      updatedAt: new Date(),
    };
    this.dashboards.push(row);
    return row;
  }

  addGraph(graph: { id: string; title: string; ownerId: string; visibility?: string }): GraphRow {
    const row: GraphRow = {
      id: graph.id,
      title: graph.title,
      ownerId: graph.ownerId,
      visibility: graph.visibility ?? 'private',
      version: 1,
      sequence: 0,
      updatedAt: new Date(),
    };
    this.graphs.push(row);
    return row;
  }

  allTopologyEvents(): TopologyEventRow[] {
    return [...this.topologyEvents];
  }

  addBroadcast(broadcast: { id: string; title: string; status?: string; manifestUrl?: string }): BroadcastRow {
    const row: BroadcastRow = {
      id: broadcast.id,
      title: broadcast.title,
      description: null,
      status: broadcast.status ?? 'scheduled',
      sourceType: 'hls',
      manifestUrl: broadcast.manifestUrl ?? 'https://cdn.example.com/secret-manifest.m3u8',
      dvrEnabled: true,
      chatSequence: 0,
      startedAt: null,
      endedAt: null,
      scheduledFor: null,
      createdAt: new Date(),
    };
    this.broadcasts.push(row);
    return row;
  }

  allChatMessages(): ChatMessageRow[] {
    return [...this.chatMessages];
  }

  userByEmail(email: string): UserRow {
    const row = this.users.find((candidate) => candidate.email === email);
    if (!row) throw new Error(`No fixture user for ${email}`);
    return row;
  }
}

/**
 * Mirrors the roles and permission strings the frontend fixtures already use, so
 * a response from this suite is directly comparable to what MSW serves.
 */
export function seedAuthFixtures(): AuthFixtures {
  const prisma = new FakePrisma();

  const admin = prisma.addRole('admin', [...ADMIN_PERMISSIONS]);
  // Deliberately without graph:write or topology:subscribe, so the permission
  // tests have a user who can read a graph but not edit or stream it.
  // Can watch and read chat, but cannot post, moderate, or manage a broadcast.
  const viewer = prisma.addRole('viewer', ['dashboard:read', 'graph:read', 'live:read']);

  prisma.addUser({ email: 'demo@example.com', name: 'Demo Maker', roleId: admin.id });
  prisma.addUser({ email: 'viewer@example.com', name: 'Read Only User', roleId: viewer.id });
  prisma.addUser({ email: 'disabled@example.com', name: 'Disabled User', roleId: viewer.id, isActive: false });

  return { prisma, sessions: () => prisma.allSessions() };
}

/**
 * Applies a Prisma update payload, honouring the `{ increment }` operation.
 *
 * Assigning the operation object verbatim would set `version` to `{ increment: 1 }`
 * and every optimistic-lock test would pass for the wrong reason.
 */
function applyUpdate(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object' && value !== null && 'increment' in value) {
      const current = typeof row[key] === 'number' ? (row[key]) : 0;
      row[key] = current + Number((value).increment);
      continue;
    }

    row[key] = value;
  }
}
