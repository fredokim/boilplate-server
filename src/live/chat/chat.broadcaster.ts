import { Injectable } from '@nestjs/common';
import type { ChatMessageView, ChatTombstone } from './chat.service';

export type ChatEvent = { kind: 'message'; message: ChatMessageView } | ChatTombstone;

type Listener = (broadcastId: string, event: ChatEvent) => void;

/**
 * The same seam as `TopologyBroadcaster`, for the same reason: in-process today,
 * and the single class a Redis adapter would replace. An event published on one
 * instance does not reach a client connected to another, and that is stated
 * rather than hidden.
 */
@Injectable()
export class ChatBroadcaster {
  private readonly listeners = new Set<Listener>();

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(broadcastId: string, event: ChatEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(broadcastId, event);
      } catch {
        // One failing subscriber must not stop the others being told.
      }
    }
  }
}
