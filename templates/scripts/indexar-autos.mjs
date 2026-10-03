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
 * - origem: `autos` (o documento tem folha: âncora `## fls. N`, rodapé do PJe,
 *   carimbo do e-SAJ, evento do eproc), `cliente` (página sem folha, `## p. N`,
 *   ou o cabeçalho diz que não foi juntado; numa pasta com folha, o documento
 *   com texto e sem folha nenhuma) ou `null` (sem texto para dizer). É o que o
 *   Redação Gate usa para cobrar folha só de documento dos autos.
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

export const VERSAO_INDICE = 2; // 2: cobertura por página (paginas_sem_texto); índice v1 é reindexado do zero
// Tipos de documento de qualquer área: a peça que abre o processo (inicial, denúncia), os atos
// do juízo, os documentos de prova (auto, boletim, relatório, ata, declaração, comprovante).
// Medido no run de 16/09/2026: dos 12 documentos de um processo criminal, 8 saíam `desconhecido`.
export const TIPOS = ['inicial', 'denuncia', 'contestacao', 'replica', 'sentenca', 'acordao', 'decisao', 'certidao', 'intimacao', 'procuracao', 'contrato', 'laudo', 'auto', 'boletim', 'relatorio', 'ata', 'declaracao', 'comprovante', 'documento', 'desconhecido'];
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
  ['denuncia', 'denuncia'],
  ['auto', 'auto'], ['autos', 'auto'],
  ['boletim', 'boletim'], ['bo', 'boletim'],
  ['relatorio', 'relatorio'],
  ['ata', 'ata'],
  ['declaracao', 'declaracao'], ['declaracoes', 'declaracao'],
  ['comprovante', 'comprovante'], ['comprovantes', 'comprovante'],
]);
/** Genéricos: só decidem depois do texto — `anexo-contrato.pdf` é um contrato. */
const TOKENS_GENERICOS = new Set(['documento', 'documentos', 'doc', 'docs', 'anexo', 'anexos']);
/**
 * Atos que o vocabulário do índice não tem. Antes da primeira palavra-chave
 * (`recurso-contra-sentenca.pdf`), o nome deixa de decidir: chutar `sentenca`
 * seria pior que `desconhecido`.
 */
const OUTROS_ATOS = new Set(['apelacao', 'agravo', 'recurso', 'embargos', 'memoriais', 'manifestacao', 'parecer', 'despacho', 'mandado', 'oficio', 'audiencia', 'alegacoes', 'impugnacao', 'reconvencao', 'quesitos', 'requerimento', 'razoes', 'contrarrazoes', 'peticao']);

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
  [/^denuncia\b/, 'denuncia'],
  [/^auto de\b/, 'auto'],
  [/^boletim de ocorrencia\b/, 'boletim'],
  [/^relatorio\b/, 'relatorio'],
  [/^ata d[aeo]\b/, 'ata'],
  [/^declarac(?:ao|oes)\b/, 'declaracao'],
  [/^comprovantes?\b/, 'comprovante'],
];
const CABECALHOS_OUTROS = /^(?:(?:recurso de |razoes de |contrarrazoes de |razoes da |razoes do )?apelacao|agravo|recurso|embargos|memoriais|manifestacao|parecer|despacho|mandado|oficio|alegacoes|impugnacao|reconvencao|quesitos|requerimento|razoes|contrarrazoes|peticao)\b/;
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

/** [150,151,190,191,192] → "150-151, 190-192" (o que o intake diz ao usuário). */
export function faixasDePaginas(numeros) {
  const n = [...new Set(numeros)].sort((a, b) => a - b);
  const faixas = [];
  let i = 0;
  while (i < n.length) {
    const inicio = n[i];
    let fim = inicio;
    while (i + 1 < n.length && n[i + 1] === fim + 1) { fim = n[i + 1]; i++; }
    faixas.push(inicio === fim ? String(inicio) : `${inicio}-${fim}`);
    i++;
  }
  return faixas.join(', ');
}

/**
 * Rodapé e carimbo que o PJe (e outros sistemas) imprimem em TODA folha como texto nativo, a mesma
 * regra de `RE_RODAPE` do `autos-para-md.py` (as duas cópias precisam concordar). Numa folha que é
 * só foto, nota ou boletim escaneado, o rodapé sozinho passa de 300 caracteres e a folha contava
 * como "com texto". Medido no teste com autos reais de 27/09/2026 (561 folhas do PJe): o índice
 * dizia 73 folhas sem texto antes da conversão e o conversor, 196 sem camada de texto útil. A
 * medição é feita sobre o texto ÚTIL; o cache em `_texto/` guarda o texto inteiro, rodapé incluído.
 */
const ATE_A_DATA = String.raw`[^\n]{0,120}?(?:\d{2}/\d{2}/\d{4}[ \d:]*|$)`;
const RE_RODAPE = new RegExp([
  String.raw`este documento foi gerado${ATE_A_DATA}`,
  String.raw`n[uú]mero do documento:?(?:[ \t]*\d{8,})?`,
  String.raw`assinado (?:eletronicamente|digitalmente) por${ATE_A_DATA}`,
  String.raw`documento assinado digitalmente${ATE_A_DATA}`,
  String.raw`este documento [eé] c[oó]pia do original${ATE_A_DATA}`,
  String.raw`(?:https?|hitps?|htps?)[ \t]*:[ \t]*/[ \t]*/[ \t]*\S+`,
  String.raw`\S*(?:\.jus\.br|listview\.seam)\S*`,
  String.raw`\b(?:pje|esaj|projudi|eproc)\.(?:[a-z0-9-]+\.)+[a-z]{2,}\S*`,
  String.raw`num\.?[ \t]*\d{4,}[ \t]*-?[ \t]*p[aá]g\.?[ \t]*\d+`,
  String.raw`^[^\p{L}\p{N}_\n]{0,4}(?:fls?\.?[ \t]*\d+|\d{15,})[ \t]*$`,
].join('|'), 'gimu');

