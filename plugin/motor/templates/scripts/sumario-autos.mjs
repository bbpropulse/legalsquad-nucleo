#!/usr/bin/env node
// Sumário durável dos autos, por caso (não por run), e o inventário das imagens
// que a conversão não conseguiu ler (folhas `vazia` e imagens avulsas).
//
// O motor não resume nem descreve nada: isto é um cartório. O agente escreve
// `autos/_sumario/sumario-dos-autos.md` (ancorado em folha) e as descrições de
// imagem em `autos/_sumario/imagens/`; este script diz se o sumário está EM DIA
// (o índice dos autos não mudou desde que ele foi marcado), lista as imagens
// que ainda não têm descrição e grava o manifesto quando o agente termina.
//
// Por que por caso: réplica e apelação sobre os mesmos 506 fólios reliam tudo
// na fase zero de cada squad. O sumário é lido pelos leitores como ponto de
// partida e nunca como fonte de citação: a folha se confere no documento.md.
// Invalidação honesta: o hash do `_index.yaml` mais o dos manifestos de conversão
// muda quando os autos mudam ou são reconvertidos, e aí o sumário volta a "desatualizado".
//
//   node scripts/sumario-autos.mjs status  <squads/<nome>|pasta-do-caso|autos/> [--json]
//       sai 0 (em dia), 3 (desatualizado: refazer o sumário) ou 4 (em dia, faltam descrições de imagem)
//   node scripts/sumario-autos.mjs imagens <...> [--teto N] [--incluir-ocr] [--json]
//   node scripts/sumario-autos.mjs marcar  <...> --por "<squad/run>" [--indice-hash <do status>] [--sem-folhas] [--json]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const PASTA_SUMARIO = '_sumario';
export const ARQUIVO_SUMARIO = 'sumario-dos-autos.md';
export const MANIFESTO_SUMARIO = '_manifesto.json';
export const PASTA_DESCRICOES = 'imagens';
export const TETO_DE_IMAGENS = 40;
export const CABECALHO_DESCRICAO = '> Descrição por modelo de visão: interpretação de máquina, não fato dos autos. Confira na imagem antes de citar.';
const EXT_IMAGEM = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.gif', '.bmp']);
// Folha dos autos (`fls. N`, `e-fls. N`) ou página de documento de uma pasta pré-processual
// (`p. N`, `pág. N`, `Doc. 03, p. 2`): a pasta do cliente não tem folha, e o marcar recusava o
// sumário ancorado nas páginas, forçando `--sem-folhas` (medido em 3 dos 7 runs de 23-24/09/2026).
// Também valem o documento sozinho (`Doc. 03`, quando o documento tem uma página só) e o
// intervalo de páginas (`pp. 2-3`, `págs. 4-6`): as duas âncoras ainda eram recusadas (G23).
const RE_FOLHAS = /\b(?:(?:e-)?fls?|p[áa]gs?|pp?|docs?)\.\s*\d+/gi;
const contarFolhas = (texto) => (texto.match(RE_FOLHAS) || []).length;
const RE_MARCADOR = /LEGALSQUAD:PREENCHER|\[PREENCHER/;

const posix = (p) => p.split(sep).join('/');

// Onde estão os autos: cópia do bloco canônico de src/autos-path.js (honra `caso.json`,
// os autos por referência). Sem isto, `status squads/<nome>` saía 1 no desenho por referência.
// >>> autos-path:begin
/**
 * Pasta de autos de um squad: `squads/<nome>/autos/` (copiados para o squad) ou,
 * por referência, a pasta do caso que `squads/<nome>/caso.json` aponta
 * (`{"autos": "Processos/<caso>/autos"}` ou `{"pasta": "Processos/<caso>"}`,
 * relativo à raiz do projeto, a pasta acima de `squads/`). A cópia local com
 * `_index.yaml` vence a referência; sem `caso.json`, fica a do squad.
 */
function pastaDeAutos(squadDir) {
  const noSquad = join(squadDir, 'autos');
  if (existsSync(join(noSquad, '_index.yaml'))) return noSquad;
  try {
    const caso = JSON.parse(readFileSync(join(squadDir, 'caso.json'), 'utf8'));
    const raiz = dirname(dirname(squadDir));
    const autos = caso && typeof caso.autos === 'string' ? caso.autos : (caso && typeof caso.pasta === 'string' ? `${caso.pasta}/autos` : null);
    if (autos) return resolve(raiz, autos);
  } catch { /* sem caso.json, ou ilegível: fica o do squad */ }
  return noSquad;
}

/**
 * Aceita `squads/<nome>` (com `autos/` dentro ou `caso.json` apontando o caso), a
 * pasta do caso (com `autos/` dentro) ou o caminho direto de `autos/`.
 * Devolve `{ dir, erro }`; `dir` é absoluto.
 */
function resolverAutos(entrada) {
  const abs = resolve(entrada);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: null, erro: `pasta não encontrada: ${entrada}` };
  if (basename(abs) === 'autos') return { dir: abs, erro: null };
  const dir = pastaDeAutos(abs);
  if (existsSync(dir) && statSync(dir).isDirectory()) return { dir, erro: null };
  if (existsSync(join(abs, 'caso.json'))) return { dir: null, erro: `${entrada}/caso.json aponta ${dir}, que não existe: confira o caminho (relativo à raiz do projeto, a pasta acima de squads/)` };
  return { dir: null, erro: `${entrada} existe, mas não tem a pasta autos/; crie ${entrada}/autos/ e coloque nela os PDFs e documentos do caso, ou grave ${entrada}/caso.json apontando a pasta do caso` };
}
// <<< autos-path:end
export { pastaDeAutos, resolverAutos };

