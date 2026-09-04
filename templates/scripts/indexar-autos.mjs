#!/usr/bin/env node
/**
 * Indexador de autos — a fase zero do run (PLANO-ORQUESTRADOR.md, Fase 2).
 *
 * Os autos do caso ficam em `squads/<nome>/autos/` (PDFs e documentos que o
 * profissional coloca lá). Este script varre a pasta UMA vez e grava
 * `autos/_index.yaml` — o inventário que os agentes leem em vez de reler
 * duzentas páginas a cada step — e, quando há texto, o cache
 * `autos/_texto/<arquivo>.txt`, com a linha `===== página N/M =====` abrindo
 * cada página, para a peça poder citar folhas.
 *
 * Honesto por construção:
 * - texto: só extrai com `pdftotext` (poppler) no PATH — `pdftotext -layout`.
 *   Sem ele, marca `nao-extraivel-localmente` e NÃO tenta parsear PDF à mão:
 *   o agente lê por página com a ferramenta Read. PDF escaneado (pdftotext
 *   devolve vazio) sai como `nao-extraivel`; PDF com páginas sem texto no meio
 *   das que têm, `parcial`.
 * - páginas: as quebras de página do pdftotext quando ele rodou; senão a
 *   contagem de `/Type /Page` nos bytes; se nada mede (PDF com object streams
 *   e sem pdftotext), `null` — nunca 0 inventado.
 * - tipo: pelo nome do arquivo, depois pelas primeiras linhas do texto; senão
 *   `desconhecido` — nunca chute. Nome com um ato que o vocabulário não tem
 *   (`recurso-contra-sentenca.pdf`) não decide pelo nome.
 * - LGPD: CPF, CNPJ, RG, e-mail e telefone nunca entram no índice
 *   (`primeira_pagina` sai mascarada com `***`); partes não são extraídas.
 *   O cache em `_texto/` guarda o texto inteiro e fica, com a pasta, fora do git.
 * - idempotente: sem mudança, o índice não muda (nem `gerado_em`). Arquivo com
 *   os mesmos bytes e mtime é reaproveitado do índice anterior; `--forcar`
 *   reindexa tudo. Cache de texto órfão (documento removido) é apagado.
 * - entradas iniciadas por `_` ou `.` são internas (`_index.yaml`, `_texto/`,
 *   ocultos) e ficam fora do inventário; subpastas são percorridas.
 *
 * Uso:
 *   node scripts/indexar-autos.mjs squads/<nome>            # ou o caminho direto de autos/
 *   node scripts/indexar-autos.mjs squads/<nome> --json     # índice em JSON (em vez de YAML) no stdout
 *   node scripts/indexar-autos.mjs squads/<nome> --check    # só imprime, não grava
 *   node scripts/indexar-autos.mjs squads/<nome> --forcar   # reindexa tudo
 *
 * Ambiente: LEGALSQUAD_PDFTOTEXT=<binário> aponta o pdftotext; `=0` desliga.
 * Sai com 1 quando a pasta não existe ou o uso está errado.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSAO_INDICE = 1;
export const TIPOS = ['inicial', 'contestacao', 'replica', 'sentenca', 'acordao', 'decisao', 'certidao', 'intimacao', 'procuracao', 'contrato', 'laudo', 'documento', 'desconhecido'];
export const STATUS_TEXTO = ['extraivel', 'parcial', 'nao-extraivel', 'nao-extraivel-localmente', 'nao-pdf'];

const NOME_INDICE = '_index.yaml';
const PASTA_TEXTO = '_texto';
const EXT_TEXTO = new Set(['.txt', '.md']);
/** Página "com texto": abaixo disto é número de folha, carimbo ou ruído de vetor. */
const MIN_CARACTERES_PAGINA = 40;
const MAX_PRIMEIRA_PAGINA = 600;
const MAX_DATAS = 20;

export class ErroDeUso extends Error {}

