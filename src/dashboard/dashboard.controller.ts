import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import type { AuthenticatedUser } from '../auth/types/authenticatedUser';
import { ApiEnvelopeResponse, ApiErrorResponse } from '../common/decorators/apiEnvelope.decorator';
import { DashboardService } from './definition/dashboard.service';
import {
  CreatePresetDto,
  DashboardResponseDto,
  DeletePresetDto,
  PersonalizationResponseDto,
  RenamePresetDto,
  SaveDashboardDefinitionDto,
  SavePersonalizationDto,
  SelectPresetDto,
} from './definition/dto/dashboard.dto';
import { PersonalizationService } from './personalization/personalization.service';

/**
 * The domain surface, under `/dashboards/:dashboardId`. The compatibility routes
 * the frontend already calls live in `DashboardDataController` under
 * `/dashboard` — see the note there.
 *
 * The authenticated user is taken from the request on every route. No handler
 * reads a user id from a path, a body, or a query string, so there is no request
 * a caller could shape to reach someone else's personalization.
 */
@ApiTags('dashboards')
@ApiBearerAuth('bearer')
@Controller('dashboards')
export class DashboardController {
  constructor(
    private readonly dashboards: DashboardService,
    private readonly personalization: PersonalizationService,
  ) {}

  @Get(':dashboardId')
  @RequirePermissions('dashboard:read')
  @ApiParam({ name: 'dashboardId' })
  @ApiOperation({
    summary: 'Read a dashboard definition',
    description: 'A dashboard the caller may not see answers 404, not 403 — a distinct 403 would confirm the id exists.',
  })
  @ApiEnvelopeResponse(DashboardResponseDto)
  @ApiErrorResponse(404, 'No such dashboard, or not visible to the caller.')
  findOne(
    @Param('dashboardId') dashboardId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DashboardResponseDto> {
    return this.dashboards.findVisible(dashboardId, user);
  }

  @Put(':dashboardId')
  @RequirePermissions('dashboard:write')
  @ApiParam({ name: 'dashboardId' })
  @ApiOperation({
    summary: 'Replace a dashboard definition',
    description: 'Requires the version last read. A mismatch answers 409 with the current version in details.',
  })
  @ApiEnvelopeResponse(DashboardResponseDto)
  @ApiErrorResponse(403, 'The caller can see the dashboard but does not own it.')
  @ApiErrorResponse(409, 'The dashboard changed since it was read.')
  @ApiErrorResponse(422, 'The definition failed schema validation.')
  save(
    @Param('dashboardId') dashboardId: string,
    @Body() body: SaveDashboardDefinitionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DashboardResponseDto> {
    return this.dashboards.save(dashboardId, user, body.expectedVersion, body.definition);
  }

  @Get(':dashboardId/personalization')
  @RequirePermissions('dashboard:read')
  @ApiParam({ name: 'dashboardId' })
  @ApiOperation({
    summary: "Read the caller's personalization",
    description: 'Creates the default personalization on first access rather than answering 404.',
  })
  @ApiEnvelopeResponse(PersonalizationResponseDto)
  @ApiErrorResponse(404, 'No such dashboard, or not visible to the caller.')
  findPersonalization(
    @Param('dashboardId') dashboardId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonalizationResponseDto> {
    return this.personalization.findForUser(dashboardId, user);
  }

  @Put(':dashboardId/personalization')
  @RequirePermissions('dashboard:write')
  @ApiParam({ name: 'dashboardId' })
  @ApiOperation({ summary: 'Replace the whole personalization' })
  @ApiEnvelopeResponse(PersonalizationResponseDto)
  @ApiErrorResponse(409, 'The personalization changed since it was read.')
  @ApiErrorResponse(422, 'The presets failed schema validation.')
  savePersonalization(
    @Param('dashboardId') dashboardId: string,
    @Body() body: SavePersonalizationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonalizationResponseDto> {
    return this.personalization.save(dashboardId, user, body.expectedVersion, body.activePresetId, body.presets);
  }

  @Post(':dashboardId/presets')
  @RequirePermissions('dashboard:write')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: 'dashboardId' })
  @ApiOperation({ summary: 'Create a preset', description: 'Copies the active preset unless another is named.' })
  @ApiEnvelopeResponse(PersonalizationResponseDto, { status: 201 })
  @ApiErrorResponse(409, 'The personalization changed since it was read.')
  createPreset(
    @Param('dashboardId') dashboardId: string,
    @Body() body: CreatePresetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonalizationResponseDto> {
    return this.personalization.createPreset(dashboardId, user, body.expectedVersion, body.name, body.copyFromPresetId);
  }

  @Patch(':dashboardId/presets/:presetId')
  @RequirePermissions('dashboard:write')
  @ApiOperation({ summary: 'Rename a preset' })
  @ApiEnvelopeResponse(PersonalizationResponseDto)
  @ApiErrorResponse(404, 'No such preset.')
  @ApiErrorResponse(409, 'The personalization changed since it was read.')
  renamePreset(
    @Param('dashboardId') dashboardId: string,
    @Param('presetId') presetId: string,
    @Body() body: RenamePresetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonalizationResponseDto> {
    return this.personalization.renamePreset(dashboardId, user, presetId, body.expectedVersion, body.name);
  }

  @Post(':dashboardId/presets/:presetId/select')
  @RequirePermissions('dashboard:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Make a preset the active one' })
  @ApiEnvelopeResponse(PersonalizationResponseDto)
  @ApiErrorResponse(404, 'No such preset.')
  selectPreset(
    @Param('dashboardId') dashboardId: string,
    @Param('presetId') presetId: string,
    @Body() body: SelectPresetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonalizationResponseDto> {
    return this.personalization.selectPreset(dashboardId, user, presetId, body.expectedVersion);
  }

  @Delete(':dashboardId/presets/:presetId')
  @RequirePermissions('dashboard:write')
  @ApiOperation({
    summary: 'Delete a preset',
    description: 'The last preset cannot be deleted; deleting the active one moves the selection.',
  })
  @ApiEnvelopeResponse(PersonalizationResponseDto)
  @ApiErrorResponse(404, 'No such preset.')
  @ApiErrorResponse(422, 'The last preset cannot be deleted.')
  deletePreset(
    @Param('dashboardId') dashboardId: string,
    @Param('presetId') presetId: string,
    @Body() body: DeletePresetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonalizationResponseDto> {
    return this.personalization.deletePreset(dashboardId, user, presetId, body.expectedVersion);
  }
}
