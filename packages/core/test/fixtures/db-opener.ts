// One wrapper process opening a shared data dir, for the test that two processes upgrading an old
// database at once never run a migration twice.
import { Db } from '../../src/db.ts';
import { loadConfig } from '../../src/paths.ts';

const [root] = process.argv.slice(2);
if (!root) throw new Error('usage: db-opener <root>');
const config = loadConfig({
  CSWAP_BIN: '/nonexistent/cswap',
  CLAUDE_CONFIG_DIR: `${root}/claude`,
  AGENTRY_WORKSPACE_DIR: `${root}/workspace`,
  AGENTRY_DATA_DIR: `${root}/data`,
});
process.stdout.write('opening\n');
new Db(config).close();
