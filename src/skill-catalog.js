import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  extractFrontMatter,
  getSkillLifecyclePolicy,
  parseSkillMetadata,
  SKILL_LIFECYCLES,
} from './frontmatter.js';
import { auditSkillCatalogQuality } from './skill-quality.js';
import { parseBestPracticesCatalog } from './best-practices-catalog.js';
import { medirOriginalidade } from './skill-originality.js';
import { contemBaseLegalVerificada } from './base-legal.js';
import { contemPrecedentesIdentificados } from './precedentes.js';

// O agrupamento é mecanismo — serve para o agente de roteamento ler o catálogo
// em blocos em vez de uma lista plana. A TAXONOMIA, porém, é da área: o motor
// não conhece os ramos do Direito do pacote instalado e não pode carregar uma
// tabela de ramos de nenhuma área. Por isso o grupo vem do que a própria skill
// declara em `categories:`, e só dois eixos genéricos restam como fallback:
// ferramenta (type != prompt) e "Outras". Um pacote de área que queira grupos
// próprios só precisa declarar a categoria certa em cada SKILL.md.
const TOOLING_GROUP = 'Integrações e ferramentas';
const FALLBACK_GROUP = 'Outras';

// Caudas fixas da ordenação: grupos declarados pela área vêm primeiro (em ordem
// alfabética), depois ferramentas e, por último, o balde das não classificadas.
const GROUP_TAIL = [TOOLING_GROUP, FALLBACK_GROUP];

function groupRank(group) {
  const index = GROUP_TAIL.indexOf(group);
  return index === -1 ? 0 : index + 1;
}

