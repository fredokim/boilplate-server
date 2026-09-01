/**
 * The wire contract shared with the frontend. `API_CONTRACT.md` at the repository
 * root is the authority; these types exist so the server cannot drift from it
 * silently.
 *
 * The frontend parses every response through `createApiEnvelopeDto`, whose
 * `ApiErrorDto` declares only `code` and `message`. It validates with
 * `whitelist: true`, so any extra key on the error object is stripped rather than
 * rejected. That is what makes `details` safe to send: clients that model it can
 * read it, and the current frontend quietly ignores it.
 */

export type ApiSuccessEnvelope<TData> = {
  success: true;
  data: TData;
};

export type ApiErrorBody = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ApiErrorEnvelope = {
  success: false;
  error: ApiErrorBody;
};

export type ApiEnvelope<TData> = ApiSuccessEnvelope<TData> | ApiErrorEnvelope;

export function toSuccessEnvelope<TData>(data: TData): ApiSuccessEnvelope<TData> {
  return { success: true, data };
}

export function toErrorEnvelope(error: ApiErrorBody): ApiErrorEnvelope {
  // `details` is omitted rather than sent as undefined so the JSON body carries
  // exactly the documented shape when there is nothing to add.
  const body: ApiErrorBody =
    error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };

  return { success: false, error: body };
}

/** Set on every response, and on every log line, so the two can be joined. */
export const REQUEST_ID_HEADER = 'x-request-id';
