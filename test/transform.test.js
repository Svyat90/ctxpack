import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripClassDocTags, stripAllComments, transformContent } from '../src/transform.js';

const MODEL = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

/**
 * App\\Models\\Order
 *
 * @property int $id
 * @property string $status
 * @property-read \\App\\Models\\User $user
 * @method static \\Illuminate\\Database\\Eloquent\\Builder<static>|Order newModelQuery()
 * @method static \\Illuminate\\Database\\Eloquent\\Builder<static>|Order whereStatus($value)
 * @mixin \\Eloquent
 */
class Order extends Model
{
    /**
     * @method not a class docblock, must stay
     * @return void
     */
    public function boot(): void {}
}
`;

test('drops ide-helper tags but keeps the description', () => {
  const out = stripClassDocTags(MODEL);
  assert.ok(out.includes('/**\n * App\\Models\\Order\n */\nclass Order extends Model'));
  assert.ok(!/@property|@mixin|whereStatus/.test(out.split('class Order')[0]));
  assert.ok(out.includes('@method not a class docblock, must stay'), 'method docblocks are untouched');
});

test('removes a block that only had ide-helper tags, without leaving a blank line', () => {
  const src = '<?php\n\nnamespace App;\n\n/**\n * @property int $id\n *\n * @method static Builder query()\n */\nfinal class A\n{\n}\n';
  assert.equal(stripClassDocTags(src), '<?php\n\nnamespace App;\n\nfinal class A\n{\n}\n');
});

test('handles one-line blocks and attributes before the class', () => {
  const src = '<?php\n/** @mixin \\Eloquent */\n#[ObservedBy([UserObserver::class])]\nclass User {}\n';
  assert.equal(stripClassDocTags(src), '<?php\n#[ObservedBy([UserObserver::class])]\nclass User {}\n');
});

test('keeps other tags and does not merge a file docblock with the class one', () => {
  const src = '<?php\n/**\n * File header.\n */\nnamespace App;\n\n/**\n * @deprecated use B\n * @property int $id\n * @template T\n */\nclass A {}\n';
  const out = stripClassDocTags(src);
  assert.ok(out.includes('/**\n * File header.\n */\nnamespace App;'));
  assert.ok(out.includes('/**\n * @deprecated use B\n * @template T\n */\nclass A {}'));
});

test('stripAllComments: PHP comments go, strings and attributes stay', () => {
  const src = [
    '<?php',
    '',
    '/** Docblock */',
    '#[Attr]',
    'class A',
    '{',
    '    // line comment',
    '    # hash comment',
    "    private string $url = 'https://example.com/#top'; // trailing",
    '    /* block',
    '       comment */',
    '    private string $s = "/* not a comment */";',
    '}',
    '',
  ].join('\n');
  assert.equal(stripAllComments('app/A.php', src), [
    '<?php',
    '',
    '#[Attr]',
    'class A',
    '{',
    '',
    "    private string $url = 'https://example.com/#top';",
    '',
    '    private string $s = "/* not a comment */";',
    '}',
    '',
  ].join('\n'));
});

test('stripAllComments: a PHP heredoc with quotes does not swallow the code after it', () => {
  const src = [
    '<?php',
    '$sql = <<<SQL',
    "  SELECT * FROM users -- don't",
    '  SQL;',
    "$glob = 'app/*.php';",
    'function keep() { return 1; } // trailing',
    "$after = 'still here';",
    '/* real */',
    'echo $after;',
  ].join('\n');
  assert.equal(stripAllComments('a.php', src), [
    '<?php',
    '$sql = <<<SQL',
    "  SELECT * FROM users -- don't",
    '  SQL;',
    "$glob = 'app/*.php';",
    'function keep() { return 1; }',
    "$after = 'still here';",
    '',
    'echo $after;',
  ].join('\n'));
});

test('stripAllComments: an unclosed /* keeps the rest of the file', () => {
  const src = "<?php\n$a = 1; /* never closed\n$b = 2;\n";
  assert.equal(stripAllComments('a.php', src), src.replace(/[ \t]+$/gm, ''));
});

test('stripAllComments: Vue script, template and scoped SCSS', () => {
  const src = [
    '<script setup>',
    "// setup comment",
    "const url = 'http://x.test/a'; /* inline */",
    '</script>',
    '<template>',
    '  <!-- hidden -->',
    '  <a :href="url">link</a>',
    '</template>',
    '<style lang="scss">',
    '// scss comment',
    'a { background: url(http://x.test/i.png); } /* css */',
    '</style>',
  ].join('\n');
  const out = stripAllComments('resources/js/A.vue', src);
  assert.ok(!/comment|hidden|inline|\/\* css/.test(out));
  assert.ok(out.includes("const url = 'http://x.test/a';"));
  assert.ok(out.includes('url(http://x.test/i.png)'));
  assert.ok(out.includes('<a :href="url">link</a>'));
});

test('stripAllComments: JS regex literals and JSX apostrophes do not confuse the scanner', () => {
  const src = [
    "const URL_RE = /https:\\/\\/[^\\s\"'`]+/gi; // urls",
    "if (!/^https?:\\/\\//i.test(ref)) return ref; // keep the regex",
    'const half = total / 2; // division',
    "const el = <p>Don't panic</p>; // jsx text",
    "const link = 'http://example.com'; // after the apostrophe line",
  ].join('\n');
  assert.equal(stripAllComments('a.tsx', src), [
    "const URL_RE = /https:\\/\\/[^\\s\"'`]+/gi;",
    "if (!/^https?:\\/\\//i.test(ref)) return ref;",
    'const half = total / 2;',
    // The apostrophe reads as a string up to the end of the line, so this comment stays:
    // a missed comment is the safe failure, and the next line is parsed correctly again.
    "const el = <p>Don't panic</p>; // jsx text",
    "const link = 'http://example.com';",
  ].join('\n'));
});

test('stripAllComments: Blade comments, and other files are untouched', () => {
  assert.equal(stripAllComments('resources/views/a.blade.php', '{{-- note --}}\n<p>{{ $x }}</p>\n'), '<p>{{ $x }}</p>\n');
  const json = '{ "url": "http://x.test" }\n';
  assert.equal(stripAllComments('package.json', json), json);
});

test('transformContent only touches PHP sources and can be switched off', () => {
  const doc = '/**\n * @property int $id\n */\nclass A {}\n';
  assert.equal(transformContent('app/A.php', doc), 'class A {}\n');
  assert.equal(transformContent('app/A.php', doc, { stripDocs: false }), doc);
  assert.equal(transformContent('resources/views/a.blade.php', doc), doc);
  assert.equal(transformContent('app/A.php', doc, { docTags: ['method'] }), doc);
});
