import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { FIXTURE, P } from './helpers.js';

const api = createApi(FIXTURE, { useGit: false });

test('file preview returns content, size and secret lines', () => {
  const f = api.file(P.services);
  assert.ok(f.content.includes("'stripe'"));
  assert.equal(f.language, 'php');
  assert.equal(f.exportable, true);
  assert.deepEqual(f.secrets.map(s => s.line), [9]);
});

test('file preview refuses denied and unknown files', () => {
  assert.throws(() => api.file('.env'), /заборонений/);
  assert.throws(() => api.file('../../package.json'), /не знайдено/);
  assert.throws(() => api.file('vendor/laravel/framework/src/Illuminate/Foundation/Auth/User.php'), /не знайдено/);
});
