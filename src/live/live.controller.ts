import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import type { AuthenticatedUser } from '../auth/types/authenticatedUser';
import { ApiEnvelopeResponse, ApiErrorResponse } from '../common/decorators/apiEnvelope.decorator';
import { ChatBroadcaster } from './chat/chat.broadcaster';
import { ChatService } from './chat/chat.service';
import {
  BroadcastDto,
  ChatHistoryDto,
  ChatHistoryQueryDto,
  ChatMessageDto,
  ModerateMessageDto,
  MuteUserDto,
  PlaybackSessionDto,
  SendChatMessageDto,
  TransitionBroadcastDto,
} from './dto/live.dto';
import { LiveService } from './live.service';

/**
 * The control plane for live broadcasts. This server never encodes, proxies, or
 * serves a media segment — it holds the manifest URL an external packager
 * produced and the policy around who may have it.
 */
@ApiTags('live')
@ApiBearerAuth('bearer')
@Controller('live')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly chat: ChatService,
    private readonly broadcaster: ChatBroadcaster,
  ) {}

  @Get('broadcasts')
  @RequirePermissions('live:read')
  @ApiOperation({ summary: 'List broadcasts' })
  @ApiEnvelopeResponse(BroadcastDto)
  list(): Promise<BroadcastDto[]> {
    return this.live.listBroadcasts();
  }

  @Get('broadcasts/:broadcastId')
  @RequirePermissions('live:read')
  @ApiParam({ name: 'broadcastId' })
  @ApiOperation({
    summary: 'Read broadcast metadata',
    description: 'Deliberately without the manifest URL — that is only issued through a playback session.',
  })
  @ApiEnvelopeResponse(BroadcastDto)
  @ApiErrorResponse(404, 'No such broadcast.')
  findOne(@Param('broadcastId') broadcastId: string): Promise<BroadcastDto> {
    return this.live.findBroadcast(broadcastId);
  }

  @Post('broadcasts/:broadcastId/playback-session')
  @RequirePermissions('live:read')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: 'broadcastId' })
  @ApiOperation({
    summary: 'Request a short-lived playback grant',
    description:
      'Returns the manifest URL with an expiry. Only a live broadcast is playable: a scheduled one has no stream yet and an ended one has none any more.',
  })
  @ApiEnvelopeResponse(PlaybackSessionDto, { status: 201 })
  @ApiErrorResponse(409, 'The broadcast is not currently live.')
  createPlaybackSession(
    @Param('broadcastId') broadcastId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PlaybackSessionDto> {
    return this.live.createPlaybackSession(broadcastId, user);
  }

  @Post('broadcasts/:broadcastId/status')
  @RequirePermissions('live:manage')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'broadcastId' })
  @ApiOperation({
    summary: 'Move a broadcast through its lifecycle',
    description:
      'Idempotent: asking for the status it already has succeeds and changes nothing. `ended` is terminal.',
  })
  @ApiEnvelopeResponse(BroadcastDto)
  @ApiErrorResponse(409, 'A transition the lifecycle does not allow.')
  transition(
    @Param('broadcastId') broadcastId: string,
    @Body() body: TransitionBroadcastDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BroadcastDto> {
    return this.live.transition(broadcastId, body.status, user);
  }

  @Get('broadcasts/:broadcastId/chat/messages')
  @RequirePermissions('live:read')
  @ApiParam({ name: 'broadcastId' })
  @ApiOperation({
    summary: 'Read chat history',
    description:
      'Cursor pagination by sequence, not offset — an offset shifts under a live chat and would skip or repeat rows.',
  })
  @ApiEnvelopeResponse(ChatHistoryDto)
  @ApiErrorResponse(404, 'No such broadcast.')
  history(
    @Param('broadcastId') broadcastId: string,
    @Query() query: ChatHistoryQueryDto,
  ): Promise<ChatHistoryDto> {
    return this.chat.history(broadcastId, query.afterSequence ?? 0, query.limit ?? 50);
  }

  @Post('broadcasts/:broadcastId/chat/messages')
  @RequirePermissions('chat:write')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: 'broadcastId' })
  @ApiOperation({
    summary: 'Send a message',
    description:
      'Idempotent on clientMessageId: a retry after a timeout returns the stored message rather than posting twice.',
  })
  @ApiEnvelopeResponse(ChatMessageDto, { status: 201 })
  @ApiErrorResponse(403, 'The author is muted.')
  @ApiErrorResponse(409, 'Chat is closed because the broadcast ended.')
  @ApiErrorResponse(429, 'Sending too quickly.')
  async send(
    @Param('broadcastId') broadcastId: string,
    @Body() body: SendChatMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChatMessageDto> {
    const { message, duplicate } = await this.chat.send(broadcastId, user, body.clientMessageId, body.body);

    // A duplicate is not re-broadcast: subscribers already saw it, and sending it
    // again would make every retry look like a new message to anyone watching.
    if (!duplicate) this.broadcaster.publish(broadcastId, { kind: 'message', message });

    return message;
  }

  @Delete('broadcasts/:broadcastId/chat/messages/:messageId')
  @RequirePermissions('chat:moderate')
  @ApiParam({ name: 'broadcastId' })
  @ApiParam({ name: 'messageId' })
  @ApiOperation({
    summary: 'Remove a message',
    description:
      'Marks it deleted and emits a tombstone. The row is retained so the action stays auditable; clients that already have the message drop it on the tombstone.',
  })
  @ApiEnvelopeResponse(ChatMessageDto)
  @ApiErrorResponse(404, 'No such message.')
  async deleteMessage(
    @Param('broadcastId') broadcastId: string,
    @Param('messageId') messageId: string,
    @Body() body: ModerateMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ deleted: true; messageId: string }> {
    const tombstone = await this.chat.deleteMessage(broadcastId, messageId, user, body.reason);
    this.broadcaster.publish(broadcastId, tombstone);

    return { deleted: true, messageId };
  }

  @Post('broadcasts/:broadcastId/chat/mutes')
  @RequirePermissions('chat:moderate')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'broadcastId' })
  @ApiOperation({ summary: 'Mute a user in this chat', description: 'Omit durationMs for an indefinite mute.' })
  @ApiEnvelopeResponse(ChatMessageDto)
  mute(
    @Param('broadcastId') broadcastId: string,
    @Body() body: MuteUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ targetId: string; until: string | null }> {
    return this.chat.muteUser(broadcastId, body.targetId, user, body.durationMs ?? null, body.reason);
  }

  @Delete('broadcasts/:broadcastId/chat/mutes/:targetId')
  @RequirePermissions('chat:moderate')
  @ApiParam({ name: 'broadcastId' })
  @ApiParam({ name: 'targetId' })
  @ApiOperation({
    summary: 'Lift a mute',
    description: 'Recorded as its own action rather than by deleting the mute, so the history survives.',
  })
  @ApiEnvelopeResponse(ChatMessageDto)
  async unmute(
    @Param('broadcastId') broadcastId: string,
    @Param('targetId') targetId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ unmuted: true; targetId: string }> {
    await this.chat.unmuteUser(broadcastId, targetId, user);

    return { unmuted: true, targetId };
  }
}
