import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { toJsonValue } from '../../database/jsonValue';
import { PrismaService } from '../../database/prisma.service';
import type { AuthenticatedUser } from '../../auth/types/authenticatedUser';
import type { DashboardResponseDto } from './dto/dashboard.dto';
import {
  assertDefinitionSize,
  DASHBOARD_SCHEMA_VERSION,
  type DashboardDefinition,
  parseDashboardDefinition,
} from './dashboardSchema';

type DashboardRow = {
  id: string;
  title: string;
  ownerId: string;
  visibility: string;
  schemaVersion: number;
  version: number;
  definition: unknown;
  updatedAt: Date;
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Loads a dashboard the caller is allowed to see.
   *
   * A private dashboard belonging to someone else answers **404, not 403**. A
   * distinct 403 would confirm that the id exists, which is enough to enumerate
   * other people's dashboards one guess at a time. 403 is reserved for a
   * dashboard the caller can see but may not change — where the existence is
   * already known and hiding it would only be confusing.
   */
  async findVisible(dashboardId: string, user: AuthenticatedUser): Promise<DashboardResponseDto> {
    const row = await this.loadVisibleRow(dashboardId, user);
    return toResponse(row, this.readDefinition(row));
  }

  async save(dashboardId: string, user: AuthenticatedUser, expectedVersion: number, definition: unknown): Promise<DashboardResponseDto> {
    const row = await this.loadVisibleRow(dashboardId, user);

    if (row.ownerId !== user.id) {
      // Existence is already established by the read above, so hiding it here
      // would tell the caller nothing they do not know.
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ErrorCode.DASHBOARD_FORBIDDEN,
        message: 'You do not own this dashboard.',
      });
    }

    assertDefinitionSize(definition);
    const parsed = parseDashboardDefinition(definition, 'incoming');

    if (parsed.metadata.id !== dashboardId) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.DASHBOARD_INVALID_SCHEMA,
        message: 'The definition metadata.id does not match the dashboard being written.',
        details: { pathId: dashboardId, definitionId: parsed.metadata.id },
      });
    }

    // The owner is taken from the row, never from the payload — otherwise a
    // client could reassign ownership by editing a field.
    const normalised: DashboardDefinition = {
      ...parsed,
      metadata: { ...parsed.metadata, ownerId: row.ownerId, updatedAt: new Date().toISOString() },
    };

    const updated = await this.updateWithLock(dashboardId, expectedVersion, {
      title: normalised.metadata.title,
      visibility: normalised.metadata.visibility,
      definition: toJsonValue(normalised),
    });

    return toResponse(updated, normalised);
  }

  private async loadVisibleRow(dashboardId: string, user: AuthenticatedUser): Promise<DashboardRow> {
    const row = (await this.prisma.dashboard.findUnique({ where: { id: dashboardId } })) as DashboardRow | null;

    if (!row || (row.visibility !== 'shared' && row.ownerId !== user.id)) {
      throw notFound();
    }

    return row;
  }

  /**
   * Validates on read too. A row written by an older server, or edited directly
   * in the database, must not reach a client as unchecked JSON — the frontend
   * would fail its own DTO validation with a message pointing at the wrong layer.
   */
  private readDefinition(row: DashboardRow): DashboardDefinition {
    if (row.schemaVersion !== DASHBOARD_SCHEMA_VERSION) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.DASHBOARD_INVALID_SCHEMA,
        message: 'This dashboard was stored under a schema version this server cannot read.',
        details: { stored: row.schemaVersion, supported: DASHBOARD_SCHEMA_VERSION },
      });
    }

    return parseDashboardDefinition(row.definition, 'stored');
  }

  /**
   * The optimistic lock. `updateMany` with the version in the WHERE clause makes
   * the check and the write one statement, so two concurrent writers cannot both
   * read version 3 and both succeed — the second matches no rows.
   */
  private async updateWithLock(
    dashboardId: string,
    expectedVersion: number,
    data: Record<string, unknown>,
  ): Promise<DashboardRow> {
    const result = await this.prisma.dashboard.updateMany({
      where: { id: dashboardId, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });

    if (result.count === 0) {
      const current = (await this.prisma.dashboard.findUnique({ where: { id: dashboardId } })) as DashboardRow | null;
      if (!current) throw notFound();

      throw versionConflict(current.version);
    }

    return (await this.prisma.dashboard.findUnique({ where: { id: dashboardId } })) as DashboardRow;
  }
}

export function notFound(): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ErrorCode.DASHBOARD_NOT_FOUND,
    message: 'Dashboard not found.',
  });
}

export function versionConflict(currentVersion: number): AppException {
  return new AppException({
    status: HttpStatus.CONFLICT,
    code: ErrorCode.DASHBOARD_VERSION_CONFLICT,
    message: 'This dashboard changed since you loaded it.',
    // The client needs the current version to re-read and retry; without it the
    // only recovery is a blind refetch.
    details: { currentVersion },
  });
}

function toResponse(row: DashboardRow, definition: DashboardDefinition): DashboardResponseDto {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.ownerId,
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    schemaVersion: row.schemaVersion,
    version: row.version,
    definition,
    updatedAt: row.updatedAt.toISOString(),
  };
}