function humanizeGroup(category) {
  const label = String(category || '').trim().replace(/[_-]+/g, ' ');
  if (!label) return '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// `name` continua na assinatura por compatibilidade com os chamadores, mas
// deliberadamente não classifica mais nada: prefixo de nome é convenção de cada
// área, e adivinhar matéria pelo nome era exatamente o que prendia o motor a uma
// área só.
export function classifySkillGroup(categories, type, name) { // eslint-disable-line no-unused-vars
  const declared = (categories || []).map(humanizeGroup).find(Boolean);
  if (declared) return declared;
  if (type && type !== 'prompt') return TOOLING_GROUP;
  return FALLBACK_GROUP;
}

export function summarizeSkillDescription(description) {
  if (!description) return '';
  let summary = description.split(/\s+Aciona com[:.]/i)[0].trim();
  if (summary.length > 170) {
    summary = `${summary.slice(0, 167).replace(/\s+\S*$/, '')}…`;
  }
  return summary;
}

export function discoverSkillCatalog(skillsDir) {
  const directories = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const entries = [];
  const missingSkillFiles = [];
  for (const id of directories) {
    // A camada local VENCE a do pacote. É ela que o agente recebe — o
    // enriquecimento só serve para alguma coisa se for o que de fato carrega.
    // O `SKILL.md` do pacote continua no disco e continua sendo atualizado
    // pelo sync; ele vira a base sobre a qual a adaptação existe.
    const localPath = join(skillsDir, id, 'SKILL.local.md');
    const packPath = join(skillsDir, id, 'SKILL.md');
    const local = existsSync(localPath);
    const skillPath = local ? localPath : packPath;

    if (!existsSync(skillPath)) {
      missingSkillFiles.push(id);
      continue;
    }

    const raw = readFileSync(skillPath, 'utf8');
    const metadata = parseSkillMetadata(raw, { fallbackName: id });
    // Informa ao gate se o frontmatter foi realmente lido: sem isso, um
    // SKILL.md ilegível passava por "sem lifecycle declarado" e herdava o
    // default `active`.
    const frontmatter = extractFrontMatter(raw);
    const policy = getSkillLifecyclePolicy(metadata?.lifecycle, {
      frontmatterLegivel: frontmatter !== null,
    });
    entries.push({
      id,
      skillPath,
      // Procedência: distingue o que o curador publicou do que esta instalação
      // adaptou. Sem isso ninguém sabe que o conteúdo divergiu do pacote.
      local,
      raw,
      frontmatter: extractFrontMatter(raw),
      metadata,
      policy,
      group: classifySkillGroup(metadata?.categories || [], metadata?.type || 'prompt', id),
    });
  }

  entries.sort((a, b) => {
    const rank = groupRank(a.group) - groupRank(b.group);
    return rank || a.group.localeCompare(b.group) || a.id.localeCompare(b.id);
  });

  return { skillsDir, directories, entries, missingSkillFiles };
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function yamlList(values) {
  return `[${values.map((value) => yamlString(value)).join(', ')}]`;
}

/**
 * Cache do catálogo, gravado JUNTO com o índice.
 *
 * `discoverSkillCatalog` lê e parseia todo SKILL.md a cada chamada: 2,4 s por
 * consulta numa instalação de aluno (6.584 skills, medido em 03/09/2026), e o
 * Arquiteto faz várias consultas por squad. O cache guarda o que a busca
 * precisa (id, metadata, group, policy) — nunca o corpo. Vale enquanto o
 * conjunto de pastas de skill for o mesmo (contagem e nomes conferidos com um
 * readdir, barato): skill adicionada ou removida à mão invalida; edição de
 * frontmatter só entra na próxima reindexação — a mesma régua do índice.
 */
export const CACHE_DO_CATALOGO = '_catalog-cache.json';

export function gravarIndiceDeSkills(skillsDir, catalog) {
  writeFileSync(join(skillsDir, '_index.yaml'), renderSkillIndex(catalog), 'utf8');
  const cache = {
    schema: 1,
    gerado_em: new Date().toISOString(),
    entries: catalog.entries.map((e) => ({
      id: e.id,
      skillPath: relative(skillsDir, e.skillPath).split(sep).join('/'),
      local: e.local,
      metadata: e.metadata,
      policy: e.policy,
      group: e.group,
    })),
  };
  writeFileSync(join(skillsDir, CACHE_DO_CATALOGO), `${JSON.stringify(cache)}\n`, 'utf8');
}

/** Catálogo a partir do cache, ou `null` se não há cache ou ele não bate com o disco. */
export function lerCacheDoCatalogo(skillsDir) {
  const caminho = join(skillsDir, CACHE_DO_CATALOGO);
  if (!existsSync(caminho)) return null;
  let cache;
  try {
    cache = JSON.parse(readFileSync(caminho, 'utf8'));
  } catch {
    return null;
  }
  if (!cache || cache.schema !== 1 || !Array.isArray(cache.entries)) return null;
  const directories = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const ids = cache.entries.map((e) => e.id).sort((a, b) => a.localeCompare(b));
  if (ids.length !== directories.length || ids.some((id, i) => id !== directories[i])) return null;
  const entries = cache.entries.map((e) => ({
    ...e,
    skillPath: join(skillsDir, e.skillPath),
    raw: null,
    frontmatter: null,
  }));
  return { skillsDir, directories, entries, missingSkillFiles: [], doCache: true };
}

/** Hidrata uma entrada vinda do cache com o corpo real (para auditoria de candidatos). */
export function hidratarEntrada(entry) {
  if (entry.raw !== null && entry.raw !== undefined) return entry;
  const raw = readFileSync(entry.skillPath, 'utf8');
  return { ...entry, raw, frontmatter: extractFrontMatter(raw) };
}

export function renderSkillIndex(catalog) {
  const qualityBySkill = new Map(
    auditSkillCatalogQuality(catalog).results.map((result) => [result.id, result]),
  );
  // Substância entra no índice (e não é medida na busca) porque medir 5523
  // skills custa ~16s — caro demais para responder uma consulta. Aqui é pago
  // uma vez, na indexação.
  const substanciaPorSkill = new Map(
    medirOriginalidade(catalog.entries.map((entry) => ({
      id: entry.id,
      titulo: entry.metadata?.name || entry.id,
      texto: entry.raw,
    }))).skills.map((skill) => [skill.id, skill]),
  );
  const groups = new Map();
  for (const entry of catalog.entries) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }

  let yaml = '# Índice de Skills — GERADO por `npx legalsquad indexar-skills` (não editar à mão; será sobrescrito).\n';
  yaml += '# Fonte de verdade para Arquiteto, Sherlock, chefe-roteador e catalog-scout.\n';
  yaml += '# Lifecycle e maturidade são dimensões independentes; qualidade exige evidência.\n';
  yaml += `# Última indexação determinística: ${catalog.entries.length} skills.\n\n`;
  yaml += 'schema_version: 3\n';
  yaml += 'lifecycle_policy:\n';
  yaml += '  legacy_default: active\n';
  yaml += '  production_default: active\n';
  yaml += '  explicit_opt_in: pilot\n';
  yaml += '  blocked_in_production: [preview, deprecated, quarantined]\n\n';
  yaml += 'quality_policy:\n';
  yaml += '  contract_version: "5.0.0"\n';
  yaml += '  evidence_required: [verified, certified]\n';
  yaml += '  structural_only: [contracted]\n';
  yaml += '  blocked: [legacy, quarantined]\n';
  yaml += '  implicit_selection_requires: high_performance_eligible\n';
  yaml += '  contracted_execution_requires: supervised\n';
  yaml += '  promotion_evidence_schema: "legalsquad.skill-promotion-evidence/v1"\n';
  yaml += '  label_without_computed_eligibility: blocked\n\n';
  yaml += 'discovery_policy:\n';
  yaml += '  command: "npx legalsquad search-skills --query <capability> --limit 8 --json"\n';
  yaml += '  max_prompt_results: 8\n';
  yaml += '  full_index_in_prompt: false\n';
  yaml += '  query_must_exclude_case_data: true\n\n';
  yaml += 'skills:\n';

  for (const [group, entries] of groups) {
    yaml += `  # ── ${group} (${entries.length}) ──\n`;
    for (const entry of entries) {
      const meta = entry.metadata;
      yaml += `  - name: ${entry.id}\n`;
      yaml += `    type: ${meta.type}\n`;
      yaml += `    grupo: ${yamlString(group)}\n`;
      yaml += `    desc: ${yamlString(summarizeSkillDescription(meta.description))}\n`;
      yaml += `    lifecycle: ${meta.lifecycle}\n`;
      yaml += `    production_eligible: ${entry.policy.productionEligible}\n`;
      yaml += `    selection: ${entry.policy.selection}\n`;
      yaml += `    high_performance_eligible: ${qualityBySkill.get(entry.id)?.highPerformanceEligible === true}\n`;
      // Substância: o que permite ao Arquiteto distinguir capacidade real de
      // título vazio. `linhas_proprias` é o que DECIDE (absoluto, imune a
      // extração de boilerplate); `originalidade` informa quanto do arquivo é
      // molde, mas não decide.
      const substancia = substanciaPorSkill.get(entry.id);
      if (substancia) {
        yaml += `    linhas_proprias: ${substancia.linhasExclusivas}\n`;
        yaml += `    originalidade: ${substancia.originalidade.toFixed(3)}\n`;
      }
      // Sinal independente de exclusividade: duas skills irmãs que citam o
      // MESMO dispositivo (legítimo) fariam `linhas_proprias` cair a zero
      // para as duas, mesmo com conteúdo real e verificado contra fonte
      // aberta. Ver `contemBaseLegalVerificada` para o porquê.
      if (contemBaseLegalVerificada(entry.raw)) yaml += '    base_legal_verificada: true\n';
      // Terceira porta de substância — ver contemPrecedentesIdentificados.
      if (contemPrecedentesIdentificados(entry.raw)) yaml += '    precedentes_identificados: true\n';
      if (meta.version) yaml += `    version: ${yamlString(meta.version)}\n`;
      if (meta.categories.length) yaml += `    categories: ${yamlList(meta.categories)}\n`;
      if (meta.aliases.length) yaml += `    aliases: ${yamlList(meta.aliases)}\n`;
      if (meta.supersedes.length) yaml += `    supersedes: ${yamlList(meta.supersedes)}\n`;
      if (meta.coexists.length) yaml += `    coexists: ${yamlList(meta.coexists)}\n`;
      if (meta.positiveTriggers.length) yaml += `    positive_triggers: ${yamlList(meta.positiveTriggers)}\n`;
      if (meta.negativeTriggers.length) yaml += `    negative_triggers: ${yamlList(meta.negativeTriggers)}\n`;
      if (meta.nextSkills.length) yaml += `    next_skills: ${yamlList(meta.nextSkills)}\n`;
      if (meta.engines.length) yaml += `    engines: ${yamlList(meta.engines)}\n`;
      if (meta.riskLevel) yaml += `    risk: ${yamlString(meta.riskLevel)}\n`;
      if (meta.deliveryType) yaml += `    delivery_type: ${yamlString(meta.deliveryType)}\n`;
      if (meta.schemaVersion) yaml += `    skill_schema: ${yamlString(meta.schemaVersion)}\n`;
      if (meta.qualityProfile) yaml += `    quality_profile: ${yamlString(meta.qualityProfile)}\n`;
      if (meta.qualityStatus) yaml += `    quality_status: ${yamlString(meta.qualityStatus)}\n`;
      if (meta.contractVersion) yaml += `    contract_version: ${yamlString(meta.contractVersion)}\n`;
      if (meta.freshnessPolicy) yaml += `    freshness_policy: ${yamlString(meta.freshnessPolicy)}\n`;
      if (meta.guardTriggers.length) yaml += `    guard_triggers: ${yamlList(meta.guardTriggers)}\n`;
      if (meta.evalCaseIds.length) yaml += `    eval_case_ids: ${yamlList(meta.evalCaseIds)}\n`;
      if (meta.sourcePackage) yaml += `    source_package: ${yamlString(meta.sourcePackage)}\n`;
    }
  }
  return yaml;
}

function issue(code, message, path = '') {
  return { code, message, path };
}

function extractLocalMarkdownReferences(raw) {
  const references = [];
  const regex = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(raw))) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    // Markdown link titles follow whitespace; paths with spaces should use <...>.
    target = target.split(/\s+["']/)[0];
    if (!target || /^(?:#|https?:|mailto:|data:|javascript:)/i.test(target)) continue;
    if (/[{}]/.test(target)) continue; // documented placeholders are not file refs
    target = target.split('#')[0].split('?')[0];
    if (target) references.push(target);
  }
  return references;
}

function validateLocalReferences(entry, errors) {
  const skillDir = dirname(entry.skillPath);
  for (const reference of extractLocalMarkdownReferences(entry.raw)) {
    const target = isAbsolute(reference) ? normalize(reference) : resolve(skillDir, reference);
    if (!existsSync(target)) {
      errors.push(issue(
        'broken-reference',
        `${entry.id}: referência local inexistente ${reference}`,
        relative(entry.skillPath, target),
      ));
    }
  }
}

function detectCycles(edges) {
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function visit(node, trail) {
    if (visiting.has(node)) {
      const start = trail.indexOf(node);
      cycles.push([...trail.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of edges.get(node) || []) visit(target, [...trail, node]);
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of edges.keys()) visit(node, []);
  return cycles;
}

export function extractIntegrationReferences(raw) {
  const references = [];
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let section = '';
  let inSpecialized = false;
  let inWaveSkills = false;

  for (const line of lines) {
    if (/^[a-z_]+:\s*$/.test(line)) {
      section = line.slice(0, -1);
      inSpecialized = false;
      inWaveSkills = false;
      continue;
    }
    if (section === 'semantic_bridges') {
      const bridge = line.match(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/);
      if (bridge) {
        references.push({ id: bridge[1], kind: 'bridge' });
        inSpecialized = false;
        continue;
      }
      if (/^ {4}specialized:\s*$/.test(line)) {
        inSpecialized = true;
        continue;
      }
      const specialized = inSpecialized && line.match(/^ {6}- ([a-z0-9][a-z0-9-]*)\s*$/);
      if (specialized) references.push({ id: specialized[1], kind: 'specialized' });
    }
    if (section === 'promotion_waves') {
      if (/^ {4}skills:\s*$/.test(line)) {
        inWaveSkills = true;
        continue;
      }
      if (/^ {2}- wave:/.test(line)) inWaveSkills = false;
      const promoted = inWaveSkills && line.match(/^ {6}- ([a-z0-9][a-z0-9-]*)\s*$/);
      if (promoted) references.push({ id: promoted[1], kind: 'promotion-wave' });
    }
  }
  return references;
}

function parseTargets(value) {
  return value
    .split(',')
    .map((target) => target.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

// Parses the deliberately compact canonicalization table in the integration
// manifest. It supports both inline rows and the expanded MS row whose action
// and gate live on separate lines.
export function parseCanonicalization(raw) {
  const marker = raw.match(/^canonicalization:\s*$/m);
  if (!marker) return null;
  const section = raw.slice(marker.index);
  const counts = {};
  for (const match of section.matchAll(/^ {4}(ADD|MERGE|SPLIT|ABSORB):\s*(\d+)\s*$/gm)) {
    counts[match[1]] = Number(match[2]);
  }

  const lines = section.replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    const inline = lines[index].match(/^ {4}- \{source:\s*([^,}]+),\s*action:\s*(ADD|MERGE|SPLIT|ABSORB),\s*targets:\s*\[([^\]]*)\]\s*\}\s*$/);
    if (inline) {
      entries.push({ source: inline[1].trim(), action: inline[2], targets: parseTargets(inline[3]) });
      continue;
    }

    const expanded = lines[index].match(/^ {4}- source:\s*([^\s]+)\s*$/);
    if (!expanded) continue;
    let action = '';
    let targets = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if (/^ {4}- /.test(lines[cursor]) || (/^[a-z_]+:\s*$/.test(lines[cursor]) && !lines[cursor].startsWith(' '))) break;
      const actionMatch = lines[cursor].match(/^ {6}action:\s*(ADD|MERGE|SPLIT|ABSORB)\s*$/);
      if (actionMatch) action = actionMatch[1];
      const targetMatch = lines[cursor].match(/^ {6}targets:\s*\[([^\]]*)\]\s*$/);
      if (targetMatch) targets = parseTargets(targetMatch[1]);
    }
    entries.push({ source: expanded[1], action, targets });
  }
  return { counts, entries };
}

export function parseDeterministicEngines(raw) {
  const marker = raw.match(/^deterministic_engines:\s*$/m);
  if (!marker) return [];
  const section = raw.slice(marker.index).split(/^canonicalization:\s*$/m)[0];
  const lines = section.replace(/\r\n/g, '\n').split('\n');
  const engines = [];
  let current = null;
  for (const line of lines) {
    const id = line.match(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/);
    if (id) {
      current = { id: id[1], file: '', canonicalSkills: [] };
      engines.push(current);
      continue;
    }
    if (!current) continue;
    const file = line.match(/^ {4}file:\s*([^\s]+)\s*$/);
    if (file) current.file = file[1];
    const skills = line.match(/^ {4}canonical_skills:\s*\[([^\]]*)\]\s*$/);
    if (skills) current.canonicalSkills = parseTargets(skills[1]);
  }
  return engines;
}

