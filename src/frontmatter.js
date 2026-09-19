// Single source of truth for parsing SKILL.md / AGENT.md YAML frontmatter.
//
// This is intentionally a focused parser instead of a general-purpose YAML
// implementation.  The registries only need scalars, folded/literal scalars,
// inline lists and simple block lists, either at the top level or inside the
// official `metadata:` map.  Keeping the supported surface explicit makes the
// catalogue deterministic without adding a runtime dependency.

export const SKILL_LIFECYCLES = Object.freeze([
  'preview',
  'pilot',
  'active',
  'deprecated',
  'quarantined',
]);

// Returns the raw frontmatter body (between the leading `---` fences) or null.
export function extractFrontMatter(raw) {
  // Remove o BOM antes de casar o `---` de abertura. Sem isso, um SKILL.md
  // salvo no Notepad/Word (que gravam BOM por padrão) tem o frontmatter
  // considerado INEXISTENTE — e o efeito era grave: sem lifecycle lido, a
  // skill caía no default `active` e virava production-eligible mesmo estando
  // quarentenada. Fail-open no gate que é a tese do produto.
  // Escrito como \uFEFF, não como o caractere literal: um BOM colado no fonte
  // é invisível na revisão e o lint o rejeita (no-irregular-whitespace).
  const content = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

function indentation(line) {
  return line.match(/^ */)?.[0].length || 0;
}

function stripMatchingQuotes(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function splitInlineList(value) {
  const inner = value.trim().slice(1, -1);
  if (!inner.trim()) return [];

  const items = [];
  let current = '';
  let quote = null;
  for (const char of inner) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      current += char;
      continue;
    }
    if (char === ',' && !quote) {
      if (current.trim()) items.push(stripMatchingQuotes(current));
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(stripMatchingQuotes(current));
  return items;
}

// Finds a direct key in a line range.  `indent` is significant so a key in an
// example/code block cannot accidentally shadow frontmatter metadata.
function findKey(lines, key, indent, start = 0, end = lines.length) {
  const prefix = `${' '.repeat(indent)}${key}:`;
  for (let index = start; index < end; index++) {
    if (lines[index].startsWith(prefix)) {
      return { index, value: lines[index].slice(prefix.length).trim() };
    }
  }
  return null;
}

function metadataRange(lines) {
  const metadata = findKey(lines, 'metadata', 0);
  if (!metadata || metadata.value) return null;
  let end = metadata.index + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && indentation(line) === 0) break;
    end++;
  }
  return { start: metadata.index + 1, end };
}

function locateKey(fm, key) {
  const lines = fm.replace(/\r\n/g, '\n').split('\n');
  const topLevel = findKey(lines, key, 0);
  if (topLevel) return { lines, ...topLevel, indent: 0 };

  const range = metadataRange(lines);
  if (!range) return null;
  const nested = findKey(lines, key, 2, range.start, range.end);
  return nested ? { lines, ...nested, indent: 2 } : null;
}

function continuationLines(lines, index, parentIndent) {
  const body = [];
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor];
    if (line.trim() && indentation(line) <= parentIndent) break;
    body.push(line);
  }
  return body;
}

/**
 * Mesma varredura de `continuationLines`, mas para listas de BLOCO: um item
 * `- valor` é uma entrada válida no MESMO nível de indentação da chave que a
 * introduz (`categories:\n- law`), não só mais recuado (`categories:\n  -
 * law`) — as duas formas são YAML válido, e a primeira é a que gera-de-lote
 * de terceiros comumente produz. `continuationLines` sozinha cortava a lista
 * no primeiro item porque exigia indentação ESTRITAMENTE maior que a chave —
 * correto para escalar em bloco (`>`/`|`, que exige recuo), errado para
 * sequência em bloco.
 */
function listContinuationLines(lines, index, parentIndent) {
  const body = [];
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor];
    if (!line.trim()) { body.push(line); continue; }
    const atual = indentation(line);
    if (atual < parentIndent) break;
    if (atual === parentIndent && !/^\s*-(\s|$)/.test(line)) break;
    body.push(line);
  }
  return body;
}