/** O que sobra da página depois do rodapé de sistema, com o espaço colapsado: é isto que se mede. */
export function textoUtil(texto) {
  return String(texto || '').replace(RE_RODAPE, '').replace(/\s+/g, ' ').trim();
}

/** Página sem camada de texto útil: abaixo do mínimo, descontado o rodapé do sistema. */
const semTextoUtil = (p) => textoUtil(p).length < MIN_CARACTERES_PAGINA;

/** Páginas (1-based) abaixo do mínimo de caracteres úteis: sem camada de texto, provavelmente digitalizadas. */
export function paginasSemTexto(paginas) {
  const out = [];
  paginas.forEach((p, i) => { if (semTextoUtil(p)) out.push(i + 1); });
  return out;
}

/**
 * Cobertura depois da conversão (`autos-para-md.py` grava `_md/<slug>/_manifesto.json`
 * com a origem de cada folha: nativo, ocr, imagem ou vazia): ninguém leu a página que
 * ficou `vazia` nem a `imagem` em que o OCR não achou um caractere (foto, nota, scan
 * ilegível): essa continua sem texto até alguém a olhar. Sem manifesto, vale o pdftotext.
 */
export function paginasSemTextoDepoisDoOcr(dir, markdownRel) {
  return lerManifestoDaConversao(dir, markdownRel)?.semTexto ?? null;
}

/** `{ semTexto: [páginas], paginas: total | null }` do manifesto de conversão, ou null sem manifesto legível. */
function lerManifestoDaConversao(dir, markdownRel) {
  if (!markdownRel) return null;
  try {
    const manifesto = JSON.parse(readFileSync(join(dir, dirname(markdownRel), '_manifesto.json'), 'utf8'));
    const folhas = Array.isArray(manifesto?.folhas) ? manifesto.folhas : Array.isArray(manifesto?.paginas) ? manifesto.paginas : Array.isArray(manifesto) ? manifesto : null;
    if (!folhas) return null;
    // Folha `imagem` conta sempre como sem texto, com ou sem a legenda que o OCR leu: o conversor a
    // conta como "de imagem sem texto legível" e o descritor do sumário a lista para descrever. Contar
    // a folha com legenda como lida deixava o índice com 7 e o conversor com 10 no mesmo PDF (P4).
    const semTexto = (f) => f && (f.origem === 'vazia' || f.origem === 'imagem');
    const paginas = Number.isFinite(manifesto?.paginas) ? manifesto.paginas : folhas.length || null;
    // `ocr`: `tesseract` (folhas sem camada lidas por máquina), `indisponivel` ou `desligado`
    // (saíram `vazia` sem leitura); manifesto antigo não diz, e aí vale `null`.
    const ocr = typeof manifesto?.ocr === 'string' ? manifesto.ocr : null;
    return { semTexto: folhas.filter(semTexto).map((f) => Number(f.pagina)).filter(Number.isFinite), paginas, ocr };
  } catch {
    return null;
  }
}

/**
 * Cobertura pelo manifesto de conversão, quando ele existe. Vale também para a entrada
 * REAPROVEITADA do índice anterior: o PDF não mudou, mas a conversão pode ter mudado (OCR
 * instalado depois, folhas a mais ou a menos), e `paginas_sem_texto` só era recalculado
 * na indexação completa. Sem isto o gate de leitura integral mandava "converta e reindexe"
 * e o reindexar repetia o número velho. E vale sem `pdftotext`: a conversão já leu as folhas,
 * então a cobertura não pode continuar dizendo que ninguém leu nenhuma.
 */
function coberturaPeloManifesto(dir, doc) {
  const m = lerManifestoDaConversao(dir, doc.markdown);
  if (!m) return doc;
  return {
    ...doc,
    paginas: Number.isFinite(doc.paginas) ? doc.paginas : m.paginas,
    paginas_sem_texto: m.semTexto.length ? faixasDePaginas(m.semTexto) : null,
    paginas_sem_texto_n: m.semTexto.length,
  };
}

