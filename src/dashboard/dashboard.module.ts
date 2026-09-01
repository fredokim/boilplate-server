import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardDataController } from './data/dashboardData.controller';
import { DashboardDataService } from './data/dashboardData.service';
import { DashboardDataSourceRegistry } from './data/dataSourceRegistry';
import { DashboardService } from './definition/dashboard.service';
import { PersonalizationService } from './personalization/personalization.service';

/**
 * Two controllers on purpose: the compatibility routes the frontend already
 * calls (`/dashboard/...`) and the domain routes (`/dashboards/:id/...`). They
 * are different contracts with different lifetimes — the first exists to be
 * dropped once the client moves, the second is the one worth keeping.
 */
@Module({
  controllers: [DashboardDataController, DashboardController],
  providers: [DashboardDataSourceRegistry, DashboardDataService, DashboardService, PersonalizationService],
})
export class DashboardModule {}
