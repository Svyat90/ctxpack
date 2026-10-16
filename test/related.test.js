import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRelated, createContext } from '../src/related/index.js';
import { parsePhp } from '../src/related/php.js';
import { loadConfig } from '../src/config.js';
import { fixture, FIXTURE, P } from './helpers.js';

const run = (seeds, rel = {}) => {
  const { ctx, cfg } = fixture();
  return findRelated(ctx, seeds, { ...cfg.related, ...rel });
};
const byPath = list => Object.fromEntries(list.map(s => [s.path, s]));

test('parsePhp reads namespace, imports, parents, interfaces and traits', () => {
  const info = parsePhp(`<?php
namespace App\\Services;
use App\\Contracts\\{Payable, Loggable as Logs};
use Illuminate\\Support\\Traits\\Macroable;
abstract class Billing extends Base implements Payable, Logs
{
    use Macroable, Concerns\\Retries;
    public function run() { $fn = function () use ($x) {}; }
}`);
  assert.equal(info.ns, 'App\\Services');
  assert.deepEqual(info.parents.map(info.resolve), ['App\\Services\\Base']);
  assert.deepEqual(info.interfaces.map(info.resolve), ['App\\Contracts\\Payable', 'App\\Contracts\\Loggable']);
  assert.deepEqual(info.traits.map(info.resolve), ['Illuminate\\Support\\Traits\\Macroable', 'App\\Services\\Concerns\\Retries']);
});

test('controller at depth 1: routes, deps, base class, Inertia page, tests', () => {
  const s = byPath(run([P.userController]));
  assert.equal(s[P.web].rule, 'controller-routes');
  assert.equal(s[P.storeRequest].reason, 'FormRequest StoreUserRequest');
  assert.equal(s[P.user].reason, 'Model User');
  assert.equal(s[P.baseController].reason, 'extends Controller');
  assert.equal(s[P.usersIndex].reason, "Inertia::render('Users/Index')");
  assert.equal(s[P.test].rule, 'tests');
  assert.equal(s[P.dataTable], undefined, 'Vue imports are level 2');
  assert.ok(Object.values(s).every(x => x.level === 1));
});

test('depth follows Vue imports level by level', () => {
  const d2 = byPath(run([P.userController], { depth: 2 }));
  assert.equal(d2[P.dataTable].level, 2);
  assert.equal(d2[P.dataTable].from, P.usersIndex);
  assert.equal(d2[P.sortHeader], undefined);

  const d3 = byPath(run([P.userController], { depth: 3 }));
  assert.equal(d3[P.sortHeader].level, 3);
});

test('depthByRule lets one rule go deeper than the global depth', () => {
  const s = byPath(run([P.userController], { depth: 1, depthByRule: { 'vue-imports': 3 } }));
  assert.equal(s[P.sortHeader].level, 3);
  assert.equal(s[P.hasRoles], undefined, 'php-inheritance stays at depth 1');
  assert.equal(s[P.migration], undefined, 'model-extras stays at depth 1');
});

test('PHP inheritance chain: service → abstract base → interface', () => {
  const s = byPath(run([P.orderService], { depth: 2 }));
  assert.equal(s[P.baseService].reason, 'extends BaseService');
  assert.equal(s[P.contract].reason, 'implements ServiceContract');
  assert.equal(s[P.contract].level, 2);
});

test('model extras: migration by table name and factory', () => {
  const s = byPath(run([P.user]));
  assert.equal(s[P.migration].reason, 'migration: users');
  assert.equal(s[P.factory].reason, 'factory');
  assert.equal(s[P.hasRoles].reason, 'use HasRoles');
});

test('route() in Vue finds the route file and its controller', () => {
  const s = byPath(run([P.usersIndex]));
  assert.equal(s[P.web].reason, "route('users.index')");
  assert.equal(s[P.userController].reason, "route('users.index') → UserController");
  assert.equal(s[P.dataTable].reason, 'import DataTable.vue');
});

test('never suggests vendor/ or node_modules/ files, and skips package classes and npm imports', () => {
  const all = run([P.userController, P.user, P.usersIndex, P.dataTable, P.baseService], { depth: 5 });
  assert.ok(all.length > 0);
  assert.ok(all.every(s => !/^(vendor|node_modules)\//.test(s.path)));
  assert.ok(!all.some(s => /Authenticatable|extends FormRequest|Macroable|lodash/.test(s.reason)));
});

test('package guard holds even when vendor/ is not excluded', () => {
  const cfg = loadConfig(FIXTURE);
  const entries = [
    { path: 'vendor/laravel/framework/src/Illuminate/Foundation/Auth/User.php', tokens: 10 },
    { path: 'node_modules/vue/index.js', tokens: 10 },
    { path: P.user, tokens: 10 },
  ];
  const ctx = createContext(FIXTURE, entries, cfg);
  assert.equal(ctx.has(entries[0].path), false);
  assert.equal(ctx.has(entries[1].path), false);
  assert.equal(ctx.has(P.user), true);
  assert.equal(ctx.classFile('Illuminate\\Foundation\\Auth\\User'), null);
});

test('rules can be switched off one by one, or all at once', () => {
  const s = byPath(run([P.userController], { rules: { tests: false, 'php-inheritance': false } }));
  assert.equal(s[P.test], undefined);
  assert.equal(s[P.baseController], undefined);
  assert.ok(s[P.web]);
  assert.deepEqual(run([P.userController], { enabled: false }), []);
});

test('suggestions carry their group and the code they were found from', () => {
  const s = byPath(run([P.userController, P.usersIndex]));
  assert.equal(s[P.web].group, 'routes');
  assert.equal(s[P.storeRequest].group, 'requests');
  assert.equal(s[P.user].group, 'models');
  assert.equal(s[P.baseController].group, 'controllers');
  assert.equal(s[P.test].group, 'tests', 'a controller test is a test, not a controller');
  assert.equal(s[P.dataTable].group, 'components');

  const req = s[P.storeRequest].sites;
  assert.equal(req.length, 1);
  assert.equal(req[0].file, P.userController);
  assert.match(req[0].code.split('\n')[req[0].lines[0] - req[0].start], /function store\(StoreUserRequest/, 'points at the use, not at the import');

  // web.php is found from the controller and again from route() in the page: both places are kept,
  // and the two neighbouring route lines share one snippet.
  const web = s[P.web].sites;
  assert.deepEqual(web.map(x => x.file), [P.web, P.usersIndex]);
  assert.deepEqual(web[0].lines, [6, 7]);
  assert.match(web[1].code, /route\('users\.index'\)/);
});

test('groupOf: services, policies under app/Models, Inertia pages', async () => {
  const { groupOf } = await import('../src/related/groups.js');
  assert.equal(groupOf('app/Services/OrderService.php'), 'services');
  assert.equal(groupOf('app/Models/Policies/UserPolicy.php'), 'policies');
  assert.equal(groupOf('app/Policies/UserPolicy.php'), 'policies');
  assert.equal(groupOf('resources/js/Pages/Users/Index.vue'), 'pages');
  assert.equal(groupOf('database/migrations/x.php'), 'database');
  assert.equal(groupOf('app/Enums/Status.php'), 'php');
});
