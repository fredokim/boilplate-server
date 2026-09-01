import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GraphController } from './graph.controller';
import { GraphService } from './graph.service';
import { TopologyBroadcaster } from './topology/topology.broadcaster';
import { TopologyGateway } from './topology/topology.gateway';
import { TopologyService } from './topology/topology.service';

/**
 * `AuthModule` is imported for `AccessTokenService`: the WebSocket handshake has
 * to verify a token, and the global HTTP guards do not apply to an upgrade
 * request.
 */
@Module({
  imports: [AuthModule],
  controllers: [GraphController],
  providers: [GraphService, TopologyService, TopologyBroadcaster, TopologyGateway],
  exports: [TopologyBroadcaster],
})
export class GraphModule {}