function validateDeterministicEngines(raw, catalog, errors, {
  integrationPath,
  requireSourceSkills,
}) {
  const engines = parseDeterministicEngines(raw);
  if (!engines.length) {
    errors.push(issue('invalid-engine-registry', 'manifesto sem deterministic_engines', integrationPath));
    return;
  }
  const ids = new Set(catalog.entries.map((entry) => entry.id));
  const engineIds = new Set();
  const rootDir = dirname(catalog.skillsDir);
  for (const engine of engines) {
    if (engineIds.has(engine.id)) {
      errors.push(issue('invalid-engine-registry', `engine duplicado: ${engine.id}`, integrationPath));
    }
    engineIds.add(engine.id);
    if (!engine.file || !existsSync(resolve(rootDir, engine.file))) {
      errors.push(issue('broken-reference', `engine ${engine.id}: arquivo inexistente ${engine.file || '(vazio)'}`, integrationPath));
    }
    if (!engine.canonicalSkills.length) {
      errors.push(issue('invalid-engine-registry', `engine ${engine.id}: canonical_skills vazio`, integrationPath));
    }
    if (requireSourceSkills) {
      for (const skill of engine.canonicalSkills) {
        if (!ids.has(skill)) {
          errors.push(issue('invalid-engine-registry', `engine ${engine.id}: skill canônica inexistente ${skill}`, integrationPath));
        }
      }
    }
  }

  for (const entry of catalog.entries) {
    for (const engine of entry.metadata.engines) {
      if (!engineIds.has(engine)) {
        errors.push(issue('invalid-engine-registry', `${entry.id}: engine ${engine} não registrado no manifesto`, entry.skillPath));
      }
    }
  }
}

