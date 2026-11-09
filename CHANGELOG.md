# Changelog

## 0.1.0

First release.

- `retryDelay(input, options)` returns the delay a server asked for, from `retry-after-ms`, `retry-after`, Google
  `RetryInfo`, Discord `retry_after`, exhausted rate-limit reset headers and "try again in" hints.
- `parseRetryAfter(value, now)` and `parseDuration(value)` for single values.
