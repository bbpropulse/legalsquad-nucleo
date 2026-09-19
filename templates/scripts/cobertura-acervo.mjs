#!/usr/bin/env node
/**
 * Cobertura do acervo por tribunal e tema — o número que a recomendação do
 * intake precisa antes de perguntar "buscar no tribunal local?".
 *
 * Política de pesquisa em camadas (ENTREGA.md §5; runner, parada `intake`):
 * superiores (STF, STJ, TST, TSE, STM), os vinculantes do tribunal competente
 * (IRDR, IAC, súmulas) e o acervo instalado entram SEMPRE; o checkpoint decide
 * só a busca EXTERNA de acórdãos ordinários do tribunal local, que é o custo
 * real. Este script lê `acervo/_index.yaml` (e os packs em `acervo/_packs/`)
 * com o mesmo parser do `acervo-busca` e devolve os sinais e uma recomendação
 * com motivo — o chefe apresenta, o profissional decide.
 *
 * Quarentena (`confianca: QUARANTINED`) fica fora da conta: o que está em
 * quarentena não cobre nada.
 *
 * Uso:
 *   node scripts/cobertura-acervo.mjs [raiz] --tema "dano moral atraso de voo" --tribunal TJPE [--instancia 1|2|superior] [--json]
 *
 * O `--tema` é curto: 2 ou 3 termos materiais por questão, e várias questões separadas por
 * vírgula ("seguro incêndio, exclusão de cobertura, ônus da prova"), cada uma medida em separado.
 * Um tema de parágrafo zera a busca; aí a ferramenta pede para reformular em vez de recomendar.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// O leitor do índice do acervo vem COPIADO de `src/acervo-search.js` (bloco
// `acervo-index`, sincronizado por `npm run sync:blocos`), e não importado:
// este script viaja para o projeto do aluno, onde não existe `src/`. O import
// relativo resolvia só no repo do motor e quebrava em toda instalação.
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

const SUPERIORES = new Set(['STF', 'STJ', 'TST', 'TSE', 'STM']);
const SIGLA = /^(?:STF|STJ|TST|TSE|STM|TJ[A-Z]{2}|TRF[1-6]|TRT\d{1,2}|TRE[A-Z]{2})$/i;
const PASTAS_DE_JULGADO = new Set(['jurisprudencia', 'sumulas', 'julgados', 'precedentes', 'teses']);
const VINCULANTE = /s[uú]mula|\birdr\b|\biac\b|repetitiv|repercuss[aã]o geral|incidente de assun/i;

export function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Sigla do tribunal de uma entrada: pela pasta (`jurisprudencia/tjpe/…`), senão pelo tema. */
export function tribunalDe(entry) {
  const seg = String(entry.path || '').split('/');
  for (let i = 0; i < seg.length - 1; i++) {
    const candidato = String(seg[i + 1] || '').replace(/[-_ ]/g, '');
    if (PASTAS_DE_JULGADO.has(normalizar(seg[i])) && SIGLA.test(candidato)) return candidato.toUpperCase();
  }
  const tema = String(entry.tema || '');
  const prefixo = tema.match(/^\s*([A-Za-z]{2,3}[A-Za-z0-9]{0,2})\s*[—–-]/);
  if (prefixo && SIGLA.test(prefixo[1])) return prefixo[1].toUpperCase();
  const solto = tema.match(/\b(STF|STJ|TST|TSE|STM|TJ[A-Z]{2}|TRF[1-6]|TRT\d{1,2}|TRE[A-Z]{2})\b/i);
  return solto ? solto[1].toUpperCase() : 'desconhecido';
}

/** Camada da política: superiores · vinculantes-local · local · legislacao · desconhecido. */
export function camadaDe(entry, tribunal = tribunalDe(entry)) {
  if (normalizar(entry.tipo) === 'legislacao') return 'legislacao';
  if (tribunal === 'desconhecido') return 'desconhecido';
  if (SUPERIORES.has(tribunal)) return 'superiores';
  const texto = `${entry.tipo} ${entry.tema} ${(entry.tags || []).join(' ')} ${entry.path}`;
  return VINCULANTE.test(texto) ? 'vinculantes-local' : 'local';
}

/**
 * Palavras de ligação que não medem cobertura ("por", "que", "para"); o corte de 3 letras já
 * tira "de", "da", "e". Mesma família do STOPWORDS do search-acervo.
 */