/** Minúsculas sem acento — a base de toda comparação de nome e cabeçalho. */
export function normalizar(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// --- tipo ------------------------------------------------------------------

const TIPO_POR_TOKEN = new Map([
  ['inicial', 'inicial'], ['exordial', 'inicial'],
  ['contestacao', 'contestacao'],
  ['replica', 'replica'],
  ['sentenca', 'sentenca'],
  ['acordao', 'acordao'],
  ['decisao', 'decisao'],
  ['certidao', 'certidao'],
  ['intimacao', 'intimacao'],
  ['procuracao', 'procuracao'],
  ['contrato', 'contrato'],
  ['laudo', 'laudo'],
]);
/** Genéricos: só decidem depois do texto — `anexo-contrato.pdf` é um contrato. */
const TOKENS_GENERICOS = new Set(['documento', 'documentos', 'doc', 'docs', 'anexo', 'anexos']);
/**
 * Atos que o vocabulário do índice não tem. Antes da primeira palavra-chave
 * (`recurso-contra-sentenca.pdf`), o nome deixa de decidir: chutar `sentenca`
 * seria pior que `desconhecido`.
 */
const OUTROS_ATOS = new Set(['apelacao', 'agravo', 'recurso', 'embargos', 'memoriais', 'manifestacao', 'parecer', 'despacho', 'mandado', 'oficio', 'ata', 'audiencia', 'alegacoes', 'impugnacao', 'reconvencao', 'quesitos', 'requerimento', 'razoes', 'contrarrazoes', 'peticao']);

function analisarNome(arquivo) {
  const semExt = normalizar(basename(arquivo)).replace(/\.[a-z0-9]+$/, '');
  const tokens = semExt.split(/[^a-z0-9]+/).filter(Boolean);
  let generico = null;
  let bloqueado = false;
  for (const t of tokens) {
    if (TIPO_POR_TOKEN.has(t)) return { tipo: bloqueado ? null : TIPO_POR_TOKEN.get(t), generico: null };
    if (t === 'peticao') continue; // `peticao-inicial` — a palavra sozinha não é ato
    if (OUTROS_ATOS.has(t)) bloqueado = true;
    else if (TOKENS_GENERICOS.has(t) && !bloqueado && !generico) generico = 'documento';
  }
  return { tipo: null, generico: bloqueado ? null : generico };
}

const CABECALHOS = [
  [/^peticao inicial\b/, 'inicial'],
  [/^contestacao\b/, 'contestacao'],
  [/^replica\b/, 'replica'],
  [/^sentenca\b/, 'sentenca'],
  [/^acordao\b/, 'acordao'],
  [/^decisao\b/, 'decisao'],
  [/^certidao\b/, 'certidao'],
  [/^(?:mandado de )?intimacao\b/, 'intimacao'],
  [/^procuracao\b/, 'procuracao'],
  [/^(?:instrumento (?:particular|publico) de )?contrato\b/, 'contrato'],
  [/^laudo\b/, 'laudo'],
];
const CABECALHOS_OUTROS = /^(?:(?:recurso de |razoes de |contrarrazoes de |razoes da |razoes do )?apelacao|agravo|recurso|embargos|memoriais|manifestacao|parecer|despacho|mandado|oficio|ata d|alegacoes|impugnacao|reconvencao|quesitos|requerimento|razoes|contrarrazoes|peticao)\b/;
const MARCAS_INICIAL = /\b(?:peticao inicial|acao (?:de|ordinaria|declaratoria|monitoria|cautelar)|vem propor|propor a presente|propoe a presente|valor da causa|da-se a causa)\b/;
const LINHAS_DE_CABECALHO = 80;

/** Cabeçalho de peça é linha curta e em caixa alta — "Vistos" e o corpo não contam. */
function ehLinhaMaiuscula(linha) {
  const letras = linha.match(/\p{L}/gu) || [];
  if (letras.length < 4) return false;
  const maiusculas = linha.match(/\p{Lu}/gu) || [];
  return maiusculas.length / letras.length >= 0.8;
}

export function tipoPeloTexto(texto) {
  if (!texto) return null;
  const linhas = String(texto).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, LINHAS_DE_CABECALHO);
  for (const linha of linhas) {
    if (linha.length > 100 || !ehLinhaMaiuscula(linha)) continue;
    const n = normalizar(linha);
    for (const [re, tipo] of CABECALHOS) if (re.test(n)) return tipo;
    if (CABECALHOS_OUTROS.test(n)) return null;
  }
  const janela = normalizar(linhas.join(' '));
  if (janela.includes('excelentissim') && MARCAS_INICIAL.test(janela)) return 'inicial';
  return null;
}

