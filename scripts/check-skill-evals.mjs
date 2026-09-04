#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFrontMatter, parseList, parseScalar } from '../src/frontmatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

function loadCases(evalsDir) {
  const cases = new Map();
  const problems = [];
  if (!existsSync(evalsDir)) return { cases, problems: ['skills/_evals ausente'] };
  for (const file of readdirSync(evalsDir).filter((name) => name.endsWith('.json')).sort()) {
    let suite;
    try { suite = JSON.parse(readFileSync(join(evalsDir, file), 'utf8')); } catch (error) {
      problems.push(`${file}: JSON inválido (${error.message})`);
      continue;
    }
    if ((suite.cases || []).length && suite.evaluation_type !== 'contract-specification') {
      problems.push(`${file}: suite de casos deve declarar evaluation_type contract-specification`);
    }
    for (const item of suite.cases || []) {
      if (!item.id || !item.skill) problems.push(`${file}: caso sem id/skill`);
      else if (cases.has(item.id)) problems.push(`${file}: id duplicado ${item.id}`);
      else cases.set(item.id, item);
      const kinds = new Set((item.scenarios || []).map((scenario) => scenario.kind));
      if (!kinds.has('normal') || !kinds.has('adversarial')) problems.push(`${item.id}: exige cenários normal e adversarial`);
      if (!Array.isArray(item.hard_fail_if) || !item.hard_fail_if.length) problems.push(`${item.id}: hard_fail_if vazio`);
      for (const scenario of item.scenarios || []) {
        if (!scenario.input || !Array.isArray(scenario.expected) || !scenario.expected.length) {
          problems.push(`${item.id}: cenário incompleto`);
        }
      }
    }
  }
  return { cases, problems };
}

export function checkSkillEvals({ root = DEFAULT_ROOT } = {}) {
  const skillsDir = join(root, 'skills');
  // skills/ só existe quando uma área foi instalada por cima do core
  // (dea4579). Núcleo puro não tem área nenhuma — não é erro, e não faz
  // sentido reportar "skills/_evals ausente" (mensagem de loadCases, real
  // quando a área EXISTE e esqueceu a pasta) quando skills/ nem existe.
  if (!existsSync(skillsDir)) {
    return { ok: true, problems: [], caseCount: 0, notApplicable: true };
  }
  const { cases, problems } = loadCases(join(skillsDir, '_evals'));
  const covered = new Set();
  for (const dir of readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const path = join(skillsDir, dir.name, 'SKILL.md');
    if (!existsSync(path)) continue;
    const fm = extractFrontMatter(readFileSync(path, 'utf8'));
    if (!fm) continue;
    const schema = parseScalar(fm, 'schema_version');
    if (!['4', '5'].includes(schema)) continue;
    const lifecycle = (parseScalar(fm, 'lifecycle') || 'active').toLowerCase();
    if (schema === '4' && !['pilot', 'active'].includes(lifecycle)) continue;
    const evalIds = parseList(fm, 'eval_case_ids');
    if (!evalIds.length) problems.push(`${dir.name}: schema v${schema} ${lifecycle} sem eval_case_ids`);
    for (const id of evalIds) {
      const item = cases.get(id);
      if (!item) problems.push(`${dir.name}: eval inexistente ${id}`);
      else if (item.skill !== dir.name) problems.push(`${dir.name}: ${id} pertence a ${item.skill}`);
      else covered.add(id);
    }
  }
  for (const id of cases.keys()) {
    if (!covered.has(id)) problems.push(`${id}: especificação de contrato órfã`);
  }
  return { ok: problems.length === 0, problems, caseCount: cases.size };
}

function main() {
  const result = checkSkillEvals();
  if (result.notApplicable) {
    console.log('Especificações de contrato de skills: nenhuma área instalada em skills/ — checagem não aplicável.');
  } else if (!result.ok) {
    console.error(result.problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Especificações de contrato de skills: ${result.caseCount} válidas e vinculadas.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