// Só os ids importam aqui (validar alvo de canonicalização); a leitura em si
// é única, em best-practices-catalog.js — reusada por empacotamento, busca e
// squad-check, pra não ter quatro parsers do mesmo `_catalog.yaml` divergindo.
function parseBestPracticeIds(path) {
  return new Set(parseBestPracticesCatalog(path).map((entrada) => entrada.id));
}

function validateCanonicalization(raw, catalog, errors, {
  integrationPath,
  bestPracticesCatalogPath,
  requireSourceSkills,
}) {
  const canonicalization = parseCanonicalization(raw);
  if (!canonicalization) {
    errors.push(issue('invalid-canonicalization', 'manifesto sem canonicalization.entries', integrationPath));
    return;
  }

  const allowedActions = new Set(['ADD', 'MERGE', 'SPLIT', 'ABSORB']);
  const sources = new Map();
  const actionCounts = { ADD: 0, MERGE: 0, SPLIT: 0, ABSORB: 0 };
  for (const entry of canonicalization.entries) {
    if (sources.has(entry.source)) {
      errors.push(issue('invalid-canonicalization', `fonte canônica duplicada: ${entry.source}`, integrationPath));
    } else {
      sources.set(entry.source, entry);
    }
    if (!allowedActions.has(entry.action)) {
      errors.push(issue('invalid-canonicalization', `${entry.source}: action ausente ou inválida`, integrationPath));
      continue;
    }
    actionCounts[entry.action]++;
    if (!entry.targets.length) {
      errors.push(issue('invalid-canonicalization', `${entry.source}: nenhum target declarado`, integrationPath));
    }
    if (new Set(entry.targets).size !== entry.targets.length) {
      errors.push(issue('invalid-canonicalization', `${entry.source}: target duplicado`, integrationPath));
    }
    if (entry.action === 'SPLIT' && entry.targets.length < 2) {
      errors.push(issue('invalid-canonicalization', `${entry.source}: SPLIT exige ao menos dois targets`, integrationPath));
    }
  }

  for (const action of allowedActions) {
    const declared = canonicalization.counts[action];
    if (declared !== actionCounts[action]) {
      errors.push(issue(
        'invalid-canonicalization',
        `contagem ${action}: manifesto declara ${declared ?? '(ausente)'}, tabela contém ${actionCounts[action]}`,
        integrationPath,
      ));
    }
  }

  const packId = raw.match(/^ {2}id:\s*([^\s]+)\s*$/m)?.[1] || '';
  const declaredPackSize = Number(raw.match(/^ {2}skills:\s*(\d+)\s*$/m)?.[1] || 0);
  // As fontes do pack são as skills que DECLARAM `source_package: <id do pack>`.
  // Não há mais heurística por prefixo de nome: prefixo é convenção de área e o
  // motor não conhece a do pacote instalado. Sem nenhuma skill declarando
  // procedência, os cruzamentos por fonte são pulados — o que dá para validar
  // sem elas (ações, targets, cobertura da tabela) continua valendo.
  const expectedSources = catalog.entries
    .filter((entry) => entry.metadata.sourcePackage === packId)
    .map((entry) => entry.id);
  const crossCheckSources = requireSourceSkills && expectedSources.length > 0;

  if (crossCheckSources && declaredPackSize && expectedSources.length !== declaredPackSize) {
    errors.push(issue(
      'invalid-canonicalization',
      `pack declara ${declaredPackSize} skills, catálogo encontrou ${expectedSources.length}`,
      integrationPath,
    ));
  }
  if (declaredPackSize && canonicalization.entries.length !== declaredPackSize) {
    errors.push(issue(
      'invalid-canonicalization',
      `pack declara ${declaredPackSize} skills, canonicalization cobre ${canonicalization.entries.length}`,
      integrationPath,
    ));
  }

  const expectedSet = new Set(expectedSources);
  if (crossCheckSources) {
    for (const source of expectedSources) {
      if (!sources.has(source)) {
        errors.push(issue('invalid-canonicalization', `fonte do pack sem decisão canônica: ${source}`, integrationPath));
      }
    }
    for (const source of sources.keys()) {
      if (!expectedSet.has(source)) {
        errors.push(issue('invalid-canonicalization', `canonicalization contém fonte fora do pack: ${source}`, integrationPath));
      }
    }
  }

  const ids = new Set(catalog.entries.map((entry) => entry.id));
  const aliases = new Set(catalog.entries.flatMap((entry) => entry.metadata.aliases));
  const addTargets = new Set(canonicalization.entries
    .filter((entry) => entry.action === 'ADD')
    .flatMap((entry) => entry.targets));
  const bestPractices = parseBestPracticeIds(bestPracticesCatalogPath);
  const rootDir = dirname(catalog.skillsDir);

  function resolves(target, action) {
    if (ids.has(target) || aliases.has(target) || addTargets.has(target) || bestPractices.has(target)) return true;
    if (action !== 'ABSORB') return false;
    if (target === 'tests' || target === 'evals' || /^gate-[a-z0-9-]+$/.test(target)) return true;
    if (target.startsWith('acervo/')) return existsSync(resolve(rootDir, target));
    return false;
  }

  for (const entry of canonicalization.entries) {
    for (const target of entry.targets) {
      if (!resolves(target, entry.action)) {
        errors.push(issue(
          'invalid-canonicalization',
          `${entry.source}: target ${target} não resolve para skill, alias, destino ADD, best-practice ou absorção permitida`,
          integrationPath,
        ));
      }
    }
  }
}

