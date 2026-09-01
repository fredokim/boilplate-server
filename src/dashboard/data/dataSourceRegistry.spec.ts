import {
  DASHBOARD_DATA_SOURCE_IDS,
  DashboardDataSourceRegistry,
  dataSourceKindById,
  isDashboardDataSourceId,
} from './dataSourceRegistry';

describe('data source allowlist', () => {
  it.each(DASHBOARD_DATA_SOURCE_IDS)('accepts the known source %s', (sourceId) => {
    expect(isDashboardDataSourceId(sourceId)).toBe(true);
  });

  /**
   * The point of an allowlist is that everything else is refused — including
   * things that look like a source name and things that are not strings at all.
   */
  it.each([
    ['an unknown name', 'sales_summary'],
    ['a SQL fragment', 'SELECT * FROM users'],
    ['a path', '../../etc/passwd'],
    ['an empty string', ''],
    ['a number', 1],
    ['null', null],
    ['an object', { sourceId: 'sales-summary' }],
  ])('refuses %s', (_label, value) => {
    expect(isDashboardDataSourceId(value)).toBe(false);
  });

  it('declares a kind for every source, so none can be resolved unclassified', () => {
    expect(Object.keys(dataSourceKindById).sort()).toEqual([...DASHBOARD_DATA_SOURCE_IDS].sort());
  });
});

describe('DashboardDataSourceRegistry', () => {
  const registry = new DashboardDataSourceRegistry();

  it.each(DASHBOARD_DATA_SOURCE_IDS)('produces the declared kind for %s', (sourceId) => {
    const data = registry.resolve(sourceId, { scope: 'month', limit: 5 });

    expect(data.kind).toBe(dataSourceKindById[sourceId]);
  });

  it('honours the row limit for table sources', () => {
    const data = registry.resolve('recent-events', { scope: 'month', limit: 3 });

    expect(data.kind).toBe('table');
    if (data.kind === 'table') expect(data.rows).toHaveLength(3);
  });

  it('shapes table rows to the columns it declares', () => {
    const data = registry.resolve('recent-events', { scope: 'month', limit: 1 });

    if (data.kind !== 'table') throw new Error('expected table data');
    expect(data.columns.map((column) => column.key)).toEqual(['event', 'owner', 'status']);
    expect(Object.keys(data.rows[0] ?? {}).sort()).toEqual(['event', 'id', 'owner', 'status']);
  });

  /** The scope filter has to visibly do something, or the control is decorative. */
  it('varies a series with the requested scope', () => {
    const week = registry.resolve('traffic-series', { scope: 'week', limit: 10 });
    const month = registry.resolve('traffic-series', { scope: 'month', limit: 10 });

    if (week.kind !== 'series' || month.kind !== 'series') throw new Error('expected series data');
    expect(week.points).toHaveLength(7);
    expect(month.points).toHaveLength(12);
  });

  it('varies a KPI with the requested scope', () => {
    const day = registry.resolve('sales-summary', { scope: 'day', limit: 10 });
    const quarter = registry.resolve('sales-summary', { scope: 'quarter', limit: 10 });

    if (day.kind !== 'kpi' || quarter.kind !== 'kpi') throw new Error('expected kpi data');
    expect(quarter.value).toBeGreaterThan(day.value ?? 0);
  });

  it('returns whole numbers, so a KPI never renders a float', () => {
    const data = registry.resolve('active-users', { scope: 'week', limit: 10 });

    if (data.kind !== 'kpi') throw new Error('expected kpi data');
    expect(Number.isInteger(data.value)).toBe(true);
  });
});
