import { AppException } from '../../common/exceptions/appException';
import { ErrorCode } from '../../common/contracts/errorCode';
import {
  assertDefinitionSize,
  DASHBOARD_SCHEMA_VERSION,
  MAX_PRESETS,
  MAX_WIDGETS,
  parseDashboardDefinition,
  parsePresets,
} from './dashboardSchema';

function widget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'w-1',
    type: 'kpi',
    position: { x: 0, y: 0 },
    width: 4,
    height: 2,
    config: { title: 'Revenue' },
    dataSource: { type: 'api', sourceId: 'sales-summary', parameters: { scope: 'month' } },
    filterConfig: { useGlobalFilters: true, acceptCrossWidgetFilters: false },
    localFilters: {},
    crossWidgetFilters: {},
    ...overrides,
  };
}

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: DASHBOARD_SCHEMA_VERSION,
    metadata: {
      id: 'dash-1',
      title: 'Ops',
      ownerId: 'user-1',
      visibility: 'private',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
    globalFilters: {},
    widgets: [widget()],
    ...overrides,
  };
}

function preset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'default',
    name: 'My dashboard',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    override: { hiddenWidgetIds: [], widgetOverrides: {}, addedWidgets: [] },
    ...overrides,
  };
}

function expectInvalidSchema(fn: () => unknown): AppException {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    const failure = error as AppException;
    expect(failure.code).toBe(ErrorCode.DASHBOARD_INVALID_SCHEMA);
    return failure;
  }

  throw new Error('Expected the parse to throw.');
}

describe('parseDashboardDefinition', () => {
  it('accepts a well-formed definition', () => {
    expect(parseDashboardDefinition(definition()).metadata.id).toBe('dash-1');
  });

  it('rejects an unsupported schema version rather than guessing', () => {
    const error = expectInvalidSchema(() => parseDashboardDefinition(definition({ version: 2 })));

    expect(error.details).toMatchObject({ expected: DASHBOARD_SCHEMA_VERSION, received: 2 });
  });

  /**
   * The allowlist at the storage boundary. Without it a widget naming an unknown
   * source is written happily and only fails much later, when something tries to
   * render it.
   */
  it('rejects a widget naming a data source that is not on the allowlist', () => {
    const rogue = widget({ dataSource: { type: 'api', sourceId: 'drop-tables', parameters: {} } });
    const error = expectInvalidSchema(() => parseDashboardDefinition(definition({ widgets: [rogue] })));

    expect(error.details).toMatchObject({ sourceId: 'drop-tables' });
  });

  it('rejects an unknown widget type', () => {
    expectInvalidSchema(() => parseDashboardDefinition(definition({ widgets: [widget({ type: 'iframe' })] })));
  });

  it('rejects parameters that are not scalars', () => {
    const nested = widget({
      dataSource: { type: 'api', sourceId: 'sales-summary', parameters: { scope: { deep: true } } },
    });

    expectInvalidSchema(() => parseDashboardDefinition(definition({ widgets: [nested] })));
  });

  /** Override lookup is keyed by widget id, so duplicates silently misapply. */
  it('rejects duplicate widget ids', () => {
    expectInvalidSchema(() => parseDashboardDefinition(definition({ widgets: [widget(), widget()] })));
  });

  it('caps the number of widgets', () => {
    const many = Array.from({ length: MAX_WIDGETS + 1 }, (_unused, index) => widget({ id: `w-${String(index)}` }));

    expectInvalidSchema(() => parseDashboardDefinition(definition({ widgets: many })));
  });

  it.each([
    ['a missing metadata id', { metadata: { title: 'x', ownerId: 'u', visibility: 'private', updatedAt: '2026-01-01T00:00:00Z' } }],
    ['an unknown visibility', { metadata: { id: 'd', title: 'x', ownerId: 'u', visibility: 'public', updatedAt: '2026-01-01T00:00:00Z' } }],
    ['a non-array widgets field', { widgets: {} }],
    ['a non-object globalFilters', { globalFilters: [] }],
  ])('rejects %s', (_label, overrides) => {
    expectInvalidSchema(() => parseDashboardDefinition(definition(overrides)));
  });

  /** The same validator runs on read, so a corrupted row cannot reach a client. */
  it('reports which direction a bad payload came from', () => {
    const error = expectInvalidSchema(() => parseDashboardDefinition({ version: 99 }, 'stored'));

    expect(error.details).toMatchObject({ direction: 'stored' });
  });
});

describe('parsePresets', () => {
  it('accepts a well-formed preset list', () => {
    expect(parsePresets([preset()])).toHaveLength(1);
  });

  it('refuses an empty list, because applying nothing is not a state', () => {
    expectInvalidSchema(() => parsePresets([]));
  });

  it('caps the number of presets', () => {
    const many = Array.from({ length: MAX_PRESETS + 1 }, (_unused, index) => preset({ id: `p-${String(index)}` }));

    expectInvalidSchema(() => parsePresets(many));
  });

  it('rejects duplicate preset ids', () => {
    expectInvalidSchema(() => parsePresets([preset(), preset()]));
  });

  it('rejects a blank name', () => {
    expectInvalidSchema(() => parsePresets([preset({ name: '   ' })]));
  });

  /**
   * The key and the widget's own id must agree, or the override is applied to a
   * different widget than the key claims.
   */
  it('rejects a widgetOverrides key that disagrees with the widget id', () => {
    const mismatched = preset({
      override: { hiddenWidgetIds: [], widgetOverrides: { 'w-2': widget({ id: 'w-1' }) }, addedWidgets: [] },
    });

    const error = expectInvalidSchema(() => parsePresets([mismatched]));
    expect(error.details).toMatchObject({ key: 'w-2', widgetId: 'w-1' });
  });

  it('validates widgets inside addedWidgets', () => {
    const bad = preset({
      override: { hiddenWidgetIds: [], widgetOverrides: {}, addedWidgets: [widget({ type: 'iframe' })] },
    });

    expectInvalidSchema(() => parsePresets([bad]));
  });
});

describe('assertDefinitionSize', () => {
  it('allows a normal payload', () => {
    expect(() => {
      assertDefinitionSize(definition());
    }).not.toThrow();
  });

  /**
   * Widget config is an open object, so the structural checks bound the shape but
   * not the bytes. This is the only thing stopping one request storing a
   * megabyte of strings.
   */
  it('rejects a payload past the byte ceiling', () => {
    const huge = definition({ widgets: [widget({ config: { title: 'x'.repeat(300_000) } })] });

    const error = expectInvalidSchema(() => {
      assertDefinitionSize(huge);
    });
    expect(error.details).toMatchObject({ maxBytes: expect.any(Number) as unknown });
  });
});