// Reads a scalar value, supporting YAML folded (`>`, `>-`) and literal (`|`,
// `|-`) scalars. Legacy top-level keys take precedence over nested metadata.
export function parseScalar(fm, key) {
  const located = locateKey(fm, key);
  if (!located) return null;

  const { lines, index, indent, value } = located;
  if (/^[>|][+-]?$/.test(value)) {
    const literal = value.startsWith('|');
    const body = continuationLines(lines, index, indent)
      .map((line) => line.trim() ? line.slice(Math.min(line.length, indent + 2)) : '');
    const rendered = literal
      ? body.join('\n').trim()
      : body.map((line) => line.trim()).filter(Boolean).join(' ').trim();
    return rendered;
  }

  if (!value || (value.startsWith('[') && value.endsWith(']'))) return value || null;
  return stripMatchingQuotes(stripComment(value));
}

/**
 * Remove comentário YAML de fim de linha (` # …`).
 *
 * Sem isso, `name: demo # nota` devolvia `"demo # nota"` — valor errado, sem
 * exceção: o pior modo de falha de um parser. Em `name:` quebra o roteamento e
 * o casamento de id; em `version:` quebra a comparação do update; em
 * `lifecycle:` fura o gate.
 *
 * Duas exceções do YAML que precisam ser respeitadas:
 *  - `#` só inicia comentário quando precedido de espaço/início — `tag#1` é valor;
 *  - dentro de aspas, `#` é conteúdo — `"peça #3"` é valor.
 *
 * Exportada de propósito: `squad-check.js` reusa esta MESMA regra em valores
 * de squad.yaml/pipeline.yaml — a semântica de comentário/aspas vive uma vez.
 */
export function stripComment(value) {
  const texto = String(value);
  let aspas = null;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === aspas) aspas = null;
      continue;
    }
    if (c === '"' || c === "'") { aspas = c; continue; }
    // Comentário exige espaço antes (ou início da linha).
    if (c === '#' && (i === 0 || /\s/.test(texto[i - 1]))) {
      return texto.slice(0, i).trim();
    }
  }
  return texto;
}

// Reads a simple YAML list, both inline (`key: [a, b]`) and block form. Lists
// may live at the top level or inside `metadata:`.
export function parseList(fm, key) {
  const located = locateKey(fm, key);
  if (!located) return [];
  const { lines, index, indent, value } = located;
  if (value.startsWith('[') && value.endsWith(']')) return splitInlineList(value);
  // Sequência de fluxo ABERTA na linha da chave e fechada linhas abaixo:
  //   transversal_skills: [
  //     apify,
  //     canva,
  //   ]
  // É YAML válido e é a forma em que um `_packs.yaml` de curadoria real foi
  // escrito. Antes, `[` sem `]` na mesma linha caía em `return []` — lista
  // VAZIA em silêncio — e o build de pacote não cortava skill transversal
  // nenhuma: fail-open exatamente onde o F1 prometia fail-closed.
  if (value.startsWith('[')) {
    const partes = [value];
    for (let i = index + 1; i < lines.length; i++) {
      const linha = stripComment(lines[i]).trim(); // `canva,   # comentário` → `canva,`
      partes.push(linha);
      if (linha.endsWith(']')) return splitInlineList(partes.join(' '));
    }
    return []; // `[` nunca fechado: não há lista a ler
  }
  if (value) return [];

  const items = [];
  for (const line of listContinuationLines(lines, index, indent)) {
    const match = line.match(/^\s*-\s+(.+)$/);
    if (match) items.push(stripMatchingQuotes(match[1]));
  }
  return items;
}

function firstScalar(fm, keys) {
  for (const key of keys) {
    const value = parseScalar(fm, key);
    if (value !== null && value !== '') return value;
  }
  return null;
}

function firstList(fm, keys, { scalarFallback = true } = {}) {
  for (const key of keys) {
    const values = parseList(fm, key);
    if (values.length) return values;
    if (scalarFallback) {
      const scalar = parseScalar(fm, key);
      if (scalar && !scalar.startsWith('[')) return [scalar];
    }
  }
  return [];
}

