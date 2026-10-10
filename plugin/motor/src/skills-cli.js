import {
  listInstalled,
  installSkill,
  removeSkill,
  getSkillMeta,
  getLocalizedDescription,
} from './skills.js';
import { createResourceCli } from './resource-cli.js';

export const skillsCli = createResourceCli({
  resource: {
    listInstalled,
    install: installSkill,
    remove: removeSkill,
    getMeta: getSkillMeta,
    getLocalizedDescription,
  },
  i18nPrefix: 'skills',
  header: 'LegalSquad Skills',
  browseLine: 'Browse available skills at: https://github.com/bbpropulse/legalsquad/tree/main/skills',
  formatListItem: (meta, desc) => {
    const parts = [meta.name];
    if (meta.type) parts.push(`(${meta.type})`);
    parts.push(`- ${desc.split('.')[0]}`);
    return parts.join(' ');
  },
  logResource: 'skill',
  usage: {
    install: '\n  Usage: legalsquad install <id>   (or: legalsquad skills install <id>)\n',
    remove: '\n  Usage: legalsquad uninstall <id>   (or: legalsquad skills remove <id>)\n',
    updateOne: '\n  Usage: legalsquad update <name>\n',
  },
});