/**
 * Hash da LEITURA dos autos: o índice (o que existe) mais os manifestos de conversão em
 * `_md/<slug>/_manifesto.json` (o que foi lido, e como). Só o índice não basta: reconverter
 * os mesmos PDFs (OCR novo, folhas antes invisíveis) não muda o índice, e o sumário escrito
 * sobre a conversão velha continuava "em dia".
 *
 * Só CONTEÚDO entra no hash. Os carimbos de hora (`gerado_em` e `mtime` do índice,
 * `convertido_em` do manifesto) ficam de fora: o runner manda converter na fase zero
 * de todo squad, e uma reconversão idêntica dos mesmos autos trocava o hash e mandava
 * reler as 506 folhas a cada squad novo, o contrário do "uma vez por autos".
 *
 * Os campos do índice que dizem O QUE os autos são (o arquivo, o tamanho, as páginas, se tem
 * texto e onde está a conversão). O resto (`tipo`, `origem`, `datas`, `primeira_pagina`,
 * `numero_processo`) é leitura do indexador, e muda quando o indexador muda, sem mudar os autos.
 * Medido na medição de 24/09/2026 (motor 0.9.49): o sumário da negativação, marcado por outro
 * squad que aponta a mesma pasta do caso, saiu desatualizado depois de reindexar porque o
 * indexador novo gravou o campo `origem`; os autos eram os mesmos.
 */
const CAMPOS_DOS_AUTOS = ['arquivo', 'bytes', 'paginas', 'texto', 'markdown', 'paginas_sem_texto_n', 'paginas_sem_texto'];
/** Campos que o indexador passou a gravar depois do manifesto v1 do sumário (G17: `origem`). */
const CAMPOS_NOVOS_DO_INDEXADOR = ['origem'];

/** Cada documento do índice, só com os campos dos autos: `{ arquivo: "bytes|paginas|..." }`. */
export function documentosDoIndice(dir) {
  const p = join(dir, '_index.yaml');
  if (!existsSync(p)) return null;
  const docs = {};
  let atual = null;
  let dentro = false;
  for (const linha of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^documentos:/.test(linha)) { dentro = true; continue; }
    if (dentro && /^\S/.test(linha)) dentro = false;
    if (!dentro) continue;
    const m = linha.match(/^\s*(?:-\s+)?([\w]+):\s*(.*)$/);
    if (!m) continue;
    if (/^\s*-\s/.test(linha)) atual = null;
    if (m[1] === 'arquivo') { atual = m[2].replace(/^"|"$/g, ''); docs[atual] = {}; continue; }
    if (atual && CAMPOS_DOS_AUTOS.includes(m[1])) docs[atual][m[1]] = m[2].trim();
  }
  return Object.fromEntries(Object.entries(docs).map(([arquivo, campos]) => [arquivo, CAMPOS_DOS_AUTOS.slice(1).map((c) => campos[c] ?? '').join('|')]));
}

