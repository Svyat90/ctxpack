import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { listFiles } from '../src/scan.js';
import { createContext } from '../src/related/index.js';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'laravel');

export function fixture(overrides = {}) {
  const cfg = loadConfig(FIXTURE);
  Object.assign(cfg.related, overrides);
  const scan = listFiles(FIXTURE, cfg, { useGit: false });
  return { cfg, scan, ctx: createContext(FIXTURE, scan.files, cfg) };
}

export const P = {
  userController: 'app/Http/Controllers/UserController.php',
  baseController: 'app/Http/Controllers/Controller.php',
  storeRequest: 'app/Http/Requests/StoreUserRequest.php',
  user: 'app/Models/User.php',
  hasRoles: 'app/Models/Concerns/HasRoles.php',
  orderService: 'app/Services/OrderService.php',
  baseService: 'app/Services/BaseService.php',
  contract: 'app/Services/Contracts/ServiceContract.php',
  migration: 'database/migrations/2024_01_01_000000_create_users_table.php',
  factory: 'database/factories/UserFactory.php',
  web: 'routes/web.php',
  usersIndex: 'resources/js/Pages/Users/Index.vue',
  dataTable: 'resources/js/Components/DataTable.vue',
  sortHeader: 'resources/js/Components/SortHeader.vue',
  layout: 'resources/js/Layouts/AppLayout.vue',
  test: 'tests/Feature/UserControllerTest.php',
  services: 'config/services.php',
};
