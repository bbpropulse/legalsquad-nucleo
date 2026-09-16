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

// Número de um caractere é identificador ("Súmula 7", "art. 5"): não cai no
// corte de tamanho que tira "a", "o", "e".
function queryTokens(query) {
  return [...new Set(normalize(query).split(' ')
    .filter((token) => (token.length >= 2 || /^\d$/.test(token)) && !STOPWORDS.has(token)))];
}

function boundedLimit(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

// Número é identificador, não radical: "54" não pode casar "544" nem "548",
// senão a busca por "Súmula 54" devolve outros verbetes na frente do certo.
function includesToken(text, token) {
  const numerico = /^\d+$/.test(token);
  return text.split(' ').some((word) => word === token || (!numerico && word.startsWith(token)));
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
      current = { path: pathMatch[1].trim(), tipo: '', tema: '', processo: '', tribunal: '', informativo: '', temaRepetitivo: '', tags: [], confianca: 'DISCOVERY_ONLY', areaPresumida: false };
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
    // Identificador do julgado ("Súmula 54", "REsp 1.132.866/SP", "Tema 1.234"),
    // vindo do frontmatter pelo indexador. É o que o verificador de citações busca.
    const processoMatch = line.match(/^\s*processo:\s*(.+)$/);
    if (processoMatch) {
      const value = processoMatch[1].trim();
      try { current.processo = String(JSON.parse(value)); } catch { current.processo = value.replace(/^"|"$/g, ''); }
      continue;
    }
    const tribunalMatch = line.match(/^\s*tribunal:\s*(.+)$/);
    if (tribunalMatch) {
      const value = tribunalMatch[1].trim();
      try { current.tribunal = String(JSON.parse(value)); } catch { current.tribunal = value.replace(/^"|"$/g, ''); }
      continue;
    }
    const informativoMatch = line.match(/^\s*informativo:\s*(.+)$/);
    if (informativoMatch) {
      const value = informativoMatch[1].trim();
      try { current.informativo = String(JSON.parse(value)); } catch { current.informativo = value.replace(/^"|"$/g, ''); }
      continue;
    }
    const temaRepMatch = line.match(/^\s*tema_repetitivo:\s*(.+)$/);
    if (temaRepMatch) {
      const value = temaRepMatch[1].trim();
      try { current.temaRepetitivo = String(JSON.parse(value)); } catch { current.temaRepetitivo = value.replace(/^"|"$/g, ''); }
      continue;
    }
    const tagsMatch = line.match(/^\s*tags:\s*\[(.*)\]\s*$/);
    if (tagsMatch) {
      current.tags = tagsMatch[1].split(',').map((tag) => tag.trim()).filter(Boolean);
      continue;
    }
    const confMatch = line.match(/^\s*confianca:\s*(.+)$/);
    if (confMatch) { current.confianca = confMatch[1].trim(); continue; }
    // Área vinda de heurística por termo, não da fonte. O campo só REBAIXA e
    // EXCLUI de contagem; nunca promove nada.
    if (/^\s*area_presumida:\s*true\s*$/.test(line)) { current.areaPresumida = true; continue; }
  }
  return entries;
}
// <<< acervo-index:end

/**
 * O que a consulta exige de um identificador EXATO, além de conter os termos:
 * "Informativo 876" só é exato se o julgado é do informativo 876 (o número de
 * um processo pode conter 876); "Tema 1282", se o tema repetitivo é 1282;
 * "Súmula 188", se o `processo` é a Súmula 188 (não um acórdão que a cita).
 */
function exigenciasDaConsulta(phrase) {
  const ex = {};
  const inf = /\binformativo\s+(?:n\s+)?0*(\d+)\b/.exec(phrase);
  if (inf) ex.informativo = inf[1];
  const tema = /\btema\s+(?:repetitivo\s+)?(?:n\s+)?(\d+)\b/.exec(phrase);
  if (tema) ex.tema = tema[1];
  const sum = /\bsumula\s+(vinculante\s+)?(?:n\s+)?(\d+)\b/.exec(phrase);
  if (sum) ex.sumula = `sumula ${sum[1] ? 'vinculante ' : ''}${sum[2]}`;
  return ex;
}

function cumpreExigencias(entry, ex) {
  if (ex.informativo && String(entry.informativo || '').replace(/^0+(?=\d)/, '') !== ex.informativo) return false;
  if (ex.tema && String(entry.temaRepetitivo || '').replace(/\./g, '') !== ex.tema) return false;
  if (ex.sumula && !normalize(entry.processo).includes(ex.sumula)) return false;
  return true;
}

