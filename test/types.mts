import {retryDelay, parseRetryAfter, parseDuration, MAX_DELAY_MS} from 'retry-delay';
import type {RetryDelayOptions, RetryDelayInput, HeadersInput} from 'retry-delay';

const fromHeaders: number | undefined = retryDelay(new Headers({'retry-after': '5'}));
const fromRecord: number | undefined = retryDelay({'retry-after': '5', 'x-ratelimit-remaining': 0});
const fromResponse: number | undefined = retryDelay(new Response(null, {status: 429}));
const fromError: number | undefined = retryDelay(new Error('x'), {now: Date.now(), status: 429, body: '{}'});
const fromCatch = (error: unknown): number | undefined => retryDelay(error);
const options: RetryDelayOptions = {body: {error: {}}};
const input: RetryDelayInput = undefined;
const bag: HeadersInput = {'set-cookie': ['a', 'b']};
const a: number | undefined = parseRetryAfter('120');
const b: number | undefined = parseDuration('6m0s');
const max: 2147483647 = MAX_DELAY_MS;
void [fromCatch, fromHeaders, fromRecord, fromResponse, fromError, options, input, bag, a, b, max];
