import assert from 'node:assert/strict';

export const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const at = (seconds) => new Date(NOW + seconds * 1000);
const httpDate = (seconds) => at(seconds).toUTCString();

export const cases = [
  ['retry-after delta seconds', {'retry-after': '5'}, 5000],
  ['retry-after zero', {'retry-after': '0'}, 0],
  ['retry-after decimal seconds', {'retry-after': '1.5'}, 1500],
  ['retry-after with whitespace', {'retry-after': ' 7 '}, 7000],
  ['retry-after IMF-fixdate', {'retry-after': httpDate(30)}, 30_000],
  ['retry-after RFC 850 date', {'retry-after': 'Thursday, 05-Nov-26 12:00:45 GMT'}, 45_000],
  ['retry-after asctime date is GMT, not local time', {'retry-after': 'Thu Nov  5 12:01:00 2026'}, 60_000],
  ['retry-after date in the past is ignored (it usually means clock skew)', {'retry-after': httpDate(-30)}, undefined],
  ['retry-after "5abc" is not 5 seconds', {'retry-after': '5abc'}, undefined],
  ['retry-after negative is invalid', {'retry-after': '-5'}, undefined],
  ['retry-after "Infinity" is invalid', {'retry-after': 'Infinity'}, undefined],
  ['retry-after empty', {'retry-after': ''}, undefined],
  ['retry-after loose date text is rejected', {'retry-after': 'tomorrow'}, undefined],
  ['retry-after huge value is clamped to the setTimeout limit', {'retry-after': '99999999999'}, 2_147_483_647],
  ['retry-after header name is case-insensitive', {'Retry-After': '3'}, 3000],
  ['retry-after array value uses the first', {'retry-after': ['4', '9']}, 4000],
  ['retry-after-ms wins over retry-after', {'retry-after-ms': '1234.5', 'retry-after': '10'}, 1235],
  ['retry-after-ms garbage falls through to retry-after', {'retry-after-ms': 'soon', 'retry-after': '2'}, 2000],
  ['no hint at all', {'content-type': 'application/json'}, undefined],
  ['OpenAI exhausted token window', {'x-ratelimit-remaining-requests': '99', 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '6m0s'}, 360_000],
  ['OpenAI reset headers ignored while quota remains', {'x-ratelimit-remaining-requests': '99', 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-remaining-tokens': '500', 'x-ratelimit-reset-tokens': '20ms'}, undefined],
  ['Groq fractional durations', {'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m59.56s'}, 179_560],
  ['Anthropic RFC 3339 reset, input tokens exhausted', {'anthropic-ratelimit-requests-remaining': '40', 'anthropic-ratelimit-requests-reset': at(1).toISOString(), 'anthropic-ratelimit-input-tokens-remaining': '0', 'anthropic-ratelimit-input-tokens-reset': at(42).toISOString()}, 42_000],
  ['GitHub epoch-seconds reset', {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 600)}, 600_000],
  ['GitHub reset ignored while requests remain', {'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(NOW / 1000 + 600)}, undefined],
  ['Discord reset-after beats the epoch reset', {'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.25', 'x-ratelimit-reset': String(NOW / 1000 + 99)}, 1250],
  ['epoch-milliseconds reset', {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW + 2500)}, 2500],
  ['IETF RateLimit-Reset delta seconds', {'ratelimit-remaining': '0', 'ratelimit-reset': '30'}, 30_000],
  ['IETF structured RateLimit field', {ratelimit: '"default";r=0;t=17'}, 17_000],
  ['IETF combined draft field', {ratelimit: 'limit=100, remaining=0, reset=8'}, 8000],
  ['structured field with quota left', {ratelimit: '"default";r=40;t=17'}, undefined],
];

export const statusCases = [
  ['reset header with no remaining count counts on a 429', {'x-ratelimit-reset': '12'}, 429, 12_000],
  ['reset header with no remaining count is ignored otherwise', {'x-ratelimit-reset': '12'}, 200, undefined],
];

export const bodyCases = [
  ['Gemini RetryInfo in error.details', {error: {code: 429, status: 'RESOURCE_EXHAUSTED', details: [{'@type': 'type.googleapis.com/google.rpc.QuotaFailure'}, {'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34.4s'}]}}, 34_400],
  ['Gemini array-wrapped body as a string', JSON.stringify([{error: {details: [{'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s'}]}}]), 3000],
  ['protobuf Duration object', {error: {details: [{'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: {seconds: 2, nanos: 500_000_000}}]}}, 2500],
  ['Discord retry_after body', {message: 'You are being rate limited.', retry_after: 0.64, global: false}, 640],
  ['OpenAI message hint', {error: {message: 'Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 30000, Requested 900. Please try again in 1.8s. Visit https://platform.openai.com/account/rate-limits to learn more.', type: 'tokens', code: 'rate_limit_exceeded'}}, 1800],
  ['Groq message hint with minutes', {error: {message: 'Rate limit reached for model `llama-3.3-70b-versatile` on tokens per day (TPD): Limit 100000, Used 99850, Requested 1200. Please try again in 7m12.48s.'}}, 432_480],
  ['Gemini message hint', {error: {message: 'You exceeded your current quota. Please retry in 34.381948s.'}}, 34_382],
  ['millisecond hint', {error: {message: 'Rate limited. Please try again in 20ms.'}}, 20],
  ['spelled-out unit hint', 'Too many requests, retry after 2 minutes', 120_000],
  ['no hint in the message', {error: {message: 'Rate limit reached. Retry later.'}}, undefined],
  ['"retry 3 times" is not a delay', {error: {message: 'Failed, will retry 3 times'}}, undefined],
];

export async function runChecks(api) {
  let count = 0;
  for (const [name, headers, expected] of cases) {
    assert.equal(api.retryDelay(headers, {now: NOW}), expected, name);
    assert.equal(api.retryDelay(new Headers(headers instanceof Array ? undefined : Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), {now: NOW}), expected, name + ' (Headers)');
    count += 2;
  }
  for (const [name, headers, status, expected] of statusCases) {
    assert.equal(api.retryDelay(headers, {now: NOW, status}), expected, name);
    assert.equal(api.retryDelay(new Response(null, {status, headers}), {now: NOW}), expected, name + ' (Response)');
    count += 2;
  }
  for (const [name, body, expected] of bodyCases) {
    assert.equal(api.retryDelay({}, {now: NOW, body}), expected, name);
    count++;
  }
  assert.equal(api.retryDelay(undefined), undefined);
  assert.equal(api.retryDelay(null), undefined);
  assert.equal(api.MAX_DELAY_MS, 2_147_483_647);
  assert.equal(api.parseRetryAfter('120', NOW), 120_000);
  assert.equal(api.parseRetryAfter(httpDate(5), NOW), 5000);
  assert.equal(api.parseDuration('1h2m3.5s'), 3_723_500);
  assert.equal(api.parseDuration('6m0s'), 360_000);
  assert.equal(api.parseDuration('250us'), 0.25);
  assert.equal(api.parseDuration('5'), undefined);
  assert.equal(api.parseDuration('5 s'), undefined);
  assert.equal(api.parseDuration(5), undefined);
  return count + 10;
}
