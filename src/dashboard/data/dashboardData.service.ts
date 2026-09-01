import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { PrismaService } from '../../database/prisma.service';
import {
  type DashboardDataSourceId,
  DashboardDataSourceRegistry,
  dataSourceKindById,
  isDashboardDataSourceId,
  type DataSourceQuery,
  type DataSourceScope,
} from './dataSourceRegistry';
import type { DashboardSummaryDto, KpiDataDto, SeriesDataDto, TableDataDto, WidgetDataQueryDto } from './dto/dashboardData.dto';

const DEFAULT_SCOPE: DataSourceScope = 'month';
const DEFAULT_LIMIT = 10;

/**
 * Legacy `metric` values the current frontend sends, mapped onto source ids.
 *
 * The MSW handlers branch on `metric=active-users` and `metric=conversion`;
 * everything else falls through to a default. Reproducing that here is what lets
 * the client switch to the real server without touching
 * `dashboardDataSourceApi.ts`.
 */
const METRIC_ALIASES: Record<string, DashboardDataSourceId> = {
  'active-users': 'active-users',
  conversion: 'conversion-series',
  incidents: 'incident-events',
};

@Injectable()
export class DashboardDataService {
  constructor(
    private readonly registry: DashboardDataSourceRegistry,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Counts derived from real rows — the one endpoint here that reads the
   * database, which also makes it the one that can genuinely be unavailable.
   */
  async summary(): Promise<DashboardSummaryDto> {
    try {
      const [total, active] = await Promise.all([
        this.prisma.user.count(),
        this.prisma.user.count({ where: { isActive: true } }),
      ]);

      return {
        activeUsers: active,
        invitedUsers: 0,
        blockedUsers: total - active,
        apiLatencyMs: 128,
        contractErrorRate: 0.2,
      };
    } catch (error) {
      // The frontend already has a scenario for this exact code, so a database
      // outage surfaces as the failure the UI was built to render rather than as
      // a generic 500.
      throw new AppException({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ErrorCode.DASHBOARD_UNAVAILABLE,
        message: 'Dashboard data is unavailable.',
        cause: error,
      });
    }
  }

  kpi(query: WidgetDataQueryDto): KpiDataDto {
    return this.resolve(query, 'kpi', 'sales-summary') as KpiDataDto;
  }

  series(query: WidgetDataQueryDto): SeriesDataDto {
    return this.resolve(query, 'series', 'traffic-series') as SeriesDataDto;
  }

  table(query: WidgetDataQueryDto): TableDataDto {
    return this.resolve(query, 'table', 'recent-events') as TableDataDto;
  }

  /**
   * Resolves the requested source and refuses one that produces the wrong shape.
   *
   * The kind check matters: `/dashboard/kpi?sourceId=recent-events` would
   * otherwise return a table to a client whose DTO expects a KPI, and the failure
   * would surface as a validation error in the browser with no indication of
   * where it came from.
   */
  private resolve(
    query: WidgetDataQueryDto,
    expectedKind: 'kpi' | 'series' | 'table',
    fallback: DashboardDataSourceId,
  ) {
    const sourceId = this.resolveSourceId(query, fallback);

    if (dataSourceKindById[sourceId] !== expectedKind) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.DASHBOARD_INVALID_SCHEMA,
        message: `Data source ${sourceId} does not produce ${expectedKind} data.`,
        details: { sourceId, produces: dataSourceKindById[sourceId], expected: expectedKind },
      });
    }

    const resolved: DataSourceQuery = {
      scope: query.scope ?? DEFAULT_SCOPE,
      limit: query.limit ?? DEFAULT_LIMIT,
    };

    return this.registry.resolve(sourceId, resolved);
  }

  private resolveSourceId(query: WidgetDataQueryDto, fallback: DashboardDataSourceId): DashboardDataSourceId {
    if (query.sourceId) return query.sourceId;

    if (query.metric !== undefined) {
      const aliased = METRIC_ALIASES[query.metric];
      if (aliased) return aliased;

      // An unrecognised metric falls back rather than failing, matching what the
      // MSW handlers do today. A client that wants an error should send sourceId,
      // which is validated against the allowlist by the DTO.
      if (isDashboardDataSourceId(query.metric)) return query.metric;
    }

    return fallback;
  }
}