/** Nome (específico) › texto › nome (genérico) › desconhecido. */
export function inferirTipo(arquivo, texto = null) {
  const nome = analisarNome(arquivo);
  if (nome.tipo) return { tipo: nome.tipo, tipo_fonte: 'nome' };
  const porTexto = tipoPeloTexto(texto);
  if (porTexto) return { tipo: porTexto, tipo_fonte: 'texto' };
  if (nome.generico) return { tipo: nome.generico, tipo_fonte: 'nome' };
  return { tipo: 'desconhecido', tipo_fonte: 'desconhecido' };
}

// --- datas, número CNJ, LGPD -------------------------------------------------

const MESES = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };

function dataIso(ano, mes, dia) {
  if (ano < 1900 || ano > 2099 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return d.toISOString().slice(0, 10);
}

/** dd/mm/aaaa e "dd de mês de aaaa" → ISO; as mais frequentes até `max`, ordenadas. */
export function extrairDatas(texto, max = MAX_DATAS) {
  const contagem = new Map();
  const soma = (iso) => { if (iso) contagem.set(iso, (contagem.get(iso) || 0) + 1); };
  const t = normalizar(texto);
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) soma(dataIso(+m[3], +m[2], +m[1]));
  for (const m of t.matchAll(/\b(\d{1,2})[º°o]?\s+de\s+([a-z]+)\s+de\s+(\d{4})\b/g)) {
    if (MESES[m[2]]) soma(dataIso(+m[3], MESES[m[2]], +m[1]));
  }
  return [...contagem.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([iso]) => iso)
    .sort();
}

const CNJ = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;

export function extrairNumeroProcesso(texto) {
  const m = String(texto || '').match(CNJ);
  return m ? m[0] : null;
}

/** O que nunca entra no índice: CNPJ, CPF, RG, e-mail, telefone — com ou sem pontuação. */
export function mascarar(texto) {
  return String(texto)
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '**.***.***/****-**')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '***.***.***-**')
    .replace(/\b\d{1,2}\.\d{3}\.\d{3}-?[\dxX]\b/g, '**.***.***-*')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '***@***')
    .replace(/\(?\b\d{2}\)?\s?(?:9\s?)?\d{4}[-\s]\d{4}\b/g, '(**) *****-****')
    .replace(/\b\d{11}\b|\b\d{14}\b/g, (m) => '*'.repeat(m.length));
}

export function primeiraPagina(texto, max = MAX_PRIMEIRA_PAGINA) {
  const limpo = mascarar(texto).replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  return Array.from(limpo).slice(0, max).join('');
}

// --- PDF ---------------------------------------------------------------------

