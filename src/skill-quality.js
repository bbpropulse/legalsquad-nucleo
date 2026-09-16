import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseList, parseScalar } from './frontmatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_PATH = join(
  __dirname,
  '..',
  '_legalsquad',
  'core',
  'skill-quality-profiles.json',
);

export const SKILL_QUALITY_STATUSES = Object.freeze([
  'legacy',
  'contracted',
  'verified',
  'certified',
  'quarantined',
]);

export const PROMOTION_EVIDENCE_SCHEMA_VERSION = 'legalsquad.skill-promotion-evidence/v1';

// These are promotion floors, not recommendations. A team may demand more
// scenarios/reviewers, but lowering them would invalidate cross-installation
// comparability. R4 certification deliberately requires two independent humans.
export const PROMOTION_EVIDENCE_MINIMUMS = Object.freeze({
  r1: Object.freeze({ cases: 5, verifiedReviewers: 1, certifiedReviewers: 1, certifiedHumans: 1 }),
  r2: Object.freeze({ cases: 5, verifiedReviewers: 1, certifiedReviewers: 1, certifiedHumans: 1 }),
  r3: Object.freeze({ cases: 8, verifiedReviewers: 1, certifiedReviewers: 2, certifiedHumans: 1 }),
  r4: Object.freeze({ cases: 12, verifiedReviewers: 2, certifiedReviewers: 2, certifiedHumans: 2 }),
});

// Regras de mecanismo: classificam pela FUNÇÃO da skill (redigir, calcular,
// periciar, publicar, orquestrar), nunca pela matéria jurídica que ela trata.
// O motor não conhece o catálogo da área instalada e por isso não lista nomes
// de skills aqui — quando estas regras não couberem, a skill declara
// `metadata.quality_profile` no próprio frontmatter, e essa declaração tem
// precedência (ver `evaluateSkillQuality`). É lá que o pacote de área resolve
// seus casos particulares, não neste arquivo.
const PROFILE_PATTERNS = [
  {
    profile: 'external-action',
    pattern: /^(?:apify|blotato|canva|image-ai-generator|instagram-publisher|publicacao-redes)(?:\s|$)/i,
  },
  {
    profile: 'system-orchestration',
    pattern: /^image-fetcher(?:\s|$)/i,
  },
  {
    profile: 'legal-calculation',
    pattern: /^calculadora-[a-z0-9-]+(?:\s|$)|\bcalculador|\bc[aá]lculo\b|\bcalculo-|\bcontagem-de-prazo\b/i,
  },
  {
    profile: 'authority-content',
    pattern: /^(?:conte[uú]do-|copywriting|instagram-|linkedin-|twitter-|youtube-|blog-|newsletter|publica[cç][aã]o-redes)/i,
  },
  {
    profile: 'external-action',
    pattern: /\bemail\b|agenda|calend|assinatura|protocolo|publicar|monitor-dje|\bdjen\b|intima[cç][aã]o|resend|gmail|whatsapp|social-publish/i,
  },
  {
    profile: 'client-operations',
    pattern: /triagem|cliente|atendimento|onboarding|follow-up|dashboard|carteira|honor[aá]rio|crm|relatorio-cliente|fam[ií]lia/i,
  },
  {
    profile: 'evidence-forensics',
    pattern: /^leitura-[a-z0-9-]+(?:\s|$)|\bprova|per[ií]cia|laudo|cadeia|cust[oó]dia|ocr|pdf|imagem|cftv|deepfake|manuscrito|transcri[cç][aã]o|classificador|extrator|documental|depoimento|reconhecimento/i,
  },
  {
    profile: 'system-orchestration',
    pattern: /^(?:legalsquad-|skill-|squad-|template-designer|apify|blotato|canva|image-creator|obsidian-vault)|\b(?:orquestra[cç][aã]o|infraestrutura|indexar|auditoria-qualidade)\b/i,
  },
  {
    profile: 'legal-drafting',
    // Vocabulário de REDAÇÃO forense, comum a qualquer área: peça, petição,
    // recurso, memoriais, minuta. Nomes de peças típicas de uma área (e as suas
    // siglas) não entram aqui — quem escreve a skill declara o perfil.
    pattern: /\bpe[cç]a(?:s)?\b|peti[cç][aã]o|minuta|manifesta[cç][aã]o|alega[cç][oõ]es-finais|memoriais|recurso|apela[cç][aã]o|agravo|embargos|contrarrazoes|contestacao|requerimento|redacao-|reda[cç][aã]o/i,
  },
];