/** O hash de cada conversão em `_md/<slug>/_manifesto.json`, sem os carimbos de hora e de motor. */
function conversoesDosAutos(dir) {
  const saida = {};
  const md = join(dir, '_md');
  if (!existsSync(md) || !statSync(md).isDirectory()) return saida;
  for (const slug of readdirSync(md).sort()) {
    const manifesto = join(md, slug, MANIFESTO_SUMARIO);
    if (!existsSync(manifesto)) continue;
    let conteudo;
    try {
      const resto = { ...JSON.parse(readFileSync(manifesto, 'utf8')) };
      delete resto.convertido_em;
      delete resto.motor;
      conteudo = JSON.stringify(resto);
    } catch {
      conteudo = readFileSync(manifesto, 'utf8');
    }
    saida[slug] = createHash('sha256').update(conteudo).digest('hex').slice(0, 16);
  }
  return saida;
}

/**
 * Hash da LEITURA dos autos (versão 2 do manifesto do sumário): os documentos, só com os campos
 * dos autos (`CAMPOS_DOS_AUTOS`), e as conversões. O sumário é do CASO: qualquer squad que aponte
 * a mesma pasta (`caso.json`) lê o mesmo sumário, e reindexar com outro indexador não o invalida.
 */
export function hashDoIndice(dir) {
  const docs = documentosDoIndice(dir);
  if (!docs) return null;
  const h = createHash('sha256').update(JSON.stringify({ documentos: docs, conversoes: conversoesDosAutos(dir) }));
  return `sha256:${h.digest('hex')}`;
}

/**
 * O hash da versão 1 do manifesto (o texto inteiro do índice, menos os carimbos, mais as
 * conversões), para o sumário marcado antes da 0.9.50 continuar valendo. `semCamposNovos`
 * tira do índice os campos que o indexador passou a gravar depois (`origem`): o sumário marcado
 * sobre o índice sem eles é o mesmo sumário sobre os mesmos autos.
 */
export function hashDoIndiceV1(dir, { semCamposNovos = false } = {}) {
  const p = join(dir, '_index.yaml');
  if (!existsSync(p)) return null;
  const campoNovo = new RegExp(`^\\s+(?:${CAMPOS_NOVOS_DO_INDEXADOR.join('|')}):`);
  const indice = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => !/^gerado_em:|^\s+mtime:/.test(l) && !(semCamposNovos && campoNovo.test(l))).join('\n');
  const h = createHash('sha256').update(indice);
  const md = join(dir, '_md');
  if (existsSync(md) && statSync(md).isDirectory()) {
    for (const slug of readdirSync(md).sort()) {
      const manifesto = join(md, slug, MANIFESTO_SUMARIO);
      if (!existsSync(manifesto)) continue;
      let conteudo;
      try {
        const resto = { ...JSON.parse(readFileSync(manifesto, 'utf8')) };
        delete resto.convertido_em;
        delete resto.motor;
        conteudo = JSON.stringify(resto);
      } catch {
        conteudo = readFileSync(manifesto, 'utf8');
      }
      h.update(`\n${slug}\n`).update(conteudo);
    }
  }
  return `sha256:${h.digest('hex')}`;
}

/** Caminho da descrição de uma imagem (relativo a `autos/`): `_sumario/imagens/<caminho com "/" trocado por "--">.md`. */
export function caminhoDaDescricao(imagemRel) {
  return `${PASTA_SUMARIO}/${PASTA_DESCRICOES}/${posix(imagemRel).replace(/^\.?\//, '').replace(/\//g, '--')}.md`;
}

function listarImagensAvulsas(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const full = join(dir, e.name);
    let st = e;
    if (e.isSymbolicLink()) { try { st = statSync(full); } catch { continue; } }
    if (st.isDirectory()) listarImagensAvulsas(full, base, acc);
    else if (st.isFile() && EXT_IMAGEM.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())) acc.push(posix(relative(base, full)));
  }
  return acc;
}

/**
 * Imagens que pedem descrição: folhas `vazia` e `imagem` dos manifestos de conversão
 * (`_md/<slug>/_manifesto.json`), as folhas de OCR quando pedido, e as imagens
 * avulsas dos autos. Cada item diz onde a descrição fica e se já existe.
 */
