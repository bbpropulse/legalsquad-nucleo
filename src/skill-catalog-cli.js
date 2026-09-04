import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverSkillCatalog,
  findIntegrationManifest,
  gravarIndiceDeSkills,
  validateSkillCatalog,
} from './skill-catalog.js';
import { auditSkillCatalogQuality } from './skill-quality.js';
import { contractSkillCatalog, generateSkillOpenAiMetadata } from './skill-contract.js';

function projectProfilesPath(targetDir) {
  const path = join(targetDir, '_legalsquad', 'core', 'skill-quality-profiles.json');
  return existsSync(path) ? path : undefined;
}

function validateProjectCatalog(targetDir) {
  const skillsDir = join(targetDir, 'skills');
  // O manifesto de integração vem do pacote de área e cada área nomeia o seu;
  // aqui ele é descoberto pelo padrão, e sua ausência apenas desliga a checagem
  // (uma instalação pode não ter pacote de área instalado ainda).
  const integrationPath = findIntegrationManifest(skillsDir);
  return validateSkillCatalog({
    skillsDir,
    integrationPath,
    requireIntegration: Boolean(integrationPath),
    // Production installs intentionally do not receive the preserved preview
    // source directories. Validate the manifest's own table, not their local
    // presence. The package/repository gate uses the strict default instead.
    requireCanonicalSources: false,
  });
}

function printErrors(result) {
  for (const error of result.errors) {
    console.error(`  - [${error.code}] ${error.message}`);
  }
}

export function indexSkillsProject(targetDir) {
  const skillsDir = join(targetDir, 'skills');
  if (!existsSync(skillsDir)) {
    console.error('Diretório skills/ ausente. Execute `npx legalsquad init` primeiro.');
    return { success: false };
  }
  const catalog = discoverSkillCatalog(skillsDir);
  gravarIndiceDeSkills(skillsDir, catalog);
  const result = validateProjectCatalog(targetDir);
  if (!result.ok) {
    console.error(`Índice gerado, mas o catálogo tem ${result.errors.length} problema(s):`);
    printErrors(result);
    return { success: false, result };
  }
  console.log(`Indexadas ${catalog.entries.length} skills; catálogo íntegro e fresco.`);
  return { success: true, result };
}

export function checkSkillsProject(targetDir) {
  const skillsDir = join(targetDir, 'skills');
  if (!existsSync(skillsDir)) {
    console.error('Diretório skills/ ausente. Execute `npx legalsquad init` primeiro.');
    return { success: false };
  }
  const result = validateProjectCatalog(targetDir);
  if (!result.ok) {
    console.error(`Catálogo de skills inválido (${result.errors.length} problema(s)):`);
    printErrors(result);
    return { success: false, result };
  }
  console.log(`Catálogo íntegro: ${result.catalog.entries.length} skills; índice fresco; grafo válido.`);
  return { success: true, result };
}

// `skills` (opcional) restringe a auditoria a esses ids — é o que o Gate 5 do
// Arquiteto precisa: conferir a skill que o squad acabou de criar. Sem o
// filtro, numa instalação de aluno (6.584 skills) a auditoria leva meio
// minuto e devolve um relatório de milhares de linhas para checar UMA skill.
// Com filtro, o relatório em disco NÃO é sobrescrito: `_quality-report.json`
// é o retrato da biblioteca inteira, e um retrato de uma skill só no lugar
// dele mentiria para o próximo leitor.
export function auditSkillsProject(targetDir, { skills = [] } = {}) {
  const skillsDir = join(targetDir, 'skills');
  if (!existsSync(skillsDir)) {
    console.error('Diretório skills/ ausente. Execute `npx legalsquad init` primeiro.');
    return { success: false };
  }
  const completo = discoverSkillCatalog(skillsDir);
  const escopo = new Set(skills.map((s) => String(s).trim()).filter(Boolean));
  const desconhecidas = [...escopo].filter((id) => !completo.entries.some((e) => e.id === id));
  if (desconhecidas.length) {
    console.error(`Skill(s) não instalada(s): ${desconhecidas.join(', ')}`);
    return { success: false, desconhecidas };
  }
  const catalog = escopo.size
    ? { ...completo, entries: completo.entries.filter((e) => escopo.has(e.id)) }
    : completo;
  const report = auditSkillCatalogQuality(catalog, {
    profilesPath: projectProfilesPath(targetDir),
  });
  if (!escopo.size) {
    writeFileSync(join(skillsDir, '_quality-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(
    `Auditoria concluída: ${report.summary.skills} skills; `
    + `${report.summary.structural_pass} sem hard fail estrutural; `
    + `${report.summary.high_performance_eligible} elegíveis por evidência. `
    + `Maturidade: ${report.summary.by_status.contracted || 0} contracted, `
    + `${report.summary.by_status.verified || 0} verified, `
    + `${report.summary.by_status.certified || 0} certified, `
    + `${report.summary.by_status.quarantined || 0} quarantined; `
    + `${report.summary.behavioral_evidence_skills || 0} com forward-run persistido e `
    + `${report.summary.promotion_evidence_skills || 0} com evidência de promoção reconhecida.`,
  );
  return { success: true, report };
}

// Applies the full v5 operational contract to the project's skills/ library and
// reindexes. Structural only: it never grants maturity — `verified`/`certified`
// come from behavioural evidence and are judged by `audit-skills`.
// This is the cwd-aware twin of the package-root dev pipeline
// (migrate-skills-v5 + generate-skill-openai-metadata + indexar-skills). The
// Architect runs it after authoring a new skill so the skill ships with the
// contract body block, its references/high-performance-contract.md, its
// agents/openai.yaml, a registered eval case, and a fresh index — reproducibly,
// without the dev build tooling.
export function contractSkillsProject(targetDir, { force = false } = {}) {
  const skillsDir = join(targetDir, 'skills');
  if (!existsSync(skillsDir)) {
    console.error('Diretório skills/ ausente. Execute `npx legalsquad init` primeiro.');
    return { success: false };
  }
  const profilesPath = projectProfilesPath(targetDir);
  const contract = contractSkillCatalog({ root: targetDir, force, profilesPath });
  const ui = generateSkillOpenAiMetadata({ root: targetDir, profilesPath });
  const catalog = discoverSkillCatalog(skillsDir);
  gravarIndiceDeSkills(skillsDir, catalog);
  const result = validateProjectCatalog(targetDir);
  console.log(
    `Contrato operacional v5 (estrutural) aplicado: ${contract.catalog_skills} skills; `
    + `${contract.changed} contratada(s)/atualizada(s), ${contract.skipped} já conformes; `
    + `${contract.generated_contract_evals} evals de contrato; `
    + `${ui.generated} agents/openai.yaml; índice regenerado. `
    + 'Contrato cumprido não é desempenho comprovado.',
  );
  if (!result.ok) {
    console.error(`Catálogo com ${result.errors.length} problema(s) após o contrato:`);
    printErrors(result);
    return { success: false, result, contract, ui };
  }
  console.log('Catálogo íntegro e fresco. Rode `npx legalsquad audit-skills` para a maturidade.');
  return { success: true, result, contract, ui };
}