/** Conta `/Type /Page` (tolera `/Type/Page`, exclui `/Pages`). 0 vira `null`: não se inventa página. */
export function contarPaginasPdf(buf) {
  const n = (buf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  return n > 0 ? n : null;
}

/** Caminho do pdftotext, ou `null`. `LEGALSQUAD_PDFTOTEXT` aponta o binário; `0`/`nao`/`off` desliga. */
export function detectarPdftotext(env = process.env) {
  const cfg = env.LEGALSQUAD_PDFTOTEXT;
  if (cfg !== undefined && cfg !== '') {
    if (/^(?:0|nao|não|no|false|off)$/i.test(cfg)) return null;
    return cfg;
  }
  const r = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  return r.error ? null : 'pdftotext';
}

function extrairTextoPdf(bin, caminho) {
  const r = spawnSync(bin, ['-layout', '-enc', 'UTF-8', caminho, '-'], { maxBuffer: 512 * 1024 * 1024, timeout: 120000 });
  if (r.error) return { ok: false, erro: r.error.message };
  if (r.status !== 0) {
    const primeira = String(r.stderr || '').trim().split('\n')[0];
    return { ok: false, erro: `pdftotext saiu com código ${r.status}${primeira ? ` (${primeira})` : ''}` };
  }
  return { ok: true, texto: r.stdout.toString('utf8') };
}

/** pdftotext fecha cada página com \f — inclusive a última e as vazias. */
export function dividirPaginas(texto) {
  if (!texto) return [];
  const partes = texto.split('\f');
  if (partes.length > 1 && partes[partes.length - 1].trim() === '') partes.pop();
  return partes;
}

export function statusDoTexto(paginas) {
  const comTexto = paginas.filter((p) => p.replace(/\s+/g, '').length >= MIN_CARACTERES_PAGINA).length;
  if (comTexto === 0) return 'nao-extraivel';
  return comTexto < paginas.length ? 'parcial' : 'extraivel';
}

export function textoComMarcadores(paginas) {
  const total = paginas.length;
  return paginas.map((p, i) => `===== página ${i + 1}/${total} =====\n${p.replace(/\s+$/, '')}\n`).join('\n');
}

// --- YAML (só o subconjunto que este script emite) -------------------------------

const q = (v) => JSON.stringify(String(v));
const escalar = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : q(v));

export function paraYaml(indice) {
  const linhas = [
    '# Índice dos autos — GERADO por `node scripts/indexar-autos.mjs` (não editar à mão; será sobrescrito).',
    '# Os agentes leem este índice e o cache em _texto/ em vez de reler os PDFs a cada step.',
    '# Sem dado pessoal por construção: CPF/CNPJ/RG/e-mail/telefone mascarados; partes não são extraídas.',
    `versao: ${indice.versao}`,
    `gerado_em: ${q(indice.gerado_em)}`,
    `raiz: ${q(indice.raiz)}`,
    `ferramentas: { pdftotext: ${indice.ferramentas.pdftotext ? 'true' : 'false'} }`,
  ];
  if (!indice.documentos.length) {
    linhas.push('documentos: []');
    return `${linhas.join('\n')}\n`;
  }
  linhas.push('documentos:');
  for (const d of indice.documentos) {
    linhas.push(`  - arquivo: ${q(d.arquivo)}`);
    linhas.push(`    bytes: ${d.bytes}`);
    linhas.push(`    mtime: ${q(d.mtime)}`);
    linhas.push(`    paginas: ${escalar(d.paginas)}`);
    linhas.push(`    texto: ${d.texto}`);
    linhas.push(`    texto_cache: ${escalar(d.texto_cache)}`);
    linhas.push(`    markdown: ${escalar(d.markdown)}`);
    linhas.push(`    tipo: ${d.tipo}`);
    linhas.push(`    tipo_fonte: ${d.tipo_fonte}`);
    linhas.push(`    datas: [${d.datas.map(q).join(', ')}]`);
    linhas.push(`    numero_processo: ${escalar(d.numero_processo)}`);
    linhas.push(`    primeira_pagina: ${escalar(d.primeira_pagina)}`);
  }
  return `${linhas.join('\n')}\n`;
}

function valorYaml(bruto) {
  const s = String(bruto).trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('"') || s.startsWith('[')) return JSON.parse(s);
  if (s.startsWith('{')) {
    const o = {};
    for (const par of s.slice(1, -1).split(',')) {
      const i = par.indexOf(':');
      if (i > 0) o[par.slice(0, i).trim()] = valorYaml(par.slice(i + 1));
    }
    return o;
  }
  return s;
}

