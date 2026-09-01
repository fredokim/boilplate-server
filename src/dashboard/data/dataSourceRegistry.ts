import { Injectable } from '@nestjs/common';
import type { DashboardDataDto, KpiDataDto, SeriesDataDto, TableDataDto } from './dto/dashboardData.dto';

/**
 * The complete set of data sources a client may ask for.
 *
 * This is an allowlist, not a lookup: a source id that is not one of these six
 * is refused before anything reads it. The client never names a table, a query,
 * or a metric expression — it names one of these, and the server decides what
 * that means. That is the whole reason this file exists rather than a generic
 * "run this query" endpoint.
 *
 * The ids match `DashboardDataSourceId` in
 * `src/features/customizable-dashboard/data/dashboardDataSource.ts`.
 */
export const DASHBOARD_DATA_SOURCE_IDS = [
  'sales-summary',
  'active-users',
  'traffic-series',
  'conversion-series',
  'recent-events',
  'incident-events',
] as const;

export type DashboardDataSourceId = (typeof DASHBOARD_DATA_SOURCE_IDS)[number];

export type DataSourceScope = 'day' | 'week' | 'month' | 'quarter';

export type DataSourceQuery = {
  scope: DataSourceScope;
  /** Row cap for table sources. Bounded by the DTO, not by the caller's hope. */
  limit: number;
};

/** What each source produces, so a caller cannot ask for a table and render a KPI. */
export const dataSourceKindById: Record<DashboardDataSourceId, 'kpi' | 'series' | 'table'> = {
  'sales-summary': 'kpi',
  'active-users': 'kpi',
  'traffic-series': 'series',
  'conversion-series': 'series',
  'recent-events': 'table',
  'incident-events': 'table',
};

export function isDashboardDataSourceId(value: unknown): value is DashboardDataSourceId {
  return typeof value === 'string' && (DASHBOARD_DATA_SOURCE_IDS as readonly string[]).includes(value);
}

/**
 * Produces the data for one source.
 *
 * The values are derived rather than read from a warehouse — this step has no
 * upstream to read from, and inventing one would be a bigger decision than it
 * looks. What matters for the contract is that the shapes match the DTOs the
 * frontend already validates, and that the numbers move with `scope` so the
 * filter controls visibly do something.
 */
@Injectable()
export class DashboardDataSourceRegistry {
  resolve(sourceId: DashboardDataSourceId, query: DataSourceQuery): DashboardDataDto {
    switch (sourceId) {
      case 'sales-summary':
        return this.kpi('Gross revenue', 48_240 * scopeFactor(query.scope), query.scope);
      case 'active-users':
        return this.kpi('Active users', 1_284 * scopeFactor(query.scope), query.scope);
      case 'traffic-series':
        return this.series(query.scope, 3_200, 1.08);
      case 'conversion-series':
        return this.series(query.scope, 42, 1.03);
      case 'recent-events':
        return this.table(query.limit, 'deployed');
      case 'incident-events':
        return this.table(query.limit, 'investigating');
    }
  }

  private kpi(label: string, value: number, scope: DataSourceScope): KpiDataDto {
    return {
      kind: 'kpi',
      label,
      value: Math.round(value),
      trend: `${scope}-over-${scope}`,
    };
  }

  private series(scope: DataSourceScope, base: number, growth: number): SeriesDataDto {
    const points = POINTS_BY_SCOPE[scope];

    return {
      kind: 'series',
      points: Array.from({ length: points }, (_unused, index) => ({
        label: `${scope[0]?.toUpperCase() ?? ''}${String(index + 1)}`,
        value: Math.round(base * growth ** index),
      })),
    };
  }

  private table(limit: number, status: string): TableDataDto {
    return {
      kind: 'table',
      columns: [
        { key: 'event', label: 'Event' },
        { key: 'owner', label: 'Owner' },
        { key: 'status', label: 'Status' },
      ],
      rows: Array.from({ length: limit }, (_unused, index) => ({
        id: `evt-${String(index + 1)}`,
        event: `Pipeline run #${String(index + 1)}`,
        owner: index % 2 === 0 ? 'Platform' : 'Design System',
        status,
      })),
    };
  }
}

const POINTS_BY_SCOPE: Record<DataSourceScope, number> = { day: 24, week: 7, month: 12, quarter: 4 };

function scopeFactor(scope: DataSourceScope): number {
  return { day: 0.05, week: 0.3, month: 1, quarter: 3 }[scope];
}
