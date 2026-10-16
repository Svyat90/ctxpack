# ctxpack

**English** · [Українська](README.uk.md)

Packs the files you pick from a project into one Markdown file (tree, paths and full contents) that you can paste into an AI chat. It suggests related files for Laravel + Vue 3 + Inertia projects, keeps the result within a token budget and never exports secrets.

Requires Node.js 20+. No dependencies.

## Install

```bash
cd ~/code/ctxpack
npm link          # makes the `ctxpack` command available everywhere
```

Without `npm link`, run it as `node ~/code/ctxpack/bin/ctxpack.js …`.

## Web UI

```bash
ctxpack ui ~/code/my-laravel-app
```

The browser opens `http://127.0.0.1:3001`. Use `--port 3002` for another port. If the port is taken, ctxpack does not start and tells you how to find what holds it.

The file tree is on the left, related-file suggestions in the middle, and the token budget, task, warnings and the **Copy MD** / **Save to file** buttons on the right.

- **EN / УКР** in the header switches the interface language. The choice is remembered in the browser.
- Drag the strip between panels to resize them (or focus it and use ← →). Double-click the strip to reset.
- **View result** opens the generated Markdown in a large window with text search: Enter / Shift+Enter or ↑ ↓ move between matches, Cmd/Ctrl+F focuses the search box. Split results get a tab per part.
- The **eye** button next to a file (shown on hover) opens its **preview** in the same window with the same search, plus line numbers, highlighted possible secrets, **Add to selection** and **PhpStorm**. Clicking a file in **Heaviest files** does the same. Blocked files (`.env` and similar) are never shown.
- The **32K · small** profile gives 26K usable tokens (6K stay free for your prompt and the answer). **no limit** is for an agent without a limit.
- **Split to fit the limit** divides the result into parts made of whole files. Each part has its own copy button.
- **Changed in git** adds modified, staged and new files.
- **Presets** save the current selection to the project's `.ctxpack.json`.

The server listens on `127.0.0.1` only and accepts requests only with the one-time token from the link it prints.

## CLI

```bash
ctxpack export ~/code/app --include app/Http/Controllers/UserController.php --related --depth 2
ctxpack export ~/code/app --changed --related --split --budget small
ctxpack export ~/code/app --preset "users feature" --copy
ctxpack export ~/code/app --include "app/Services/**/*.php" --stdout > context.md
ctxpack init ~/code/app     # create .ctxpack.json
```

The result goes to `./ctxpack-out/<project>-context.md` (or `.part1.md`, `.part2.md`, …). All options: `ctxpack --help`.

CLI messages follow `--lang en|uk`, then the `CTXPACK_LANG` environment variable, then the system locale.

## Related files

| Rule | What it finds |
|---|---|
| Controller routes | lines in `routes/*.php` that mention the controller |
| Controller dependencies | FormRequest, Resource, Model, Policy, Service from signatures, `new X`, `X::` |
| Inertia page | `Inertia::render('Users/Index')` → `resources/js/Pages/Users/Index.vue` |
| Vue/JS imports | relative imports and `@/…` |
| route() in Vue | `route('users.index')` → the routes file and its controller |
| PHP inheritance | `extends`, `implements`, traits |
| Migrations & factories | migrations of the model's table, Factory, Seeder, Policy, Observer |
| Tests | tests that mention the class or component |

Files from `vendor/` (the Laravel framework, composer packages) and `node_modules/` (npm packages) are **never** suggested. PHP classes resolve only through the PSR-4 roots in your `composer.json`, and bare npm imports (`vue`, `@inertiajs/vue3`) are skipped.

Set the depth (1–5) in the UI. In `.ctxpack.json` you can also set it per rule:

```json
{
  "related": {
    "depth": 1,
    "depthByRule": { "vue-imports": 4, "php-inheritance": 5 },
    "rules": { "tests": false }
  }
}
```

## `.ctxpack.json` settings

Every field is optional:

- `exclude`: extra exclusions, added to the defaults (`vendor`, `node_modules`, `public/build`, lock files…).
- `maxFileKb` (200): larger files are listed in the tree but cannot be exported.
- `tokenCharsRatio` (3.2): characters per token. To calibrate, compare the counter with what your AI interface shows and adjust.
- `budgets`: profiles like `{ "limit": 32000, "reserve": 6000 }`; `limit: null` means no limit.
- `related.aliases` (`{"@": "resources/js"}`): import aliases.

Secrets are never exported: `.env*` (except `.env.example`), keys, certificates, `storage/`, `auth.json`. Selected files are also scanned for lines that look like secrets, and the UI asks for confirmation before copying them.

## Tests

```bash
npm test
```