/** Lê um `_index.yaml` gerado por `paraYaml`. Lança em qualquer forma que não seja a emitida. */
export function lerIndiceYaml(texto) {
  const indice = { documentos: [] };
  let atual = null;
  for (const linha of String(texto).split(/\r?\n/)) {
    if (!linha.trim() || linha.trimStart().startsWith('#')) continue;
    const m = linha.match(/^(\s*)(- )?([a-z_]+):\s?(.*)$/);
    if (!m) throw new Error(`linha inesperada no índice: ${linha}`);
    const [, recuo, item, chave, valor] = m;
    if (recuo.length === 0) {
      atual = null;
      if (chave === 'documentos') {
        if (valor.trim() && valor.trim() !== '[]') throw new Error('documentos: forma inesperada');
        continue;
      }
      indice[chave] = valorYaml(valor);
    } else if (item) {
      atual = { [chave]: valorYaml(valor) };
      indice.documentos.push(atual);
    } else if (atual) {
      atual[chave] = valorYaml(valor);
    } else {
      throw new Error(`campo fora de documento: ${linha}`);
    }
  }
  return indice;
}

// --- indexação -----------------------------------------------------------------

const posix = (p) => p.split(sep).join('/');

/** Aceita `squads/<nome>` (usa `autos/` dentro) ou o caminho direto de `autos/`. */
export function resolverAutos(entrada) {
  const abs = resolve(entrada);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: null, erro: `pasta não encontrada: ${entrada}` };
  if (basename(abs) === 'autos') return { dir: abs, erro: null };
  const sub = join(abs, 'autos');
  if (existsSync(sub) && statSync(sub).isDirectory()) return { dir: sub, erro: null };
  return { dir: null, erro: `${entrada} existe, mas não tem a pasta autos/ — crie squads/<nome>/autos/ e coloque nela os PDFs e documentos do caso` };
}

function listarArquivos(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const full = join(dir, e.name);
    let st = e;
    if (e.isSymbolicLink()) {
      try { st = statSync(full); } catch { continue; }
    }
    if (st.isDirectory()) listarArquivos(full, base, acc);
    else if (st.isFile()) acc.push(posix(relative(base, full)));
  }
  return acc.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const cachePara = (arquivo) => `${PASTA_TEXTO}/${arquivo.replace(/\.[^./]+$/, '')}.txt`;

function entradaValida(d) {
  return d && typeof d.arquivo === 'string' && typeof d.bytes === 'number' && typeof d.mtime === 'string'
    && STATUS_TEXTO.includes(d.texto) && TIPOS.includes(d.tipo) && typeof d.tipo_fonte === 'string' && Array.isArray(d.datas)
    && 'paginas' in d && 'texto_cache' in d && 'numero_processo' in d && 'primeira_pagina' in d;
}

function podeReaproveitar(prev, bytes, mtime, temPdftotext, dir) {
  if (!entradaValida(prev) || prev.bytes !== bytes || prev.mtime !== mtime) return false;
  if (prev.texto === 'nao-extraivel-localmente' && temPdftotext) return false; // agora dá para extrair
  if (prev.texto_cache && !existsSync(join(dir, prev.texto_cache))) return false;
  // A conversão para Markdown roda DEPOIS do índice — é outro comando, e é a
  // ordem natural (indexar para saber o que há, converter em seguida). Sem esta
  // linha, reindexar não via a conversão nova: o PDF não mudou, a entrada era
  // reaproveitada com `markdown: null`, e o ponteiro nunca aparecia. O agente
  // seguia abrindo o PDF a cada step com o Markdown pronto ao lado.
  const md = join('_md', slugDeArquivo(prev.arquivo), 'documento.md');
  if (existsSync(join(dir, md)) !== Boolean(prev.markdown)) return false;
  return true;
}

