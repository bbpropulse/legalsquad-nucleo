import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSkillCatalog } from './skill-catalog.js';
import { auditSkillCatalogQuality } from './skill-quality.js';

export const NATIVE_RUNTIME_SKILLS = Object.freeze(['web_search', 'web_fetch']);

const NATIVE_RUNTIME_SKILL_SET = new Set(NATIVE_RUNTIME_SKILLS);
const ALLOWED_QUALITY_STATUSES = new Set(['contracted', 'verified', 'certified']);
const HIGH_PERFORMANCE_STATUSES = new Set(['verified', 'certified']);

function asSet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

function asMap(value) {
  if (value instanceof Map) return value;
  if (value && typeof value === 'object') return new Map(Object.entries(value));
  return new Map();
}

function reason(code, message) {
  return { code, message };
}

function isHighPerformanceRecord(record) {
  return HIGH_PERFORMANCE_STATUSES.has(String(record?.qualityStatus || '').toLowerCase())
    && record?.highPerformanceEligible === true;
}

function blockedDecision(id, reasons, record = null) {
  return {
    id,
    allowed: false,
    disposition: 'blocked',
    lifecycle: record?.lifecycle || 'missing',
    qualityStatus: record?.qualityStatus || 'missing',
    highPerformanceEligible: isHighPerformanceRecord(record),
    requiresHumanSupervision: record?.qualityStatus === 'contracted',
    fallback: null,
    reasons,
  };
}

function evaluateBasePolicy(record, { supervised = false } = {}) {
  const reasons = [];
  const lifecycle = String(record.lifecycle || '').toLowerCase();
  const qualityStatus = String(record.qualityStatus || '').toLowerCase();

  if (!['active', 'pilot'].includes(lifecycle)) {
    const lifecycleCode = ['preview', 'deprecated', 'quarantined'].includes(lifecycle)
      ? `lifecycle-${lifecycle}-blocked`
      : 'lifecycle-invalid-blocked';
    reasons.push(reason(
      lifecycleCode,
      `lifecycle '${lifecycle || 'ausente'}' não pode executar em produção`,
    ));
  }

  if (!ALLOWED_QUALITY_STATUSES.has(qualityStatus)) {
    const statusCode = ['legacy', 'quarantined'].includes(qualityStatus)
      ? `quality-${qualityStatus}-blocked`
      : 'quality-invalid-blocked';
    reasons.push(reason(
      statusCode,
      `quality_status '${qualityStatus || 'ausente'}' não é executável`,
    ));
  }

  if ((record.hardFails || []).length > 0 || Number(record.score || 0) < 90) {
    reasons.push(reason(
      'structural-gate-failed',
      'a skill possui hard fail ou não atingiu o piso estrutural de 90 pontos',
    ));
  }

  if (HIGH_PERFORMANCE_STATUSES.has(qualityStatus) && !record.highPerformanceEligible) {
    reasons.push(reason(
      'promotion-evidence-missing',
      `${qualityStatus} sem elegibilidade comportamental persistida compatível`,
    ));
  }

  if (qualityStatus === 'contracted' && !supervised) {
    reasons.push(reason(
      'human-supervision-required',
      'contracted exige supervisão humana explícita durante toda a execução',
    ));
  }

  return reasons;
}

/**
 * Avalia uma única skill já materializada no catálogo de runtime.
 * A função é pura quando `records` é fornecido, facilitando testes de política.
 */
export function evaluateSkillRuntime(record, options = {}) {
  if (!record?.id) {
    return blockedDecision('unknown', [reason('skill-record-invalid', 'registro da skill inválido')]);
  }

  if (record.native === true || NATIVE_RUNTIME_SKILL_SET.has(record.id)) {
    return {
      id: record.id,
      allowed: true,
      disposition: 'native',
      lifecycle: 'native',
      qualityStatus: 'native',
      // Native tools bypass the catalogue gate, but are not evidence-certified
      // agent skills and therefore never win automatic skill selection.
      highPerformanceEligible: false,
      requiresHumanSupervision: false,
      fallback: null,
      reasons: [],
    };
  }

  const supervised = options.supervised === true;
  const reasons = evaluateBasePolicy(record, { supervised });
  let fallback = null;

  if (String(record.lifecycle || '').toLowerCase() === 'pilot') {
    const pilotOptIns = asSet(options.pilotOptIns);
    const pilotFallbacks = asMap(options.pilotFallbacks);
    if (!pilotOptIns.has(record.id)) {
      reasons.push(reason(
        'pilot-opt-in-required',
        'pilot exige opt-in explícito e específico para esta execução',
      ));
    }

    const fallbackId = pilotFallbacks.get(record.id);
    if (!fallbackId) {
      reasons.push(reason(
        'pilot-active-fallback-required',
        'pilot exige fallback active declarado',
      ));
    } else if (fallbackId === record.id) {
      reasons.push(reason(
        'pilot-fallback-self-reference',
        'pilot não pode usar a si própria como fallback',
      ));
    } else {
      const fallbackRecord = options.records?.get(fallbackId);
      if (!fallbackRecord) {
        reasons.push(reason(
          'pilot-fallback-missing',
          `fallback '${fallbackId}' não foi encontrado no catálogo instalado`,
        ));
      } else if (fallbackRecord.lifecycle !== 'active') {
        reasons.push(reason(
          'pilot-fallback-not-active',
          `fallback '${fallbackId}' precisa ter lifecycle active`,
        ));
      } else {
        const fallbackReasons = evaluateBasePolicy(fallbackRecord, { supervised });
        if (fallbackReasons.length > 0) {
          reasons.push(reason(
            'pilot-fallback-not-executable',
            `fallback '${fallbackId}' não passou no gate: ${fallbackReasons.map((item) => item.code).join(', ')}`,
          ));
        } else {
          fallback = fallbackId;
        }
      }
    }
  }

  if (reasons.length > 0) return blockedDecision(record.id, reasons, record);

  const highPerformanceEligible = isHighPerformanceRecord(record);
  return {
    id: record.id,
    allowed: true,
    disposition: highPerformanceEligible ? 'high-performance' : 'supervised-contracted',
    lifecycle: record.lifecycle,
    qualityStatus: record.qualityStatus,
    highPerformanceEligible,
    requiresHumanSupervision: record.qualityStatus === 'contracted',
    fallback,
    reasons: [],
  };
}

