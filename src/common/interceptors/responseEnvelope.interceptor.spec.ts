import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from './responseEnvelope.interceptor';

function httpContext(type: 'http' | 'rpc' = 'http'): ExecutionContext {
  return { getType: () => type } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) } as CallHandler;
}

describe('ResponseEnvelopeInterceptor', () => {
  const interceptor = new ResponseEnvelopeInterceptor();

  it('wraps a handler return value in the success envelope', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(httpContext(), handlerReturning({ id: 'node-1', status: 'up' })),
    );

    expect(result).toEqual({ success: true, data: { id: 'node-1', status: 'up' } });
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['zero', 0],
    ['false', false],
  ])('wraps %s rather than treating it as an absent body', async (_label, value) => {
    const result = await firstValueFrom(interceptor.intercept(httpContext(), handlerReturning(value)));

    expect(result).toEqual({ success: true, data: value });
  });

  it('wraps arrays as data rather than spreading them', async () => {
    const result = await firstValueFrom(interceptor.intercept(httpContext(), handlerReturning([1, 2, 3])));

    expect(result).toEqual({ success: true, data: [1, 2, 3] });
  });

  it('does not nest an envelope inside another envelope', async () => {
    const alreadyWrapped = { success: true, data: { id: 'node-1' } };

    const result = await firstValueFrom(interceptor.intercept(httpContext(), handlerReturning(alreadyWrapped)));

    expect(result).toBe(alreadyWrapped);
  });

  it('leaves non-http contexts untouched', async () => {
    const result = await firstValueFrom(interceptor.intercept(httpContext('rpc'), handlerReturning({ raw: true })));

    expect(result).toEqual({ raw: true });
  });
});