function lerAnterior(dir, avisar) {
  const caminho = join(dir, NOME_INDICE);
  if (!existsSync(caminho)) return null;
  try {
    const idx = lerIndiceYaml(readFileSync(caminho, 'utf8'));
    return idx.versao === VERSAO_INDICE ? idx : null;
  } catch (e) {
    avisar(`aviso: ${NOME_INDICE} anterior ilegível (${e.message}) — reindexando do zero`);
    return null;
  }
}

/**
 * Mesma regra de nome que `autos-para-md.py` usa para a pasta de saída: sem
 * acento, não-alfanumérico vira hífen, minúsculas, 80 caracteres. As duas
 * cópias precisam concordar, ou o índice aponta para uma pasta que não existe.
 */
function slugDeArquivo(arquivo) {
  const semExt = arquivo.replace(/\.[^.]*$/, '');
  return semExt.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80);
}

function indexarArquivo({ dir, arquivo, bytes, mtime, pdftotext, avisar }) {
  const full = join(dir, arquivo);
  const doc = { arquivo, bytes, mtime, paginas: null, texto: 'nao-pdf', texto_cache: null, markdown: null, tipo: 'desconhecido', tipo_fonte: 'desconhecido', datas: [], numero_processo: null, primeira_pagina: null };
  let conteudo = null;
  let cache = null;
  const ext = extname(arquivo).toLowerCase();
  // Markdown já convertido por `autos-para-md.py`, se existir. O índice APONTA,
  // não converte: a conversão é Python (PyMuPDF + OCR) e roda uma vez; o que
  // não pode é o agente não saber que o Markdown existe e voltar a abrir o PDF
  // a cada step — 700 páginas relidas por step é o custo que a fase zero existe
  // para eliminar.
  const md = join('_md', slugDeArquivo(arquivo), 'documento.md');
  if (existsSync(join(dir, md))) doc.markdown = md;
  if (ext === '.pdf') {
    const porBytes = contarPaginasPdf(readFileSync(full));
    doc.paginas = porBytes;
    if (!pdftotext) {
      doc.texto = 'nao-extraivel-localmente';
    } else {
      const r = extrairTextoPdf(pdftotext, full);
      if (!r.ok) {
        avisar(`aviso: ${arquivo}: ${r.erro} — marcado nao-extraivel`);
        doc.texto = 'nao-extraivel';
      } else {
        const paginas = dividirPaginas(r.texto);
        if (paginas.length) doc.paginas = paginas.length;
        doc.texto = statusDoTexto(paginas);
        if (doc.texto !== 'nao-extraivel') {
          conteudo = paginas.join('\n');
          doc.texto_cache = cachePara(arquivo);
          cache = textoComMarcadores(paginas);
        }
      }
    }
  } else if (EXT_TEXTO.has(ext)) {
    conteudo = readFileSync(full, 'utf8');
  }
  Object.assign(doc, inferirTipo(arquivo, conteudo));
  if (conteudo) {
    doc.datas = extrairDatas(conteudo);
    doc.numero_processo = extrairNumeroProcesso(conteudo);
    doc.primeira_pagina = primeiraPagina(conteudo);
  }
  if (!doc.numero_processo) doc.numero_processo = extrairNumeroProcesso(arquivo);
  return { doc, cache };
}

function gravarAtomico(caminho, conteudo) {
  mkdirSync(dirname(caminho), { recursive: true });
  const tmp = `${caminho}.tmp`;
  writeFileSync(tmp, conteudo, 'utf8');
  renameSync(tmp, caminho);
}

function listarCaches(dir) {
  const raiz = join(dir, PASTA_TEXTO);
  if (!existsSync(raiz)) return [];
  const acc = [];
  const anda = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) anda(full);
      else if (e.isFile() && e.name.endsWith('.txt')) acc.push(posix(relative(dir, full)));
    }
  };
  anda(raiz);
  return acc;
}

/**
 * Indexa a pasta de autos. Devolve `{ indice, caminhoIndice, gravado, reaproveitados }`.
 * Com `check`, nada toca o disco. Lança `ErroDeUso` quando a pasta não existe.
 */