const PALAVRAS_DE_LIGACAO = new Set(['aos', 'ate', 'com', 'como', 'contra', 'das', 'dos', 'entre', 'essa', 'esse', 'esta', 'este', 'mais', 'nao', 'nas', 'nos', 'num', 'numa', 'para', 'pela', 'pelas', 'pelo', 'pelos', 'por', 'que', 'sem', 'seu', 'seus', 'sob', 'sobre', 'sua', 'suas', 'uma', 'umas', 'uns']);
/** Vírgula, ponto e vírgula, dois-pontos, barra ou travessão entre espaços separam as questões de um tema. */
const SEPARADOR_DE_QUESTAO = /\s*(?:[,;:|/]|\s[-–—]\s)\s*/;
/**
 * A partir daqui, zero resultado é quase sempre defeito da consulta, não do acervo: o índice
 * guarda um cabeçalho curto por julgado (tema, tags, caminho), e exigir quatro ou mais termos
 * juntos nele zera a busca. Medido num caso real (17/09/2026): um tema de dez termos devolvia
 * "0 julgados, os superiores calam", e os mesmos termos em três questões davam 9, 3 e 1.
 */
const TERMOS_DEMAIS = 4;

/** Termos materiais de um texto: 3+ letras, sem palavra de ligação, sem repetição. */
export function termosDoTema(texto) {
  return [...new Set(normalizar(texto).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !PALAVRAS_DE_LIGACAO.has(t)))];
}

/** As questões de um tema, cada uma com seus termos: "a, b, c" mede a, b e c em separado. Sem termos, lista vazia. */
export function questoesDoTema(tema) {
  return String(tema || '').split(SEPARADOR_DE_QUESTAO)
    .map((texto) => ({ texto: texto.trim(), termos: termosDoTema(texto) }))
    .filter((q) => q.termos.length);
}

const alvoDe = (entry) => normalizar(`${entry.tema} ${(entry.tags || []).join(' ')} ${entry.path}`);

/** Quais dos termos a entrada traz em tema, tags ou caminho. */
export function termosCasados(entry, termos) {
  const alvo = alvoDe(entry);
  return termos.filter((t) => alvo.includes(t));
}

/** Todos os termos materiais de ALGUMA questão do tema aparecem em tema, tags ou caminho. Sem termos, tudo casa. */
export function casaTema(entry, tema) {
  const questoes = questoesDoTema(tema);
  if (!questoes.length) return true;
  return questoes.some((q) => termosCasados(entry, q.termos).length === q.termos.length);
}

/**
 * Quando nenhum julgado casa uma questão longa, o mais perto que o acervo chega dela: quantos
 * casam pelo menos metade dos termos e qual o melhor casamento. É o que separa "o acervo não
 * tem" de "a consulta pediu demais", e vai para a recomendação em vez de virar "superiores calam".
 */
export function aproximacaoDe(lista, questoes) {
  let melhor = null;
  for (const q of questoes) {
    if (q.termos.length < TERMOS_DEMAIS) continue;
    const minimo = Math.ceil(q.termos.length / 2);
    const casamentos = lista.map((e) => termosCasados(e, q.termos)).filter((c) => c.length >= minimo);
    const maximo = casamentos.reduce((m, c) => Math.max(m, c.length), 0);
    const atual = { questao: q.texto, termos: q.termos.length, minimo, julgados: casamentos.length, melhor: maximo, termosDoMelhor: casamentos.find((c) => c.length === maximo) || [] };
    if (!melhor || atual.julgados > melhor.julgados) melhor = atual;
  }
  return melhor;
}

function entradas(rootDir) {
  const lidos = [];
  const base = join(rootDir, 'acervo', '_index.yaml');
  if (existsSync(base)) lidos.push(...parseAcervoIndex(base).map((e) => ({ ...e, pack: null })));
  const packs = join(rootDir, 'acervo', '_packs');
  if (existsSync(packs)) {
    for (const p of readdirSync(packs, { withFileTypes: true })) {
      const idx = join(packs, p.name, '_index.yaml');
      if (p.isDirectory() && existsSync(idx)) lidos.push(...parseAcervoIndex(idx).map((e) => ({ ...e, pack: p.name })));
    }
  }
  // Caminhos são relativos a `acervo/` nos dois índices (o de pacote já vem com
  // `_packs/<pack>/`): o mesmo julgado listado no índice do projeto e no do
  // pacote conta UMA vez, e a entrada do pacote (gerada na origem) vence.
  const porCaminho = new Map();
  for (const e of lidos) if (!porCaminho.has(e.path) || e.pack) porCaminho.set(e.path, e);
  return [...porCaminho.values()];
}

