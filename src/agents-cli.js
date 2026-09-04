import {
  listInstalled,
  installAgent,
  removeAgent,
  getAgentMeta,
  getLocalizedDescription,
} from './agents.js';
import { createResourceCli } from './resource-cli.js';

export const agentsCli = createResourceCli({
  resource: {
    listInstalled,
    install: installAgent,
    remove: removeAgent,
    getMeta: getAgentMeta,
    getLocalizedDescription,
  },
  i18nPrefix: 'agents',
  header: 'LegalSquad Agents',
  browseLine: 'Browse available agents at: https://github.com/bbpropulse/legalsquad/tree/main/agents',
  formatListItem: (meta, desc) => {
    const parts = [meta.name];
    if (meta.icon) parts.unshift(meta.icon);
    if (meta.category) parts.push(`(${meta.category})`);
    parts.push(`- ${desc.split('.')[0]}`);
    return parts.join(' ');
  },
  logResource: 'agent',
  usage: {
    install: '\n  Usage: legalsquad agents install <id>\n',
    remove: '\n  Usage: legalsquad agents remove <id>\n',
    updateOne: '\n  Usage: legalsquad update <name>\n',
  },
});