// Normalized metadata used by the runtime registry, the generated catalogue
// and the deterministic checker. Missing lifecycle is treated as `active` for
// backwards compatibility with the pre-lifecycle skill library.
export function parseSkillMetadata(raw, { fallbackName = '' } = {}) {
  const fm = extractFrontMatter(raw);
  if (!fm) return null;

  const explicitLifecycle = firstScalar(fm, ['lifecycle']);
  const categories = [
    ...firstList(fm, ['categories'], { scalarFallback: false }),
    ...firstList(fm, ['category']),
  ].filter(Boolean);

  return {
    name: firstScalar(fm, ['name']) || fallbackName,
    description: firstScalar(fm, ['description']) || '',
    type: firstScalar(fm, ['type']) || 'prompt',
    version: firstScalar(fm, ['version']) || '',
    lifecycle: (explicitLifecycle || 'active').toLowerCase(),
    lifecycleExplicit: Boolean(explicitLifecycle),
    categories: [...new Set(categories)],
    aliases: firstList(fm, ['aliases', 'alias']),
    supersedes: firstList(fm, ['supersedes']),
    coexists: firstList(fm, ['coexists', 'coexists_with']),
    positiveTriggers: firstList(fm, ['positive_triggers', 'triggers', 'activation_triggers']),
    negativeTriggers: firstList(fm, ['negative_triggers', 'do_not_use_when', 'exclusion_triggers']),
    nextSkills: firstList(fm, ['next_skills_sugeridas', 'next_skills', 'recommended_next_skills']),
    engines: firstList(fm, ['engines', 'deterministic_engines']),
    riskLevel: firstScalar(fm, ['risk_level', 'risk']) || '',
    deliveryType: firstScalar(fm, ['delivery_type']) || '',
    schemaVersion: firstScalar(fm, ['schema_version']) || '',
    qualityProfile: firstScalar(fm, ['quality_profile']) || '',
    qualityStatus: firstScalar(fm, ['quality_status']) || 'legacy',
    contractVersion: firstScalar(fm, ['contract_version']) || '',
    freshnessPolicy: firstScalar(fm, ['freshness_policy']) || '',
    guardTriggers: firstList(fm, ['guard_triggers', 'input_guards']),
    evalCaseIds: firstList(fm, ['eval_case_ids']),
    sourcePackage: firstScalar(fm, ['source_package']) || '',
  };
}

export function getSkillLifecyclePolicy(value = 'active', options = {}) {
  // "Não declarou lifecycle" e "não consegui ler o frontmatter" são coisas
  // diferentes e exigem respostas opostas. A primeira é legítima e cai no
  // default `active` (o legacy_default documentado no _index.yaml). A segunda
  // significa que NÃO SABEMOS o lifecycle — e afirmar `active` aí é fail-open:
  // uma skill quarentenada, com o SKILL.md ilegível, entrava em produção e era
  // auto-instalada. Sem leitura confiável, nada é elegível.
  if (options.frontmatterLegivel === false) {
    return { lifecycle: 'unknown', productionEligible: false, autoInstallable: false, selection: 'invalid' };
  }

  const lifecycle = String(value || 'active').toLowerCase();
  switch (lifecycle) {
    case 'active':
      return { lifecycle, productionEligible: true, autoInstallable: true, selection: 'default' };
    case 'pilot':
      // Pilot skills are installed so discovery can inspect/evaluate them, but
      // routing remains explicit and must declare an active fallback.
      return { lifecycle, productionEligible: true, autoInstallable: true, selection: 'explicit' };
    case 'preview':
      return { lifecycle, productionEligible: false, autoInstallable: false, selection: 'test-only' };
    case 'deprecated':
      return { lifecycle, productionEligible: false, autoInstallable: false, selection: 'compatibility-only' };
    case 'quarantined':
      return { lifecycle, productionEligible: false, autoInstallable: false, selection: 'blocked' };
    default:
      return { lifecycle, productionEligible: false, autoInstallable: false, selection: 'invalid' };
  }
}

// Reads localized descriptions (description_pt-BR, description_es, ...).
// Returns an object with only the codes that are present.
export function parseLocalizedDescriptions(fm, codes) {
  const descriptions = {};
  for (const code of codes) {
    const value = parseScalar(fm, `description_${code}`);
    if (value !== null) descriptions[code] = value;
  }
  return descriptions;
}
