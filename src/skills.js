import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from './registry.js';
import { getSkillLifecyclePolicy } from './frontmatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const registry = createRegistry({
  bundleDir: join(__dirname, '..', 'skills'),
  resourceName: 'skill',
  sourceFile: 'SKILL.md',
  installedDir: 'skills',
  installLayout: 'dir',
  excludeInstalled: ['legalsquad-skill-creator'],
  metaFields: [
    { key: 'type', kind: 'scalar', defaultValue: 'prompt' },
    { key: 'env', kind: 'list' },
    { key: 'lifecycle', kind: 'scalar', defaultValue: 'active' },
    { key: 'version', kind: 'scalar' },
    { key: 'aliases', kind: 'list' },
    { key: 'supersedes', kind: 'list' },
    { key: 'coexists', kind: 'list', sourceKeys: ['coexists', 'coexists_with'] },
    { key: 'positiveTriggers', kind: 'list', sourceKeys: ['positive_triggers', 'triggers', 'activation_triggers'] },
    { key: 'negativeTriggers', kind: 'list', sourceKeys: ['negative_triggers', 'do_not_use_when', 'exclusion_triggers'] },
    { key: 'nextSkills', kind: 'list', sourceKeys: ['next_skills_sugeridas', 'next_skills'] },
    { key: 'engines', kind: 'list', sourceKeys: ['engines', 'deterministic_engines'] },
    { key: 'riskLevel', kind: 'scalar', sourceKeys: ['risk_level', 'risk'] },
    { key: 'deliveryType', kind: 'scalar', sourceKeys: ['delivery_type'] },
    { key: 'schemaVersion', kind: 'scalar', sourceKeys: ['schema_version'] },
    { key: 'qualityProfile', kind: 'scalar', sourceKeys: ['quality_profile'] },
    { key: 'qualityStatus', kind: 'scalar', sourceKeys: ['quality_status'], defaultValue: 'legacy' },
    { key: 'contractVersion', kind: 'scalar', sourceKeys: ['contract_version'] },
    { key: 'freshnessPolicy', kind: 'scalar', sourceKeys: ['freshness_policy'] },
    { key: 'guardTriggers', kind: 'list', sourceKeys: ['guard_triggers', 'input_guards'] },
    { key: 'evalCaseIds', kind: 'list', sourceKeys: ['eval_case_ids'] },
    { key: 'sourcePackage', kind: 'scalar', sourceKeys: ['source_package'] },
  ],
});

export const listInstalled = registry.listInstalled;
export const listAvailable = registry.listAvailable;
export const getSkillMeta = registry.getMeta;
export const installSkill = registry.install;
export const removeSkill = registry.remove;
export const getSkillVersion = registry.getVersion;
export const clearMetaCache = registry.clearMetaCache;
export const getLocalizedDescription = registry.getLocalizedDescription;

export function isSkillProductionEligible(meta) {
  return Boolean(meta) && getSkillLifecyclePolicy(meta.lifecycle).productionEligible;
}

export function isSkillAutoInstallable(meta) {
  return Boolean(meta) && getSkillLifecyclePolicy(meta.lifecycle).autoInstallable;
}