/**
 * Mede a cobertura de um tema. Puro: recebe as entradas já lidas.
 * `instancia`: '1' | '2' | 'superior' (onde a peça será lida).
 */
export function medirCobertura(lista, { tema = '', tribunal = null, instancia = null } = {}) {
  const trib = tribunal ? String(tribunal).replace(/[-_ ]/g, '').toUpperCase() : null;
  const todas = Array.isArray(lista) ? lista : [];
  const emQuarentena = (e) => String(e.confianca || '').toUpperCase() === 'QUARANTINED';
  const questoes = questoesDoTema(tema);
  const relevantes = todas.filter((e) => casaTema(e, tema));
  const quarentena = relevantes.filter(emQuarentena).length;
  const uteis = relevantes.filter((e) => !emQuarentena(e));
  // Cada questão do tema conta por si: "seguro incêndio, exclusão de cobertura" mostra 9 e 3,
  // não um número só que esconde qual das duas o acervo cobre.
  const porQuestao = questoes.map((q) => ({ questao: q.texto, termos: q.termos, total: uteis.filter((e) => termosCasados(e, q.termos).length === q.termos.length).length }));
  const aproximacao = uteis.length === 0 ? aproximacaoDe(todas.filter((e) => !emQuarentena(e)), questoes) : null;
  // Julgado cuja ÁREA veio de heurística por termo, não da fonte. Ele continua
  // na lista — é material de partida válido — mas entra numa coluna própria.
  // Somá-lo à cobertura declarada é o que fazia a recomendação do intake
  // prometer o que o acervo não tinha: num acervo real, 2.905 julgados de
  // direito administrativo dos quais só 1.007 tinham a área declarada.
  const presumidos = uteis.filter((e) => e.areaPresumida === true).length;

  const porTribunal = {};
  const porCamada = { superiores: 0, 'vinculantes-local': 0, local: 0, legislacao: 0, desconhecido: 0 };
  let verificados = 0;
  for (const e of uteis) {
    const t = tribunalDe(e);
    const c = camadaDe(e, t);
    porCamada[c] += 1;
    if (String(e.confianca || '').toUpperCase() === 'VERIFIED_OFFICIAL') verificados += 1;
    if (c === 'superiores' || c === 'vinculantes-local' || c === 'local') {
      porTribunal[t] = porTribunal[t] || { total: 0, vinculantes: 0, ordinarios: 0 };
      porTribunal[t].total += 1;
      if (c === 'vinculantes-local') porTribunal[t].vinculantes += 1;
      if (c === 'local') porTribunal[t].ordinarios += 1;
    }
  }

  const doTribunal = trib ? porTribunal[trib] || { total: 0, vinculantes: 0, ordinarios: 0 } : null;
  const sinais = {
    tema,
    tribunal: trib,
    instancia: instancia ? String(instancia) : null,
    total: uteis.length,
    verificados,
    quarentena,
    presumidos,
    declarados: uteis.length - presumidos,
    superiores: porCamada.superiores,
    vinculantesDoTribunal: doTribunal ? doTribunal.vinculantes : null,
    localDoTribunal: doTribunal ? doTribunal.ordinarios : null,
    outrosLocais: porCamada.local + porCamada['vinculantes-local'] - (doTribunal ? doTribunal.total : 0),
    porCamada,
    porTribunal,
    questoes: porQuestao,
    aproximacao,
  };

  // A recomendação é uma regra pequena e declarada; o chefe a apresenta e o
  // profissional vira a chave. Nunca decide sozinha e nunca inventa custo.
  let recomendacao;
  if (aproximacao) {
    // Zero numa questão de 4+ termos não é fato do acervo: é a consulta que pediu demais ao
    // cabeçalho do índice. Abster, dizer o mais perto que o acervo chega e como reformular.
    const perto = aproximacao.julgados
      ? `${aproximacao.julgados} casam pelo menos ${aproximacao.minimo}; o mais próximo casa ${aproximacao.melhor}: ${aproximacao.termosDoMelhor.join(', ')}`
      : 'nenhum casa nem metade deles';
    recomendacao = { buscaExterna: null, motivo: `tema longo demais para o índice: nenhum julgado casa os ${aproximacao.termos} termos de "${aproximacao.questao}" (${perto}); reformule com 2 ou 3 termos por questão, separando as questões por vírgula` };
  } else if (!trib) {
    recomendacao = { buscaExterna: null, motivo: 'informe o tribunal competente (--tribunal) para haver recomendação' };
  } else if (String(instancia) === 'superior') {
    recomendacao = { buscaExterna: false, motivo: `a peça vai a tribunal superior: a jurisprudência ordinária do ${trib} não decide` };
  } else if (doTribunal.vinculantes > 0) {
    recomendacao = { buscaExterna: false, motivo: `o acervo tem ${doTribunal.vinculantes} vinculante(s) do ${trib} (IRDR/IAC/súmula) sobre o tema — entra sempre, sem busca externa` };
  } else if (doTribunal.ordinarios >= 5) {
    recomendacao = { buscaExterna: false, motivo: `o acervo local do ${trib} cobre o tema (${doTribunal.ordinarios} julgados)` };
  } else if (porCamada.superiores > 0 && doTribunal.ordinarios >= 3) {
    recomendacao = { buscaExterna: false, motivo: `superiores (${porCamada.superiores}) e acervo local do ${trib} (${doTribunal.ordinarios}) cobrem o tema — busca externa opcional` };
  } else if (sinais.declarados === 0 && sinais.presumidos > 0) {
    recomendacao = { buscaExterna: true, motivo: `os ${sinais.presumidos} julgado(s) do acervo têm a área presumida por heurística, nenhum declarado pela fonte — o tema não está coberto, está apenas indexado` };
  } else if (porCamada.superiores === 0) {
    recomendacao = { buscaExterna: true, motivo: `os superiores calam no acervo e o ${trib} tem ${doTribunal.ordinarios} julgado(s) sobre o tema — a prática local decide` };
  } else {
    recomendacao = { buscaExterna: true, motivo: `o acervo local do ${trib} é raso (${doTribunal.ordinarios} julgado(s)); superiores cobrem (${porCamada.superiores}), mas o tema depende da prática local` };
  }
  return { ...sinais, recomendacao };
}