export function loadSkillRuntimeRecords(rootDir) {
  const skillsDir = join(rootDir, 'skills');
  if (!existsSync(skillsDir)) {
    throw new Error(`Diretório de skills ausente: ${skillsDir}`);
  }

  const catalog = discoverSkillCatalog(skillsDir);
  // Mesma tolerância de src/skill-search.js: os perfis de qualidade são um
  // vocabulário do motor (não por área), então uma raiz que não replica
  // _legalsquad/core/ (uma área instalada, não um projeto inteiro) cai no
  // arquivo real do motor em vez de falhar.
  const profilesPath = join(rootDir, '_legalsquad', 'core', 'skill-quality-profiles.json');
  const audit = auditSkillCatalogQuality(catalog, {
    profilesPath: existsSync(profilesPath) ? profilesPath : undefined,
  });
  const qualityById = new Map(audit.results.map((result) => [result.id, result]));
  const records = new Map();

  for (const entry of catalog.entries) {
    const quality = qualityById.get(entry.id);
    records.set(entry.id, {
      id: entry.id,
      lifecycle: entry.metadata?.lifecycle || '',
      qualityStatus: quality?.qualityStatus || entry.metadata?.qualityStatus || '',
      highPerformanceEligible: quality?.highPerformanceEligible === true,
      score: quality?.score || 0,
      hardFails: quality?.hardFails || ['auditoria de qualidade ausente'],
    });
  }

  return { records, audit };
}

function missingSkillDecision(id) {
  return blockedDecision(id, [reason(
    'skill-not-installed',
    `skills/${id}/SKILL.md não foi encontrado`,
  )]);
}

function qualityRank(decision) {
  if (decision.qualityStatus === 'certified') return 2;
  if (decision.qualityStatus === 'verified') return 1;
  return 0;
}

/**
 * Resolve uma lista explícita ou seleciona automaticamente um candidato.
 * Em `selection`, apenas high_performance_eligible pode ser escolhido.
 */
export function resolveSkillRuntime(skillIds, options = {}) {
  const mode = ['selection', 'explicit-selection'].includes(options.mode)
    ? options.mode
    : 'execution';
  const ids = [...new Set((skillIds || []).map((id) => String(id).trim()).filter(Boolean))];

  if (ids.length === 0) {
    return {
      success: false,
      mode,
      selected: null,
      decisions: [],
      error: reason('skill-list-empty', 'nenhuma skill foi informada ao resolvedor'),
    };
  }

  // Nativas têm bypass declarado do gate de catálogo: uma lista 100% nativa não
  // pode ser bloqueada pela ausência de skills/ (o load lança sem o diretório).
  // Qualquer id de catálogo na lista reativa o caminho fail-closed integral.
  const somenteNativas = ids.every((id) => NATIVE_RUNTIME_SKILL_SET.has(id));
  const loaded = options.records
    ? { records: options.records, audit: options.audit || null }
    : somenteNativas
      ? { records: new Map(), audit: null }
      : loadSkillRuntimeRecords(options.rootDir || process.cwd());
  const records = loaded.records;

  const decisions = ids.map((id) => {
    if (NATIVE_RUNTIME_SKILL_SET.has(id)) {
      return evaluateSkillRuntime({ id, native: true }, options);
    }
    const record = records.get(id);
    return record
      ? evaluateSkillRuntime(record, { ...options, records })
      : missingSkillDecision(id);
  });

  if (mode === 'selection') {
    const candidates = decisions
      .map((decision, index) => ({ decision, index }))
      .filter(({ decision }) => decision.allowed && decision.highPerformanceEligible)
      .sort((left, right) => (
        qualityRank(right.decision) - qualityRank(left.decision)
        || Number(left.decision.lifecycle === 'pilot') - Number(right.decision.lifecycle === 'pilot')
        || left.index - right.index
      ));
    const selected = candidates[0]?.decision.id || null;
    return {
      success: Boolean(selected),
      mode,
      selected,
      decisions,
      error: selected ? null : reason(
        'no-high-performance-candidate',
        'nenhum candidato high_performance_eligible passou no gate; não houve seleção automática',
      ),
    };
  }

  if (mode === 'explicit-selection') {
    if (ids.length !== 1) {
      return {
        success: false,
        mode,
        selected: null,
        decisions,
        error: reason(
          'explicit-selection-requires-one',
          'seleção explícita exige exatamente uma skill nominal; valide listas no modo execution',
        ),
      };
    }
    const selected = decisions[0].allowed ? decisions[0].id : null;
    return {
      success: Boolean(selected),
      mode,
      selected,
      decisions,
      error: selected ? null : reason(
        'explicit-selection-blocked',
        'a skill escolhida explicitamente não passou no gate de execução',
      ),
    };
  }

  return {
    success: decisions.every((decision) => decision.allowed),
    mode,
    selected: null,
    decisions,
    error: null,
  };
}
