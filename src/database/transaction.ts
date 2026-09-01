import type { Prisma } from '../generated/prisma';

/**
 * The client Prisma hands to a `$transaction` callback.
 *
 * It is not a `PrismaService`: the lifecycle methods and `$transaction` itself
 * are stripped, because nesting a transaction inside one is not something Prisma
 * supports. Typing a helper as `PrismaService` would let it be written and only
 * fail at the call site, so helpers meant to run inside a transaction take this
 * instead.
 */
export type TransactionClient = Prisma.TransactionClient;