export function inventarioDeImagens(dir, { incluirOcr = false, teto = TETO_DE_IMAGENS } = {}) {
  const itens = [];
  const md = join(dir, '_md');
  if (existsSync(md) && statSync(md).isDirectory()) {
    for (const slug of readdirSync(md).sort()) {
      const manifesto = join(md, slug, MANIFESTO_SUMARIO);
      if (!existsSync(manifesto)) continue;
      let m;
      try { m = JSON.parse(readFileSync(manifesto, 'utf8')); } catch { continue; }
      for (const f of Array.isArray(m.folhas) ? m.folhas : []) {
        if (!f || !f.imagem) continue;
        if (f.origem !== 'vazia' && f.origem !== 'imagem' && !(incluirOcr && f.origem === 'ocr')) continue;
        itens.push({ imagem: posix(join('_md', slug, f.imagem)), origem: f.origem, documento: m.arquivo || slug, pagina: f.pagina ?? null });
      }
    }
  }
  for (const img of listarImagensAvulsas(dir)) itens.push({ imagem: img, origem: 'avulsa', documento: img, pagina: null });
  // `--` também é válido em nome de arquivo: `fotos/a--b.jpg` e `fotos/a/b.jpg` cairiam na
  // mesma descrição, e a segunda nasceria "descrita" com o que o modelo viu na primeira.
  // Só a colisão ganha sufixo (hash curto do caminho), para as descrições já gravadas
  // continuarem valendo.
  const ocupados = new Set();
  for (const it of itens) {
    let descricao = caminhoDaDescricao(it.imagem);
    if (ocupados.has(descricao)) descricao = descricao.replace(/\.md$/, `.${createHash('sha256').update(it.imagem).digest('hex').slice(0, 8)}.md`);
    ocupados.add(descricao);
    it.descricao = descricao;
    it.descrita = existsSync(join(dir, it.descricao));
  }
  const pendentes = itens.filter((i) => !i.descrita);
  return {
    total: itens.length,
    descritas: itens.length - pendentes.length,
    pendentes: pendentes.slice(0, teto),
    alem_do_teto: Math.max(0, pendentes.length - teto),
    teto,
  };
}

/** A razão exata de o sumário não estar em dia: que documento entrou, saiu, mudou ou foi reconvertido. */
function motivoDaMudanca(dir, manifesto) {
  if (manifesto.versao !== 2 || !manifesto.documentos) {
    return 'os autos mudaram ou foram reconvertidos desde o sumário (manifesto da versão anterior, sem a lista de documentos para dizer qual): refaça o sumário e marque de novo';
  }
  const agora = documentosDoIndice(dir) || {};
  const antes = manifesto.documentos;
  const entraram = Object.keys(agora).filter((a) => !(a in antes));
  const sairam = Object.keys(antes).filter((a) => !(a in agora));
  const mudaram = Object.keys(agora).filter((a) => a in antes && antes[a] !== agora[a]);
  const conv = conversoesDosAutos(dir);
  const reconvertidos = Object.keys({ ...conv, ...(manifesto.conversoes || {}) }).filter((k) => (manifesto.conversoes || {})[k] !== conv[k]);
  const partes = [
    entraram.length && `entrou ${entraram.join(', ')}`,
    sairam.length && `saiu ${sairam.join(', ')}`,
    mudaram.length && `mudou ${mudaram.join(', ')} (tamanho, páginas ou texto)`,
    reconvertidos.length && `reconvertido ${reconvertidos.join(', ')}`,
  ].filter(Boolean);
  return `os autos mudaram desde o sumário: ${partes.join('; ') || 'o índice mudou'}. Refaça o sumário e marque de novo`;
}

