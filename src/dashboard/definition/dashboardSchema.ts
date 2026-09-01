import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/contracts/errorCode';
import { AppException } from '../../common/exceptions/appException';
import { isDashboardDataSourceId } from '../data/dataSourceRegistry';

/**
 * Structural validation for the versioned JSON stored in `Dashboard.definition`
 * and in `DashboardPersonalization.presets`.
 *
 * PostgreSQL will accept any JSON in a `Json` column, so this is the only thing
 * standing between a malformed payload and a row that every later read has to
 * cope with. It runs on the way in *and* on the way out: a row written by an
 * older server, or edited by hand, must not reach a client as unvalidated JSON.
 *
 * Kept as hand-written guards rather than class-validator because the widget type
 * is a discriminated union whose `config` differs per variant — expressing that
 * with decorators means one DTO class per widget type and a discriminator
 * mapping, which is more machinery than the shape justifies.
 */

export const DASHBOARD_SCHEMA_VERSION = 1;
export const PERSONALIZATION_SCHEMA_VERSION = 1;

/** Bounds. Without them a single request can store an arbitrarily large document. */
export const MAX_WIDGETS = 60;
export const MAX_PRESETS = 20;
export const MAX_DEFINITION_BYTES = 256 * 1024;

const WIDGET_TYPES = ['kpi', 'chart', 'table', 'lightweight', 'lazy-error', 'runtime-error'] as const;

export type WidgetPosition = { x: number; y: number };

export type DashboardWidget = {
  id: string;
  type: (typeof WIDGET_TYPES)[number];
  position: WidgetPosition;
  width: number;
  height: number;
  config: Record<string, unknown>;
  dataSource: {
    type: 'api' | 'static' | 'derived';
    sourceId: string;
    parameters: Record<string, string | number | boolean>;
    refreshPolicy?: { mode: 'manual' | 'interval'; staleTimeMs?: number; intervalMs?: number };
  };
  filterConfig: { useGlobalFilters: boolean; acceptCrossWidgetFilters: boolean };
  localFilters: Record<string, unknown>;
  crossWidgetFilters: Record<string, unknown>;
};

export type DashboardDefinition = {
  version: 1;
  metadata: {
    id: string;
    title: string;
    ownerId: string;
    visibility: 'private' | 'shared';
    updatedAt: string;
  };
  globalFilters: Record<string, unknown>;
  widgets: DashboardWidget[];
};

export type PersonalizationOverride = {
  globalFilters?: Record<string, unknown>;
  hiddenWidgetIds: string[];
  widgetOverrides: Record<string, DashboardWidget>;
  addedWidgets: DashboardWidget[];
};

export type DashboardPreset = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  override: PersonalizationOverride;
};

// ---------------------------------------------------------------------------

function invalid(message: string, details?: Record<string, unknown>): AppException {
  return new AppException({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ErrorCode.DASHBOARD_INVALID_SCHEMA,
    message,
    details,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isParameterMap(value: unknown): value is Record<string, string | number | boolean> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) => typeof entry === 'string' || typeof entry === 'boolean' || isFiniteNumber(entry),
    )
  );
}

function parseWidget(value: unknown, path: string): DashboardWidget {
  if (!isRecord(value)) throw invalid(`${path} must be an object.`);

  const { id, type, position, width, height, config, dataSource, filterConfig, localFilters, crossWidgetFilters } =
    value;

  if (typeof id !== 'string' || id === '') throw invalid(`${path}.id must be a non-empty string.`);
  if (!(WIDGET_TYPES as readonly unknown[]).includes(type)) {
    throw invalid(`${path}.type is not a known widget type.`, { allowed: WIDGET_TYPES });
  }
  if (!isRecord(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)) {
    throw invalid(`${path}.position must be { x, y } numbers.`);
  }
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) throw invalid(`${path} needs numeric width and height.`);
  if (!isRecord(config)) throw invalid(`${path}.config must be an object.`);
  if (!isRecord(dataSource)) throw invalid(`${path}.dataSource must be an object.`);

  const { type: sourceType, sourceId, parameters, refreshPolicy } = dataSource;

  if (sourceType !== 'api' && sourceType !== 'static' && sourceType !== 'derived') {
    throw invalid(`${path}.dataSource.type must be api, static, or derived.`);
  }

  // The allowlist again, at the storage boundary. A widget saved with an unknown
  // source would otherwise sit in the database until someone rendered it.
  if (!isDashboardDataSourceId(sourceId)) {
    throw invalid(`${path}.dataSource.sourceId is not an allowed data source.`, { sourceId });
  }

  if (!isParameterMap(parameters)) {
    throw invalid(`${path}.dataSource.parameters must map to strings, numbers, or booleans.`);
  }

  if (refreshPolicy !== undefined) {
    if (!isRecord(refreshPolicy) || (refreshPolicy.mode !== 'manual' && refreshPolicy.mode !== 'interval')) {
      throw invalid(`${path}.dataSource.refreshPolicy.mode must be manual or interval.`);
    }
  }

  if (
    !isRecord(filterConfig) ||
    typeof filterConfig.useGlobalFilters !== 'boolean' ||
    typeof filterConfig.acceptCrossWidgetFilters !== 'boolean'
  ) {
    throw invalid(`${path}.filterConfig needs both boolean flags.`);
  }

  if (!isRecord(localFilters) || !isRecord(crossWidgetFilters)) {
    throw invalid(`${path} needs localFilters and crossWidgetFilters objects.`);
  }

  return value as unknown as DashboardWidget;
}

