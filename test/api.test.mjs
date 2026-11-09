import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {GoogleGenAI} from '@google/genai';
import {generateText} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import axios from 'axios';
import * as api from '../src/index.js';
import {runChecks, cases, NOW} from './checks.mjs';

const {retryDelay} = api;

test('the shared checks pass against the source', async () => {
  const count = await runChecks(api);
  assert.ok(count >= cases.length * 2, `${count} checks ran`);
});

const geminiBody = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests'}]},
      {'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s'},
    ],
  },
};

const respond = (status, body, headers = {}) => async () => new Response(JSON.stringify(body), {
  status,
  headers: {'content-type': 'application/json', ...headers},
});

async function caught(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

test('openai: APIError from a 429 with retry-after-ms', async () => {
  const client = new OpenAI({apiKey: 'test', maxRetries: 0, fetch: respond(429, {error: {message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded'}}, {'retry-after-ms': '850', 'retry-after': '1'})});
  const error = await caught(client.chat.completions.create({model: 'gpt-5.6-luna', messages: [{role: 'user', content: 'hi'}]}));
  assert.ok(error instanceof OpenAI.RateLimitError);
  assert.equal(retryDelay(error), 850);
});

test('openai: no headers, delay only in the error message', async () => {
  const client = new OpenAI({apiKey: 'test', maxRetries: 0, fetch: respond(429, {error: {message: 'Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000. Please try again in 1.8s.', type: 'tokens', code: 'rate_limit_exceeded'}})});
  const error = await caught(client.chat.completions.create({model: 'gpt-4o', messages: [{role: 'user', content: 'hi'}]}));
  assert.equal(retryDelay(error), 1800);
});

test('openai: exhausted token window from reset headers', async () => {
  const client = new OpenAI({apiKey: 'test', maxRetries: 0, fetch: respond(429, {error: {message: 'Rate limit reached'}}, {'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '6m0s', 'x-ratelimit-remaining-requests': '10', 'x-ratelimit-reset-requests': '120ms'})});
  const error = await caught(client.responses.create({model: 'gpt-5.6-luna', input: 'hi'}));
  assert.equal(retryDelay(error), 360_000);
});

test('anthropic: APIError from a 429 with retry-after and reset headers', async () => {
  const reset = new Date(NOW + 20_000).toISOString();
  const client = new Anthropic({apiKey: 'test', maxRetries: 0, fetch: respond(429, {type: 'error', error: {type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit'}}, {'retry-after': '17', 'anthropic-ratelimit-input-tokens-remaining': '0', 'anthropic-ratelimit-input-tokens-reset': reset})});
  const error = await caught(client.messages.create({model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{role: 'user', content: 'hi'}]}));
  assert.ok(error instanceof Anthropic.RateLimitError);
  assert.equal(retryDelay(error, {now: NOW}), 17_000);
});

test('anthropic: 429 with reset headers only', async () => {
  const reset = new Date(NOW + 9000).toISOString();
  const client = new Anthropic({apiKey: 'test', maxRetries: 0, fetch: respond(429, {type: 'error', error: {type: 'rate_limit_error', message: 'rate limited'}}, {'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': reset})});
  const error = await caught(client.messages.create({model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{role: 'user', content: 'hi'}]}));
  assert.equal(retryDelay(error, {now: NOW}), 9000);
});

test('@google/genai: ApiError keeps no headers, RetryInfo is read from the message', async () => {
  const ai = new GoogleGenAI({apiKey: 'test', httpOptions: {fetch: respond(429, geminiBody), retryOptions: {attempts: 1}}});
  const error = await caught(ai.models.generateContent({model: 'gemini-3.7-flash', contents: 'hi'}));
  assert.equal(error.status, 429);
  assert.equal(retryDelay(error), 34_000);
});

test('AI SDK: APICallError from @ai-sdk/google carries RetryInfo in responseBody', async () => {
  const google = createGoogleGenerativeAI({apiKey: 'test', fetch: respond(429, geminiBody)});
  const error = await caught(generateText({model: google('gemini-3.7-flash'), prompt: 'hi', maxRetries: 0}));
  assert.equal(retryDelay(error), 34_000);
});

test('AI SDK: APICallError from @ai-sdk/openai with retry-after', async () => {
  const openai = createOpenAI({apiKey: 'test', fetch: respond(429, {error: {message: 'Rate limit reached', type: 'requests'}}, {'retry-after': '3'})});
  const error = await caught(generateText({model: openai('gpt-5.6-luna'), prompt: 'hi', maxRetries: 0}));
  assert.equal(retryDelay(error), 3000);
});

test('axios: error.response with AxiosHeaders', async () => {
  const error = await caught(axios.get('https://api.example.test/x', {
    adapter: async (config) => {
      const response = {status: 429, statusText: 'Too Many Requests', headers: new axios.AxiosHeaders({'Retry-After': '11'}), data: {}, config};
      throw new axios.AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', config, {}, response);
    },
  }));
  assert.equal(retryDelay(error), 11_000);
});

test('fetch Response and a node http-style headers object', () => {
  assert.equal(retryDelay(new Response(null, {status: 503, headers: {'Retry-After': '120'}})), 120_000);
  assert.equal(retryDelay({'retry-after': ['2'], 'x-ratelimit-remaining': '0'}), 2000);
  assert.equal(retryDelay({statusCode: 429, headers: {'x-ratelimit-reset': '4'}}), 4000);
});

test('an error wrapping another through cause', () => {
  const inner = Object.assign(new Error('rate limited'), {statusCode: 429, responseHeaders: {'retry-after': '6'}});
  assert.equal(retryDelay(new Error('gateway failed', {cause: inner})), 6000);
});

test('a malformed header on the outer error does not hide a valid one in cause', () => {
  const inner = {responseHeaders: {'retry-after': '5'}};
  assert.equal(retryDelay({responseHeaders: {'retry-after': '-3'}, cause: inner}), 5000);
  assert.equal(retryDelay({cause: {responseHeaders: {'retry-after-ms': '250'}}}), 250);
});

test('the outer error wins when both carry a valid header', () => {
  const inner = {responseHeaders: {'retry-after': '9'}};
  assert.equal(retryDelay({responseHeaders: {'retry-after': '2'}, cause: inner}), 2000);
});

test('an object that cycles through cause does not hang', () => {
  const a = new Error('a');
  const b = new Error('b', {cause: a});
  a.cause = b;
  assert.equal(retryDelay(a), undefined);
});
