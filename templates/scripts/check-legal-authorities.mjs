#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function localIsoDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysBetween(a, b) {
  return Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function isFresh(record, today) {
  const age = daysBetween(record.verified_at, today);
  const limits = { same_day: 0, daily: 1, weekly: 7, monthly: 31, on_change: Infinity };
  return age >= 0 && age <= (limits[record.revalidate_policy] ?? -1);
}

export function checkLegalAuthorities({
  today = localIsoDate(),
  root = DEFAULT_ROOT,
  registryDir = join(root, '_legalsquad', 'core', 'authorities'),
  skillsDir = join(root, 'skills'),
} = {}) {
  const problems = [];
  const warnings = [];
  let records = 0;
  const REGISTRY = registryDir;
  // core/authorities/ só existe quando um pacote de área foi instalado por
  // cima do core: apesar do caminho passar por "core/", o CONTEÚDO é de
  // área, não de núcleo (MIKE-CHEFE.md: "skills de matéria, squads,
  // best-practices, agentes especialistas, core/authorities/ — chegam por
  // [pacote]"). O que É do núcleo é o CONTRATO
  // (authority-record.schema.json, presente); os REGISTROS não. Núcleo puro
  // sem área instalada não ter nenhum registro não é erro.
  if (!existsSync(REGISTRY)) return { ok: true, problems: [], warnings, records, notApplicable: true };

  for (const file of readdirSync(REGISTRY).filter((name) => name.endsWith('.json')).sort()) {
    let item;
    try { item = JSON.parse(readFileSync(join(REGISTRY, file), 'utf8')); } catch (error) {
      problems.push(`${file}: JSON inválido (${error.message})`);
      continue;
    }
    records++;
    if (item.schema_version !== '1' || !item.topic) problems.push(`${file}: contrato básico inválido`);
    if (!['active', 'pilot', 'quarantined'].includes(item.operational_status)) problems.push(`${file}: operational_status inválido`);
    if (!ISO_DATE.test(item.verified_at || '')) problems.push(`${file}: verified_at inválido`);
    if (!['same_day', 'daily', 'weekly', 'monthly', 'on_change'].includes(item.revalidate_policy)) problems.push(`${file}: revalidate_policy inválida`);
    if (!item.human_review || !['pending', 'approved', 'rejected'].includes(item.human_review.status)) problems.push(`${file}: human_review inválida`);
    if (item.operational_status === 'active' && item.human_review?.status !== 'approved') problems.push(`${file}: active sem revisão humana aprovada`);
    if (!isFresh(item, today)) {
      const message = `${file}: autoridade expirada para ${today} (${item.revalidate_policy}; verificada em ${item.verified_at})`;
      if (item.operational_status === 'active') problems.push(message); else warnings.push(message);
    }
    const sourceIds = new Set();
    for (const source of item.sources || []) {
      if (!source.id || sourceIds.has(source.id)) problems.push(`${file}: source id ausente/duplicado`);
      sourceIds.add(source.id);
      if (!/^https:\/\//.test(source.official_url || '')) problems.push(`${file}/${source.id}: URL oficial inválida`);
      if (!ISO_DATE.test(source.verified_at || '')) problems.push(`${file}/${source.id}: verified_at inválido`);
      if (!['verified_official', 'discovery_only', 'quarantined'].includes(source.status)) problems.push(`${file}/${source.id}: status inválido`);
    }
    for (const skill of item.affected_skills || []) {
      if (!existsSync(join(skillsDir, skill, 'SKILL.md'))) problems.push(`${file}: skill afetada inexistente ${skill}`);
    }
  }
  return { ok: problems.length === 0, problems, warnings, records };
}

function main() {
  const result = checkLegalAuthorities();
  for (const warning of result.warnings) console.warn(`AVISO: ${warning}`);
  if (result.notApplicable) {
    console.log('Autoridades jurídicas: nenhuma área instalada em core/authorities/ — checagem não aplicável.');
  } else if (!result.ok) {
    console.error(result.problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Autoridades jurídicas: ${result.records} registros estruturalmente válidos.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