export function statusDoTexto(paginas) {
  const comTexto = paginas.filter((p) => !semTextoUtil(p)).length;
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
    '# Índice dos autos: GERADO por `node scripts/indexar-autos.mjs` (não editar à mão; será sobrescrito).',
    '# Os agentes leem este índice e o cache em _texto/ em vez de reler os PDFs a cada step.',
    '# Sem dado pessoal por construção: CPF/CNPJ/RG/e-mail/telefone mascarados; partes não são extraídas.',
    '# PDF integral do PJe: o bloco `pje:` separa os documentos (Num. do rodapé e capa); a peça cita `fls. N` (página do PDF) ou `Num. X - Pág. Y`.',
    `versao: ${indice.versao}`,
    `gerado_em: ${q(indice.gerado_em)}`,
    `raiz: ${q(indice.raiz)}`,
    `ferramentas: { pdftotext: ${indice.ferramentas.pdftotext ? 'true' : 'false'} }`,
  ];
  const cob = indice.cobertura || (() => { const c = cobertura(indice); return { paginas: c.paginas, com_texto: c.comTexto, sem_texto: c.semTexto }; })();
  linhas.push(`cobertura: { paginas: ${cob.paginas}, com_texto: ${cob.com_texto}, sem_texto: ${cob.sem_texto} }`);
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
    linhas.push(`    paginas_sem_texto_n: ${escalar(d.paginas_sem_texto_n ?? null)}`);
    linhas.push(`    paginas_sem_texto: ${escalar(d.paginas_sem_texto ?? null)}`);
    linhas.push(`    tipo: ${d.tipo}`);
    linhas.push(`    tipo_fonte: ${d.tipo_fonte}`);
    linhas.push(`    origem: ${d.origem === 'autos' || d.origem === 'cliente' ? d.origem : 'null'}`);
    linhas.push(`    datas: [${d.datas.map(q).join(', ')}]`);
    linhas.push(`    numero_processo: ${escalar(d.numero_processo)}`);
    linhas.push(`    primeira_pagina: ${escalar(d.primeira_pagina)}`);
    if ('pje_documentos' in d) {
      linhas.push(`    pje_documentos: ${escalar(d.pje_documentos)}`);
      linhas.push(`    pje_capa: ${escalar(d.pje_capa)}`);
      linhas.push(`    pje_capa_documentos: ${escalar(d.pje_capa_documentos)}`);
      linhas.push(`    pje_avisos: ${escalar(d.pje_avisos)}`);
    }
  }
  if (Array.isArray(indice.pje) && indice.pje.length) {
    // Um item por documento do PJe dentro do PDF integral: `folhas` são as páginas do PDF (a folha
    // que o conversor abre com `## fls. N`), `pags` são as páginas do documento no PJe (o rodapé
    // `Num. X - Pág. Y`). Linear: a folha F do documento é a Pág. F - folha_inicial + pag inicial;
    // fora de sequência, `correspondencia` lista folha=Pág. de cada uma.
    linhas.push('pje:');
    for (const p of indice.pje) {
      linhas.push(`  - pdf: ${q(p.pdf)}`);
      linhas.push(`    num: ${q(p.num)}`);
      linhas.push(`    titulo: ${escalar(p.titulo)}`);
      linhas.push(`    especie: ${p.especie}`);
      linhas.push(`    especie_fonte: ${p.especie_fonte}`);
      linhas.push(`    data: ${escalar(p.data)}`);
      linhas.push(`    folhas: ${q(p.folhas)}`);
      linhas.push(`    folha_inicial: ${p.folha_inicial}`);
      linhas.push(`    folha_final: ${p.folha_final}`);
      linhas.push(`    pags: ${q(p.pags)}`);
      linhas.push(`    correspondencia: ${escalar(p.correspondencia)}`);
      linhas.push(`    fonte: ${q(p.fonte)}`);
      linhas.push(`    aviso: ${escalar(p.aviso)}`);
    }
  }
  return `${linhas.join('\n')}\n`;
}

