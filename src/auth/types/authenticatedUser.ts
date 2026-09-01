import type { Request } from 'express';

/**
 * What a verified access token resolves to, and the only shape the rest of the
 * application sees for "the current user".
 *
 * Deliberately not the Prisma `User` row: nothing downstream should be able to
 * reach `passwordHash` through the request, and permissions are flattened here so
 * a guard never has to join a role to answer a question.
 */
export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: readonly string[];
};

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

/** Narrowing helper so call sites do not repeat the shape check. */
export function getAuthenticatedUser(request: Request): AuthenticatedUser | undefined {
  return (request as AuthenticatedRequest).user;
}
