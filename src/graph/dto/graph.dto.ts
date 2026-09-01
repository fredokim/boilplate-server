import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class GraphPositionDto {
  @IsNumber() @ApiProperty() x!: number;
  @IsNumber() @ApiProperty() y!: number;
}

export class GraphNodeDto {
  @IsString() @Length(1, 128) @ApiProperty() nodeId!: string;
  @IsString() @Length(1, 64) @ApiProperty() type!: string;
  @IsString() @Length(0, 256) @ApiProperty() label!: string;

  @ValidateNested()
  @Type(() => GraphPositionDto)
  @ApiProperty({ type: GraphPositionDto })
  position!: GraphPositionDto;

  /**
   * Open by design — node metadata is application-specific and the frontend types
   * it as `Record<string, unknown>`. The size ceiling in `graphInvariants.ts` is
   * what keeps "open" from meaning "unbounded".
   */
  @IsObject()
  @Type(() => Object)
  @ApiProperty({ type: Object })
  metadata!: Record<string, unknown>;
}

export class GraphEdgeDto {
  @IsString() @Length(1, 128) @ApiProperty() edgeId!: string;
  @IsString() @Length(1, 128) @ApiProperty() sourceNodeId!: string;
  @IsString() @Length(1, 128) @ApiProperty() targetNodeId!: string;

  @IsOptional() @IsString() @Length(0, 256) @ApiPropertyOptional() label?: string;

  @IsObject()
  @Type(() => Object)
  @ApiProperty({ type: Object })
  metadata!: Record<string, unknown>;
}

export class CreateGraphDto {
  @IsString() @Length(1, 128) @ApiProperty() id!: string;
  @IsString() @Length(1, 256) @ApiProperty() title!: string;

  @IsOptional()
  @IsIn(['private', 'shared'])
  @ApiPropertyOptional({ enum: ['private', 'shared'], default: 'private' })
  visibility?: 'private' | 'shared';
}

export class ReplaceGraphContentDto {
  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'The structure version last read. A mismatch answers 409.' })
  expectedVersion!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GraphNodeDto)
  @ApiProperty({ type: [GraphNodeDto] })
  nodes!: GraphNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GraphEdgeDto)
  @ApiProperty({ type: [GraphEdgeDto] })
  edges!: GraphEdgeDto[];
}

export class PublishTopologyEventDto {
  @IsIn(['NODE_STATUS_CHANGED', 'EDGE_STATUS_CHANGED', 'NODE_METRIC_UPDATED', 'EDGE_METRIC_UPDATED'])
  @ApiProperty({ enum: ['NODE_STATUS_CHANGED', 'EDGE_STATUS_CHANGED', 'NODE_METRIC_UPDATED', 'EDGE_METRIC_UPDATED'] })
  type!: 'NODE_STATUS_CHANGED' | 'EDGE_STATUS_CHANGED' | 'NODE_METRIC_UPDATED' | 'EDGE_METRIC_UPDATED';

  @IsString() @Length(1, 128) @ApiProperty() entityId!: string;

  @IsOptional() @IsString() @Length(1, 32) @ApiPropertyOptional() status?: string;

  /** Merged into whatever is already stored — see the note in TopologyService. */
  @IsOptional()
  @IsObject()
  @Type(() => Object)
  @ApiPropertyOptional({ type: Object })
  metrics?: Record<string, number>;
}

export class ResyncQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'The highest sequence the client already applied.' })
  lastSequence!: number;
}

export class GraphSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() ownerId!: string;
  @ApiProperty({ enum: ['private', 'shared'] }) visibility!: 'private' | 'shared';
  @ApiProperty({ description: 'Optimistic lock on the structure.' }) version!: number;
  @ApiProperty({ description: 'Highest runtime event sequence. Unrelated to version.' }) sequence!: number;
  @ApiProperty() nodeCount!: number;
  @ApiProperty() edgeCount!: number;
  @ApiProperty() updatedAt!: string;
}

export class GraphDetailDto extends GraphSummaryDto {
  @ApiProperty({ type: [GraphNodeDto] }) nodes!: GraphNodeDto[];
  @ApiProperty({ type: [GraphEdgeDto] }) edges!: GraphEdgeDto[];
}

export class TopologySnapshotDto {
  @ApiProperty() topologyId!: string;
  @ApiProperty({ description: 'The sequence this snapshot reflects. Subscribe from here.' }) revision!: number;
  @ApiProperty() capturedAt!: number;
  @ApiProperty({ type: Object }) nodes!: Record<string, unknown>;
  @ApiProperty({ type: Object }) edges!: Record<string, unknown>;
}

export class TopologyReplayDto {
  @ApiProperty({ enum: ['up-to-date', 'replay', 'resync'] }) decision!: string;
  @ApiProperty({ type: [Object] }) events!: unknown[];
}
