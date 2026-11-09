import retry = require('retry-delay');
import type {RetryDelayOptions} from 'retry-delay';

const value: number | undefined = retry.retryDelay({'retry-after': '1'});
const options: RetryDelayOptions = {now: 0};
const parsed: number | undefined = retry.parseRetryAfter(['3']);
const max: 2147483647 = retry.MAX_DELAY_MS;
void [value, options, parsed, max];
