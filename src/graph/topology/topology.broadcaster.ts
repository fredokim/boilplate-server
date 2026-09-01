import { Injectable } from '@nestjs/common';
import type { TopologyRealtimeEvent } from './topologyEvent';

type Listener = (graphId: string, event: TopologyRealtimeEvent) => void;

/**
 * The seam between publishing an event and delivering it.
 *
 * Today it is an in-process emitter, which is correct for one instance and wrong
 * for several: an event published on instance A never reaches a client connected
 * to instance B. That is the whole reason this indirection exists rather than the
 * service calling the gateway directly — swapping in a Redis pub/sub adapter is a
 * replacement of this class and nothing else.
 *
 * Redis is deliberately not introduced in this step. What is introduced is the
 * place it goes.
 */
@Injectable()
export class TopologyBroadcaster {
  private readonly listeners = new Set<Listener>();

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(graphId: string, event: TopologyRealtimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(graphId, event);
      } catch {
        // One failing subscriber must not stop the others from being told.
      }
    }
  }
}
