// Reports contain only fixed labels and numeric status codes, never raw stderr.
export const DIAGNOSTICS_REVISION = 'native-diagnostics-2';
const events = new Set(['connect_initialization_failed', 'client_token_failed', 'access_token_failed', 'network_error',
  'tls_error', 'dns_error', 'audio_key_rejected', 'track_unavailable', 'authentication_rejected',
  'player_shutdown', 'reconnect_limit', 'panic', 'unclassified_error']);
const kinds = new Map([
  ['PermissionDenied', /PermissionDenied|Permission denied|Forbidden/i],
  ['Unauthenticated', /Unauthenticated|No valid authentication credentials|Unauthorized/i],
  ['Unavailable', /\bUnavailable\b|Service unavailable/i],
  ['InvalidArgument', /InvalidArgument|Client specified an invalid argument/i],
  ['FailedPrecondition', /FailedPrecondition|Invalid state/i],
  ['DeadlineExceeded', /DeadlineExceeded|Deadline expired/i],
  ['ResourceExhausted', /ResourceExhausted|Resource has been exhausted/i],
  ['NotFound', /NotFound|Requested entity was not found/i],
  ['Internal', /\bInternal error\b|kind:\s*Internal/i],
]);
const signals = new Set(['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGSEGV', 'SIGTERM']);
const osCodes = new Set(['ENOENT', 'EACCES', 'ENOMEM', 'EMFILE', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']);
const reasons = new Map([
  ['invalid_credentials', /INVALID_CREDENTIALS/i], ['bad_credentials', /BAD_CREDENTIALS|BadCredentials/i],
  ['invalid_client', /INVALID_CLIENT|UNKNOWN_CLIENT/i], ['token_expired', /TOKEN_EXPIRED|expired access token|access token expired/i],
  ['invalid_scope', /INVALID_SCOPE|insufficient.scope/i], ['premium_required', /PREMIUM_REQUIRED|premium.*required/i],
  ['hashcash_challenge_failed', /Unable to solve.*hash cash|Unable to decode hash cash|No challenges found/i],
]);

export function classifyNativeLine(line) {
  if (/Authenticated as/i.test(line)) return null;
  if (!/\bERROR\b|panic|failed|could not|unable|error|unavailable|denied|refused|timed out|invalid/i.test(line)) return null;
  let event = 'unclassified_error';
  if (/client[ _-]?token/i.test(line)) event = 'client_token_failed';
  else if (/access[ _-]?token|login5|keymaster/i.test(line)) event = 'access_token_failed';
  else if (/could not initialize spirc/i.test(line)) event = 'connect_initialization_failed';
  else if (/AudioKeyError|audio key|Unable to load key/i.test(line)) event = 'audio_key_rejected';
  else if (/Unable to read audio file|Skipping to next track, unable to load/i.test(line)) event = 'track_unavailable';
  else if (/BadCredentials|Login failed|Authentication failed/i.test(line)) event = 'authentication_rejected';
  else if (/Spirc shut down too often/i.test(line)) event = 'reconnect_limit';
  else if (/Player shut down unexpectedly/i.test(line)) event = 'player_shutdown';
  else if (/panicked|panic/i.test(line)) event = 'panic';
  else if (/dns|name resolution|resolve.*host|ENOTFOUND/i.test(line)) event = 'dns_error';
  else if (/tls|ssl|certificate/i.test(line)) event = 'tls_error';
  else if (/connection|\bconnect\b|network|timed out|timeout|ECONNREFUSED|ETIMEDOUT/i.test(line)) event = 'network_error';
  const result = { event };
  for (const [kind, pattern] of kinds) if (pattern.test(line)) { result.errorKind = kind; break; }
  const status = line.match(/\b(?:status(?:[ _-]code)?|http(?:\/\d(?:\.\d)?)?|error)\s*[:=]?\s*([45]\d{2})\b/i);
  if (status) result.httpStatus = Number(status[1]);
  for (const code of osCodes) if (new RegExp(`\\b${code}\\b`).test(line)) { result.osErrorCode = code; break; }
  for (const [reason, pattern] of reasons) if (pattern.test(line)) { result.reason = reason; break; }
  return result;
}

export function nativeFailureCode(line, event) {
  if (/panicked|panic/i.test(line)) return 'native_player_panicked';
  if (/Spirc shut down too often/i.test(line)) return 'native_connect_reconnect_failed';
  if (/Player shut down unexpectedly/i.test(line)) return 'native_player_shutdown';
  if (!/could not initialize spirc/i.test(line)) return null;
  if (event?.event === 'client_token_failed') return 'spotify_client_token_failed';
  if (event?.event === 'access_token_failed') return 'spotify_access_token_failed';
  return 'native_connect_initialization_failed';
}

export function processExit(code, signal) {
  return { code: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null, signal: signals.has(signal) ? signal : null };
}

export function safeDiagnostics(input) {
  if (!input || typeof input !== 'object' || input.revision !== DIAGNOSTICS_REVISION) return undefined;
  const safe = { revision: DIAGNOSTICS_REVISION, events: [] };
  for (const key of ['nativeExit', 'encoderExit']) if (input[key]) safe[key] = processExit(input[key].code, input[key].signal);
  if (Array.isArray(input.events)) for (const entry of input.events.slice(-12)) {
    if (!entry || !events.has(entry.event)) continue;
    const item = { event: entry.event };
    if (kinds.has(entry.errorKind)) item.errorKind = entry.errorKind;
    if (Number.isInteger(entry.httpStatus) && entry.httpStatus >= 400 && entry.httpStatus <= 599) item.httpStatus = entry.httpStatus;
    if (osCodes.has(entry.osErrorCode)) item.osErrorCode = entry.osErrorCode;
    if (reasons.has(entry.reason)) item.reason = entry.reason;
    safe.events.push(item);
  }
  return safe;
}