/** Soma sobre os PDFs: quantas páginas têm texto (nativo ou OCR) e quantas ninguém leu. */
export function cobertura(indice) {
  let paginas = 0;
  let semTexto = 0;
  const faixas = [];
  for (const d of indice.documentos || []) {
    if (!Number.isFinite(d.paginas)) continue;
    paginas += d.paginas;
    const n = Number.isFinite(d.paginas_sem_texto_n) ? d.paginas_sem_texto_n : (d.texto === 'nao-extraivel' || d.texto === 'nao-extraivel-localmente' ? d.paginas : 0);
    semTexto += n;
    if (n) faixas.push(`${d.arquivo}: ${d.paginas_sem_texto || `${n} página(s)`}`);
  }
  return { paginas, comTexto: paginas - semTexto, semTexto, faixas };
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
const LISTAS_DO_INDICE = new Set(['documentos', 'pje']);

export function lerIndiceYaml(texto) {
  const indice = { documentos: [], pje: [] };
  let atual = null;
  let lista = null;
  for (const linha of String(texto).split(/\r?\n/)) {
    if (!linha.trim() || linha.trimStart().startsWith('#')) continue;
    const m = linha.match(/^(\s*)(- )?([a-z_]+):\s?(.*)$/);
    if (!m) throw new Error(`linha inesperada no índice: ${linha}`);
    const [, recuo, item, chave, valor] = m;
    if (recuo.length === 0) {
      atual = null;
      lista = null;
      if (LISTAS_DO_INDICE.has(chave)) {
        if (valor.trim() && valor.trim() !== '[]') throw new Error(`${chave}: forma inesperada`);
        lista = chave;
        if (!indice[chave]) indice[chave] = [];
        continue;
      }
      indice[chave] = valorYaml(valor);
    } else if (item) {
      if (!lista) throw new Error(`item fora de lista: ${linha}`);
      atual = { [chave]: valorYaml(valor) };
      indice[lista].push(atual);
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

// Onde estão os autos: cópia do bloco canônico de src/autos-path.js (honra `caso.json`,
// os autos por referência, além de `squads/<nome>/autos/` e da pasta do caso).
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

// De onde vem cada documento (autos × cliente): cópia do bloco canônico de src/autos-origem.js.
// >>> autos-origem:begin
/**
 * Âncora de folha que a pasta do caso dá ao documento: a que o conversor e as
 * cópias extraídas de processo trazem (`## fls. 12`, `<!-- fls. 3/40 -->`).
 * Folha citada em prosa ("a via juntada está às fls. 145") não conta: é o
 * documento falando de outro.
 */
const ORIGEM_ANCORA_FOLHA = /(?:^|\s)#{1,3}\s*(?:e-?)?fls?\.?\s*\d+|<!--\s*(?:e-?)?fls?\.\s*\d+/;
/** Âncora de página de documento sem folha (pasta pré-processual): `## p. 1`, `## pág. 2`. */
const ORIGEM_ANCORA_PAGINA = /(?:^|\s)#{1,3}\s*(?:p|pag|pagina)\.?\s*\d+/;
/**
 * Marca de sistema processual no texto de um PDF sem âncora: o rodapé do PJe
 * (`Num. 12345678 - Pág. 1`), o carimbo de folha do e-SAJ numa linha só
 * (`fls. 123`), o rodapé de conferência do e-SAJ e a marca de evento do eproc.
 * Vem DEPOIS da âncora: a cópia de uma sentença de outro processo, que o
 * cliente trouxe e a pasta pagina com `## p. N`, carrega o rodapé do tribunal
 * e continua sendo documento do cliente (medido no despejo de 24/09/2026).
 */
const ORIGEM_SISTEMA = [
  /\bnum\.\s*\d{5,}\s*-\s*pag\.\s*\d+/,
  /(?:^|\n)[ \t]*(?:e-?)?fls\.\s*\d+(?:\s*\/\s*\d+)?[ \t]*(?:\n|$)/,
  /\bevento\s+\d+\s*,\s*[a-z]+\d*\s*,\s*pagina\s+\d+/,
  /\bpara conferir o original,? acesse o site\b/,
];
/** O próprio documento diz, no cabeçalho, que está fora dos autos. */
const ORIGEM_FORA_DOS_AUTOS = /\bnao juntad[oa]s?\b|\bfora da numeracao\b|\bsem folha\b|\bdocumento (?:avulso|do escritorio|do cliente|interno)\b|\ba juntar\b|\bpasta (?:da empresa|do cliente)\b/;
const ORIGEM_CABECALHO = 400;
/**
 * Sinal de peça processual num documento sem âncora nem marca de sistema: o número
 * CNJ do processo, o endereçamento ao juízo ("Excelentíssimo", "Juízo de Direito"),
 * o "Vistos" que abre o despacho, "autos nº". Uma pasta em que nenhum documento tem
 * folha nem nenhum destes sinais é a pasta do cliente antes do processo.
 */
const ORIGEM_PECA_PROCESSUAL = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b|\bexcelentissim[oa]s?\b|\bjuizo (?:de direito|federal|da \d|do trabalho)|(?:^|\n)[ \t#>*]*vistos\b|\bautos (?:do processo )?n[.oº°]/;

function semAcentoOrigem(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** `autos`, `cliente` ou `null` (não dá para dizer pelo texto). */
function origemDoTexto(texto) {
  const t = semAcentoOrigem(texto);
  if (!t.trim()) return null;
  if (ORIGEM_ANCORA_FOLHA.test(t)) return 'autos';
  if (ORIGEM_ANCORA_PAGINA.test(t)) return 'cliente';
  if (ORIGEM_FORA_DOS_AUTOS.test(t.slice(0, ORIGEM_CABECALHO))) return 'cliente';
  if (ORIGEM_SISTEMA.some((re) => re.test(t))) return 'autos';
  return null;
}

/**
 * Completa `origem` em cada documento do índice. `textoDe(doc)` devolve o texto
 * (ou `null` quando não há o que ler). A origem já gravada vale; a que falta sai
 * do texto; e, numa pasta em que algum documento tem folha, o documento com
 * texto e sem folha nenhuma está fora da numeração: é do cliente.
 *
 * Pasta do cliente antes do processo (inicial pré-processual): nenhum documento
 * tem folha nem marca de sistema, e nenhum traz sinal de peça processual
 * (`ORIGEM_PECA_PROCESSUAL`). Aí todo documento é do cliente, inclusive o que
 * não tem texto (foto, digitalização sem OCR). Medido no teste de ponta a ponta
 * de 30/09/2026 (achado 25): a pasta de uma inicial de vizinhança, só com
 * documentos do cliente, saía com `origem: null` em todos, e o Redação Gate
 * cobrou folha de autos que não existem por dois ciclos, até a escalada.
 *
 * Fora disso, documento sem texto fica `null`, e quem lê trata como autos.
 */
function completarOrigens(docs, textoDe) {
  const lista = Array.isArray(docs) ? docs : [];
  const textos = lista.map((d) => { try { return textoDe(d); } catch { return null; } });
  const origens = lista.map((d, i) => (d && (d.origem === 'autos' || d.origem === 'cliente') ? d.origem : origemDoTexto(textos[i])));
  const haAutos = origens.includes('autos');
  const comTexto = textos.filter((t) => String(t || '').trim());
  const pastaDoCliente = !haAutos && comTexto.length > 0
    && !comTexto.some((t) => ORIGEM_PECA_PROCESSUAL.test(semAcentoOrigem(t)));
  return lista.map((d, i) => ({
    ...d,
    origem: origens[i] ?? (pastaDoCliente || (haAutos && String(textos[i] || '').trim()) ? 'cliente' : null),
  }));
}
// <<< autos-origem:end

// O PDF integral do PJe separado por documento (Num. do rodapé e índice da capa): cópia do bloco
// canônico de src/autos-pje.js.
// >>> autos-pje:begin
/** Rodapé do PJe: `Num. 12345678 - Pág. 3`. Tolerante ao OCR (`Pag` sem acento, sem ponto, sem hífen). */
const PJE_RODAPE = /\bnum\.?[ \t]*(\d{5,})[ \t]*-?[ \t]*p[aá]g\.?[ \t]*(\d{1,4})\b/gi;
/** O mesmo rodapé sozinho na linha: é o que o PJe imprime; a menção no corpo vem no meio da frase. */
const PJE_RODAPE_LINHA = /^[ \t]*num\.?[ \t]*(\d{5,})[ \t]*-?[ \t]*p[aá]g\.?[ \t]*(\d{1,4})[ \t]*$/gim;
const PJE_ASSINATURA = /assinado (?:eletronicamente|digitalmente) por:?[^\n]{0,160}?(\d{2})\/(\d{2})\/(\d{4})/i;
/** Linha do índice da capa: Num. (ou Id.), data (e hora), o título do documento e, às vezes, a página. */
const PJE_CAPA_LINHA = /^[ \t]*(?:(?:num|id)\.?[ \t]*)?(\d{6,})[ \t]+(\d{2})\/(\d{2})\/(\d{4})(?:[ \t]+\d{2}:\d{2}(?::\d{2})?)?[ \t]+(.+?)[ \t]*$/i;
/** Capa com a coluna da página: o cabeçalho da tabela nomeia `Pág.` ao lado de `Documento`. */
const PJE_CAPA_COM_PAGINA = /\bdocumento\b[^\n]{0,80}\bp[aá]g(?:ina)?\.?(?=\s|$)/i;
/** Até onde a capa vai: o índice de um processo de milhares de folhas cabe em dezenas de páginas. */
const PJE_MAX_PAGINAS_DE_CAPA = 60;

/** `{ num, pag }` do rodapé da página, ou `null`. Vale o rodapé sozinho na linha; senão, a última menção. */
function rodapeDaPagina(texto) {
  const t = String(texto || '');
  const naLinha = [...t.matchAll(PJE_RODAPE_LINHA)];
  const achados = naLinha.length ? naLinha : [...t.matchAll(PJE_RODAPE)];
  if (!achados.length) return null;
  const m = achados[achados.length - 1];
  return { num: m[1], pag: Number(m[2]) };
}

function isoDaData(dia, mes, ano) {
  const d = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));
  if (d.getUTCMonth() !== Number(mes) - 1 || d.getUTCDate() !== Number(dia)) return null;
  return d.toISOString().slice(0, 10);
}

/** [3,4,5,9] → "3-5, 9". */
function faixasPje(numeros) {
  const n = [...new Set(numeros)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n.length; i += 1) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j += 1;
    out.push(i === j ? String(n[i]) : `${n[i]}-${n[j]}`);
    i = j;
  }
  return out.join(', ');
}

/** O índice da capa, nas páginas antes do primeiro rodapé: `{ folhas: [1..k], itens: Map(num → {...}) }` ou `null`. */
function capaDoPdf(paginas, mascarar) {
  const itens = new Map();
  let ultima = -1;
  const comPagina = paginas.some((p) => PJE_CAPA_COM_PAGINA.test(String(p || '')));
  paginas.forEach((p, i) => {
    // O Markdown do conversor junta as linhas da capa numa só: cada Num. seguido de data abre uma linha.
    // (também colado no traço da régua do cabeçalho: `-----10000001 05/03/2024 ...`).
    const texto = String(p || '').replace(/(?:[ \t]+|(?<=[-=_]))(?=\d{6,}[ \t]+\d{2}\/\d{2}\/\d{4}\b)/g, '\n');
    for (const linha of texto.split(/\r?\n/)) {
      const m = linha.match(PJE_CAPA_LINHA);
      if (!m) continue;
      let resto = m[5];
      let pagina = null;
      if (comPagina) {
        const fim = resto.match(/^(.*?)[ \t]+(\d{1,5})$/);
        if (fim) { resto = fim[1]; pagina = Number(fim[2]); }
      }
      const titulo = mascarar(resto.replace(/[ \t]*(?:…|\.\.\.)$/, '').replace(/\s+/g, ' ').trim()) || null;
      if (!itens.has(m[1])) itens.set(m[1], { num: m[1], data: isoDaData(m[2], m[3], m[4]), titulo, pagina, ordem: itens.size });
      ultima = i;
    }
  });
  if (!itens.size) return null;
  return { folhas: Array.from({ length: ultima + 1 }, (_, k) => k + 1), itens, comPagina };
}

/**
 * Os documentos do PDF integral do PJe, a partir do texto de cada página (índice 0 = folha 1).
 * `tipoDe(titulo, textoDaPrimeiraFolha)` devolve `{ tipo, tipo_fonte }` (o indexador passa o dele);
 * `mascarar` tira CPF, CNPJ, e-mail e telefone do título.
 * Devolve `null` quando o PDF não é do PJe (nenhum rodapé e nenhuma capa com página), ou
 * `{ pecas, capa, avisos }`: cada peça com o Num., as folhas do PDF (`folha_inicial`/`folha_final`),
 * as páginas do PJe (`pag_inicial`/`pag_final`), a correspondência quando não é linear, título,
 * data, tipo e o aviso do que foi deduzido.
 */
function separarPecasPje(paginas, { tipoDe = () => ({ tipo: 'documento', tipo_fonte: 'desconhecido' }), mascarar = (s) => s } = {}) {
  const lista = Array.isArray(paginas) ? paginas.map((p) => String(p || '')) : [];
  const total = lista.length;
  if (!total) return null;
  const rod = lista.map(rodapeDaPagina);
  const primeira = rod.findIndex(Boolean);
  const capa = capaDoPdf(lista.slice(0, Math.min(primeira < 0 ? total : primeira, PJE_MAX_PAGINAS_DE_CAPA)), mascarar);
  const avisos = [];

  // Sem rodapé nenhum: só a capa com a página inicial de cada documento separa.
  if (primeira < 0) {
    if (!capa || !capa.comPagina) return null;
    const itens = [...capa.itens.values()].filter((it) => Number.isInteger(it.pagina) && it.pagina >= 1 && it.pagina <= total).sort((a, b) => a.pagina - b.pagina);
    if (!itens.length) return null;
    const pecas = itens.map((it, k) => {
      const fim = k + 1 < itens.length ? Math.max(it.pagina, itens[k + 1].pagina - 1) : total;
      const { tipo, tipo_fonte } = tipoDe(it.titulo, lista[it.pagina - 1]);
      return { num: it.num, titulo: it.titulo, tipo, tipo_fonte, data: it.data, folha_inicial: it.pagina, folha_final: fim, pag_inicial: 1, pag_final: fim - it.pagina + 1, correspondencia: null, fonte: 'capa', aviso: 'sem rodapé do PJe legível: folhas pela página da capa' };
    });
    return { pecas, capa: { folhas: faixasPje(capa.folhas), documentos: capa.itens.size }, avisos: ['nenhuma folha com rodapé do PJe legível: os documentos saem da capa, pela página inicial de cada um'] };
  }

  // Menção no corpo que escapou como "rodapé" (a sentença citando outro documento): o vizinho decide.
  for (let i = 1; i + 1 < total; i += 1) {
    const [a, b, c] = [rod[i - 1], rod[i], rod[i + 1]];
    if (a && b && c && a.num === c.num && b.num !== a.num && c.pag === a.pag + 2) rod[i] = { num: a.num, pag: a.pag + 1, corrigido: true };
  }

  const naCapa = new Set(capa ? capa.folhas.map((f) => f - 1) : []);
  const atrib = new Array(total).fill(null);
  for (let i = 0; i < total; i += 1) {
    if (naCapa.has(i)) continue;
    if (rod[i]) { atrib[i] = { ...rod[i], herdado: false }; continue; }
    // Sem rodapé legível (folha de imagem sem a tarja, OCR que errou): herda do vizinho.
    let j = i - 1;
    while (j >= 0 && !atrib[j]) j -= 1;
    let k = i + 1;
    while (k < total && !rod[k]) k += 1;
    const antes = j >= 0 ? atrib[j] : null;
    const depois = k < total ? rod[k] : null;
    if (depois && (!antes || antes.num === depois.num || depois.pag - (k - i) >= 1)) atrib[i] = { num: depois.num, pag: Math.max(1, depois.pag - (k - i)), herdado: true };
    else if (antes) atrib[i] = { num: antes.num, pag: antes.pag + (i - j), herdado: true };
  }

  const pecas = [];
  const vistos = new Map();
  for (let i = 0; i < total; i += 1) {
    if (!atrib[i]) continue;
    let j = i;
    while (j + 1 < total && atrib[j + 1] && atrib[j + 1].num === atrib[i].num) j += 1;
    const folhas = [];
    for (let f = i; f <= j; f += 1) folhas.push({ folha: f + 1, ...atrib[f] });
    const num = atrib[i].num;
    const linear = folhas.every((f, n) => f.pag === folhas[0].pag + n);
    const it = capa ? capa.itens.get(num) : null;
    const assinatura = lista[i].match(PJE_ASSINATURA);
    const data = (it && it.data) || (assinatura ? isoDaData(assinatura[1], assinatura[2], assinatura[3]) : null);
    const titulo = it ? it.titulo : null;
    const { tipo, tipo_fonte } = tipoDe(titulo, lista[i]);
    const notas = [];
    const herdadas = folhas.filter((f) => f.herdado).map((f) => f.folha);
    if (herdadas.length) notas.push(`${herdadas.length > 1 ? 'folhas' : 'folha'} ${faixasPje(herdadas)} sem rodapé legível: atribuída(s) pelo vizinho, confira`);
    const corrigidas = folhas.filter((f) => f.corrigido).map((f) => f.folha);
    if (corrigidas.length) notas.push(`folhas ${faixasPje(corrigidas)} com outro Num. no texto: atribuídas pela sequência`);
    if (it && Number.isInteger(it.pagina) && it.pagina !== i + 1) notas.push(`a capa diz que começa na folha ${it.pagina}; o rodapé, na ${i + 1}`);
    if (capa && !it) notas.push('fora do índice da capa');
    if (vistos.has(num)) notas.push(`o mesmo Num. já apareceu nas folhas ${vistos.get(num)}`);
    if (!linear) notas.push('páginas do PJe fora de sequência: veja a correspondência');
    vistos.set(num, `${i + 1}-${j + 1}`);
    pecas.push({
      num, titulo, tipo, tipo_fonte, data,
      folha_inicial: i + 1, folha_final: j + 1,
      pag_inicial: folhas[0].pag, pag_final: folhas[folhas.length - 1].pag,
      correspondencia: linear ? null : folhas.map((f) => `${f.folha}=${f.pag}`).join(', '),
      fonte: it ? 'rodape+capa' : 'rodape',
      aviso: notas.length ? notas.join('; ') : null,
    });
    i = j;
  }
  if (capa) {
    const achados = new Set(pecas.map((p) => p.num));
    const faltam = [...capa.itens.values()].filter((it) => !achados.has(it.num));
    if (faltam.length) avisos.push(`${faltam.length} documento(s) da capa sem folha com o rodapé correspondente: Num. ${faltam.slice(0, 10).map((it) => it.num).join(', ')}${faltam.length > 10 ? '…' : ''}`);
  }
  const semDono = atrib.map((a, i) => (!a && !naCapa.has(i) ? i + 1 : null)).filter(Boolean);
  if (semDono.length) avisos.push(`folhas ${faixasPje(semDono)} sem documento do PJe`);
  return { pecas, capa: capa ? { folhas: faixasPje(capa.folhas), documentos: capa.itens.size } : null, avisos };
}

/** Valor de uma linha do bloco `pje:` do índice: número, null ou string entre aspas. */
function valorPje(bruto) {
  const s = String(bruto ?? '').trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  return s;
}

/** O bloco `pje:` do `_index.yaml` (um item por documento do PJe), ou `[]`. */
function lerPecasPje(textoDoIndice) {
  const pecas = [];
  let dentro = false;
  let atual = null;
  for (const linha of String(textoDoIndice || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!linha.trim() || /^\s*#/.test(linha)) continue;
    if (/^\S/.test(linha)) { dentro = /^pje:\s*$/.test(linha); atual = null; continue; }
    if (!dentro) continue;
    const item = linha.match(/^\s*-\s+([a-z_]+):\s?(.*)$/);
    if (item) { atual = { [item[1]]: valorPje(item[2]) }; pecas.push(atual); continue; }
    const kv = linha.match(/^\s+([a-z_]+):\s?(.*)$/);
    if (kv && atual) atual[kv[1]] = valorPje(kv[2]);
  }
  return pecas.filter((p) => typeof p.pdf === 'string' && p.num != null && Number.isInteger(p.folha_inicial));
}

/**
 * Troca cada PDF integral do PJe pelos documentos dele: `{ arquivo, num, titulo, tipo, paginas,
 * folha_inicial, folha_final, pags, origem: 'autos' }`, na ordem do PDF. PDF sem bloco `pje:`, ou com um
 * documento só, fica como está.
 */
function expandirPecasPje(docs, pecas) {
  const porPdf = new Map();
  for (const p of Array.isArray(pecas) ? pecas : []) {
    if (!porPdf.has(p.pdf)) porPdf.set(p.pdf, []);
    porPdf.get(p.pdf).push(p);
  }
  const saida = [];
  for (const d of Array.isArray(docs) ? docs : []) {
    const doPdf = d && porPdf.get(d.arquivo);
    // Um documento só no PDF (a sentença baixada avulsa): o arquivo já é o documento.
    if (!doPdf || doPdf.length < 2) { saida.push(d); continue; }
    for (const p of doPdf) {
      saida.push({
        arquivo: d.arquivo, num: String(p.num), titulo: p.titulo || null, tipo: p.especie || 'documento',
        paginas: p.folha_final - p.folha_inicial + 1, folha_inicial: p.folha_inicial, folha_final: p.folha_final,
        pags: p.pags || null, data: p.data || null, origem: 'autos',
      });
    }
  }
  return saida;
}
// <<< autos-pje:end

// O indexador só separa; ler o bloco e expandir é do hook e do empacotador.
void lerPecasPje;
void expandirPecasPje;
void rodapeDaPagina;

/** Tipo de um documento do PJe: o título da capa (como nome de arquivo) › o texto da primeira folha › `documento`. */
function tipoDaPecaPje(titulo, texto) {
  if (titulo) {
    const nome = analisarNome(`${String(titulo).replace(/[\\/]/g, ' ')}.pdf`);
    if (nome.tipo) return { tipo: nome.tipo, tipo_fonte: 'capa' };
  }
  const porTexto = tipoPeloTexto(texto);
  if (porTexto) return { tipo: porTexto, tipo_fonte: 'texto' };
  return { tipo: 'documento', tipo_fonte: titulo ? 'capa' : 'desconhecido' };
}

/** O texto de cada folha de um PDF já lido: o cache do pdftotext (recém-extraído ou do disco) ou, sem ele, o Markdown do conversor. */
function paginasLidas(dir, doc, novos) {
  try {
    if (doc.texto_cache) {
      const t = novos.get(doc.texto_cache) ?? readFileSync(join(dir, doc.texto_cache), 'utf8');
      return t.split(/^===== página \d+\/\d+ =====$/m).slice(1).map((p) => p.replace(/^\n/, ''));
    }
    if (doc.markdown) {
      // As descrições de figura (`<!-- figura:begin -->` … `<!-- figura:end -->`, gravadas pelo
      // `sumario-autos.mjs integrar`) são interpretação de máquina, não texto da folha: um
      // "Num. X - Pág. Y" transcrito de uma foto não pode passar por rodapé do PJe.
      const t = readFileSync(join(dir, doc.markdown), 'utf8').replace(/<!-- figura:begin[^\n]*-->\n[\s\S]*?<!-- figura:end -->\n?/g, '');
      return t.split(/^<!-- fls\. \d+\/\d+[^\n]*-->$/m).slice(1);
    }
  } catch { /* sem texto legível: sem separação */ }
  return null;
}

/** Os documentos do PJe de um PDF, gravados no documento (contagem, capa, avisos) e devolvidos para o bloco `pje:`. */
function pecasDoPdf(dir, doc, novos) {
  const vazio = { pje_documentos: null, pje_capa: null, pje_capa_documentos: null, pje_avisos: null };
  if (extname(doc.arquivo).toLowerCase() !== '.pdf') return { campos: vazio, pecas: [] };
  const paginas = paginasLidas(dir, doc, novos);
  const r = paginas && paginas.length ? separarPecasPje(paginas, { tipoDe: tipoDaPecaPje, mascarar }) : null;
  if (!r || !r.pecas.length) return { campos: vazio, pecas: [] };
  const campos = {
    pje_documentos: r.pecas.length,
    pje_capa: r.capa ? r.capa.folhas : null,
    pje_capa_documentos: r.capa ? r.capa.documentos : null,
    pje_avisos: r.avisos.length ? r.avisos.join('; ') : null,
  };
  const pecas = r.pecas.map((p) => ({
    pdf: doc.arquivo, num: p.num, titulo: p.titulo, especie: p.tipo, especie_fonte: p.tipo_fonte, data: p.data,
    folhas: p.folha_inicial === p.folha_final ? String(p.folha_inicial) : `${p.folha_inicial}-${p.folha_final}`,
    folha_inicial: p.folha_inicial, folha_final: p.folha_final,
    pags: p.pag_inicial === p.pag_final ? String(p.pag_inicial) : `${p.pag_inicial}-${p.pag_final}`,
    correspondencia: p.correspondencia, fonte: p.fonte, aviso: p.aviso,
  }));
  return { campos, pecas };
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
    avisar(`aviso: ${NOME_INDICE} anterior ilegível (${e.message}); reindexando do zero`);
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
  const doc = { arquivo, bytes, mtime, paginas: null, texto: 'nao-pdf', texto_cache: null, markdown: null, paginas_sem_texto: null, paginas_sem_texto_n: null, tipo: 'desconhecido', tipo_fonte: 'desconhecido', datas: [], numero_processo: null, primeira_pagina: null };
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
      Object.assign(doc, coberturaPeloManifesto(dir, doc));
    } else {
      const r = extrairTextoPdf(pdftotext, full);
      if (!r.ok) {
        avisar(`aviso: ${arquivo}: ${r.erro}: marcado nao-extraivel`);
        doc.texto = 'nao-extraivel';
      } else {
        const paginas = dividirPaginas(r.texto);
        if (paginas.length) doc.paginas = paginas.length;
        doc.texto = statusDoTexto(paginas);
        // O que o OCR não recuperou continua sem texto; sem OCR, é o que o pdftotext não leu.
        const semTexto = paginasSemTextoDepoisDoOcr(dir, doc.markdown) ?? paginasSemTexto(paginas);
        doc.paginas_sem_texto = semTexto.length ? faixasDePaginas(semTexto) : null;
        doc.paginas_sem_texto_n = semTexto.length;
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

/**
 * O texto que decide a origem: o próprio arquivo quando é texto, o cache do
 * pdftotext quando é PDF (o recém-extraído, ainda não gravado, ou o do disco).
 * O Markdown convertido não serve: o conversor abre TODA página com `## fls. N`,
 * seja o PDF dos autos ou a foto do comprovante do cliente.
 */
function textoParaOrigem(dir, doc, novos) {
  const ext = extname(doc.arquivo).toLowerCase();
  try {
    if (EXT_TEXTO.has(ext)) return readFileSync(join(dir, doc.arquivo), 'utf8');
    if (!doc.texto_cache) return null;
    return novos.get(doc.texto_cache) ?? readFileSync(join(dir, doc.texto_cache), 'utf8');
  } catch {
    return null;
  }
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
      documentos.push(coberturaPeloManifesto(dir, prev));
      reaproveitados += 1;
      continue;
    }
    const { doc, cache } = indexarArquivo({ dir, arquivo, bytes: st.size, mtime, pdftotext, avisar });
    documentos.push(doc);
    if (cache !== null) caches.set(doc.texto_cache, cache);
  }

  // Origem (autos × cliente), recalculada a cada indexação para todos, inclusive
  // os reaproveitados: depende dos vizinhos (numa pasta com folha, o documento
  // sem folha está fora da numeração), e um vizinho novo pode mudá-la.
  const comOrigem = completarOrigens(documentos.map((d) => ({ ...d, origem: null })), (d) => textoParaOrigem(dir, d, caches));
  documentos.splice(0, documentos.length, ...comOrigem);

  // O PDF integral do PJe, separado por documento, recalculado a cada indexação (também para o
  // reaproveitado): sai do texto já lido (cache do pdftotext ou Markdown do conversor), sem reler o PDF.
  const pje = [];
  for (let i = 0; i < documentos.length; i += 1) {
    const { campos, pecas } = pecasDoPdf(dir, documentos[i], caches);
    documentos[i] = { ...documentos[i], ...campos };
    pje.push(...pecas);
  }

  const rel = relative(process.cwd(), dir);
  const raiz = rel && !rel.startsWith('..') && !isAbsolute(rel) ? posix(rel) : posix(dir);
  const indice = { versao: VERSAO_INDICE, gerado_em: null, raiz, ferramentas: { pdftotext: !!pdftotext }, documentos, pje };
  // Cobertura da leitura, no próprio índice: é o que o runner confere na fase
  // zero e o que o intake repete ao usuário ("433 de 506 páginas com texto").
  const cob = cobertura(indice);
  indice.cobertura = { paginas: cob.paginas, com_texto: cob.comTexto, sem_texto: cob.semTexto };
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
    // A frase que o intake repete ao usuário. "Parcial" não é leitura: as
    // páginas sem texto são as digitalizadas, e num processo importante elas
    // costumam ser os anexos que decidem o caso.
    const cob = cobertura(indice);
    if (cob.paginas > 0) {
      // Depois da conversão, o que sobra sem texto é folha `imagem` ou `vazia` que o OCR
      // não leu: repetir "rode o OCR" seria mandar o agente girar em falso.
      const { dir } = resolverAutos(entrada);
      const manifestos = indice.documentos.filter((d) => Number.isFinite(d.paginas)).map((d) => lerManifestoDaConversao(dir, d.markdown));
      const convertidos = manifestos.length > 0 && manifestos.every(Boolean);
      const comOcr = convertidos && manifestos.every((m) => m.ocr === 'tesseract');
      const oQueFazer = comOcr
        ? 'folhas de imagem ou sem texto depois do OCR: leitura visual pelo `Read` do PDF por faixa, e descrição pelo `sumario-autos imagens`'
        : convertidos
          ? 'a conversão rodou sem OCR (tesseract ausente ou `--sem-ocr`): instale o tesseract, rode `npm run autos:md` e reindexe'
          : 'rode `npm run autos:md` (OCR) e reindexe antes do primeiro step';
      const detalhe = cob.semTexto ? `; ${cob.semTexto} sem texto (${cob.faixas.join('; ')}): ${oQueFazer}` : ', leitura integral';
      process.stderr.write(`cobertura: ${cob.comTexto}/${cob.paginas} páginas com texto${detalhe}\n`);
    }
    process.exit(0);
  } catch (e) {
    if (e instanceof ErroDeUso) {
      process.stderr.write(`indexar-autos: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}