export function statusDoSumario(dir) {
  const sumario = join(dir, PASTA_SUMARIO, ARQUIVO_SUMARIO);
  const manifestoPath = join(dir, PASTA_SUMARIO, MANIFESTO_SUMARIO);
  const hash = hashDoIndice(dir);
  const existe = existsSync(sumario);
  let manifesto = null;
  if (existsSync(manifestoPath)) { try { manifesto = JSON.parse(readFileSync(manifestoPath, 'utf8')); } catch { manifesto = null; } }
  let motivo;
  let emDia = false;
  if (!hash) motivo = 'os autos não estão indexados: rode `node scripts/indexar-autos.mjs` (e `npm run autos:md`) antes do sumário';
  else if (!existe) motivo = 'não há sumário do caso: o agente escreve `_sumario/sumario-dos-autos.md` e o runner marca';
  else if (!manifesto) motivo = 'sumário sem manifesto: rode `sumario-autos marcar` depois de conferi-lo';
  else if (manifesto.indice_hash === hash) { emDia = true; motivo = 'em dia'; }
  else if (manifesto.versao !== 2 && [hashDoIndiceV1(dir), hashDoIndiceV1(dir, { semCamposNovos: true })].includes(manifesto.indice_hash)) {
    emDia = true;
    motivo = 'em dia (manifesto da versão anterior; os autos não mudaram, só o indexador ganhou campo)';
  } else motivo = motivoDaMudanca(dir, manifesto);
  if (emDia && manifesto && manifesto.por) motivo += `; marcado por ${manifesto.por}: o sumário é do caso e vale para todo squad que aponta esta pasta`;
  const texto = existe ? readFileSync(sumario, 'utf8') : '';
  const folhas = contarFolhas(texto);
  const imagens = inventarioDeImagens(dir);
  const pendentes = imagens.total - imagens.descritas;
  // Imagem sem descrição é pendência do sumário, não detalhe: o teto de 40 por rodada
  // deixava o resto para "a próxima rodada", que nunca vinha porque o status dizia
  // "em dia" e o runner só despacha o descritor quando o sumário está desatualizado.
  if (emDia && pendentes) motivo = `em dia, mas ${pendentes} imagem(ns) sem descrição: despache o descritor e marque de novo`;
  return {
    autos: dir, sumario: existe ? posix(relative(dir, sumario)) : null, existe, em_dia: emDia, motivo,
    imagens_pendentes: pendentes,
    indice_hash: hash, marcado: manifesto ? { em: manifesto.gerado_em, por: manifesto.por, folhas_citadas: manifesto.folhas_citadas } : null,
    folhas_citadas: folhas, imagens: { total: imagens.total, descritas: imagens.descritas, pendentes },
  };
}

/** Grava o manifesto do sumário. Recusa sumário sem folha citada (salvo `semFolhas`) ou com marcador de preenchimento. */
export function marcarSumario(dir, { por, semFolhas = false, indiceHash = null, agora = () => new Date().toISOString() } = {}) {
  const sumario = join(dir, PASTA_SUMARIO, ARQUIVO_SUMARIO);
  if (!existsSync(sumario)) return { ok: false, erro: `não há ${PASTA_SUMARIO}/${ARQUIVO_SUMARIO} em ${dir}: o agente escreve o sumário antes de marcar` };
  const hash = hashDoIndice(dir);
  if (!hash) return { ok: false, erro: 'os autos não estão indexados (sem _index.yaml): sumário sem índice não tem o que invalidar' };
  // O certificado é do que o agente LEU: `status --json` entrega o hash antes do despacho e
  // o runner o devolve aqui; se os autos foram reconvertidos ou reindexados no meio, o
  // sumário é de outra leitura e não pode sair "em dia".
  if (indiceHash && indiceHash !== hash) return { ok: false, erro: `os autos mudaram entre a leitura (${indiceHash.slice(0, 19)}…) e a marcação (${hash.slice(0, 19)}…): refaça o sumário sobre a leitura atual` };
  const texto = readFileSync(sumario, 'utf8');
  if (RE_MARCADOR.test(texto)) return { ok: false, erro: 'o sumário ainda tem marcador de preenchimento' };
  const folhas = contarFolhas(texto);
  if (!folhas && !semFolhas) return { ok: false, erro: 'o sumário não cita nenhuma folha (fls. N, p. N, pp. N-M ou Doc. NN): sumário sem folha é resumo de memória; se os autos não têm PDF paginado, passe --sem-folhas' };
  const imagens = inventarioDeImagens(dir);
  const descricoesSemCabecalho = [];
  const pastaDesc = join(dir, PASTA_SUMARIO, PASTA_DESCRICOES);
  if (existsSync(pastaDesc)) {
    for (const f of readdirSync(pastaDesc).filter((n) => n.endsWith('.md'))) {
      const t = readFileSync(join(pastaDesc, f), 'utf8');
      if (!t.includes(CABECALHO_DESCRICAO)) descricoesSemCabecalho.push(f);
    }
  }
  if (descricoesSemCabecalho.length) return { ok: false, erro: `${descricoesSemCabecalho.length} descrição(ões) de imagem sem o cabeçalho de procedência (${descricoesSemCabecalho.slice(0, 3).join(', ')}${descricoesSemCabecalho.length > 3 ? '…' : ''}): a descrição é interpretação de máquina e tem de dizer isso na primeira linha` };
  const manifesto = { versao: 2, indice_hash: hash, documentos: documentosDoIndice(dir), conversoes: conversoesDosAutos(dir), gerado_em: agora(), por: por || null, folhas_citadas: folhas, imagens_descritas: imagens.descritas, imagens_pendentes: imagens.total - imagens.descritas, caracteres: texto.length };
  mkdirSync(join(dir, PASTA_SUMARIO), { recursive: true });
  writeFileSync(join(dir, PASTA_SUMARIO, MANIFESTO_SUMARIO), `${JSON.stringify(manifesto, null, 2)}\n`, 'utf8');
  return { ok: true, manifesto };
}

