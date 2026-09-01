import { Module } from '@nestjs/common';
import { DATABASE_HEALTH } from './databaseHealth.port';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { PrismaHealthIndicator } from './prismaHealth.indicator';

/**
 * `DATABASE_HEALTH` is bound to the Prisma implementation here and nowhere else,
 * which is the single point a test overrides to run readiness without a database.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService, { provide: DATABASE_HEALTH, useClass: PrismaHealthIndicator }],
})
export class HealthModule {}
