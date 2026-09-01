import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ErrorCode } from '../src/common/contracts/errorCode';
import { createTestApp, httpServer } from './createTestApp';
import { type AuthFixtures, seedAuthFixtures } from './authFixtures';

const LIVE_ID = 'bc-live';
const SCHEDULED_ID = 'bc-scheduled';
const ENDED_ID = 'bc-ended';
const MANIFEST = 'https://cdn.example.com/secret-manifest.m3u8';

describe('Live and chat (e2e)', () => {
  let app: INestApplication;
  let fixtures: AuthFixtures;

  async function auth(email = 'demo@example.com'): Promise<{ Authorization: string }> {
    const login = await request(httpServer(app))
      .post('/api/auth/login')
      .send({ email, password: 'demo-password' })
      .expect(200);

    return { Authorization: `Bearer ${(login.body as { data: { accessToken: string } }).data.accessToken}` };
  }

  beforeEach(async () => {
    fixtures = seedAuthFixtures();

    fixtures.prisma.addBroadcast({ id: LIVE_ID, title: 'Launch stream', status: 'live', manifestUrl: MANIFEST });
    fixtures.prisma.addBroadcast({ id: SCHEDULED_ID, title: 'Next week', status: 'scheduled' });
    fixtures.prisma.addBroadcast({ id: ENDED_ID, title: 'Yesterday', status: 'ended' });

    app = await createTestApp({ prisma: fixtures.prisma });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('broadcast metadata', () => {
    it('401s without a token', async () => {
      await request(httpServer(app)).get(`/api/live/broadcasts/${LIVE_ID}`).expect(401);
    });

    /**
     * The manifest URL is a capability: anyone holding it can play the stream.
     * Returning it with the metadata would make it permanent and unrevocable.
     */
    it('never returns the manifest URL with the metadata', async () => {
      const response = await request(httpServer(app))
        .get(`/api/live/broadcasts/${LIVE_ID}`)
        .set(await auth())
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(MANIFEST);
      expect(response.body).toMatchObject({ data: { id: LIVE_ID, status: 'live', isLive: true } });
    });

    it('reports isLive from the stored status, not the clock', async () => {
      const headers = await auth();

      const scheduled = await request(httpServer(app))
        .get(`/api/live/broadcasts/${SCHEDULED_ID}`)
        .set(headers)
        .expect(200);
      const ended = await request(httpServer(app)).get(`/api/live/broadcasts/${ENDED_ID}`).set(headers).expect(200);

      expect(scheduled.body).toMatchObject({ data: { isLive: false } });
      expect(ended.body).toMatchObject({ data: { isLive: false } });
    });

    it('404s an unknown broadcast', async () => {
      const response = await request(httpServer(app))
        .get('/api/live/broadcasts/nope')
        .set(await auth())
        .expect(404);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.BROADCAST_NOT_FOUND } });
    });
  });

  describe('playback sessions', () => {
    it('issues the manifest URL with an expiry for a live broadcast', async () => {
      const response = await request(httpServer(app))
        .post(`/api/live/broadcasts/${LIVE_ID}/playback-session`)
        .set(await auth())
        .expect(201);

      expect(response.body).toMatchObject({
        data: { source: { kind: 'hls', src: MANIFEST }, isLive: true, dvrEnabled: true },
      });
      expect((response.body as { data: { expiresAt: string } }).data.expiresAt).toBeTruthy();
    });

    /**
     * A scheduled broadcast has no stream yet and an ended one has none any more.
     * Issuing a URL for either would produce a player failing with a manifest
     * error rather than a clear reason.
     */
    it.each([
      ['a scheduled broadcast', SCHEDULED_ID],
      ['an ended broadcast', ENDED_ID],
    ])('refuses playback for %s', async (_label, broadcastId) => {
      const response = await request(httpServer(app))
        .post(`/api/live/broadcasts/${broadcastId}/playback-session`)
        .set(await auth())
        .expect(409);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.BROADCAST_NOT_PLAYABLE } });
    });
  });

  describe('status transitions', () => {
    it('requires live:manage', async () => {
      await request(httpServer(app))
        .post(`/api/live/broadcasts/${SCHEDULED_ID}/status`)
        .set(await auth('viewer@example.com'))
        .send({ status: 'live' })
        .expect(403);
    });

    it('moves scheduled to live and records the start', async () => {
      const response = await request(httpServer(app))
        .post(`/api/live/broadcasts/${SCHEDULED_ID}/status`)
        .set(await auth())
        .send({ status: 'live' })
        .expect(200);

      expect(response.body).toMatchObject({ data: { status: 'live', isLive: true } });
      expect((response.body as { data: { startedAt: string | null } }).data.startedAt).not.toBeNull();
    });

    /** An operator double-click, or a retried request, must not fail. */
    it('is idempotent', async () => {
      const headers = await auth();

      await request(httpServer(app))
        .post(`/api/live/broadcasts/${LIVE_ID}/status`)
        .set(headers)
        .send({ status: 'live' })
        .expect(200);
    });

    it('refuses to reopen an ended broadcast', async () => {
      const response = await request(httpServer(app))
        .post(`/api/live/broadcasts/${ENDED_ID}/status`)
        .set(await auth())
        .send({ status: 'live' })
        .expect(409);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.BROADCAST_INVALID_TRANSITION } });
    });
  });

  describe('chat', () => {
    async function send(headers: Record<string, string>, body: Record<string, unknown>, expected = 201) {
      return request(httpServer(app))
        .post(`/api/live/broadcasts/${LIVE_ID}/chat/messages`)
        .set(headers)
        .send(body)
        .expect(expected);
    }

    it('stores a message with a server sequence and timestamp', async () => {
      const response = await send(await auth(), { clientMessageId: 'c-1', body: 'hello' });

      expect(response.body).toMatchObject({
        data: { sequence: 1, body: 'hello', displayName: 'Demo Maker', deleted: false },
      });
    });

    /**
     * The property a retry depends on: the same client id returns the message
     * that was already stored rather than posting a second one.
     */
    it('is idempotent on clientMessageId', async () => {
      const headers = await auth();

      const first = await send(headers, { clientMessageId: 'c-1', body: 'hello' });
      const second = await send(headers, { clientMessageId: 'c-1', body: 'hello again' });

      expect((second.body as { data: { id: string } }).data.id).toBe(
        (first.body as { data: { id: string } }).data.id,
      );
      // The body of the stored message wins — a retry does not edit it.
      expect((second.body as { data: { body: string } }).data.body).toBe('hello');
      expect(fixtures.prisma.allChatMessages()).toHaveLength(1);
    });

    it('assigns strictly increasing sequences', async () => {
      const headers = await auth();

      for (let i = 0; i < 5; i += 1) await send(headers, { clientMessageId: `c-${String(i)}`, body: `m${String(i)}` });

      const sequences = fixtures.prisma.allChatMessages().map((row) => row.sequence);
      expect(sequences).toEqual([1, 2, 3, 4, 5]);
    });

    it('requires chat:write to post', async () => {
      await request(httpServer(app))
        .post(`/api/live/broadcasts/${LIVE_ID}/chat/messages`)
        .set(await auth('viewer@example.com'))
        .send({ clientMessageId: 'c-1', body: 'hi' })
        .expect(403);
    });

    /** History stays readable after a broadcast ends; only writing closes. */
    it('refuses to post to an ended broadcast but still serves its history', async () => {
      const headers = await auth();

      const refused = await request(httpServer(app))
        .post(`/api/live/broadcasts/${ENDED_ID}/chat/messages`)
        .set(headers)
        .send({ clientMessageId: 'c-1', body: 'hi' })
        .expect(409);

      expect(refused.body).toMatchObject({ error: { code: ErrorCode.CHAT_CLOSED } });

      await request(httpServer(app)).get(`/api/live/broadcasts/${ENDED_ID}/chat/messages`).set(headers).expect(200);
    });

    it('rejects an empty or oversized body', async () => {
      const headers = await auth();

      await send(headers, { clientMessageId: 'c-1', body: '   ' }, 400);
      await send(headers, { clientMessageId: 'c-2', body: 'x'.repeat(501) }, 400);
    });

    it('throttles a sender who posts too quickly', async () => {
      const headers = await auth();

      for (let i = 0; i < 10; i += 1) await send(headers, { clientMessageId: `c-${String(i)}`, body: 'spam' });

      const throttled = await send(headers, { clientMessageId: 'c-over', body: 'spam' }, 429);
      expect(throttled.body).toMatchObject({ error: { code: ErrorCode.CHAT_RATE_LIMITED } });
    });

    describe('history', () => {
      it('paginates by sequence and reports the end of the page', async () => {
        const headers = await auth();
        for (let i = 0; i < 5; i += 1) await send(headers, { clientMessageId: `c-${String(i)}`, body: `m${String(i)}` });

        const page = await request(httpServer(app))
          .get(`/api/live/broadcasts/${LIVE_ID}/chat/messages?afterSequence=2&limit=2`)
          .set(headers)
          .expect(200);

        const body = page.body as { data: { messages: { sequence: number }[]; nextCursor: number | null; latestSequence: number } };
        expect(body.data.messages.map((message) => message.sequence)).toEqual([3, 4]);
        expect(body.data.nextCursor).toBe(4);
        expect(body.data.latestSequence).toBe(5);
      });

      it('reports a null cursor once the page reaches the end', async () => {
        const headers = await auth();
        await send(headers, { clientMessageId: 'c-1', body: 'only' });

        const page = await request(httpServer(app))
          .get(`/api/live/broadcasts/${LIVE_ID}/chat/messages?limit=50`)
          .set(headers)
          .expect(200);

        expect(page.body).toMatchObject({ data: { nextCursor: null } });
      });

      it('caps the page size', async () => {
        await request(httpServer(app))
          .get(`/api/live/broadcasts/${LIVE_ID}/chat/messages?limit=5000`)
          .set(await auth())
          .expect(400);
      });
    });

    describe('moderation', () => {
      it('requires chat:moderate', async () => {
        const headers = await auth();
        const sent = await send(headers, { clientMessageId: 'c-1', body: 'hello' });
        const messageId = (sent.body as { data: { id: string } }).data.id;

        await request(httpServer(app))
          .delete(`/api/live/broadcasts/${LIVE_ID}/chat/messages/${messageId}`)
          .set(await auth('viewer@example.com'))
          .send({})
          .expect(403);
      });

      /**
       * The row is retained so the action stays auditable; what a client sees is
       * an empty body and a deleted flag.
       */
      it('keeps the row but stops serving the body', async () => {
        const headers = await auth();
        const sent = await send(headers, { clientMessageId: 'c-1', body: 'remove me' });
        const messageId = (sent.body as { data: { id: string } }).data.id;

        await request(httpServer(app))
          .delete(`/api/live/broadcasts/${LIVE_ID}/chat/messages/${messageId}`)
          .set(headers)
          .send({ reason: 'spam' })
          .expect(200);

        const history = await request(httpServer(app))
          .get(`/api/live/broadcasts/${LIVE_ID}/chat/messages`)
          .set(headers)
          .expect(200);

        const messages = (history.body as { data: { messages: { body: string; deleted: boolean }[] } }).data.messages;
        expect(messages[0]).toMatchObject({ body: '', deleted: true });
        // Retained for audit.
        expect(fixtures.prisma.allChatMessages()[0]?.body).toBe('remove me');
      });

      it('is idempotent when deleting twice', async () => {
        const headers = await auth();
        const sent = await send(headers, { clientMessageId: 'c-1', body: 'remove me' });
        const messageId = (sent.body as { data: { id: string } }).data.id;
        const url = `/api/live/broadcasts/${LIVE_ID}/chat/messages/${messageId}`;

        await request(httpServer(app)).delete(url).set(headers).send({}).expect(200);
        await request(httpServer(app)).delete(url).set(headers).send({}).expect(200);
      });

      it('mutes a user, then lets an unmute restore them', async () => {
        const moderator = await auth();
        const target = fixtures.prisma.userByEmail('demo@example.com');

        await request(httpServer(app))
          .post(`/api/live/broadcasts/${LIVE_ID}/chat/mutes`)
          .set(moderator)
          .send({ targetId: target.id, reason: 'spam' })
          .expect(200);

        const blocked = await send(moderator, { clientMessageId: 'c-1', body: 'hi' }, 403);
        expect(blocked.body).toMatchObject({ error: { code: ErrorCode.CHAT_USER_MUTED } });

        await request(httpServer(app))
          .delete(`/api/live/broadcasts/${LIVE_ID}/chat/mutes/${target.id}`)
          .set(moderator)
          .expect(200);

        await send(moderator, { clientMessageId: 'c-2', body: 'back' }, 201);
      });
    });
  });
});
