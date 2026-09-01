/**
 * Header and field names that must never reach a log sink. Logs are routinely
 * shipped to third parties and kept far longer than the credentials they would
 * otherwise contain.
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-refresh-token',
]);

const SENSITIVE_FIELDS = new Set([
  'password',
  'passwordconfirmation',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'clientsecret',
  'apikey',
  'authorization',
  'cookie',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
]);

export const REDACTED = '[REDACTED]';

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

export function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELDS.has(name.toLowerCase().replace(/[-_]/g, ''));
}

/**
 * Returns a copy of the headers with sensitive values replaced. The original is
 * never mutated — the request object keeps its real headers for handlers.
 */
export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(headers)) {
    safe[name] = isSensitiveHeader(name) ? REDACTED : value;
  }

  return safe;
}

/**
 * Depth-limited redaction for arbitrary payloads. The depth cap keeps a
 * pathological or cyclic object from turning a log call into a hang.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }

  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    safe[key] = isSensitiveField(key) ? REDACTED : redactValue(item, depth + 1);
  }

  return safe;
}
