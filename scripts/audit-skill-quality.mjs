#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkillCatalog } from '../src/skill-catalog.js';
import { auditSkillCatalogQuality } from '../src/skill-quality.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKILLS = join(ROOT, 'skills');
const OUTPUT = join(SKILLS, '_quality-report.json');

// skills/ só existe quando um pacote de área foi baixado por cima do core
// (dea4579). Um checkout puro do core não tem área nenhuma — não é erro.
if (!existsSync(SKILLS)) {
  console.log('Qualidade das skills: nenhuma área instalada em skills/ — checagem não aplicável.');
} else {
  const report = auditSkillCatalogQuality(discoverSkillCatalog(SKILLS));
  if (!process.argv.includes('--check')) {
    writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  const { summary } = report;
  console.log(
    `Qualidade das skills: ${summary.skills} catalogadas; `
    + `${summary.structural_pass} sem hard fail estrutural; `
    + `${summary.high_performance_eligible} elegíveis por evidência. `
    + `Maturidade: ${summary.by_status.contracted || 0} contracted, `
    + `${summary.by_status.verified || 0} verified, `
    + `${summary.by_status.certified || 0} certified, `
    + `${summary.by_status.quarantined || 0} quarantined; `
    + `${summary.behavioral_evidence_skills || 0} com forward-run persistido e `
    + `${summary.promotion_evidence_skills || 0} com evidência de promoção reconhecida.`,
  );

  // Evidência ilegível não é "sem evidência": some da contagem acima sem explicar
  // por quê, e a skill deixa de promover em silêncio. Sai em stderr, alto.
  const evidenceProblems = report.evidence_problems || [];
  if (evidenceProblems.length) {
    console.error(
      `⚠️  ${evidenceProblems.length} arquivo(s) de evidência ilegíveis — as skills correspondentes `
      + 'contam como SEM evidência e não vão promover. Corrija ou remova:',
    );
    for (const p of evidenceProblems) console.error(`   ${p.arquivo} — ${p.detalhe}`);
  }

  const productionFailures = report.results.filter(
    (item) => ['active', 'pilot'].includes(item.lifecycle) && item.hardFails.length,
  );
  if (process.argv.includes('--check') && productionFailures.length) {
    for (const item of productionFailures.slice(0, 50)) {
      console.error(`- ${item.id}: ${item.hardFails.join('; ')}`);
    }
    if (productionFailures.length > 50) {
      console.error(`- ... e mais ${productionFailures.length - 50} skills`);
    }
    process.exitCode = 1;
  }
}
