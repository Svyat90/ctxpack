import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRanges, applyCuts, finishCuts, alignLines, hashText } from '../src/cuts.js';
import { transformContent } from '../src/transform.js';
import { buildExport, readText } from '../src/export.js';
import { fixture, FIXTURE, P } from './helpers.js';

const cut = (path, text, ranges, opts = {}) => {
  const r = normalizeRanges(ranges, text.split('\n').length);
  const done = applyCuts(text, r);
  return finishCuts(path, text, done.text, done.origin, transformContent(path, done.text, opts));
};

test('normalizeRanges sorts, clamps and merges touching ranges', () => {
  assert.deepEqual(normalizeRanges([[9, 7], [1, 2], [3, 4], [20, 99], 'x', [5]], 12), [[1, 4], [7, 9]]);
});

test('a cut block becomes one comment line with the indent of its first line', () => {
  const src = ['<?php', 'class A', '{', '    public function a() {}', '    public function b() {}', '    public function c() {}', '}'].join('\n');
  const r = cut('app/A.php', src, [[4, 5]]);
  assert.equal(r.content, ['<?php', 'class A', '{', '    // ctxpack: lines 4-5 removed', '    public function c() {}', '}'].join('\n'));
  assert.deepEqual(r.map, [1, 2, 3, 4, 6, 7]);
  assert.deepEqual(r.markers, [{ line: 3, range: [4, 5] }]);
});

test('the note survives "remove all comments" and the map still points at file lines', () => {
  const src = ['<?php', '// header', 'function a() {', '    return 1; // one', '}', '', '/** doc */', 'function b() {}', 'function c() {}'].join('\n');
  const r = cut('x.php', src, [[8, 8]], { stripComments: true });
  const lines = r.content.split('\n');
  assert.ok(lines.includes('// ctxpack: line 8 removed'));
  assert.equal(r.map[lines.indexOf('    return 1;')], 4);
  assert.equal(r.map[lines.indexOf('function c() {}')], 9);
});

test('Vue: the comment syntax follows the block the cut starts in', () => {
  const src = ['<script setup>', 'const a = 1;', 'const b = 2;', '</script>', '', '<template>', '  <div>', '    <p>x</p>', '  </div>', '</template>'].join('\n');
  const r = cut('A.vue', src, [[2, 2], [8, 8]]);
  assert.match(r.content, /^\/\/ ctxpack: line 2 removed$/m);
  assert.match(r.content, /^    <!-- ctxpack: line 8 removed -->$/m);
});

test('alignLines maps blank and shortened lines forward', () => {
  assert.deepEqual(alignLines(['a', '', 'b'], ['a', '// x', '', 'b // y']), [0, 1, 3]);
});

test('export applies cuts and drops stale ones', () => {
  const { cfg, scan } = fixture();
  const base = { root: FIXTURE, name: 'laravel', entries: scan.files, cfg, selected: [P.userController] };
  const original = readText(FIXTURE, P.userController);
  const hash = hashText(original);

  const r = buildExport({ ...base, cuts: { [P.userController]: { hash, ranges: [[15, 20]] } } });
  assert.deepEqual(r.staleCuts, []);
  assert.equal(r.files[0].cutLines, 6);
  assert.ok(r.files[0].tokens < buildExport(base).files[0].tokens);
  const block = r.parts[0].blocks[0];
  const md = r.parts[0].markdown.split('\n');
  assert.equal(md[block.heading], `### \`${P.userController}\``);
  assert.equal(md[block.start + block.markers[0].line], '    // ctxpack: lines 15-20 removed');
  assert.ok(!r.parts[0].markdown.includes('Inertia::render'));

  const stale = buildExport({ ...base, cuts: { [P.userController]: { hash: 'nope', ranges: [[1, 3]] } } });
  assert.deepEqual(stale.staleCuts, [P.userController]);
  assert.equal(stale.files[0].cutLines, 0);
});
