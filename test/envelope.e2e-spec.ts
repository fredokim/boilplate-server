import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsString, Min, ValidateNested } from 'class-validator';
import request from 'supertest';
import { ErrorCode } from '../src/common/contracts/errorCode';
import { AppException } from '../src/common/exceptions/appException';
import { Public } from '../src/auth/decorators/auth.decorators';
import { createTestApp, httpServer } from './createTestApp';

/**
 * A probe controller, mounted only for this suite.
 *
 * The envelope and validation behaviour has to be proven over a real HTTP round
 * trip, but proving it should not force a domain route into the shipped API just
 * to have something to POST at. This controller exists for the duration of the
 * test and exercises the same global pipe, interceptor, and filter as every real
 * route will.
 */
class ProfileDto {
  @IsString()
  @IsNotEmpty()
  displayName!: string;

  @IsInt()
  @Min(0)
  age!: number;
}

class ProbeDto {
  @IsEmail()
  email!: string;

  @ValidateNested()
  @Type(() => ProfileDto)
  profile!: ProfileDto;
}

/**
 * Public: this suite is about the envelope, not about authentication. Every route
 * is guarded by default now, so without this the whole file would assert 401.
 * The one route that proves that default is `GuardedProbeController` below.
 */
@Public()
@Controller('probe')
class ProbeController {
  @Get()
  read() {
    return { id: 'probe-1', nested: { ok: true } };
  }

  @Post()
  create(@Body() body: ProbeDto) {
    return { email: body.email, displayName: body.profile.displayName };
  }

  @Get('boom')
  boom(): never {
    throw new Error('database exploded at postgres://user:hunter2@db:5432');
  }

  @Get('teapot')
  teapot(): never {
    throw AppException.notFound('Probe not found.', { probeId: 'probe-9' });
  }
}

/**
 * Carries no `@Public()`, so it inherits the global authentication guard. It
 * exists to prove that the default is "protected" — a regression that flipped it
 * would leave every other test in this file passing.
 */
@Controller('guarded-probe')
class GuardedProbeController {
  @Get()
  read() {
    return { reached: true };
  }
}

describe('API envelope (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController, GuardedProbeController] });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('success', () => {
    it('wraps a handler result in the success envelope', async () => {
      const response = await request(httpServer(app)).get('/api/probe').expect(200);

      expect(response.body).toEqual({ success: true, data: { id: 'probe-1', nested: { ok: true } } });
    });

    it('accepts and transforms a valid body', async () => {
      const response = await request(httpServer(app))
        .post('/api/probe')
        .send({ email: 'user@example.com', profile: { displayName: 'Ada', age: 36 } })
        .expect(201);

      expect(response.body).toEqual({ success: true, data: { email: 'user@example.com', displayName: 'Ada' } });
    });
  });

  describe('validation', () => {
    it('returns VALIDATION_ERROR with per-field messages', async () => {
      const response = await request(httpServer(app))
        .post('/api/probe')
        .send({ email: 'not-an-email', profile: { displayName: '', age: -1 } })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: ErrorCode.VALIDATION_ERROR, message: 'Request validation failed.' },
      });

      const fields = (response.body as { error: { details: { fields: Record<string, string[]> } } }).error.details
        .fields;

      expect(fields.email).toEqual(expect.arrayContaining([expect.stringContaining('email')]));
      expect(fields['profile.displayName']).toBeDefined();
      expect(fields['profile.age']).toBeDefined();
    });

    it('rejects a property the DTO never declared rather than dropping it', async () => {
      const response = await request(httpServer(app))
        .post('/api/probe')
        .send({ email: 'user@example.com', profile: { displayName: 'Ada', age: 36 }, isAdmin: true })
        .expect(400);

      expect(response.body).toMatchObject({ error: { code: ErrorCode.VALIDATION_ERROR } });
      expect(JSON.stringify(response.body)).toContain('isAdmin');
    });
  });

  describe('errors', () => {
    it('returns the standard envelope for an unmatched route', async () => {
      const response = await request(httpServer(app)).get('/api/does-not-exist').expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: ErrorCode.NOT_FOUND },
      });
      expect(response.body).toHaveProperty('success', false);
    });

    it('carries an AppException code and details through unchanged', async () => {
      const response = await request(httpServer(app)).get('/api/probe/teapot').expect(404);

      expect(response.body).toEqual({
        success: false,
        error: { code: ErrorCode.NOT_FOUND, message: 'Probe not found.', details: { probeId: 'probe-9' } },
      });
    });

    it('turns an unhandled error into a generic 500', async () => {
      const response = await request(httpServer(app)).get('/api/probe/boom').expect(500);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred.' },
      });
    });

    it('protects a route that did not opt out, with the code the frontend expects', async () => {
      const response = await request(httpServer(app)).get('/api/guarded-probe').expect(401);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: ErrorCode.AUTH_REQUIRED },
      });
    });

    it('attaches a request id to an error response too', async () => {
      const response = await request(httpServer(app)).get('/api/does-not-exist').expect(404);

      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