export function paraMarkdown(m) {
  const linhas = [`## Cobertura do acervo — tema "${m.tema || '(todos)'}"`];
  const trib = m.tribunal ? `${m.tribunal}` : 'tribunal não informado';
  linhas.push(`- Superiores: ${m.superiores} · Vinculantes do ${trib}: ${m.vinculantesDoTribunal ?? 'n/a'} · Acervo local do ${trib}: ${m.localDoTribunal ?? 'n/a'} · Outros tribunais locais: ${m.outrosLocais} · Verificados na fonte: ${m.verificados}/${m.total}${m.quarentena ? ` · Quarentena: ${m.quarentena} (fora da conta)` : ''}`);
  // A linha da área presumida é separada de propósito: somada à de cima, ela
  // volta a prometer cobertura que o acervo não tem. Quem lê precisa ver que
  // parte do número é palpite antes de decidir se busca fora.
  if (m.presumidos) {
    linhas.push(`- Desses, ${m.presumidos} têm a ÁREA presumida por heurística de termo, não declarada pela fonte: ${m.declarados} com área declarada. Material de partida, não cobertura.`);
  }
  if (Array.isArray(m.questoes) && m.questoes.length > 1) {
    linhas.push(`- Por questão: ${m.questoes.map((q) => `"${q.questao}" ${q.total}`).join(' · ')}`);
  }
  const r = m.recomendacao;
  const rotulo = r.buscaExterna === null ? 'sem recomendação' : r.buscaExterna ? `buscar no ${m.tribunal}` : 'não buscar fora';
  linhas.push(`- Recomendação: ${rotulo} — ${r.motivo}`);
  return linhas.join('\n');
}

export function medirNoProjeto(rootDir, opts) {
  return medirCobertura(entradas(resolve(rootDir)), opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const raiz = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--'))) || '.';
  if (!existsSync(join(resolve(raiz), 'acervo'))) {
    process.stderr.write(`sem acervo/ em ${resolve(raiz)} — nada a medir\n`);
    process.exit(1);
  }
  const m = medirNoProjeto(raiz, { tema: flag('--tema') || '', tribunal: flag('--tribunal'), instancia: flag('--instancia') });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(m, null, 2)}\n` : `${paraMarkdown(m)}\n`);
  process.exit(0);
}
