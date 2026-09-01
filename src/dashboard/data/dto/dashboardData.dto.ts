import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { DASHBOARD_DATA_SOURCE_IDS, type DashboardDataSourceId, type DataSourceScope } from '../dataSourceRegistry';

/**
 * Response shapes, matched field for field to the frontend's
 * `dashboardDataSource.dto.ts`. Those DTOs validate every response, so a missing
 * or extra field here is a runtime failure in the browser, not a type error here.
 */

export class KpiDataDto {
  @ApiProperty({ enum: ['kpi'] })
  kind!: 'kpi';

  @ApiProperty()
  label!: string;

  @ApiPropertyOptional()
  value?: number;

  @ApiPropertyOptional()
  trend?: string;
}

export class SeriesPointDto {
  @ApiProperty()
  label!: string;

  @ApiProperty()
  value!: number;
}

export class SeriesDataDto {
  @ApiProperty({ enum: ['series'] })
  kind!: 'series';

  @ApiProperty({ type: [SeriesPointDto] })
  points!: SeriesPointDto[];
}

export class TableColumnDto {
  @ApiProperty({ enum: ['event', 'owner', 'status'] })
  key!: 'event' | 'owner' | 'status';

  @ApiProperty()
  label!: string;
}

export class TableRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() event!: string;
  @ApiProperty() owner!: string;
  @ApiProperty() status!: string;
}

export class TableDataDto {
  @ApiProperty({ enum: ['table'] })
  kind!: 'table';

  @ApiProperty({ type: [TableColumnDto] })
  columns!: TableColumnDto[];

  @ApiProperty({ type: [TableRowDto] })
  rows!: TableRowDto[];
}

export type DashboardDataDto = KpiDataDto | SeriesDataDto | TableDataDto;

/** The four counts the existing dashboard summary card renders. */
export class DashboardSummaryDto {
  @ApiProperty() activeUsers!: number;
  @ApiProperty() invitedUsers!: number;
  @ApiProperty() blockedUsers!: number;
  @ApiProperty() apiLatencyMs!: number;
  @ApiProperty() contractErrorRate!: number;
}

/**
 * Query parameters for the widget data endpoints.
 *
 * Every bound here is deliberate. `limit` is capped because a table source
 * generates rows on demand and an uncapped one is a request-sized denial of
 * service. `scope` is an enum because it selects a code path, and a free string
 * would eventually be used to select something else.
 */
export class WidgetDataQueryDto {
  /**
   * The existing frontend sends `metric` on the KPI and chart endpoints. It is
   * accepted as an alias for the source id so those calls keep working
   * unchanged; new callers should send `sourceId`.
   */
  @IsOptional()
  @IsIn(DASHBOARD_DATA_SOURCE_IDS)
  @ApiPropertyOptional({ enum: DASHBOARD_DATA_SOURCE_IDS })
  sourceId?: DashboardDataSourceId;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Legacy alias resolved by the controller. Unknown values fall back to a default.' })
  metric?: string;

  @IsOptional()
  @IsIn(['day', 'week', 'month', 'quarter'])
  @ApiPropertyOptional({ enum: ['day', 'week', 'month', 'quarter'], default: 'month' })
  scope?: DataSourceScope;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  limit?: number;
}

/** A widget config value, constrained to what the frontend's `DataSourceParameter` allows. */
export class WidgetParameterDto {
  @IsString()
  key!: string;

  @Transform(({ value }: { value: unknown }) => value)
  @IsOptional()
  value?: string | number | boolean;
}

export class SeriesPointInputDto {
  @IsString()
  label!: string;

  @IsNumber()
  value!: number;
}

export class SeriesInputDto {
  @IsIn(['series'])
  kind!: 'series';

  @ValidateNested({ each: true })
  @Type(() => SeriesPointInputDto)
  points!: SeriesPointInputDto[];
}
