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
  assert.throws(() => api.file('.env'), /blocked/);
  assert.throws(() => api.file('../../package.json'), /not among the project files/);
  assert.throws(() => api.file('vendor/laravel/framework/src/Illuminate/Foundation/Auth/User.php'), /not among/);
  assert.throws(() => api.file('.env', 'uk'), /заборонений/);
});

test('export strips IDE-helper docblocks by default and reports the savings', () => {
  const body = { selected: [P.user, P.userController], budget: 'large' };
  const md = api.export(body).parts[0].markdown;
  assert.ok(!md.includes('@property'), 'ide-helper tags are gone');
  assert.ok(md.includes('class User extends Authenticatable'));
  const on = api.preview(body).stripped;
  assert.equal(on.files, 1);
  assert.ok(on.tokens > 50);

  const off = api.preview({ ...body, stripDocs: false }).stripped;
  assert.deepEqual([off.files, off.tokens], [0, 0]);
  assert.ok(api.export({ ...body, stripDocs: false }).parts[0].markdown.includes('@property int $id'));

  const all = api.preview({ ...body, stripComments: true }).stripped;
  assert.equal(all.files, 2, 'the controller docblock goes too');
  assert.ok(all.tokens > on.tokens);
});

test('warnings come back in the requested language', () => {
  const body = { selected: [P.services, '.env'], budget: 'small' };
  const en = api.preview(body, 'en').warnings.map(w => w.text);
  const uk = api.preview(body, 'uk').warnings.map(w => w.text);
  assert.ok(en.includes('Skipped .env: blocked file'));
  assert.ok(en.includes('Possible secret (password or key in code): config/services.php:9'));
  assert.ok(uk.includes('Пропущено .env: заборонений файл'));
  assert.ok(uk.includes('Можливий секрет (пароль або ключ у коді): config/services.php:9'));
});
