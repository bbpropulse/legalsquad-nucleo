import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

// Ranked search over the local acervo (acervo/_index.yaml), symmetric to
// src/skill-search.js. Lets pesquisa-jurisprudencial consult the acervo BEFORE
// the web without reading the whole index into the prompt. The tiny text
// helpers below mirror skill-search.js on purpose: the skill-routing path is
// critical and kept untouched, so a little duplication buys full isolation.

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const STOPWORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e',
  'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por', 'que', 'um',
  'uma', 'the', 'to', 'of', 'and', 'for', 'with',
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTokens(query) {
  return [...new Set(normalize(query).split(' ')
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token)))];
}

function boundedLimit(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

function includesToken(text, token) {
  return text.split(' ').some((word) => word === token || word.startsWith(token));
}

// Parses the generated acervo/_index.yaml. The file is machine-emitted by
// scripts/indexar-acervo.js with a fixed, regular shape, so a line-based reader
// is robust and avoids adding a YAML dependency (the repo has none).
// >>> acervo-index:begin
/**
 * Leitor do `acervo/_index.yaml` (e dos `_packs/<area>/_index.yaml`).
 *
 * Copiado VERBATIM para `scripts/cobertura-acervo.mjs` e sua cópia em
 * `templates/scripts/`, porque o script viaja para o projeto do aluno e lá
 * NÃO existe `src/`. O import `../src/acervo-search.js` resolvia no repo do
 * motor e quebrava em toda instalação — `ERR_MODULE_NOT_FOUND` na primeira
 * chamada, achado ao rodar um caso real em 04/09/2026.
 */
export function parseAcervoIndex(indexPath) {
  if (!existsSync(indexPath)) return null;
  const text = readFileSync(indexPath, 'utf8');
  const entries = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === 'acervo:') continue;
    const pathMatch = line.match(/^\s*-\s*path:\s*(.+)$/);
    if (pathMatch) {
      current = { path: pathMatch[1].trim(), tipo: '', tema: '', tags: [], confianca: 'DISCOVERY_ONLY' };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const tipoMatch = line.match(/^\s*tipo:\s*(.+)$/);
    if (tipoMatch) { current.tipo = tipoMatch[1].trim(); continue; }
    const temaMatch = line.match(/^\s*tema:\s*(.+)$/);
    if (temaMatch) {
      const value = temaMatch[1].trim();
      try { current.tema = JSON.parse(value); } catch { current.tema = value.replace(/^"|"$/g, ''); }
      continue;
    }
    const tagsMatch = line.match(/^\s*tags:\s*\[(.*)\]\s*$/);
    if (tagsMatch) {
      current.tags = tagsMatch[1].split(',').map((tag) => tag.trim()).filter(Boolean);
      continue;
    }
    const confMatch = line.match(/^\s*confianca:\s*(.+)$/);
    if (confMatch) { current.confianca = confMatch[1].trim(); continue; }
  }
  return entries;
}
// <<< acervo-index:end

function scoreEntry(entry, phrase, tokens) {
  const tema = normalize(entry.tema);
  const tipo = normalize(entry.tipo);
  const tags = (entry.tags || []).map(normalize);
  const path = normalize(entry.path);
  const reasons = new Set();
  let score = 0;

  if (phrase && tema === phrase) {
    score += 160;
    reasons.add('tema-exato');
  } else if (phrase && tema && tema.includes(phrase)) {
    score += 80;
    reasons.add('tema-frase');
  }

  let covered = 0;
  for (const token of tokens) {
    let tokenCovered = false;
    if (includesToken(tema, token)) { score += 24; tokenCovered = true; reasons.add('tema'); }
    if (tags.some((tag) => includesToken(tag, token))) { score += 20; tokenCovered = true; reasons.add('tag'); }
    if (includesToken(tipo, token)) { score += 10; tokenCovered = true; reasons.add('tipo'); }
    if (includesToken(path, token)) { score += 6; tokenCovered = true; reasons.add('caminho'); }
    if (tokenCovered) covered++;
  }
  if (tokens.length && covered === tokens.length) {
    score += 30;
    reasons.add('todos-os-termos');
  }
  return { score, reasons: [...reasons].sort() };
}

export function searchAcervoCatalog(query, rootDir, options = {}) {
  const tokens = queryTokens(query);
  if (!tokens.length) {
    return {
      success: false,
      results: [],
      error: { code: 'search-query-empty', message: 'informe termos materiais do tema' },
    };
  }
  const indexPath = join(rootDir, 'acervo', '_index.yaml');
  const entries = parseAcervoIndex(indexPath);
  if (!entries) {
    return {
      success: false,
      results: [],
      error: { code: 'acervo-index-missing', message: 'acervo/_index.yaml ausente — rode indexar-acervo' },
    };
  }

  const phrase = normalize(query);
  const limit = boundedLimit(options.limit);
  // QUARANTINED = confiança rebaixada na indexação; fica fora por padrão.
  const includeQuarantined = options.includeQuarantined === true;

  const ranked = entries
    .filter((entry) => includeQuarantined || entry.confianca !== 'QUARANTINED')
    .map((entry) => {
      const match = scoreEntry(entry, phrase, tokens);
      // Fonte oficial verificada é mais confiável que descoberta — leve empurrão.
      const confidenceBonus = entry.confianca === 'VERIFIED_OFFICIAL' ? 10 : 0;
      return { entry, match, rank: match.score + confidenceBonus };
    })
    .filter((item) => item.match.score > 0)
    .sort((left, right) => right.rank - left.rank || left.entry.path.localeCompare(right.entry.path))
    .slice(0, limit)
    .map(({ entry, match, rank }) => ({
      path: entry.path,
      tipo: entry.tipo,
      tema: entry.tema,
      tags: entry.tags,
      confianca: entry.confianca,
      score: rank,
      matched_by: match.reasons,
      verified: entry.confianca === 'VERIFIED_OFFICIAL',
    }));

  const stale = detectarIndiceDefasado(join(rootDir, 'acervo'), entries);

  return {
    success: true,
    result_count: ranked.length,
    limit,
    results: ranked,
    error: null,
    ...(stale ? { stale } : {}),
  };
}

