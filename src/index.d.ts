export type HeaderValue = string | number | readonly string[] | null | undefined;

export type HeadersInput =
  | {get(name: string): string | null | undefined}
  | Readonly<Record<string, HeaderValue>>;

/**
 * A fetch `Response`, an SDK or HTTP-client error, a headers object, or anything with `headers` / `responseHeaders`.
 * Typed `unknown` so a caught error can be passed as is; anything else returns `undefined`.
 */
export type RetryDelayInput = unknown;

export interface RetryDelayOptions {
  /** Current time in milliseconds since the epoch. Defaults to `Date.now()`. */
  now?: number;
  /** HTTP status, when it can't be read from the input. 429 lets reset headers count without a remaining count of 0. */
  status?: number;
  /** Response body (a string or parsed JSON), for providers that put the delay in the body, such as Gemini. */
  body?: unknown;
}

/** Largest delay `setTimeout` accepts: 2^31 - 1 ms. Every result is clamped to it. */
export declare const MAX_DELAY_MS: 2147483647;

/**
 * How long the server asked you to wait before retrying, in whole milliseconds, or `undefined` if it didn't say.
 * Reads `retry-after-ms`, `retry-after`, Google `RetryInfo`, rate-limit reset headers whose remaining count is 0,
 * and "try again in 6.5s" hints in error messages, in that order.
 */
export declare function retryDelay(input: RetryDelayInput, options?: RetryDelayOptions): number | undefined;

/** Parses a `Retry-After` value (delta seconds or an HTTP-date) into milliseconds from `now`, or `undefined`. */
export declare function parseRetryAfter(value: HeaderValue, now?: number): number | undefined;

/** Parses a Go-style duration such as `6m0s`, `1.5s` or `20ms` into milliseconds, or `undefined`. */
export declare function parseDuration(value: unknown): number | undefined;