export function indexar(entrada, { forcar = false, check = false, pdftotext = detectarPdftotext(), agora = () => new Date().toISOString(), avisar = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const { dir, erro } = resolverAutos(entrada);
  if (!dir) throw new ErroDeUso(erro);
  const anterior = lerAnterior(dir, avisar);
  const anteriorPorArquivo = new Map((anterior ? anterior.documentos : []).map((d) => [d.arquivo, d]));

  const documentos = [];
  const caches = new Map();
  let reaproveitados = 0;
  for (const arquivo of listarArquivos(dir)) {
    const st = statSync(join(dir, arquivo));
    const mtime = st.mtime.toISOString();
    const prev = anteriorPorArquivo.get(arquivo);
    if (!forcar && podeReaproveitar(prev, st.size, mtime, !!pdftotext, dir)) {
      documentos.push(prev);
      reaproveitados += 1;
      continue;
    }
    const { doc, cache } = indexarArquivo({ dir, arquivo, bytes: st.size, mtime, pdftotext, avisar });
    documentos.push(doc);
    if (cache !== null) caches.set(doc.texto_cache, cache);
  }

  const rel = relative(process.cwd(), dir);
  const raiz = rel && !rel.startsWith('..') && !isAbsolute(rel) ? posix(rel) : posix(dir);
  const indice = { versao: VERSAO_INDICE, gerado_em: null, raiz, ferramentas: { pdftotext: !!pdftotext }, documentos };
  // Comparação pelo emissor canônico (ordem fixa de chaves): só o conteúdo decide se a data muda.
  const semData = (i) => paraYaml({ ...i, gerado_em: '' });
  indice.gerado_em = anterior && semData(anterior) === semData(indice) ? anterior.gerado_em : agora();

  const caminhoIndice = join(dir, NOME_INDICE);
  if (!check) {
    for (const [relCache, conteudo] of caches) gravarAtomico(join(dir, relCache), conteudo);
    const vivos = new Set(documentos.map((d) => d.texto_cache).filter(Boolean));
    for (const orfao of listarCaches(dir)) if (!vivos.has(orfao)) rmSync(join(dir, orfao), { force: true });
    gravarAtomico(caminhoIndice, paraYaml(indice));
  }
  return { indice, caminhoIndice, gravado: !check, reaproveitados };
}

// --- CLI -----------------------------------------------------------------------

const USO = 'uso: node scripts/indexar-autos.mjs <squads/nome | squads/nome/autos> [--json] [--check] [--forcar]';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const desconhecidas = flags.filter((f) => !['--json', '--check', '--forcar'].includes(f));
  const entrada = args.find((a) => !a.startsWith('--'));
  if (!entrada || desconhecidas.length) {
    process.stderr.write(`${desconhecidas.length ? `opção desconhecida: ${desconhecidas.join(' ')}\n` : ''}${USO}\n`);
    process.exit(1);
  }
  const check = flags.includes('--check');
  try {
    const pdftotext = detectarPdftotext();
    const { indice, caminhoIndice, reaproveitados } = indexar(entrada, { forcar: flags.includes('--forcar'), check, pdftotext });
    process.stdout.write(flags.includes('--json') ? `${JSON.stringify(indice, null, 2)}\n` : paraYaml(indice));
    const n = indice.documentos.length;
    const destino = check ? '--check: nada gravado' : `→ ${posix(relative(process.cwd(), caminhoIndice)) || caminhoIndice}`;
    const semFerramenta = pdftotext ? '' : ' · pdftotext ausente: texto de PDF não extraído localmente (o agente lê por página)';
    process.stderr.write(`indexar-autos: ${n} documento${n === 1 ? '' : 's'}${reaproveitados ? ` (${reaproveitados} reaproveitado${reaproveitados === 1 ? '' : 's'})` : ''} ${destino}${semFerramenta}\n`);
    process.exit(0);
  } catch (e) {
    if (e instanceof ErroDeUso) {
      process.stderr.write(`indexar-autos: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}
