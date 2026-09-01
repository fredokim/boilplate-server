import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../auth/decorators/auth.decorators';
import type { AuthenticatedUser } from '../auth/types/authenticatedUser';
import { ApiEnvelopeResponse, ApiErrorResponse } from '../common/decorators/apiEnvelope.decorator';
import {
  CreateGraphDto,
  GraphDetailDto,
  GraphSummaryDto,
  PublishTopologyEventDto,
  ReplaceGraphContentDto,
  ResyncQueryDto,
  TopologyReplayDto,
  TopologySnapshotDto,
} from './dto/graph.dto';
import { GraphService } from './graph.service';
import { TopologyBroadcaster } from './topology/topology.broadcaster';
import { TopologyService } from './topology/topology.service';

/**
 * Graph editing and topology runtime are deliberately separate concerns on the
 * same resource.
 *
 * `/graphs/:id` is the structure a person edits, guarded by `graph:read` and
 * `graph:write` and protected by an optimistic version. `/graphs/:id/topology/*`
 * is the runtime state that changes on its own, ordered by a sequence that has
 * nothing to do with the structure version. Sharing one counter would make every
 * metric tick invalidate every open editor.
 */
@ApiTags('graphs')
@ApiBearerAuth('bearer')
@Controller('graphs')
export class GraphController {
  constructor(
    private readonly graphs: GraphService,
    private readonly topology: TopologyService,
    private readonly broadcaster: TopologyBroadcaster,
  ) {}

  @Get()
  @RequirePermissions('graph:read')
  @ApiOperation({ summary: 'List graphs the caller can see' })
  @ApiEnvelopeResponse(GraphSummaryDto)
  list(@CurrentUser() user: AuthenticatedUser): Promise<GraphSummaryDto[]> {
    return this.graphs.list(user);
  }

  @Post()
  @RequirePermissions('graph:write')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an empty graph' })
  @ApiEnvelopeResponse(GraphDetailDto, { status: 201 })
  @ApiErrorResponse(409, 'A graph with that id already exists.')
  create(@Body() body: CreateGraphDto, @CurrentUser() user: AuthenticatedUser): Promise<GraphDetailDto> {
    return this.graphs.create(user, body.id, body.title, body.visibility ?? 'private');
  }

  @Get(':graphId')
  @RequirePermissions('graph:read')
  @ApiParam({ name: 'graphId' })
  @ApiOperation({
    summary: 'Read a graph with its nodes and edges',
    description: 'A graph the caller may not see answers 404, never 403.',
  })
  @ApiEnvelopeResponse(GraphDetailDto)
  @ApiErrorResponse(404, 'No such graph, or not visible to the caller.')
  findOne(@Param('graphId') graphId: string, @CurrentUser() user: AuthenticatedUser): Promise<GraphDetailDto> {
    return this.graphs.findVisible(graphId, user);
  }

  @Put(':graphId/content')
  @RequirePermissions('graph:write')
  @ApiParam({ name: 'graphId' })
  @ApiOperation({
    summary: 'Replace every node and edge',
    description:
      'Atomic. Invariants are checked before the transaction opens, so an invalid edge costs nothing and names itself.',
  })
  @ApiEnvelopeResponse(GraphDetailDto)
  @ApiErrorResponse(403, 'The caller can see the graph but does not own it.')
  @ApiErrorResponse(409, 'The structure changed since it was read.')
  @ApiErrorResponse(422, 'A dangling endpoint, a self-loop, or a duplicate edge.')
  replaceContent(
    @Param('graphId') graphId: string,
    @Body() body: ReplaceGraphContentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GraphDetailDto> {
    return this.graphs.replaceContent(graphId, user, body.expectedVersion, body.nodes, body.edges);
  }

  @Delete(':graphId')
  @RequirePermissions('graph:write')
  @ApiParam({ name: 'graphId' })
  @ApiOperation({ summary: 'Delete a graph, its content, and its events' })
  @ApiEnvelopeResponse(GraphSummaryDto)
  @ApiErrorResponse(404, 'No such graph.')
  async remove(
    @Param('graphId') graphId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ deleted: true; id: string }> {
    await this.graphs.remove(graphId, user);
    return { deleted: true, id: graphId };
  }

  @Get(':graphId/topology/snapshot')
  @RequirePermissions('graph:read')
  @ApiParam({ name: 'graphId' })
  @ApiOperation({
    summary: 'Current runtime state',
    description:
      'Read directly from runtime rows, not folded from events. `revision` is the sequence the snapshot reflects — subscribe from it.',
  })
  @ApiEnvelopeResponse(TopologySnapshotDto)
  @ApiErrorResponse(404, 'No such graph.')
  async snapshot(
    @Param('graphId') graphId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TopologySnapshotDto> {
    // Visibility first: the snapshot query itself does not check it.
    await this.graphs.findVisible(graphId, user);
    return this.topology.snapshot(graphId);
  }

  @Get(':graphId/topology/resync')
  @RequirePermissions('graph:read')
  @ApiParam({ name: 'graphId' })
  @ApiOperation({
    summary: 'Events missed since a sequence',
    description:
      'The HTTP counterpart of the WebSocket replay. Answers `resync` when the gap is older than the retained window, which means the client must take a fresh snapshot rather than assume continuity.',
  })
  @ApiEnvelopeResponse(TopologyReplayDto)
  @ApiErrorResponse(404, 'No such graph.')
  async resync(
    @Param('graphId') graphId: string,
    @Query() query: ResyncQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TopologyReplayDto> {
    await this.graphs.findVisible(graphId, user);
    const { decision, events } = await this.topology.replayFor(graphId, query.lastSequence);

    return { decision: decision.kind, events };
  }

  @Post(':graphId/topology/events')
  @RequirePermissions('graph:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam({ name: 'graphId' })
  @ApiOperation({
    summary: 'Publish a runtime event',
    description:
      'Allocates a sequence, stores the event, updates runtime state, and fans it out — the first three in one transaction. Exists so a monitoring agent can feed the stream; the UI only reads.',
  })
  @ApiEnvelopeResponse(TopologyReplayDto, { status: 202 })
  @ApiErrorResponse(404, 'No such graph.')
  async publish(
    @Param('graphId') graphId: string,
    @Body() body: PublishTopologyEventDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ eventId: string; sequence: number }> {
    await this.graphs.findVisible(graphId, user);

    const event = await this.topology.publish({
      graphId,
      type: body.type,
      entityId: body.entityId,
      payload: { ...(body.status ? { status: body.status } : {}), ...(body.metrics ? { metrics: body.metrics } : {}) },
    });

    // Fan-out happens after the transaction commits. Publishing inside it would
    // let a subscriber see an event that a rollback then un-happened.
    this.broadcaster.publish(graphId, event);

    // Pruning is driven by writes rather than a timer: a graph nobody writes to
    // needs none, and a timer would hold the process awake for it.
    await this.topology.prune(graphId);

    return { eventId: event.eventId, sequence: event.sequence };
  }
}