// --- CLI -----------------------------------------------------------------------

function uso() {
  return 'uso: node scripts/sumario-autos.mjs <status|imagens|marcar> <squads/<nome>|pasta-do-caso|autos/> [--json] [--teto N] [--incluir-ocr] [--por "<squad/run>"] [--sem-folhas] [--indice-hash <hash do status>]';
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: 'boolean' }, teto: { type: 'string' }, 'incluir-ocr': { type: 'boolean' }, por: { type: 'string' }, 'sem-folhas': { type: 'boolean' }, 'indice-hash': { type: 'string' },
  } });
  const [comando, entrada] = positionals;
  if (!comando || !entrada) { console.error(uso()); return 2; }
  const { dir, erro } = resolverAutos(entrada);
  if (!dir) { console.error(`sumario-autos: ${erro}`); return 1; }
  const json = values.json === true;
  if (comando === 'status') {
    const s = statusDoSumario(dir);
    if (json) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(`Sumário do caso: ${s.em_dia ? (s.imagens_pendentes ? 'EM DIA, IMAGENS PENDENTES' : 'EM DIA') : 'DESATUALIZADO'} (${s.motivo})`);
      if (s.existe) console.log(`  ${s.sumario} · ${s.folhas_citadas} folha(s) citada(s)${s.marcado ? ` · marcado em ${s.marcado.em} por ${s.marcado.por || 'não informado'}` : ''}`);
      console.log(`  Imagens sem leitura: ${s.imagens.total} (${s.imagens.descritas} descritas, ${s.imagens.pendentes} pendentes)`);
    }
    // 0: em dia · 3: desatualizado (refazer o sumário) · 4: sumário vale, faltam descrições de imagem
    return s.em_dia ? (s.imagens_pendentes ? 4 : 0) : 3;
  }
  if (comando === 'imagens') {
    const teto = values.teto ? Number(values.teto) : TETO_DE_IMAGENS;
    if (!Number.isInteger(teto) || teto < 0) { console.error('sumario-autos: --teto precisa ser inteiro >= 0'); return 2; }
    const inv = inventarioDeImagens(dir, { incluirOcr: values['incluir-ocr'] === true, teto });
    if (json) console.log(JSON.stringify({ autos: dir, cabecalho_obrigatorio: CABECALHO_DESCRICAO, ...inv }, null, 2));
    else {
      console.log(`Imagens sem leitura: ${inv.total} (${inv.descritas} descritas, ${inv.pendentes.length} a descrever agora${inv.alem_do_teto ? `, ${inv.alem_do_teto} além do teto de ${teto}` : ''})`);
      for (const it of inv.pendentes) console.log(`  ${it.imagem}  →  ${it.descricao}${it.pagina ? `  (${it.documento}, fls. ${it.pagina}, ${it.origem})` : `  (${it.origem})`}`);
    }
    return 0;
  }
  if (comando === 'marcar') {
    const r = marcarSumario(dir, { por: values.por, semFolhas: values['sem-folhas'] === true, indiceHash: values['indice-hash'] || null });
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (r.ok) console.log(`Sumário marcado: ${r.manifesto.folhas_citadas} folha(s) citada(s), ${r.manifesto.imagens_descritas} imagem(ns) descrita(s), ${r.manifesto.imagens_pendentes} pendente(s); índice ${r.manifesto.indice_hash.slice(0, 19)}…`);
    else console.error(`sumario-autos: ${r.erro}`);
    return r.ok ? 0 : 1;
  }
  console.error(uso());
  return 2;
}

// Guarda de entrada por caminho real: `import.meta.url === file://argv[1]` falha com espaço ou
// acento no caminho do projeto (achado no run de 19/09 na calculadora de prazo).
function chamadoDiretamente() {
  try { return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); } catch { return false; }
}
if (chamadoDiretamente()) process.exit(main());
