// One wrapper process creating and moving work items on a shared data dir, for the test that
// several processes never hand out the same number or collide on a rank.
import { Db } from '../../src/db.ts';
import { loadConfig } from '../../src/paths.ts';
import { WorkItemService } from '../../src/work-items.ts';

const [root, label, count] = process.argv.slice(2);
if (!root || !label || !count) throw new Error('usage: work-item-writer <root> <label> <count>');
const config = loadConfig({
  CSWAP_BIN: '/nonexistent/cswap',
  CLAUDE_CONFIG_DIR: `${root}/claude`,
  AGENTRY_WORKSPACE_DIR: `${root}/workspace`,
  AGENTRY_DATA_DIR: `${root}/data`,
});
const db = new Db(config);
const service = new WorkItemService({ db, project: () => ({ keyPrefix: 'AGN', columnLimits: {} }) });
for (let i = 0; i < Number(count); i++) {
  const item = service.create('p1', { title: `${label} ${String(i)}` });
  service.move(item.id, { status: 'todo', afterId: null });
}
db.close();
