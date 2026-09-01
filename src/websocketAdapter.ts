import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';

/**
 * Selects the plain `ws` adapter rather than the Socket.IO default.
 *
 * The frontend's `WebSocketTopologyTransport` speaks the browser `WebSocket` API,
 * so Socket.IO's framing would require a client library the app does not have.
 *
 * Shared by `main.ts` and `createTestApp` for the same reason the global pipe and
 * filter are module providers: an adapter chosen only in `main.ts` would leave
 * every e2e test running without one, and gateways fail at `app.init()` when
 * none is selected.
 */
export function useWebSocketAdapter(app: INestApplication): void {
  app.useWebSocketAdapter(new WsAdapter(app));
}
