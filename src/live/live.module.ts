import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatBroadcaster } from './chat/chat.broadcaster';
import { ChatGateway } from './chat/chat.gateway';
import { ChatService } from './chat/chat.service';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';

/** `AuthModule` for `AccessTokenService`: the chat handshake verifies a token. */
@Module({
  imports: [AuthModule],
  controllers: [LiveController],
  providers: [LiveService, ChatService, ChatBroadcaster, ChatGateway],
  exports: [ChatBroadcaster],
})
export class LiveModule {}