function validateGraph(catalog, errors) {
  const ids = new Set(catalog.entries.map((entry) => entry.id));
  const entriesById = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const aliases = new Map();
  const supersedes = new Map();

  for (const entry of catalog.entries) {
    const meta = entry.metadata;
    for (const alias of meta.aliases) {
      if (alias === entry.id) {
        errors.push(issue('invalid-graph', `${entry.id}: alias aponta para o próprio id`));
      } else if (ids.has(alias)) {
        const shadowed = entriesById.get(alias);
        // Canonical active skills may retain the exact id of an imported
        // preview/deprecated/quarantined source as a compatibility alias while
        // that source remains preserved for audit. The integration manifest is
        // the authority that decides routing between them.
        if (entry.policy.productionEligible && !shadowed.policy.productionEligible) {
          aliases.set(alias, entry.id);
        } else {
          errors.push(issue('invalid-graph', `${entry.id}: alias ${alias} colide com uma skill existente`));
        }
      } else if (aliases.has(alias) && aliases.get(alias) !== entry.id) {
        errors.push(issue('invalid-graph', `${entry.id}: alias ${alias} já pertence a ${aliases.get(alias)}`));
      } else {
        aliases.set(alias, entry.id);
      }
    }

    const relations = [
      ['supersedes', meta.supersedes],
      ['coexists', meta.coexists],
      ['next_skills', meta.nextSkills],
    ];
    for (const [kind, targets] of relations) {
      for (const target of targets) {
        if (target === entry.id) {
          errors.push(issue('invalid-graph', `${entry.id}: ${kind} contém autorreferência`));
        } else if (!ids.has(target)) {
          errors.push(issue('invalid-graph', `${entry.id}: ${kind} aponta para skill inexistente ${target}`));
        }
      }
    }
    supersedes.set(entry.id, meta.supersedes.filter((target) => ids.has(target)));
  }

  for (const cycle of detectCycles(supersedes)) {
    errors.push(issue('invalid-graph', `ciclo em supersedes: ${cycle.join(' -> ')}`));
  }
}

