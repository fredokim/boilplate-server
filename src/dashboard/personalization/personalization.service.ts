import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { toJsonValue } from '../../database/jsonValue';
import { PrismaService } from '../../database/prisma.service';
import type { AuthenticatedUser } from '../../auth/types/authenticatedUser';
import { notFound, versionConflict } from '../definition/dashboard.service';
import type { PersonalizationResponseDto } from '../definition/dto/dashboard.dto';
import {
  assertDefinitionSize,
  type DashboardPreset,
  MAX_PRESETS,
  PERSONALIZATION_SCHEMA_VERSION,
  parsePresets,
} from '../definition/dashboardSchema';

type PersonalizationRow = {
  userId: string;
  dashboardId: string;
  schemaVersion: number;
  version: number;
  activePresetId: string;
  presets: unknown;
  updatedAt: Date;
};

const DEFAULT_PRESET_ID = 'default';

/**
 * Per-user personalization. Every method takes the authenticated user and derives
 * the owner from it — a userId in a body or a query string is never read, so
 * there is no request shape that could reach another person's row.
 */
@Injectable()
export class PersonalizationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the caller's personalization, creating the default one on first access
   * rather than answering 404.
   *
   * "No personalization yet" and "an empty personalization" are the same thing to
   * every caller, and making the client handle a 404 that means "this is fine"
   * only moves the defaulting into the UI. It mirrors what the frontend's
   * `loadDashboardPersonalization` already does locally.
   */
  async findForUser(dashboardId: string, user: AuthenticatedUser): Promise<PersonalizationResponseDto> {
    await this.assertDashboardVisible(dashboardId, user);

    const row = (await this.prisma.dashboardPersonalization.findUnique({
      where: { userId_dashboardId: { userId: user.id, dashboardId } },
    })) as PersonalizationRow | null;

    if (!row) return this.create(dashboardId, user.id);

    return toResponse(row, this.readPresets(row));
  }

  async save(
    dashboardId: string,
    user: AuthenticatedUser,
    expectedVersion: number,
    activePresetId: string,
    presets: unknown,
  ): Promise<PersonalizationResponseDto> {
    await this.assertDashboardVisible(dashboardId, user);

    assertDefinitionSize(presets);
    const parsed = parsePresets(presets, 'incoming');

    if (!parsed.some((preset) => preset.id === activePresetId)) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.DASHBOARD_INVALID_SCHEMA,
        message: 'activePresetId does not name one of the supplied presets.',
        details: { activePresetId, presetIds: parsed.map((preset) => preset.id) },
      });
    }

    return this.write(dashboardId, user.id, expectedVersion, activePresetId, parsed);
  }

  async createPreset(
    dashboardId: string,
    user: AuthenticatedUser,
    expectedVersion: number,
    name: string,
    copyFromPresetId?: string,
  ): Promise<PersonalizationResponseDto> {
    const { presets, activePresetId } = await this.load(dashboardId, user);

    if (presets.length >= MAX_PRESETS) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.DASHBOARD_INVALID_SCHEMA,
        message: `At most ${String(MAX_PRESETS)} presets are allowed.`,
      });
    }

    const source = presets.find((preset) => preset.id === (copyFromPresetId ?? activePresetId));

    if (!source) throw presetNotFound();

    const now = new Date().toISOString();
    const created: DashboardPreset = {
      id: randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
      // A new preset starts as a copy, which is what "save the current view under
      // a new name" means to the person clicking it.
      override: structuredClone(source.override),
    };

    return this.write(dashboardId, user.id, expectedVersion, created.id, [...presets, created]);
  }

  async renamePreset(
    dashboardId: string,
    user: AuthenticatedUser,
    presetId: string,
    expectedVersion: number,
    name: string,
  ): Promise<PersonalizationResponseDto> {
    const { presets, activePresetId } = await this.load(dashboardId, user);

    if (!presets.some((preset) => preset.id === presetId)) throw presetNotFound();

    const next = presets.map((preset) =>
      preset.id === presetId ? { ...preset, name, updatedAt: new Date().toISOString() } : preset,
    );

    return this.write(dashboardId, user.id, expectedVersion, activePresetId, next);
  }

  async selectPreset(
    dashboardId: string,
    user: AuthenticatedUser,
    presetId: string,
    expectedVersion: number,
  ): Promise<PersonalizationResponseDto> {
    const { presets } = await this.load(dashboardId, user);

    if (!presets.some((preset) => preset.id === presetId)) throw presetNotFound();

    return this.write(dashboardId, user.id, expectedVersion, presetId, presets);
  }

  async deletePreset(
    dashboardId: string,
    user: AuthenticatedUser,
    presetId: string,
    expectedVersion: number,
  ): Promise<PersonalizationResponseDto> {
    const { presets, activePresetId } = await this.load(dashboardId, user);

    if (!presets.some((preset) => preset.id === presetId)) throw presetNotFound();

    if (presets.length === 1) {
      // Deleting the last one would leave a personalization with nothing to
      // apply, and `parsePresets` refuses an empty list on the way back in.
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.DASHBOARD_INVALID_SCHEMA,
        message: 'The last preset cannot be deleted.',
      });
    }

    const remaining = presets.filter((preset) => preset.id !== presetId);
    // Deleting the active preset has to move the selection somewhere real.
    const nextActive = activePresetId === presetId ? (remaining[0]?.id ?? DEFAULT_PRESET_ID) : activePresetId;

    return this.write(dashboardId, user.id, expectedVersion, nextActive, remaining);
  }

  // -------------------------------------------------------------------------

  private async load(
    dashboardId: string,
    user: AuthenticatedUser,
  ): Promise<{ presets: DashboardPreset[]; activePresetId: string }> {
    const current = await this.findForUser(dashboardId, user);

    return {
      presets: current.presets as DashboardPreset[],
      activePresetId: current.activePresetId,
    };
  }

  /**
   * A personalization is meaningless without a dashboard the caller can see, and
   * checking here is what stops one user reading another's row by guessing a
   * dashboard id.
   */
  private async assertDashboardVisible(dashboardId: string, user: AuthenticatedUser): Promise<void> {
    const dashboard = (await this.prisma.dashboard.findUnique({ where: { id: dashboardId } })) as {
      ownerId: string;
      visibility: string;
    } | null;

    if (!dashboard || (dashboard.visibility !== 'shared' && dashboard.ownerId !== user.id)) {
      throw notFound();
    }
  }

  private async create(dashboardId: string, userId: string): Promise<PersonalizationResponseDto> {
    const now = new Date().toISOString();
    const presets: DashboardPreset[] = [
      {
        id: DEFAULT_PRESET_ID,
        name: 'My dashboard',
        createdAt: now,
        updatedAt: now,
        override: { hiddenWidgetIds: [], widgetOverrides: {}, addedWidgets: [] },
      },
    ];

    const row = (await this.prisma.dashboardPersonalization.create({
      data: {
        userId,
        dashboardId,
        schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
        activePresetId: DEFAULT_PRESET_ID,
        presets: toJsonValue(presets),
      },
    })) as PersonalizationRow;

    return toResponse(row, presets);
  }

  private async write(
    dashboardId: string,
    userId: string,
    expectedVersion: number,
    activePresetId: string,
    presets: DashboardPreset[],
  ): Promise<PersonalizationResponseDto> {
    // The version lives in the WHERE clause, so the check and the write are one
    // statement. Two writers who both read version 3 cannot both succeed.
    const result = await this.prisma.dashboardPersonalization.updateMany({
      where: { userId, dashboardId, version: expectedVersion },
      data: {
        activePresetId,
        presets: toJsonValue(presets),
        schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
        version: { increment: 1 },
      },
    });

    const row = (await this.prisma.dashboardPersonalization.findUnique({
      where: { userId_dashboardId: { userId, dashboardId } },
    })) as PersonalizationRow | null;

    if (!row) throw notFound();
    if (result.count === 0) throw versionConflict(row.version);

    return toResponse(row, presets);
  }

  private readPresets(row: PersonalizationRow): DashboardPreset[] {
    if (row.schemaVersion !== PERSONALIZATION_SCHEMA_VERSION) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.DASHBOARD_INVALID_SCHEMA,
        message: 'This personalization was stored under a schema version this server cannot read.',
        details: { stored: row.schemaVersion, supported: PERSONALIZATION_SCHEMA_VERSION },
      });
    }

    return parsePresets(row.presets, 'stored');
  }
}

/** Same reasoning as a missing dashboard: no distinct 403 to confirm an id. */
function presetNotFound(): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ErrorCode.DASHBOARD_NOT_FOUND,
    message: 'Preset not found.',
  });
}

function toResponse(row: PersonalizationRow, presets: DashboardPreset[]): PersonalizationResponseDto {
  return {
    dashboardId: row.dashboardId,
    userId: row.userId,
    schemaVersion: row.schemaVersion,
    version: row.version,
    activePresetId: row.activePresetId,
    presets,
    updatedAt: row.updatedAt.toISOString(),
  };
}
