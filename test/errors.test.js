'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeError, Logger } = require('../src/main/logger');

test('describeError unwraps AggregateError members instead of printing an empty message', () => {
  const a = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect', address: '1.2.3.4', port: 443 });
  const b = Object.assign(new Error('getaddrinfo ENOTFOUND libraries.minecraft.net'), { code: 'ENOTFOUND' });
  const text = describeError(new AggregateError([a, b, a], ''));
  assert.match(text, /AggregateError/);
  assert.match(text, /ETIMEDOUT.*1\.2\.3\.4:443/);
  assert.match(text, /ENOTFOUND/);
  assert.equal(text.match(/ETIMEDOUT/g).length >= 1, true);
  assert.equal((text.match(/connect ETIMEDOUT/g) || []).length, 1, 'duplicates are collapsed');
});

test('describeError follows cause and tolerates non-errors', () => {
  assert.match(describeError(new Error('outer', { cause: new Error('inner') })), /причина: Error: inner/);
  assert.equal(describeError('plain'), 'plain');
  assert.equal(describeError(null), 'неизвестная ошибка');
});

test('Logger.describe redacts secrets inside nested errors', () => {
  const logger = new Logger({ dir: null });
  logger.redactor.addSecret('SECRET-TOKEN-123');
  const out = logger.describe(new AggregateError([new Error('HTTP 401 Bearer SECRET-TOKEN-123')], ''));
  assert.ok(!out.includes('SECRET-TOKEN-123'));
});
