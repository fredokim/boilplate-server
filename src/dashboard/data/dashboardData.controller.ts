import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../auth/decorators/auth.decorators';
import { ApiEnvelopeResponse, ApiErrorResponse } from '../../common/decorators/apiEnvelope.decorator';
import { DashboardDataService } from './dashboardData.service';
import { DashboardSummaryDto, KpiDataDto, SeriesDataDto, TableDataDto, WidgetDataQueryDto } from './dto/dashboardData.dto';

/**
 * The compatibility surface: the four routes the frontend already calls, at the
 * paths it already calls them.
 *
 * They are kept under `/dashboard` (singular) while the domain routes live under
 * `/dashboards/:id` (plural). Collapsing them into one namespace would have meant
 * changing `dashboardDataSourceApi.ts` and the MSW scenarios, and the point of
 * this step is that the client can be pointed at the real server without editing
 * its contracts.
 */
@ApiTags('dashboard-data')
@ApiBearerAuth('bearer')
@Controller('dashboard')
@RequirePermissions('dashboard:read')
export class DashboardDataController {
  constructor(private readonly data: DashboardDataService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Counts for the dashboard summary card' })
  @ApiEnvelopeResponse(DashboardSummaryDto)
  @ApiErrorResponse(503, 'Dashboard data is unavailable.')
  summary(): Promise<DashboardSummaryDto> {
    return this.data.summary();
  }

  @Get('kpi')
  @ApiOperation({
    summary: 'A single KPI value',
    description: 'Accepts sourceId, or the legacy metric alias the current frontend sends.',
  })
  @ApiEnvelopeResponse(KpiDataDto)
  @ApiErrorResponse(503, 'Dashboard data is unavailable.')
  kpi(@Query() query: WidgetDataQueryDto): KpiDataDto {
    return this.data.kpi(query);
  }

  @Get('chart')
  @ApiOperation({ summary: 'A time series for a chart widget' })
  @ApiEnvelopeResponse(SeriesDataDto)
  @ApiErrorResponse(503, 'Dashboard data is unavailable.')
  chart(@Query() query: WidgetDataQueryDto): SeriesDataDto {
    return this.data.series(query);
  }

  @Get('table')
  @ApiOperation({ summary: 'Rows for a table widget' })
  @ApiEnvelopeResponse(TableDataDto)
  @ApiErrorResponse(503, 'Dashboard data is unavailable.')
  table(@Query() query: WidgetDataQueryDto): TableDataDto {
    return this.data.table(query);
  }
}