// O manifesto de integração/canonicalização é artefato do PACOTE DE ÁREA e cada
// área nomeia o seu (`skills/_<pacote>-integration.yaml`). O motor descobre pelo
// padrão — nunca por um nome fixo, que amarraria o núcleo a uma área. Havendo
// mais de um, o primeiro em ordem alfabética é o canônico.
export const INTEGRATION_MANIFEST_PATTERN = /^_.+-integration\.ya?ml$/;

export function findIntegrationManifest(skillsDir) {
  if (!skillsDir || !existsSync(skillsDir)) return '';
  const found = readdirSync(skillsDir, { withFileTypes: true })
    .filter((item) => item.isFile() && INTEGRATION_MANIFEST_PATTERN.test(item.name))
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b));
  return found.length ? join(skillsDir, found[0]) : '';
}

export function validateSkillCatalog({
  skillsDir,
  indexPath = join(skillsDir, '_index.yaml'),
  integrationPath = findIntegrationManifest(skillsDir),
  checkIndex = true,
  requireIntegration = true,
  bestPracticesCatalogPath = join(dirname(skillsDir), '_legalsquad', 'core', 'best-practices', '_catalog.yaml'),
  requireCanonicalSources = true,
} = {}) {
  const catalog = discoverSkillCatalog(skillsDir);
  const expectedIndex = renderSkillIndex(catalog);
  const errors = [];
  const warnings = [];

  for (const id of catalog.missingSkillFiles) {
    errors.push(issue('missing-skill-file', `${id}: pasta sem SKILL.md`, join(skillsDir, id)));
  }

  for (const entry of catalog.entries) {
    const meta = entry.metadata;
    if (!entry.frontmatter || !meta) {
      errors.push(issue('invalid-frontmatter', `${entry.id}: frontmatter ausente ou inválido`, entry.skillPath));
      continue;
    }
    if (meta.name !== entry.id) {
      errors.push(issue('folder-name-mismatch', `${entry.id}: frontmatter name é ${meta.name || '(vazio)'}`, entry.skillPath));
    }
    if (!meta.description) {
      errors.push(issue('invalid-frontmatter', `${entry.id}: description ausente`, entry.skillPath));
    }
    if (!SKILL_LIFECYCLES.includes(meta.lifecycle)) {
      errors.push(issue('invalid-lifecycle', `${entry.id}: lifecycle desconhecido ${meta.lifecycle}`, entry.skillPath));
    }
    for (const engine of meta.engines) {
      const enginePath = join(dirname(skillsDir), 'scripts', 'legal-calculators', `${engine}-engine.mjs`);
      if (!existsSync(enginePath)) {
        errors.push(issue('broken-reference', `${entry.id}: engine determinístico inexistente ${engine}`, enginePath));
      }
    }
    validateLocalReferences(entry, errors);
  }

  validateGraph(catalog, errors);

  if (requireIntegration && !(integrationPath && existsSync(integrationPath))) {
    errors.push(issue(
      'missing-integration-manifest',
      'manifesto de integração do pacote de área ausente (esperado skills/_<pacote>-integration.yaml)',
      integrationPath || skillsDir,
    ));
  } else if (integrationPath && existsSync(integrationPath)) {
    const ids = new Set(catalog.entries.map((entry) => entry.id));
    const raw = readFileSync(integrationPath, 'utf8');
    const canonicalSources = new Set(parseCanonicalization(raw)?.entries.map((entry) => entry.source) || []);
    for (const reference of extractIntegrationReferences(raw)) {
      if (!ids.has(reference.id)) {
        if (!requireCanonicalSources && canonicalSources.has(reference.id)) continue;
        errors.push(issue(
          'invalid-graph',
          `manifesto: ${reference.kind} aponta para skill inexistente ${reference.id}`,
          integrationPath,
        ));
      }
    }
    validateCanonicalization(raw, catalog, errors, {
      integrationPath,
      bestPracticesCatalogPath,
      requireSourceSkills: requireCanonicalSources,
    });
    validateDeterministicEngines(raw, catalog, errors, {
      integrationPath,
      requireSourceSkills: requireCanonicalSources,
    });
  }

  if (checkIndex) {
    if (!existsSync(indexPath)) {
      errors.push(issue('stale-index', 'skills/_index.yaml ausente', indexPath));
    } else {
      const actual = readFileSync(indexPath, 'utf8');
      if (actual !== expectedIndex) {
        errors.push(issue('stale-index', 'skills/_index.yaml está desatualizado; rode npx legalsquad indexar-skills', indexPath));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    catalog,
    expectedIndex,
  };
}
