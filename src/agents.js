import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const registry = createRegistry({
  // Agents ship as flat {id}.md files in the claude-code IDE template — the same
  // bundle the init/install-global flows copy into the project's .claude/agents/.
  bundleDir: join(__dirname, '..', 'templates', 'ide-templates', 'claude-code', '.claude', 'agents'),
  resourceName: 'agent',
  sourceFile: 'AGENT.md',
  sourceLayout: 'flat',
  installedDir: join('.claude', 'agents'),
  installLayout: 'file',
  installedExt: '.md',
  excludeInstalled: ['README'], // .claude/agents/README.md is the index, not an agent
  metaFields: [
    { key: 'category', kind: 'scalar' },
    { key: 'icon', kind: 'scalar' },
    { key: 'version', kind: 'scalar' },
  ],
});

export const listInstalled = registry.listInstalled;
export const listAvailable = registry.listAvailable;
export const getAgentMeta = registry.getMeta;
export const installAgent = registry.install;
export const removeAgent = registry.remove;
export const getAgentVersion = registry.getVersion;
export const clearMetaCache = registry.clearMetaCache;
export const getLocalizedDescription = registry.getLocalizedDescription;
