import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/auth.decorators';
import { ApiEnvelopeResponse, ApiErrorResponse } from '../common/decorators/apiEnvelope.decorator';
import { HealthSummaryDto, LivenessDto, ReadinessDto } from './dto/health.response.dto';
import { HealthService } from './health.service';

/**
 * Controllers here do HTTP and nothing else: pick the service call, return its
 * value. The envelope is added by the response interceptor and failures are
 * turned into the error envelope by the exception filter, so there is no
 * response shaping in this file at all.
 *
 * Public as a whole. A readiness probe is called by an orchestrator that holds no
 * credentials, and a liveness probe that failed on an auth misconfiguration would
 * report the process dead for entirely the wrong reason.
 */
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Aggregate health summary',
    description:
      'Informational endpoint for dashboards and humans. Always answers 200 and reports a degraded status rather than failing, so a poller does not have to unpack an error envelope. Use /health/live and /health/ready for probes.',
  })
  @ApiEnvelopeResponse(HealthSummaryDto)
  summary(): Promise<HealthSummaryDto> {
    return this.health.summary();
  }

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Succeeds whenever the process can serve requests. Checks no dependency by design.',
  })
  @ApiEnvelopeResponse(LivenessDto)
  live(): LivenessDto {
    return this.health.live();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description: 'Verifies the database round-trips. Answers 503 with the failing checks in error.details when it does not.',
  })
  @ApiEnvelopeResponse(ReadinessDto)
  @ApiErrorResponse(503, 'A dependency is unavailable.')
  ready(): Promise<ReadinessDto> {
    return this.health.ready();
  }
}