// Mesmas regras de scripts/indexar-acervo.js: casos/ é sigiloso e nunca entra;
// só extensões conhecidas; _index.yaml e README.md ficam fora; e um binário com
// irmão .md de mesmo nome cede a vez ao .md (que é o legível).
const EXT_INDEXAVEL = new Set(['.md', '.pdf', '.txt', '.docx', '.rtf']);
const DIRS_IGNORADOS = new Set(['casos']);

function listarIndexaveis(acervoDir, dir = acervoDir, acc = []) {
  let entradas;
  try {
    entradas = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  const temMdIrmao = new Set(
    entradas
      .filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.md')
      .map((e) => e.name.slice(0, -3))
  );

  for (const e of entradas) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!DIRS_IGNORADOS.has(e.name)) listarIndexaveis(acervoDir, full, acc);
      continue;
    }
    if (!e.isFile()) continue;

    const ext = extname(e.name).toLowerCase();
    if (!EXT_INDEXAVEL.has(ext)) continue;
    if (e.name === '_index.yaml' || e.name === 'README.md') continue;
    if (ext !== '.md' && temMdIrmao.has(e.name.slice(0, -ext.length))) continue;

    acc.push(relative(acervoDir, full).split('\\').join('/'));
  }
  return acc;
}

/**
 * Compara o índice com o disco e devolve o descompasso, se houver.
 *
 * O índice do acervo é o ÚNICO que a busca realmente consome (as skills são
 * descobertas varrendo o disco). Sem esta checagem, um material adicionado e
 * não reindexado fica invisível à pesquisa **sem erro nenhum** — o pior modo de
 * falha para um acervo jurídico, porque a ausência de resultado é
 * indistinguível de "não existe precedente sobre isso".
 *
 * É um AVISO, não um bloqueio: a busca segue com o que há (degradação
 * graciosa), mas quem consome passa a saber que o resultado está incompleto.
 */
export function detectarIndiceDefasado(acervoDir, entries) {
  if (!existsSync(acervoDir)) return null;

  const noDisco = listarIndexaveis(acervoDir);
  const noIndice = new Set((entries || []).map((e) => e.path));

  const naoIndexados = noDisco.filter((p) => !noIndice.has(p)).sort();
  const fantasmas = [...noIndice]
    .filter((p) => !existsSync(join(acervoDir, p)))
    .sort();

  if (naoIndexados.length === 0 && fantasmas.length === 0) return null;

  const partes = [];
  if (naoIndexados.length) partes.push(`${naoIndexados.length} arquivo(s) fora do índice`);
  if (fantasmas.length) partes.push(`${fantasmas.length} entrada(s) apontando para arquivo inexistente`);

  return {
    naoIndexados,
    fantasmas,
    message:
      `acervo/_index.yaml está defasado (${partes.join(' e ')}) — ` +
      'a busca pode estar incompleta; rode `indexar-acervo` para atualizar',
  };
}

export function acervoSearchCli(query, targetDir, values = {}) {
  const result = searchAcervoCatalog(query, targetDir, {
    limit: values.limit,
    includeQuarantined: values['include-quarantined'] === true,
  });
  if (values.json === true) {
    console.log(JSON.stringify(result));
    return result;
  }
  if (!result.success) {
    console.error(`BUSCA_ACERVO:BLOQUEADA — ${result.error.message}`);
    return result;
  }
  console.log(`BUSCA_ACERVO:${result.result_count}`);
  for (const item of result.results) {
    const selo = item.verified ? 'oficial-verificado' : 'descoberta';
    console.log(`  - ${item.path} [${selo}] — ${item.tema}`);
  }
  // O aviso vai para stderr e DEPOIS dos resultados: quem lê a saída não perde
  // o achado, e quem só olha o fim vê que a busca pode estar incompleta.
  if (result.stale) {
    console.error(`BUSCA_ACERVO:DEFASADA — ${result.stale.message}`);
    for (const p of result.stale.naoIndexados.slice(0, 5)) console.error(`  fora do índice: ${p}`);
    if (result.stale.naoIndexados.length > 5) {
      console.error(`  … e mais ${result.stale.naoIndexados.length - 5}`);
    }
    for (const p of result.stale.fantasmas.slice(0, 5)) console.error(`  indexado mas ausente: ${p}`);
  }
  return result;
}
