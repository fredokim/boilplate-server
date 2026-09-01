import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/auth.decorators';
import { ApiEnvelopeResponse, ApiErrorResponse } from '../common/decorators/apiEnvelope.decorator';
import { UserListResponseDto, UserResponseDto } from './dto/user.dto';
import { UserService } from './user.service';

/**
 * The endpoints the dashboard's user list has always called.
 *
 * They existed as MSW handlers and were the one part of the frontend with no
 * server behind it — which only surfaced when the app was first pointed at the
 * real server and the list spun on "Loading" against a 404.
 */
@ApiTags('users')
@ApiBearerAuth('bearer')
@Controller('users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get()
  @RequirePermissions('user:read')
  @ApiOperation({ summary: 'List users', description: 'Capped; this is not a paginated collection yet.' })
  @ApiEnvelopeResponse(UserListResponseDto)
  async list(): Promise<UserListResponseDto> {
    return { items: await this.users.list() };
  }

  @Get(':id')
  @RequirePermissions('user:read')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Read one user' })
  @ApiEnvelopeResponse(UserResponseDto)
  @ApiErrorResponse(404, 'No such user.')
  findOne(@Param('id') id: string): Promise<UserResponseDto> {
    return this.users.findOne(id);
  }
}