/**
 * @param direction distinguishes a client sending nonsense (422) from the server
 * finding nonsense already stored — the second is a data problem, and saying so
 * in the message is what makes it findable.
 */
export function parseDashboardDefinition(value: unknown, direction: 'incoming' | 'stored' = 'incoming'): DashboardDefinition {
  if (!isRecord(value)) throw invalid(`Dashboard definition (${direction}) must be an object.`);

  if (value.version !== DASHBOARD_SCHEMA_VERSION) {
    throw invalid('Unsupported dashboard schema version.', {
      expected: DASHBOARD_SCHEMA_VERSION,
      received: value.version,
      direction,
    });
  }

  const { metadata, globalFilters, widgets } = value;

  if (!isRecord(metadata)) throw invalid('Dashboard metadata must be an object.');
  if (typeof metadata.id !== 'string' || metadata.id === '') throw invalid('Dashboard metadata.id is required.');
  if (typeof metadata.title !== 'string') throw invalid('Dashboard metadata.title is required.');
  if (typeof metadata.ownerId !== 'string') throw invalid('Dashboard metadata.ownerId is required.');
  if (metadata.visibility !== 'private' && metadata.visibility !== 'shared') {
    throw invalid('Dashboard metadata.visibility must be private or shared.');
  }
  if (!isIsoDate(metadata.updatedAt)) throw invalid('Dashboard metadata.updatedAt must be an ISO date.');

  if (!isRecord(globalFilters)) throw invalid('Dashboard globalFilters must be an object.');
  if (!Array.isArray(widgets)) throw invalid('Dashboard widgets must be an array.');
  if (widgets.length > MAX_WIDGETS) {
    throw invalid(`A dashboard may hold at most ${String(MAX_WIDGETS)} widgets.`, { received: widgets.length });
  }

  const parsed = widgets.map((widget, index) => parseWidget(widget, `widgets[${String(index)}]`));

  const ids = new Set(parsed.map((widget) => widget.id));
  if (ids.size !== parsed.length) {
    // Duplicate ids silently break override lookup, which is keyed by id.
    throw invalid('Widget ids must be unique within a dashboard.');
  }

  return { ...(value as unknown as DashboardDefinition), widgets: parsed };
}

export function parsePreset(value: unknown, path: string): DashboardPreset {
  if (!isRecord(value)) throw invalid(`${path} must be an object.`);

  const { id, name, createdAt, updatedAt, override } = value;

  if (typeof id !== 'string' || id === '') throw invalid(`${path}.id must be a non-empty string.`);
  if (typeof name !== 'string' || name.trim() === '') throw invalid(`${path}.name must not be empty.`);
  if (name.length > 80) throw invalid(`${path}.name is too long.`, { maxLength: 80 });
  if (!isIsoDate(createdAt) || !isIsoDate(updatedAt)) throw invalid(`${path} needs ISO createdAt and updatedAt.`);
  if (!isRecord(override)) throw invalid(`${path}.override must be an object.`);

  const { globalFilters, hiddenWidgetIds, widgetOverrides, addedWidgets } = override;

  if (globalFilters !== undefined && !isRecord(globalFilters)) {
    throw invalid(`${path}.override.globalFilters must be an object when present.`);
  }
  if (!Array.isArray(hiddenWidgetIds) || hiddenWidgetIds.some((entry) => typeof entry !== 'string')) {
    throw invalid(`${path}.override.hiddenWidgetIds must be an array of strings.`);
  }
  if (!isRecord(widgetOverrides)) throw invalid(`${path}.override.widgetOverrides must be an object.`);
  if (!Array.isArray(addedWidgets)) throw invalid(`${path}.override.addedWidgets must be an array.`);

  if (Object.keys(widgetOverrides).length + addedWidgets.length > MAX_WIDGETS) {
    throw invalid(`A preset may not carry more than ${String(MAX_WIDGETS)} widgets.`);
  }

  for (const [widgetId, widget] of Object.entries(widgetOverrides)) {
    const parsed = parseWidget(widget, `${path}.override.widgetOverrides.${widgetId}`);
    if (parsed.id !== widgetId) {
      // A mismatch here means the override would be applied to a different widget
      // than the key claims.
      throw invalid(`${path}.override.widgetOverrides.${widgetId} has a mismatched widget id.`, {
        key: widgetId,
        widgetId: parsed.id,
      });
    }
  }

  addedWidgets.forEach((widget, index) => parseWidget(widget, `${path}.override.addedWidgets[${String(index)}]`));

  return value as unknown as DashboardPreset;
}

export function parsePresets(value: unknown, direction: 'incoming' | 'stored' = 'incoming'): DashboardPreset[] {
  if (!Array.isArray(value)) throw invalid(`Presets (${direction}) must be an array.`);
  if (value.length === 0) throw invalid('A personalization must keep at least one preset.');
  if (value.length > MAX_PRESETS) {
    throw invalid(`At most ${String(MAX_PRESETS)} presets are allowed.`, { received: value.length });
  }

  const presets = value.map((preset, index) => parsePreset(preset, `presets[${String(index)}]`));

  const ids = new Set(presets.map((preset) => preset.id));
  if (ids.size !== presets.length) throw invalid('Preset ids must be unique.');

  return presets;
}

/**
 * A size ceiling measured after serialisation, because the structural checks
 * above bound the shape but not the total bytes — a widget config is an open
 * object and could hold a megabyte of strings.
 */
export function assertDefinitionSize(value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');

  if (bytes > MAX_DEFINITION_BYTES) {
    throw invalid('Dashboard payload is too large.', { bytes, maxBytes: MAX_DEFINITION_BYTES });
  }
}
