import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { BROADCAST_STATUSES } from '../broadcastState';
import { MAX_HISTORY_PAGE, MAX_MESSAGE_LENGTH } from '../chat/chatMessage';

export class BroadcastDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: BROADCAST_STATUSES }) status!: string;
  @ApiProperty({ enum: ['hls', 'progressive'] }) sourceType!: string;
  @ApiProperty({ description: 'Derived from the stored status, never from the clock.' }) isLive!: boolean;
  @ApiProperty() dvrEnabled!: boolean;
  @ApiPropertyOptional({ nullable: true }) scheduledFor!: string | null;
  @ApiPropertyOptional({ nullable: true }) startedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) endedAt!: string | null;
}

export class PlaybackSourceDto {
  @ApiProperty({ enum: ['hls', 'progressive'] }) kind!: string;
  @ApiProperty({ description: 'Manifest URL. Treated as a secret and never logged.' }) src!: string;
  @ApiPropertyOptional() lowLatency?: boolean;
}

export class PlaybackSessionDto {
  @ApiProperty() sessionId!: string;
  @ApiProperty({ type: PlaybackSourceDto }) source!: PlaybackSourceDto;
  @ApiProperty() isLive!: boolean;
  @ApiProperty() dvrEnabled!: boolean;
  @ApiProperty({ description: 'Short TTL. A leaked URL stops working on its own.' }) expiresAt!: string;
}

export class TransitionBroadcastDto {
  @IsIn(BROADCAST_STATUSES)
  @ApiProperty({ enum: BROADCAST_STATUSES })
  status!: 'scheduled' | 'live' | 'ended';
}

export class ChatHistoryQueryDto {
  /** Sequence cursor, not an offset — an offset shifts under a live chat. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ default: 0 })
  afterSequence?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_HISTORY_PAGE)
  @ApiPropertyOptional({ default: 50, maximum: MAX_HISTORY_PAGE })
  limit?: number;
}

export class SendChatMessageDto {
  /**
   * Supplied by the client so a retry after a timeout is stored once. Unique per
   * broadcast — the uniqueness is what makes the retry idempotent.
   */
  @IsString()
  @Length(1, 128)
  @ApiProperty({
    description:
      'Client-generated id for this send attempt. A retry with the same id returns the stored message rather than posting twice. It never becomes the message id and it never orders anything.',
  })
  clientMessageId!: string;

  @IsString()
  @Length(1, MAX_MESSAGE_LENGTH)
  @ApiProperty({ maxLength: MAX_MESSAGE_LENGTH })
  body!: string;
}

/**
 * A stored message.
 *
 * Three of these fields identify or order it, and they are not interchangeable:
 *
 * - `id` names the stored row. Clients de-duplicate on it.
 * - `clientMessageId` names the *send attempt*. It exists so a retry after a
 *   timeout is stored once, and it orders nothing — it is chosen by a client
 *   that has no idea what anyone else is sending.
 * - `sequence` is the room's order and the resume point.
 *
 * `sentAt` is a fourth number in disguise and orders nothing either.
 */
export class ChatMessageDto {
  @ApiProperty({ description: 'The stored row. Clients de-duplicate on it.' }) id!: string;

  @ApiProperty({
    description: 'The send attempt, chosen by the sender. Makes a retry idempotent; orders nothing.',
  })
  clientMessageId!: string;

  @ApiProperty() broadcastId!: string;

  @ApiProperty({ description: "The room's order. Monotonic per broadcast, and what a reconnect resumes from." })
  sequence!: number;

  @ApiProperty() authorId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ description: 'Empty for a deleted message; the row is retained for audit.' }) body!: string;

  @ApiProperty({
    description:
      'Server clock, for display. The client timestamp is not trusted or stored. Not an order — it is transaction start time, so it can disagree with sequence. Order on sequence.',
  })
  sentAt!: string;

  @ApiProperty() deleted!: boolean;
}

export class ChatHistoryDto {
  @ApiProperty({ type: [ChatMessageDto] }) messages!: ChatMessageDto[];
  @ApiPropertyOptional({ nullable: true, description: 'Null when the page reached the end.' })
  nextCursor!: number | null;
  @ApiProperty() latestSequence!: number;
}

export class ModerateMessageDto {
  @IsOptional()
  @IsString()
  @Length(1, 256)
  @ApiPropertyOptional()
  reason?: string;
}

export class MuteUserDto {
  @IsString()
  @Length(1, 128)
  @ApiProperty()
  targetId!: string;

  /** Omitted means indefinite, which is a decision the moderator makes explicitly. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(86_400_000)
  @ApiPropertyOptional({ description: 'Milliseconds. Omit for an indefinite mute.' })
  durationMs?: number;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  @ApiPropertyOptional()
  reason?: string;
}
