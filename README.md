# retry-delay

How long a server asked you to wait before retrying. Pass it the response, the headers or the error your HTTP
client or AI SDK threw, and get back milliseconds, or `undefined` if the server didn't say.

```js
import {retryDelay} from 'retry-delay';

try {
  return await client.chat.completions.create(request);
} catch (error) {
  const ms = retryDelay(error) ?? backoff(attempt); // 1800 for "Please try again in 1.8s."
  await sleep(Math.min(ms, 60_000));
}
```

No dependencies. ESM and CommonJS. Plain JavaScript with no Node APIs, tested on Node 22, 24 and 26.

## What it reads

In this order, first match wins:

| Source | Sent by | Example |
| --- | --- | --- |
| `retry-after-ms` | OpenAI, Azure OpenAI | `retry-after-ms: 850` |
| `retry-after`, seconds or HTTP-date (all three formats RFC 9110 allows) | Anthropic, OpenAI, GitHub, Slack, most APIs | `retry-after: 17`, `retry-after: Thu, 05 Nov 2026 12:00:30 GMT` |
| Google `RetryInfo` in the error body | Gemini API, Vertex AI, Google Cloud APIs | `"retryDelay": "34s"` |
| `retry_after` in the body | Discord | `"retry_after": 0.64` |
| Reset headers for a limit that is used up (`remaining` is 0) | OpenAI, Groq, Anthropic, GitHub, Discord, IETF `RateLimit` | `x-ratelimit-reset-tokens: 6m0s`, `anthropic-ratelimit-input-tokens-reset: 2026-11-05T12:00:42Z`, `x-ratelimit-reset: 1793880600`, `ratelimit: "default";r=0;t=17` |
| A "try again in …" hint in the error message | OpenAI, Groq, Gemini | `Please try again in 7m12.48s.` |

Reset headers are only used when their limit is used up, or when the status is 429 and no remaining count was sent.
Otherwise every response would tell you to wait for the next window.

## What it accepts

- A fetch `Response`, `Headers`, or a plain headers object (any key case, array values allowed).
- Errors from the OpenAI and Anthropic SDKs (`error.headers`, `error.error`), `@google/genai` (its error keeps no
  headers, only the JSON body in `message`), the AI SDK's `APICallError` (`responseHeaders`, `responseBody`), axios,
  any error with a `response` that has headers (as got and ky errors do), and errors that wrap one of these in `cause`.
- `{status, body}` in the options, when you have them separately.

Each of these is tested with the real SDK throwing a real 429 through a stubbed `fetch`
([`test/api.test.mjs`](test/api.test.mjs)).

## Edge cases it gets right

These are the places hand-written parsers disagree:

- `Retry-After: 5abc` is invalid, not 5 seconds. `parseFloat` says 5.
- A `Retry-After` date in the past returns `undefined`, so you fall back to your own backoff. It usually means the
  client's clock is ahead, and retrying at once would hammer a server that asked you to wait.
- Decimal seconds (`Retry-After: 1.5`) are accepted. RFC 9110 only allows whole seconds, but some APIs send decimals.
- The asctime date format has no zone and must be read as GMT. `Date.parse` reads it as local time.
- `retry-after-ms` is preferred over `retry-after` because it is more precise.
- OpenAI and Groq send Go durations (`6m0s`, `2m59.56s`, `20ms`), Anthropic sends RFC 3339 timestamps, GitHub sends
  epoch seconds, Discord and the IETF draft send delta seconds.
- When several limits are used up, the longest wait wins.
- Results are whole milliseconds, rounded up so you never retry early, and clamped to `2147483647`, the largest
  delay `setTimeout` accepts. Above that it fires immediately.

It does not decide whether to retry, and it does not cap the delay to something you find reasonable. Apply your own
ceiling.

## API

### `retryDelay(input, options?)`

Returns `number | undefined`. Options:

- `now`: current time in ms, for HTTP-dates and reset timestamps. Defaults to `Date.now()`.
- `status`: the HTTP status, if `input` doesn't carry one.
- `body`: the response body, as a string or parsed JSON.

### `parseRetryAfter(value, now?)`

Parses one `Retry-After` value. Returns milliseconds or `undefined`.

### `parseDuration(value)`

Parses a Go-style duration such as `1h2m3.5s`. Returns milliseconds or `undefined`.

### `MAX_DELAY_MS`

`2147483647`.

## License

MIT
