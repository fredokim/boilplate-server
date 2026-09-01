import type { Prisma } from '../generated/prisma';

/**
 * The one place a domain value is handed to a Prisma `Json` column.
 *
 * `InputJsonValue` is a recursive structural type, and a domain type like
 * `DashboardPreset[]` does not satisfy it even though every value in it is
 * serialisable — the index signature it wants is not something a named object
 * type provides. Rather than scatter `as unknown as` at every write, the cast
 * lives here with the reason attached.
 *
 * The safety this gives up is recovered elsewhere: nothing reaches a Json column
 * without first passing `dashboardSchema.ts`, and nothing is read back out
 * without passing it again.
 */
export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
