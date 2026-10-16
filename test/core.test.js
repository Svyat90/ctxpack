import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matcher } from '../src/match.js';
import { orderPaths } from '../src/order.js';
import { isDenied, scanSecrets } from '../src/deny.js';
import { fenceFor, languageFor, treeText, renderMarkdown } from '../src/render.js';
import { packParts } from '../src/tokens.js';
import { resolveBudget, loadConfig } from '../src/config.js';
import { buildExport } from '../src/export.js';
import { fixture, FIXTURE, P } from './helpers.js';

test('matcher: bare names match any segment, slashes anchor at root', () => {
  assert.ok(matcher('vendor')('vendor/laravel/x.php'));
  assert.ok(matcher('node_modules')('resources/js/node_modules/a.js'));
  assert.ok(matcher('*.lock')('composer.lock'));
  assert.ok(!matcher('*.lock')('app/lock.php'));
  assert.ok(matcher('/public/build')('public/build/app.js'));
  assert.ok(!matcher('/public/build')('resources/public/build/app.js'));
  assert.ok(matcher('/app/**/*.php')('app/Http/Kernel.php'));
});

test('orderPaths puts directories before files at every level', () => {
  assert.deepEqual(orderPaths(['composer.json', 'app/User.php', 'app/Http/A.php', '.env']), ['app/Http/A.php', 'app/User.php', '.env', 'composer.json']);
});

test('isDenied blocks secrets but allows .env.example', () => {
  for (const p of ['.env', '.env.production', 'storage/logs/laravel.log', 'certs/server.pem', 'auth.json']) assert.ok(isDenied(p), p);
  for (const p of ['.env.example', 'app/Storage/Disk.php', 'config/services.php']) assert.ok(!isDenied(p), p);
});

test('scanSecrets flags literal keys but not env() calls or validation rules', () => {
  const hits = scanSecrets([
    "'secret' => env('MAILGUN_SECRET'),",
    "'password' => 'required|string|min:8',",
    "'secret' => 'sk_live_51Habc123XYZdemo',",
    'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";',
  ].join('\n'));
  assert.deepEqual(hits.map(h => h.line), [3, 4]);
});

test('fenceFor outgrows backtick runs inside the file', () => {
  assert.equal(fenceFor('plain'), '```');
  assert.equal(fenceFor('docs:\n```php\necho 1;\n```'), '````');
  assert.equal(fenceFor('`````'), '``````');
});

test('languageFor knows blade and vue', () => {
  assert.equal(languageFor('resources/views/a.blade.php'), 'blade');
  assert.equal(languageFor('resources/js/A.vue'), 'vue');
  assert.equal(languageFor('README'), '');
});

test('treeText collapses single-directory chains', () => {
  assert.equal(treeText(['app/Http/Controllers/A.php', 'app/Http/Controllers/B.php', 'routes/web.php']),
    'app/Http/Controllers/\n  A.php\n  B.php\nroutes/\n  web.php');
});

test('renderMarkdown: task first, tree, fenced files', () => {
  const md = renderMarkdown({
    name: 'shop',
    task: 'Fix it',
    now: new Date(2026, 9, 16, 14, 5),
    files: [{ path: 'README.md', content: 'Use:\n```bash\nnpm i\n```\n' }],
  });
  assert.match(md, /^# Project context: shop\nGenerated: 2026-10-16 14:05 · Files: 1\n\n## Task\nFix it\n/);
  assert.ok(md.includes('### `README.md`\n````markdown\nUse:\n```bash\nnpm i\n```\n````'));
});

test('packParts keeps order and isolates oversized files', () => {
  const parts = packParts([{ cost: 40 }, { cost: 50 }, { cost: 200 }, { cost: 10 }], 100);
  assert.deepEqual(parts.map(p => p.map(i => i.cost)), [[40, 50], [200], [10]]);
});

test('resolveBudget: profiles, none, and raw numbers', () => {
  const cfg = loadConfig(FIXTURE);
  assert.deepEqual(resolveBudget(cfg, 'small'), { name: 'small', limit: 32000, reserve: 6000 });
  assert.equal(resolveBudget(cfg, 'large'), null);
  assert.equal(resolveBudget(cfg, 'none'), null);
  assert.equal(resolveBudget(cfg, '50k').limit, 50000);
  assert.throws(() => resolveBudget(cfg, 'huge'));
});

test('scan: vendor excluded, .env listed as denied, text files kept', () => {
  const { scan } = fixture();
  const paths = scan.files.map(f => f.path);
  assert.ok(paths.includes(P.userController));
  assert.ok(!paths.some(p => p.startsWith('vendor/')));
  assert.equal(scan.files.find(f => f.path === '.env').flag, 'deny');
  assert.ok(paths.indexOf(P.userController) < paths.indexOf('composer.json'), 'directories first');
});

test('buildExport: skips denied files, warns on secrets, splits under budget', () => {
  const { cfg, scan } = fixture();
  const selected = [P.userController, P.user, P.web, P.usersIndex, P.dataTable, P.services, '.env'];
  const single = buildExport({ root: FIXTURE, name: 'shop', entries: scan.files, cfg, selected, task: 'T' });
  assert.equal(single.parts.length, 1);
  assert.ok(!single.parts[0].markdown.includes('APP_KEY'));
  assert.ok(single.warnings.some(w => w.text.includes('.env')));
  assert.ok(single.warnings.some(w => w.level === 'secret' && w.path === P.services && w.line === 9));

  const split = buildExport({ root: FIXTURE, name: 'shop', entries: scan.files, cfg, selected, task: 'T', budget: { limit: 500, reserve: 0 }, split: true });
  assert.ok(split.parts.length > 1);
  assert.match(split.parts[1].markdown, /Part 2\/\d+/);
  assert.ok(!split.parts[1].markdown.includes('## Task'));
  assert.deepEqual(split.parts.flatMap(p => p.files).sort(), single.parts[0].files.sort());
});
