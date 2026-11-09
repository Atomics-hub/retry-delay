export const MAX_DELAY_MS = 2_147_483_647;

const UNITS = {h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, 'µs': 0.001, 'μs': 0.001, ns: 0.000001};
const DURATION = /^(?:\d+(?:\.\d+)?|\.\d+)(?:h|ms|m|s|us|µs|μs|ns)(?:(?:\d+(?:\.\d+)?|\.\d+)(?:h|ms|m|s|us|µs|μs|ns))*$/;
const DURATION_PART = /(\d+(?:\.\d+)?|\.\d+)(h|ms|m|s|us|µs|μs|ns)/g;
const NUMBER = /^\d+(?:\.\d+)?$/;
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE = /^[A-Z][a-z]{5,8}, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const TEXT_HINT = /\b(?:try again|retry)(?: (?:in|after))? ((?:(?:\d+(?:\.\d+)?|\.\d+)(?:h|ms|m|s)(?![a-z]))+|\d+(?:\.\d+)? ?(?:milliseconds?|seconds?|secs?|minutes?|mins?|hours?)\b)/i;
const TEXT_UNITS = {millisecond: 1, second: 1000, sec: 1000, minute: 60_000, min: 60_000, hour: 3_600_000};

export function parseDuration(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!DURATION.test(text)) return undefined;
  let ms = 0;
  for (const [, amount, unit] of text.matchAll(DURATION_PART)) ms += Number(amount) * UNITS[unit];
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseRetryAfter(value, now = Date.now()) {
  const text = first(value)?.trim();
  if (!text) return undefined;
  if (NUMBER.test(text)) return clamp(Number(text) * 1000);
  const at = parseHttpDate(text);
  return at === undefined || at < now ? undefined : clamp(at - now);
}

export function retryDelay(input, options = {}) {
  const now = options.now ?? Date.now();
  const {sources, status, bodies, messages} = collect(input, options);

  for (const source of sources) {
    const retryAfterMs = first(readHeader(source, 'retry-after-ms'))?.trim();
    if (retryAfterMs && NUMBER.test(retryAfterMs)) return clamp(Number(retryAfterMs));
    const retryAfter = parseRetryAfter(readHeader(source, 'retry-after'), now);
    if (retryAfter !== undefined) return retryAfter;
  }

  for (const body of bodies) {
    const fromBody = delayFromBody(body);
    if (fromBody !== undefined) return clamp(fromBody);
  }

  for (const source of sources) {
    const fromReset = delayFromResetHeaders((name) => readHeader(source, name), status, now);
    if (fromReset !== undefined) return clamp(fromReset);
  }

  for (const message of messages) {
    const fromText = delayFromText(message);
    if (fromText !== undefined) return clamp(fromText);
  }
  return undefined;
}

function collect(input, options) {
  const sources = [];
  let status = options.status;
  const bodies = options.body === undefined ? [] : [options.body];
  const messages = [];
  const seen = new Set();
  const queue = [input];
  while (queue.length && seen.size < 8) {
    const current = queue.shift();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (isHeaderBag(current)) {
      sources.push(current);
      continue;
    }
    const headers = current.responseHeaders ?? current.headers;
    const isResponseLike = (headers !== null && typeof headers === 'object') || 'status' in current || 'statusCode' in current
      || current instanceof Error || 'response' in current || 'cause' in current;
    if (!isResponseLike) {
      sources.push(current);
      continue;
    }
    if (headers !== null && typeof headers === 'object') sources.push(headers);
    status ??= numberOrUndefined(current.status ?? current.statusCode);
    const fields = [current.responseBody, current.error, current.data, typeof current.body === 'string' ? current.body : undefined];
    if (Array.isArray(current.errorDetails)) fields.push({error: {details: current.errorDetails}});
    for (const body of fields) {
      if (body !== undefined && body !== null) bodies.push(body);
    }
    if (typeof current.message === 'string') {
      messages.push(current.message);
      const json = jsonInside(current.message);
      if (json !== undefined) bodies.push(json);
    }
    queue.push(current.response, current.cause);
  }
  for (const body of bodies) {
    const message = errorMessage(body);
    if (message) messages.push(message);
  }
  return {sources, status, bodies, messages};
}

function isHeaderBag(value) {
  return typeof value.get === 'function' && !('headers' in value) && !('responseHeaders' in value);
}

function readHeader(source, name) {
  if (typeof source.get === 'function') {
    const value = source.get(name);
    return value === null ? undefined : value;
  }
  if (name in source) return source[name];
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === name) return source[key];
  }
  return undefined;
}

function delayFromBody(body) {
  const data = typeof body === 'string' ? parseJson(body) : body;
  if (data === undefined || data === null || typeof data !== 'object') return undefined;
  for (const item of Array.isArray(data) ? data : [data]) {
    if (item === null || typeof item !== 'object') continue;
    const error = item.error && typeof item.error === 'object' ? item.error : item;
    const details = Array.isArray(error.details) ? error.details : [item];
    for (const detail of details) {
      if (detail && typeof detail === 'object' && String(detail['@type'] ?? '').endsWith('google.rpc.RetryInfo')) {
        const ms = protobufDuration(detail.retryDelay);
        if (ms !== undefined) return ms;
      }
    }
    for (const candidate of [item.retry_after, error.retry_after]) {
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate * 1000;
    }
  }
  return undefined;
}

