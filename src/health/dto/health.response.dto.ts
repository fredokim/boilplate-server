import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ComponentStatus } from '../databaseHealth.port';

/**
 * Response models, not Prisma types. Controllers return these so the database
 * schema can change without changing the wire contract.
 */

export class ComponentHealthDto {
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  status!: ComponentStatus;

  @ApiPropertyOptional({ example: 1.42, description: 'Round-trip time of the check in milliseconds.' })
  latencyMs?: number;

  @ApiPropertyOptional({ description: 'Present only when the component is down. Redacted in production.' })
  error?: string;
}

export class LivenessDto {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 12.5, description: 'Seconds since the process started.' })
  uptimeSeconds!: number;
}

export class ReadinessDto {
  @ApiProperty({ enum: ['ok', 'degraded'], example: 'ok' })
  status!: 'ok' | 'degraded';

  @ApiProperty({ type: () => Object, description: 'One entry per checked dependency.' })
  checks!: Record<string, ComponentHealthDto>;
}

export class HealthSummaryDto extends ReadinessDto {
  @ApiProperty({ example: 12.5 })
  uptimeSeconds!: number;
}