const LEGAL_PROFILES = new Set(['legal-drafting', 'legal-analysis', 'legal-calculation']);
const UNTRUSTED_INPUT_PROFILES = new Set(['evidence-forensics', 'external-action', 'system-orchestration']);

export function loadSkillQualityProfiles(path = DEFAULT_PROFILES_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw?.contract_version || !raw?.profiles) {
    throw new Error(`Perfis de qualidade inválidos: ${path}`);
  }
  return raw;
}

export function classifySkillQualityProfile(entry) {
  const meta = entry.metadata || {};
  const haystack = [
    entry.id,
    entry.group,
    meta.type,
    ...(meta.categories || []),
  ].join(' ');

  for (const candidate of PROFILE_PATTERNS) {
    if (candidate.pattern.test(haystack)) return candidate.profile;
  }
  return 'legal-analysis';
}

function frontmatterTopLevelKeys(frontmatter) {
  if (!frontmatter) return [];
  return frontmatter
    .split('\n')
    .map((line) => line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/)?.[1])
    .filter(Boolean);
}

function bodyFromRaw(raw) {
  const match = raw.replace(/\r\n/g, '\n').match(/^---\n[\s\S]*?\n---\n?/);
  return match ? raw.slice(match[0].length) : raw;
}

function localMarkdownReferences(raw) {
  const result = [];
  for (const match of raw.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
    if (target && !/^(?:https?:|mailto:|data:|#)/i.test(target)) result.push(target);
  }
  return result;
}

export function loadSkillEvalCases(skillsDir) {
  const evalsDir = join(skillsDir, '_evals');
  const cases = new Map();
  if (!existsSync(evalsDir)) return cases;

  for (const file of readdirSync(evalsDir).filter((name) => name.endsWith('.json')).sort()) {
    let suite;
    try {
      suite = JSON.parse(readFileSync(join(evalsDir, file), 'utf8'));
    } catch {
      continue;
    }
    for (const item of suite.cases || []) {
      if (item?.id) cases.set(item.id, item);
    }
  }
  return cases;
}

function evaluationResultFiles(resultsDir) {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(resultsDir, entry.name);
    if (entry.isDirectory()) return evaluationResultFiles(path);
    return entry.isFile() && entry.name.endsWith('.json') ? [path] : [];
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimestamp(value, { dateTimeOnly = false } = {}) {
  if (!nonEmptyString(value) || !Number.isFinite(Date.parse(value))) return false;
  return !dateTimeOnly || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

function validModel(value) {
  return isRecord(value)
    && nonEmptyString(value.provider)
    && nonEmptyString(value.name)
    && nonEmptyString(value.version);
}

function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function modelFingerprint(value) {
  return validModel(value) ? `${value.provider}\0${value.name}\0${value.version}` : '';
}

export function computeSkillContentSha256(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function readSkillEvidenceBinding(skillsDir, skill) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(skill || ''))) return null;
  const skillPath = join(skillsDir, skill, 'SKILL.md');
  if (!existsSync(skillPath)) return null;
  const raw = readFileSync(skillPath, 'utf8');
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  return {
    algorithm: 'sha256',
    skill_sha256: computeSkillContentSha256(raw),
    skill_version: parseScalar(frontmatter, 'version') || '',
    contract_version: parseScalar(frontmatter, 'contract_version') || '',
    risk_level: (parseScalar(frontmatter, 'risk_level') || '').toLowerCase(),
  };
}

function validateCommonPromotionFields(suite, result, binding, failures) {
  if (suite?.schema_version !== PROMOTION_EVIDENCE_SCHEMA_VERSION) {
    failures.push(`schema_version deve ser ${PROMOTION_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(suite?.suite)) failures.push('suite ausente');
  if (!nonEmptyString(result?.evidence_id)) failures.push('evidence_id ausente');
  if (!nonEmptyString(result?.skill)) failures.push('skill ausente');
  if (!validTimestamp(result?.evaluated_at || suite?.evaluated_at, { dateTimeOnly: true })) {
    failures.push('evaluated_at deve ser timestamp ISO 8601 com hora');
  }
  const model = result?.execution_model || suite?.execution_model;
  if (!validModel(model)) failures.push('execution_model exige provider, name e version');
  const evaluator = result?.evaluator || suite?.evaluator;
  if (!isRecord(evaluator) || !nonEmptyString(evaluator.id) || !['human', 'model'].includes(evaluator.type)) {
    failures.push('evaluator exige id e type human|model');
  } else if (evaluator.type === 'model' && !validModel(evaluator.model || model)) {
    failures.push('evaluator model exige identificação versionada do modelo');
  }

  const declared = result?.skill_binding;
  if (!binding) failures.push('SKILL referenciada não existe');
  if (!isRecord(declared)) {
    failures.push('skill_binding ausente');
  } else if (binding) {
    if (declared.algorithm !== 'sha256') failures.push('skill_binding.algorithm deve ser sha256');
    if (declared.skill_sha256 !== binding.skill_sha256) failures.push('skill_binding.skill_sha256 divergente');
    if (declared.skill_version !== binding.skill_version) failures.push('skill_binding.skill_version divergente');
    if (declared.contract_version !== binding.contract_version) failures.push('skill_binding.contract_version divergente');
  }
}

function validateBaseline(baseline, scenarios, executionModel, minimum, failures) {
  if (!isRecord(baseline)) {
    failures.push('baseline controlado ausente');
    return;
  }
  if (baseline.method !== 'same-cases-without-skill') {
    failures.push('baseline.method deve ser same-cases-without-skill');
  }
  if (!validTimestamp(baseline.executed_at, { dateTimeOnly: true })) {
    failures.push('baseline.executed_at inválido');
  }
  if (!validModel(baseline.model) || modelFingerprint(baseline.model) !== modelFingerprint(executionModel)) {
    failures.push('baseline deve usar o mesmo modelo versionado da execução');
  }
  const caseIds = Array.isArray(baseline.case_ids) ? baseline.case_ids : [];
  const scenarioIds = scenarios.map((scenario) => scenario?.id).filter(nonEmptyString);
  if (caseIds.length < minimum.cases || new Set(caseIds).size !== caseIds.length) {
    failures.push(`baseline exige ao menos ${minimum.cases} case_ids únicos`);
  }
  if (caseIds.length !== scenarioIds.length
    || caseIds.some((id) => !scenarioIds.includes(id))) {
    failures.push('baseline e execução devem usar exatamente os mesmos casos');
  }
  const withoutSkill = baseline.without_skill_score;
  const withSkill = baseline.with_skill_score;
  const improvement = baseline.improvement;
  if (![withoutSkill, withSkill, improvement].every(Number.isFinite)) {
    failures.push('baseline exige scores numéricos e improvement');
    return;
  }
  if (!['higher-is-better', 'lower-is-better'].includes(baseline.direction)) {
    failures.push('baseline.direction inválida');
    return;
  }
  const calculated = baseline.direction === 'higher-is-better'
    ? withSkill - withoutSkill
    : withoutSkill - withSkill;
  if (Math.abs(calculated - improvement) > 1e-9 || improvement <= 0) {
    failures.push('baseline não demonstra melhoria positiva reproduzível');
  }
}

function validateReviewers(reviewers, awardedStatus, risk, evaluator, failures) {
  const minimum = PROMOTION_EVIDENCE_MINIMUMS[risk];
  if (!Array.isArray(reviewers)) {
    failures.push('reviewers ausente');
    return;
  }
  const required = awardedStatus === 'certified'
    ? minimum.certifiedReviewers
    : minimum.verifiedReviewers;
  const ids = reviewers.map((reviewer) => reviewer?.id).filter(nonEmptyString);
  if (reviewers.length < required) failures.push(`${risk} ${awardedStatus} exige ${required} revisor(es)`);
  if (ids.length !== reviewers.length || new Set(ids).size !== ids.length) {
    failures.push('reviewers devem ter ids distintos');
  }
  if (ids.includes(evaluator?.id)) failures.push('revisor deve ser distinto do avaliador');
  for (const reviewer of reviewers) {
    if (!isRecord(reviewer)
      || !['human', 'model'].includes(reviewer.type)
      || reviewer.independent !== true
      || reviewer.decision !== 'approved'
      || !validTimestamp(reviewer.reviewed_at, { dateTimeOnly: true })) {
      failures.push('todo revisor deve ser independente, identificado, datado e aprovar explicitamente');
      continue;
    }
    if (reviewer.type === 'model' && !validModel(reviewer.model)) {
      failures.push(`revisor modelo ${reviewer.id || '(sem id)'} sem modelo versionado`);
    }
  }
  if (awardedStatus === 'certified') {
    const humans = reviewers.filter((reviewer) => reviewer?.type === 'human').length;
    if (humans < minimum.certifiedHumans) {
      failures.push(`${risk} certified exige ${minimum.certifiedHumans} revisor(es) humano(s)`);
    }
  }
}

// Validates the dedicated, versioned promotion envelope against both the
// mechanical policy and the exact SKILL bytes installed locally. A JSON Schema
// is shipped for authoring/tooling; this resolver remains dependency-free and
// fail-closed at runtime.
export function validateSkillPromotionEvidence(suite, result, binding) {
  const failures = [];
  validateCommonPromotionFields(suite, result, binding, failures);
  const awardedStatus = String(result?.awarded_status || '').toLowerCase();
  const verdict = String(result?.verdict || '').toLowerCase();

  if (awardedStatus === 'revoked') {
    if (verdict !== 'revoked' || !nonEmptyString(result?.revocation_reason)) {
      failures.push('revogação exige verdict revoked e revocation_reason');
    }
    return {
      valid: failures.length === 0,
      qualifiesForPromotion: false,
      awardedStatus,
      failures,
    };
  }

  if (!['verified', 'certified'].includes(awardedStatus)) {
    failures.push('awarded_status deve ser verified, certified ou revoked');
  }
  const risk = String(result?.risk_level || '').toLowerCase();
  const minimum = PROMOTION_EVIDENCE_MINIMUMS[risk];
  if (!minimum) failures.push('risk_level inválido');
  if (binding && risk !== binding.risk_level) failures.push('risk_level diverge da SKILL');
  if (result?.behavioral_run !== true) failures.push('behavioral_run deve ser true');
  if (verdict !== 'pass') failures.push('verdict deve ser pass');
  if (!Array.isArray(result?.hard_fails) || result.hard_fails.length !== 0) {
    failures.push('hard_fails deve ser array vazio');
  }

  const scenarios = Array.isArray(result?.scenarios) ? result.scenarios : [];
  if (minimum && scenarios.length < minimum.cases) {
    failures.push(`${risk} exige ao menos ${minimum.cases} cenários executados`);
  }
  const ids = scenarios.map((scenario) => scenario?.id).filter(nonEmptyString);
  if (ids.length !== scenarios.length || new Set(ids).size !== ids.length) {
    failures.push('cenários devem ter ids distintos');
  }
  const kinds = new Set(scenarios.map((scenario) => scenario?.kind));
  if (!kinds.has('normal') || !kinds.has('adversarial')) {
    failures.push('cenários devem cobrir normal e adversarial');
  }
  if (scenarios.some((scenario) => scenario?.behavioral_run !== true
    || scenario?.status !== 'pass'
    || !validTimestamp(scenario?.executed_at, { dateTimeOnly: true })
    || !validSha256(scenario?.input_sha256)
    || !validSha256(scenario?.output_sha256)
    || (scenario?.trace_sha256 !== undefined && !validSha256(scenario.trace_sha256)))) {
    failures.push('todo cenário deve ser comportamental, aprovado, datado e vinculado aos hashes de input/output/trace');
  }
  if (scenarios.some((scenario) => !isRecord(scenario?.grader)
    || !nonEmptyString(scenario.grader.id)
    || !['model', 'deterministic'].includes(scenario.grader.type)
    || !validModel(scenario.grader.model)
    || !nonEmptyString(scenario.grader.rubric_version))) {
    failures.push('todo cenário exige grader versionado com id, type, model e rubric_version');
  }

  const executionModel = result?.execution_model || suite?.execution_model;
  if (minimum) validateBaseline(result?.baseline, scenarios, executionModel, minimum, failures);
  if (minimum) {
    validateReviewers(
      result?.reviewers,
      awardedStatus,
      risk,
      result?.evaluator || suite?.evaluator,
      failures,
    );
  }
  const regression = result?.regression;
  if (!isRecord(regression)
    || regression.status !== 'pass'
    || !nonEmptyString(regression.suite_id)
    || !validTimestamp(regression.executed_at, { dateTimeOnly: true })
    || !Number.isInteger(regression.case_count)
    || regression.case_count < (minimum?.cases || 1)) {
    failures.push('regressão exige suite, data, status pass e cobertura mínima');
  }

  return {
    valid: failures.length === 0,
    qualifiesForPromotion: failures.length === 0,
    awardedStatus,
    failures,
  };
}

function candidateIsLater(candidate, current) {
  if (!current) return true;
  if (candidate.timestamp !== current.timestamp) return candidate.timestamp > current.timestamp;
  if (candidate.source !== current.source) return candidate.source > current.source;
  return candidate.resultIndex > current.resultIndex;
}

// Evidence is deliberately opt-in. Legacy forward-runs remain observable, but
// only the dedicated schema can promote. Resolution is chronological: the
// latest run (pass, fail, invalid attempt or explicit revocation) supersedes an
// older pass, so stale evidence cannot silently survive a regression.
export function loadSkillEvaluationEvidence(skillsDir) {
  const evidence = new Map();
  // Problemas de LEITURA acompanham o mapa em vez de sumirem. Descartar um
  // arquivo ilegível em silêncio é indistinguível de "não há evidência": a
  // skill deixa de promover e ninguém sabe por quê. O mapa continua sendo um
  // Map (todos os chamadores usam .get()), então a assinatura não muda.
  const problemas = [];
  Object.defineProperty(evidence, 'problemas', { value: problemas, enumerable: false });

  for (const path of evaluationResultFiles(join(skillsDir, '_evals', 'results')).sort()) {
    let suite;
    try {
      suite = JSON.parse(readFileSync(path, 'utf8'));
    } catch (erro) {
      problemas.push({
        code: 'evidencia-ilegivel',
        arquivo: path,
        detalhe: `não foi possível ler como JSON: ${erro.message}`,
      });
      continue;
    }
    let resultIndex = -1;
    for (const result of suite.results || []) {
      resultIndex++;
      const skill = result?.skill;
      if (!nonEmptyString(skill)) continue;
      const awardedStatus = String(
        result?.awarded_status || result?.quality_status_awarded || '',
      ).toLowerCase();
      const behavioralRun = result?.behavioral_run === true
        || result?.evidence?.behavioral_run === true;
      const verdict = String(result?.verdict || result?.evidence?.verdict || '').toLowerCase();
      const promotionEnvelope = suite?.schema_version === PROMOTION_EVIDENCE_SCHEMA_VERSION
        || nonEmptyString(awardedStatus);
      const observedForwardRun = behavioralRun && verdict.startsWith('pass');
      if (!promotionEnvelope && !observedForwardRun) continue;

      const binding = readSkillEvidenceBinding(skillsDir, skill);
      const validation = promotionEnvelope
        ? validateSkillPromotionEvidence(suite, result, binding)
        : { valid: true, qualifiesForPromotion: false, failures: [], awardedStatus };
      const evaluatedAt = result?.evaluated_at || suite?.evaluated_at || '';
      const parsedTimestamp = Date.parse(evaluatedAt);
      const candidate = {
        skill,
        awardedStatus,
        behavioralRun,
        humanReview: Array.isArray(result?.reviewers)
          && result.reviewers.some((reviewer) => reviewer?.type === 'human' && reviewer?.decision === 'approved'),
        regression: result?.regression?.status === 'pass',
        evidenceKind: promotionEnvelope ? 'promotion' : 'forward-run',
        evidenceValid: validation.valid,
        validationFailures: validation.failures,
        qualifiesForPromotion: validation.qualifiesForPromotion,
        evaluatedAt,
        timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Number.NEGATIVE_INFINITY,
        source: relative(skillsDir, path).replaceAll('\\', '/'),
        resultIndex,
      };
      const current = evidence.get(skill);
      if (candidateIsLater(candidate, current)) evidence.set(skill, candidate);
    }
  }
  return evidence;
}

function hasTerms(text, terms) {
  return terms.some((term) => term.test(text));
}

function minimumBehavioralCases(riskLevel) {
  return PROMOTION_EVIDENCE_MINIMUMS[String(riskLevel || '').toLowerCase()]?.cases || 8;
}

function certificationWave(entry, qualityStatus) {
  const lifecycle = entry.metadata?.lifecycle || 'active';
  if (qualityStatus === 'quarantined' || lifecycle === 'quarantined') return 'quarantine-remediation';
  if (lifecycle === 'preview') return 'preview-integration';
  if (lifecycle === 'pilot') return 'pilot-forward-runs';
  if (entry.metadata?.riskLevel === 'r4') return 'r4-production';
  if (entry.metadata?.riskLevel === 'r3') return 'r3-specialized';
  return 'r2-productivity';
}

export function evaluateSkillQuality(entry, {
  profiles = loadSkillQualityProfiles(),
  evalCases = new Map(),
  evidence = new Map(),
} = {}) {
  const profileId = parseScalar(entry.frontmatter, 'quality_profile')
    || classifySkillQualityProfile(entry);
  const profile = profiles.profiles[profileId];
  const body = bodyFromRaw(entry.raw);
  const description = entry.metadata?.description || '';
  const topLevelKeys = frontmatterTopLevelKeys(entry.frontmatter);
  const unexpectedTopLevel = topLevelKeys.filter(
    (key) => !['name', 'description', 'license', 'allowed-tools', 'metadata'].includes(key),
  );
  const lineCount = entry.raw.split(/\r?\n/).length;
  const refs = localMarkdownReferences(entry.raw);
  const evalIds = parseList(entry.frontmatter, 'eval_case_ids');
  const linkedCases = evalIds.map((id) => evalCases.get(id)).filter(Boolean);
  const kinds = new Set(linkedCases.flatMap((item) => (item.scenarios || []).map((scenario) => scenario.kind)));
  const hasScript = existsSync(join(dirname(entry.skillPath), 'scripts'))
    || /scripts\/[A-Za-z0-9_./-]+/.test(entry.raw)
    || (entry.metadata?.engines || []).length > 0;
  const hasProfileReference = refs.includes('references/high-performance-contract.md');
  const qualityStatus = (parseScalar(entry.frontmatter, 'quality_status') || 'legacy').toLowerCase();
  const lifecycle = (entry.metadata?.lifecycle || 'active').toLowerCase();
  const behavioralEvidence = evidence.get(entry.id) || null;

  const checks = {
    official_frontmatter: unexpectedTopLevel.length === 0,
    description_valid: description.length > 0 && description.length <= 1024 && !/[<>]/.test(description),
    description_front_loaded: /^(?:use|utilize|analisa|avalia|redige|elabora|produz|converte|extrai|monitora|calcula|classifica|estrutura|cria|automatiza)/i.test(description),
    description_boundary: /n[aã]o use|n[aã]o utilizar|fora do escopo|n[aã]o substitui/i.test(description),
    contract_marker: /LEGALSQUAD:HP-CONTRACT:START/.test(body),
    contract_reference: hasProfileReference,
    inputs_declared: /\*\*Entrada|Entradas m[ií]nimas/i.test(body) || hasProfileReference,
    blockers_declared: /\*\*Bloqueio|hard stop|blocked/i.test(body) || hasProfileReference,
    output_declared: /\*\*Sa[ií]da|output/i.test(body) || hasProfileReference,
    workflow_declared: /\*\*Processo|workflow|fluxo|procedimento/i.test(body) || hasProfileReference,
    feedback_loop: hasTerms(body, [/validar.+corrigir.+validar/is, /revis[aã]o/i]) || hasProfileReference,
    deterministic_resource: profileId !== 'legal-calculation' || hasScript,
    provenance_gate: !LEGAL_PROFILES.has(profileId)
      || hasTerms(body, [/fonte oficial/i, /cita[cç][aã]o/i, /proveni[eê]ncia/i])
      || hasProfileReference,
    security_gate: !UNTRUSTED_INPUT_PROFILES.has(profileId)
      || hasTerms(body, [/n[aã]o confi[aá]vel/i, /prompt injection/i, /nunca como instru[cç][aã]o/i])
      || hasProfileReference,
    human_checkpoint: hasTerms(body, [/revis[aã]o humana/i, /checkpoint/i, /aprova[cç][aã]o humana/i])
      || hasProfileReference,
    eval_linked: evalIds.length > 0 && linkedCases.length === evalIds.length,
    eval_normal: kinds.has('normal'),
    eval_adversarial: kinds.has('adversarial'),
    eval_hard_fails: linkedCases.length > 0 && linkedCases.every((item) => item.hard_fail_if?.length),
    context_budget: lineCount <= 500,
    references_one_level: refs.every((target) => !target.startsWith('../') && target.split('/').length <= 2),
    quality_status_valid: SKILL_QUALITY_STATUSES.includes(qualityStatus),
    evidence_required_satisfied: !['verified', 'certified'].includes(qualityStatus)
      || (behavioralEvidence
        && behavioralEvidence.qualifiesForPromotion
        && (behavioralEvidence.awardedStatus === qualityStatus
          || behavioralEvidence.awardedStatus === 'certified')),
  };

  const dimensions = {
    discovery: [
      ['official_frontmatter', 2],
      ['description_valid', 2],
      ['description_front_loaded', 3],
      ['description_boundary', 3],
    ],
    contract: [
      ['contract_marker', 3],
      ['contract_reference', 3],
      ['inputs_declared', 3],
      ['blockers_declared', 3],
      ['output_declared', 3],
    ],
    workflow: [
      ['workflow_declared', 8],
      ['feedback_loop', 7],
    ],
    resources: [
      ['deterministic_resource', 10],
    ],
    provenance: [
      ['provenance_gate', 15],
    ],
    security: [
      ['security_gate', 8],
      ['human_checkpoint', 7],
    ],
    evals: [
      ['eval_linked', 5],
      ['eval_normal', 3],
      ['eval_adversarial', 3],
      ['eval_hard_fails', 4],
    ],
    context: [
      ['context_budget', 3],
      ['references_one_level', 2],
    ],
  };

  const dimensionScores = {};
  let score = 0;
  for (const [dimension, items] of Object.entries(dimensions)) {
    const value = items.reduce((sum, [key, weight]) => sum + (checks[key] ? weight : 0), 0);
    dimensionScores[dimension] = value;
    score += value;
  }

  const hardFails = [];
  if (!checks.official_frontmatter) hardFails.push(`frontmatter não oficial: ${unexpectedTopLevel.join(', ')}`);
  if (!checks.description_valid) hardFails.push('description inválida');
  if (!checks.contract_marker || !checks.contract_reference) hardFails.push('contrato v5 ausente');
  if (!checks.eval_linked || !checks.eval_adversarial) hardFails.push('eval normal/adversarial não vinculada');
  if (!checks.deterministic_resource) hardFails.push('cálculo sem recurso determinístico declarado');
  if (!checks.security_gate) hardFails.push('input não confiável sem guard explícito');
  if (!checks.evidence_required_satisfied) {
    hardFails.push(`${qualityStatus} sem evidência comportamental persistida compatível`);
  }

  return {
    id: entry.id,
    profile: profileId,
    profileLabel: profile?.label || profileId,
    qualityStatus,
    lifecycle,
    score,
    dimensionScores,
    checks,
    hardFails,
    lineCount,
    evalIds,
    behavioralEvidence,
    minimumBehavioralCases: minimumBehavioralCases(entry.metadata?.riskLevel),
    certificationWave: certificationWave(entry, qualityStatus),
    highPerformanceEligible: ['verified', 'certified'].includes(qualityStatus)
      && ['active', 'pilot'].includes(lifecycle)
      && score >= 90
      && hardFails.length === 0
      && checks.evidence_required_satisfied,
  };
}

export function auditSkillCatalogQuality(catalog, options = {}) {
  const profiles = options.profiles || loadSkillQualityProfiles(options.profilesPath);
  const evalCases = options.evalCases || loadSkillEvalCases(catalog.skillsDir);
  const evidence = options.evidence || loadSkillEvaluationEvidence(catalog.skillsDir);
  const results = catalog.entries.map((entry) => evaluateSkillQuality(entry, {
    profiles,
    evalCases,
    evidence,
  }));
  const byProfile = {};
  const byStatus = {};
  const byLifecycle = {};
  const byWave = {};
  for (const result of results) {
    byProfile[result.profile] = (byProfile[result.profile] || 0) + 1;
    byStatus[result.qualityStatus] = (byStatus[result.qualityStatus] || 0) + 1;
    byLifecycle[result.lifecycle] = (byLifecycle[result.lifecycle] || 0) + 1;
    byWave[result.certificationWave] = (byWave[result.certificationWave] || 0) + 1;
  }
  const production = results.filter((result) => ['active', 'pilot'].includes(result.lifecycle));
  return {
    schema_version: '1',
    contract_version: profiles.contract_version,
    // Arquivos de evidência que não puderam ser lidos. Sobem até aqui para o
    // relatório poder distinguir "esta skill não tem evidência" de "a evidência
    // dela existe mas está corrompida" — que exigem ações opostas.
    evidence_problems: Array.isArray(evidence?.problemas) ? evidence.problemas : [],
    summary: {
      skills: results.length,
      production_skills: production.length,
      structural_pass: results.filter((result) => result.score >= 90 && result.hardFails.length === 0).length,
      high_performance_eligible: results.filter((result) => result.highPerformanceEligible).length,
      behavioral_evidence_skills: results.filter((result) => result.behavioralEvidence).length,
      promotion_evidence_skills: results.filter(
        (result) => result.behavioralEvidence?.qualifiesForPromotion,
      ).length,
      invalid_promotion_evidence_skills: results.filter(
        (result) => result.behavioralEvidence?.evidenceKind === 'promotion'
          && !result.behavioralEvidence.evidenceValid,
      ).length,
      revoked_promotion_evidence_skills: results.filter(
        (result) => result.behavioralEvidence?.awardedStatus === 'revoked',
      ).length,
      hard_fail_skills: results.filter((result) => result.hardFails.length > 0).length,
      by_profile: byProfile,
      by_status: byStatus,
      by_lifecycle: byLifecycle,
      by_certification_wave: byWave,
      minimum_behavioral_cases_backlog: results
        .filter((result) => !result.highPerformanceEligible && result.qualityStatus !== 'quarantined')
        .reduce((sum, result) => sum + result.minimumBehavioralCases, 0),
    },
    results,
  };
}
