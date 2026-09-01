import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { type ApiSuccessEnvelope, toSuccessEnvelope } from '../contracts/apiEnvelope';

/**
 * Wraps every successful handler return value in the shared envelope, so no
 * controller ever writes `{ success: true }` by hand. A controller returns its
 * domain object and nothing else; the envelope is applied in exactly one place.
 *
 * Failures never reach here — they go to the exception filter, which owns the
 * error half of the same contract.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<TData> implements NestInterceptor<TData, ApiSuccessEnvelope<TData> | TData> {
  intercept(context: ExecutionContext, next: CallHandler<TData>): Observable<ApiSuccessEnvelope<TData> | TData> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        // A handler that already produced an envelope is passed through rather
        // than nested inside a second one. This should not happen, but silently
        // producing `data.data.data` would be far harder to notice than this.
        if (isEnvelopeLike(data)) {
          return data;
        }

        return toSuccessEnvelope(data);
      }),
    );
  }
}

function isEnvelopeLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { success?: unknown }).success === 'boolean';
}