function protobufDuration(value) {
  if (typeof value === 'string') return /^\d+(?:\.\d+)?s$/.test(value.trim()) ? Number(value.trim().slice(0, -1)) * 1000 : undefined;
  if (value && typeof value === 'object') {
    const seconds = Number(value.seconds ?? 0);
    const nanos = Number(value.nanos ?? 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos) && seconds >= 0 && nanos >= 0) return seconds * 1000 + nanos / 1e6;
  }
  return undefined;
}

const RESET_PAIRS = [
  ['x-ratelimit-reset-requests', 'x-ratelimit-remaining-requests'],
  ['x-ratelimit-reset-tokens', 'x-ratelimit-remaining-tokens'],
  ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-requests-remaining'],
  ['anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-tokens-remaining'],
  ['anthropic-ratelimit-input-tokens-reset', 'anthropic-ratelimit-input-tokens-remaining'],
  ['anthropic-ratelimit-output-tokens-reset', 'anthropic-ratelimit-output-tokens-remaining'],
  ['x-ratelimit-reset-after', 'x-ratelimit-remaining'],
  ['x-ratelimit-reset', 'x-ratelimit-remaining'],
  ['ratelimit-reset', 'ratelimit-remaining'],
];

function delayFromResetHeaders(headers, status, now) {
  const exhausted = [];
  const unknown = [];
  const consider = (reset, remaining) => {
    if (reset === undefined) return;
    if (remaining === undefined) unknown.push(reset);
    else if (remaining <= 0) exhausted.push(reset);
  };
  const seenAfter = headers('x-ratelimit-reset-after') !== undefined;
  for (const [resetName, remainingName] of RESET_PAIRS) {
    if (resetName === 'x-ratelimit-reset' && seenAfter) continue;
    const raw = first(headers(resetName));
    if (raw === undefined) continue;
    const reset = resetName === 'x-ratelimit-reset-after' ? deltaSeconds(raw) : parseResetValue(raw, now);
    consider(reset, numberOrUndefined(first(headers(remainingName))));
  }
  const structured = parseStructuredRateLimit(first(headers('ratelimit')));
  if (structured) consider(structured.reset, structured.remaining);
  const pool = exhausted.length ? exhausted : status === 429 ? unknown : [];
  return pool.length ? Math.max(0, ...pool) : undefined;
}

function parseResetValue(raw, now) {
  const text = String(raw).trim();
  const duration = parseDuration(text);
  if (duration !== undefined) return duration;
  if (NUMBER.test(text)) {
    const value = Number(text);
    if (value >= 1e12) return value - now;
    if (value >= 1e9) return value * 1000 - now;
    return value * 1000;
  }
  const at = parseHttpDate(text);
  return at === undefined ? undefined : at - now;
}

function deltaSeconds(raw) {
  const text = String(raw).trim();
  return NUMBER.test(text) ? Number(text) * 1000 : undefined;
}

function parseStructuredRateLimit(value) {
  if (typeof value !== 'string') return undefined;
  const fields = {};
  for (const [, key, number] of value.matchAll(/(?:^|[;,\s])(r|t|remaining|reset)=(\d+(?:\.\d+)?)/g)) fields[key] ??= Number(number);
  const remaining = fields.r ?? fields.remaining;
  const reset = fields.t ?? fields.reset;
  return reset === undefined ? undefined : {reset: reset * 1000, remaining};
}

function delayFromText(text) {
  const match = TEXT_HINT.exec(text);
  if (!match) return undefined;
  const value = match[1].replace(/\s+/g, '');
  const duration = parseDuration(value);
  if (duration !== undefined) return duration;
  const [, amount, unit] = /^(\d+(?:\.\d+)?)([a-z]+?)s?$/i.exec(value) ?? [];
  const scale = TEXT_UNITS[unit?.toLowerCase()];
  return scale === undefined ? undefined : Number(amount) * scale;
}

function errorMessage(body) {
  const data = typeof body === 'string' ? parseJson(body) ?? body : body;
  if (typeof data === 'string') return data;
  if (data === null || typeof data !== 'object') return undefined;
  const item = Array.isArray(data) ? data[0] : data;
  const message = item?.error?.message ?? item?.message;
  return typeof message === 'string' ? message : undefined;
}

function parseHttpDate(text) {
  let source = text;
  if (ASCTIME_DATE.test(text)) source = text.replace(/ {2}/, ' ') + ' GMT';
  else if (!IMF_FIXDATE.test(text) && !RFC850_DATE.test(text) && !ISO_DATE.test(text)) return undefined;
  const at = Date.parse(source);
  return Number.isNaN(at) ? undefined : at;
}

function jsonInside(message) {
  let tries = 0;
  for (let start = message.search(/[[{]/); start !== -1 && tries < 20; tries++) {
    const parsed = parseJson(message.slice(start));
    if (parsed !== undefined) return parsed;
    const next = message.slice(start + 1).search(/[[{]/);
    start = next === -1 ? -1 : start + 1 + next;
  }
  return undefined;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function first(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clamp(ms) {
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.ceil(ms)));
}