function scoreEntry(entry, phrase, tokens, exigencias = exigenciasDaConsulta(phrase)) {
  const tema = normalize(entry.tema);
  // Identificador = processo + tribunal + informativo + tema repetitivo:
  // "Súmula 54" + "STJ-SUM" responde a "Súmula 54 STJ" por inteiro; "Informativo
  // 876 STJ" e "Tema 1282" acham o julgado pelo número do boletim ou do tema
  // (o verificador pergunta assim, e o acervo é feito dos informativos).
  const processo = normalize([
    entry.processo || '',
    entry.tribunal || '',
    entry.informativo ? `informativo ${entry.informativo}` : '',
    entry.temaRepetitivo ? `tema ${entry.temaRepetitivo}` : '',
  ].join(' '));
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

  // Todos os termos da consulta no identificador ("sumula 54" ⊂ "Súmula 54/STJ"):
  // é a pergunta "existe este verbete?", e ela vale mais que qualquer tema.
  if (processo && tokens.length && tokens.every((token) => includesToken(processo, token)) && cumpreExigencias(entry, exigencias)) {
    score += 120;
    reasons.add('identificador-exato');
  }
  let covered = 0;
  for (const token of tokens) {
    let tokenCovered = false;
    if (includesToken(processo, token)) { score += 30; tokenCovered = true; reasons.add('identificador'); }
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
  // Palpite atrás de declaração. A penalidade é proporcional, não corte: o
  // julgado presumido continua aparecendo — ele é material de partida válido —
  // mas nunca à frente de um cuja área a própria fonte declarou. Empatar os dois
  // é o que fazia a busca entregar palpite como se fosse resposta.
  if (entry.areaPresumida) {
    score = Math.round(score * 0.6);
    reasons.add('area presumida');
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
  const entries = carregarIndicesDoAcervo(join(rootDir, 'acervo'));
  if (!entries) {
    return {
      success: false,
      results: [],
      error: { code: 'acervo-index-missing', message: 'acervo/_index.yaml ausente — rode indexar-acervo' },
    };
  }

  const phrase = normalize(query);
  const exigencias = exigenciasDaConsulta(phrase);
  const limit = boundedLimit(options.limit);
  // QUARANTINED = confiança rebaixada na indexação; fica fora por padrão.
  const includeQuarantined = options.includeQuarantined === true;

  const ranked = entries
    .filter((entry) => includeQuarantined || entry.confianca !== 'QUARANTINED')
    .map((entry) => {
      const match = scoreEntry(entry, phrase, tokens, exigencias);
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
      processo: entry.processo || null,
      tribunal: entry.tribunal || null,
      informativo: entry.informativo || null,
      tema_repetitivo: entry.temaRepetitivo || null,
      tags: entry.tags,
      confianca: entry.confianca,
      score: rank,
      matched_by: match.reasons,
      area_presumida: entry.areaPresumida === true,
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

/**
 * Pacotes de acervo que chegam pelo depósito da máquina (src/deposito.js) já
 * vêm indexados na origem: `acervo/_packs/<pack>/_index.yaml`, gerado uma vez
 * por sync, com caminhos relativos a `acervo/` (`_packs/<pack>/...`). Antes,
 * cada projeto reindexava 60 mil julgados por conta própria.
 */
export function packsComIndiceProprio(acervoDir) {
  const packs = join(acervoDir, '_packs');
  const lista = [];
  let entradas;
  try {
    entradas = readdirSync(packs, { withFileTypes: true });
  } catch {
    return lista;
  }
  for (const e of entradas) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    const idx = join(packs, e.name, '_index.yaml');
    if (existsSync(idx)) lista.push({ pack: e.name, indexPath: idx });
  }
  return lista;
}

/**
 * O índice do projeto (`acervo/_index.yaml`, o que o usuário tem) somado aos
 * índices de pacote. Entrada de pacote vence a do projeto para o mesmo caminho
 * (um índice do projeto anterior ao depósito ainda pode listá-la). Devolve null
 * só quando não há índice NENHUM.
 */
export function carregarIndicesDoAcervo(acervoDir) {
  const base = parseAcervoIndex(join(acervoDir, '_index.yaml'));
  const dePacotes = packsComIndiceProprio(acervoDir).flatMap(({ pack, indexPath }) => {
    const prefixo = `_packs/${pack}/`;
    return (parseAcervoIndex(indexPath) || [])
      .map((e) => (e.path.startsWith(prefixo) ? e : { ...e, path: prefixo + e.path }))
      .map((e) => ({ ...e, pack }));
  });
  if (!base && dePacotes.length === 0) return null;
  const porCaminho = new Map();
  for (const e of base || []) porCaminho.set(e.path, e);
  for (const e of dePacotes) porCaminho.set(e.path, e);
  return [...porCaminho.values()];
}

// Mesmas regras de scripts/indexar-acervo.js: casos/ é sigiloso e nunca entra;
// só extensões conhecidas; _index.yaml e README.md ficam fora; e um binário com
// irmão .md de mesmo nome cede a vez ao .md (que é o legível). Pacote com
// índice próprio não é revarrido: o índice dele é gerado na origem.
const EXT_INDEXAVEL = new Set(['.md', '.pdf', '.txt', '.docx', '.rtf']);
const DIRS_IGNORADOS = new Set(['casos']);

function listarIndexaveis(acervoDir, dir = acervoDir, acc = [], indexados = null) {
  const jaIndexados = indexados || new Set(packsComIndiceProprio(acervoDir).map((p) => join(acervoDir, '_packs', p.pack)));
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
      if (!DIRS_IGNORADOS.has(e.name) && !jaIndexados.has(full)) listarIndexaveis(acervoDir, full, acc, jaIndexados);
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
  // Entrada de índice de pacote é confiada (gerada na origem, ligada com o
  // pacote): conferir 60 mil existências a cada busca custaria mais que vale.
  const fantasmas = (entries || [])
    .filter((e) => !e.pack && !existsSync(join(acervoDir, e.path)))
    .map((e) => e.path)
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
    // O selo diz de onde vem a CONFIANÇA; este aviso diz de onde vem a ÁREA.
    // São coisas diferentes, e sem o segundo o leitor toma palpite de heurística
    // por classificação da fonte — que é como um julgado tributário arquivado
    // como administrativo entra numa peça sem ninguém perceber.
    const presumida = item.area_presumida ? ' [área presumida]' : '';
    const identificador = item.processo ? ` (${item.processo}${item.tribunal ? `, ${item.tribunal}` : ''})` : '';
    console.log(`  - ${item.path} [${selo}]${presumida} —${identificador} ${item.tema}`);
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
