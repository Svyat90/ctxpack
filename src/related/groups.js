// What kind of file a suggestion is, for grouping in the UI. Checked in this order, first match wins
// (tests before controllers, so UserControllerTest.php is a test; policies before models, so app/Models/Policies is a policy).
const MATCH = [
  ['tests', p => p.startsWith('tests/') || /(?:^|\/)__tests__\//.test(p) || /\.(?:test|spec)\.\w+$/.test(p)],
  ['policies', p => /\/Policies\//.test(p)],
  ['requests', p => /\/Http\/Requests\//.test(p)],
  ['resources', p => /\/Http\/Resources\//.test(p)],
  ['controllers', p => /\/Http\/Controllers\//.test(p) || /Controller\.php$/.test(p)],
  ['models', p => /\/Models\//.test(p)],
  ['services', p => /(?:^|\/)Services\//.test(p)],
  ['routes', p => p.startsWith('routes/')],
  ['database', p => p.startsWith('database/')],
  ['pages', p => /^resources\/(?:js|ts)\/[Pp]ages\//.test(p)],
  ['components', p => /\.(?:vue|jsx|tsx)$/.test(p)],
  ['scripts', p => /\.(?:js|mjs|cjs|ts)$/.test(p)],
  ['php', p => p.endsWith('.php')],
];

// Display order of the groups.
export const GROUPS = ['controllers', 'requests', 'resources', 'models', 'policies', 'services', 'php', 'routes', 'database', 'pages', 'components', 'scripts', 'tests', 'other'];

export const groupOf = p => (MATCH.find(([, test]) => test(p)) || ['other'])[0];
