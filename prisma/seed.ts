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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
