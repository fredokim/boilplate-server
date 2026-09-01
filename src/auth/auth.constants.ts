/**
 * The refresh token never appears in a response body or in browser storage — it
 * lives only in this cookie, which JavaScript cannot read.
 *
 * The `__Host-` prefix is not used: it forbids a `Domain` attribute and requires
 * `Path=/`, and this cookie is deliberately scoped to `/api/auth` so it is not
 * attached to every request in the application.
 */
export const REFRESH_COOKIE_NAME = 'rb_refresh';
