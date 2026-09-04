#!/usr/bin/env node
/**
 * Empacotador — "pacote pronto para protocolar".
 *
 * Fase 4 do plano (docs/specs/legalsquad/PLANO-ORQUESTRADOR.md) e item 4 da
 * ENTREGA.md §2: a segunda ponta do run. Lê o que o run deixou em
 * `squads/<nome>/` — a peça em Markdown na raiz de `output/`, os ledgers
 * (`run-state.json`, `review-state.json`), o manifesto do Citation Gate e, se
 * houver, o índice dos autos — e monta `output/pacote/<run_id>/`:
 *
 *   <peça>.docx              a peça no estilo forense — dados em
 *                            `_legalsquad/core/estilo-forense.json`, sobrescritos por
 *                            `_legalsquad/estilo-escritorio.json` do projeto, se existir
 *   <peça>.pdf               só quando há LibreOffice (`soffice`) no PATH; ausência não é erro
 *   TERMO-DE-CONFERENCIA.md  (+ .docx) gerado DOS LEDGERS, nunca de texto livre
 *   ANEXOS.md                índice dos autos cruzado com o que a peça cita
 *   PROXIMOS-PASSOS.md       prazo TRANSCRITO do intake (nunca calculado); protocolo após revisão
 *   MANIFESTO.json           SHA-256 de cada arquivo e a versão do estilo usado
 *
 * Regras: sai 0 ao gerar; sai 1 só em erro real (pasta inexistente, artefato
 * ambíguo, Markdown ilegível, estilo ausente/inválido). Idempotente por run_id:
 * regrava a mesma pasta. Dado sigiloso (CPF/CNPJ/e-mail/telefone) nas respostas
 * de checkpoint sai mascarado no termo. Nada aqui calcula prazo nem inventa
 * número: o que o ledger não tem sai como "não medido"/"não informado".
 *
 * Uso:
 *   node scripts/empacotar.mjs squads/<nome> [--run <run_id>] [--artefato <arquivo.md>] [--sem-pdf] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PENDING_MARKER, TEMA_MARKER, ehArtefatoDeEntrega, medirSquad, paraMarkdown } from './run-metricas.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ESTILO_CORE = 'estilo-forense.json';
const ESTILO_ESCRITORIO = 'estilo-escritorio.json';
const MANIFEST_SUFFIX = '.citation-gate.json';

export const FRASE_FINAL = 'Rascunho técnico. Revisão e assinatura do(a) profissional responsável são obrigatórias.';
export const AVISO_MANIFESTO_AUSENTE = 'Citações: manifesto ausente — Citation Gate não registrou conferência';
export const AVISO_INDICE_AUSENTE = (squadRel) => `Índice de autos ausente — rode \`node scripts/indexar-autos.mjs ${squadRel}\``;
export const PRAZO_NAO_INFORMADO = 'prazo não informado no intake';

/** Erro que justifica exit 1. Tudo o mais é degradação registrada no termo. */
export class ErroReal extends Error {}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normalizar = (s) => semAcento(s).toLowerCase();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const celula = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
const truncar = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lerJson(caminho) {
  if (!existsSync(caminho)) return null;
  try { return JSON.parse(readFileSync(caminho, 'utf8')); } catch { return null; }
}

function lerJsonOuFalhar(caminho, oQue) {
  try { return JSON.parse(readFileSync(caminho, 'utf8')); } catch (e) {
    throw new ErroReal(`${oQue} ilegível (${caminho}): ${e.message}`);
  }
}

/**
 * Mascara dado sigiloso antes de ele sair no termo: CNPJ, CPF, e-mail, telefone.
 * O ledger fica como está — só a cópia que vai no pacote é mascarada.
 */
const SIGILO = [
  /\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g, // CNPJ (antes do CPF: contém sequência parecida)
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, // CPF
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // e-mail
  /(?:\+55\s?)?(?:\(\d{2}\)\s?|\b\d{2}\s)9?\d{4}[-\s]?\d{4}\b/g, // telefone com DDD separado
  /\b(?:\+55\s?)?\d{10,11}\b/g, // telefone só dígitos (CPF de 11 dígitos já caiu acima)
];
export function mascararSigilo(texto) {
  let s = String(texto ?? '');
  for (const re of SIGILO) s = s.replace(re, '***');
  return s;
}

// ---------------------------------------------------------------------------
// Estilo — dados, não código. Core sobrescrito pelo escritório.
// ---------------------------------------------------------------------------
const ALINHAMENTOS = ['justificado', 'esquerda', 'direita', 'centralizado'];

/** Raiz do projeto: `squads/<nome>` → dois níveis acima; senão, sobe até achar `_legalsquad/`; senão, cwd. */
export function raizDoProjeto(squadDir) {
  const dir = resolve(squadDir);
  if (basename(dirname(dir)) === 'squads') return dirname(dirname(dir));
  let atual = dir;
  for (;;) {
    if (existsSync(join(atual, '_legalsquad'))) return atual;
    const pai = dirname(atual);
    if (pai === atual) return process.cwd();
    atual = pai;
  }
}

/**
 * Merge do estilo do escritório sobre o do core: chave de primeiro nível
 * declarada vence (merge raso); sub-chave omitida dentro de um objeto declarado
 * herda o core — para `fonte: { familia: "Arial" }` não derrubar o tamanho.
 * Chaves `_doc`/`_*` são documentação e não entram.
 */
export function mesclarEstilo(base, sobre) {
  const out = { ...base };
  for (const [k, v] of Object.entries(sobre || {})) {
    if (k.startsWith('_')) continue;
    if (ehObjeto(v) && ehObjeto(base[k])) {
      const interno = { ...base[k] };
      for (const [sk, sv] of Object.entries(v)) interno[sk] = ehObjeto(sv) && ehObjeto(base[k][sk]) ? { ...base[k][sk], ...sv } : sv;
      out[k] = interno;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function validarEstilo(e, origem) {
  const erros = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!e.fonte || typeof e.fonte.familia !== 'string' || !e.fonte.familia.trim()) erros.push('fonte.familia');
  if (!e.fonte || !num(e.fonte.tamanho_pt) || e.fonte.tamanho_pt === 0) erros.push('fonte.tamanho_pt');
  for (const m of ['superior', 'inferior', 'esquerda', 'direita']) if (!e.margens_cm || !num(e.margens_cm[m])) erros.push(`margens_cm.${m}`);
  if (!e.paragrafo || !num(e.paragrafo.entrelinha) || e.paragrafo.entrelinha === 0) erros.push('paragrafo.entrelinha');
  if (!e.paragrafo || !ALINHAMENTOS.includes(e.paragrafo.alinhamento)) erros.push(`paragrafo.alinhamento (aceitos: ${ALINHAMENTOS.join(' | ')})`);
  for (const h of ['h1', 'h2', 'h3']) if (!e.titulos || !ehObjeto(e.titulos[h])) erros.push(`titulos.${h}`);
  if (!e.pagina || !num(e.pagina.largura_cm) || !num(e.pagina.altura_cm)) erros.push('pagina');
  if (erros.length) throw new ErroReal(`estilo inválido (${origem}): campos ausentes ou inválidos — ${erros.join(', ')}`);
}

/** Lê `_legalsquad/estilo-escritorio.json` do projeto se existir, senão `_legalsquad/core/estilo-forense.json`. */
export function carregarEstilo(raiz) {
  const candidatosCore = [join(raiz, '_legalsquad', 'core', ESTILO_CORE), join(AQUI, '..', '_legalsquad', 'core', ESTILO_CORE)];
  const core = candidatosCore.find((c) => existsSync(c));
  if (!core) throw new ErroReal(`estilo do core ausente: ${ESTILO_CORE} não encontrado (procurado em ${candidatosCore.join(' e ')})`);
  const base = lerJsonOuFalhar(core, 'estilo do core');
  const escritorio = join(raiz, '_legalsquad', ESTILO_ESCRITORIO);
  let estilo = base;
  let origem = 'core';
  let arquivo = core;
  if (existsSync(escritorio)) {
    estilo = mesclarEstilo(base, lerJsonOuFalhar(escritorio, 'estilo do escritório'));
    origem = 'escritorio';
    arquivo = escritorio;
  }
  validarEstilo(estilo, arquivo);
  // Caminho relativo à raiz quando o arquivo está dentro dela; absoluto quando é o core do motor, fora do projeto.
  const mostrar = (c) => { const r = relative(raiz, c); return !r || r.startsWith('..') || isAbsolute(r) ? c : r; };
  return {
    estilo,
    origem,
    arquivo: mostrar(arquivo),
    nome: typeof estilo.nome === 'string' ? estilo.nome : 'sem nome',
    versao: typeof estilo.versao === 'string' ? estilo.versao : 'sem versão',
    base: { nome: base.nome, versao: base.versao, arquivo: mostrar(core) },
  };
}

// ---------------------------------------------------------------------------
// Markdown → blocos. Cobre o que uma peça usa: títulos, parágrafos, ênfase,
// listas (com nível por indentação), citação em bloco, tabela simples, código,
// régua. Frontmatter e comentários HTML são descartados.
// ---------------------------------------------------------------------------
const RE_TITULO = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_REGRA = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_SEPARADOR_TABELA = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function dividirCelulas(linha) {
  const s = linha.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cels = [];
  let atual = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { atual += '|'; i++; continue; }
    if (s[i] === '|') { cels.push(atual.trim()); atual = ''; continue; }
    atual += s[i];
  }
  cels.push(atual.trim());
  return cels;
}

function alinhamentoDaColuna(sep) {
  const s = sep.trim();
  if (s.startsWith(':') && s.endsWith(':')) return 'centralizado';
  if (s.endsWith(':')) return 'direita';
  return 'esquerda';
}

function agruparParagrafos(linhas) {
  const out = [];
  let atual = [];
  for (const l of linhas) {
    if (!l.trim()) { if (atual.length) out.push(atual.join(' ')); atual = []; } else atual.push(l.trim());
  }
  if (atual.length) out.push(atual.join(' '));
  return out;
}

export function parseMarkdown(texto) {
  const linhas = String(texto).replace(/\r\n?/g, '\n').split('\n');
  const blocos = [];
  let i = 0;
  if (linhas[0] === '---') {
    const fim = linhas.indexOf('---', 1);
    if (fim > 0) i = fim + 1;
  }
  let paragrafo = [];
  const fechar = () => {
    if (paragrafo.length) blocos.push({ tipo: 'paragrafo', texto: paragrafo.join(' ') });
    paragrafo = [];
  };
  while (i < linhas.length) {
    const linha = linhas[i];
    if (/^\s*<!--/.test(linha)) {
      fechar();
      while (i < linhas.length && !/-->/.test(linhas[i])) i++;
      i++;
      continue;
    }
    if (/^\s*```/.test(linha)) {
      fechar();
      const corpo = [];
      i++;
      while (i < linhas.length && !/^\s*```/.test(linhas[i])) corpo.push(linhas[i++]);
      i++;
      blocos.push({ tipo: 'codigo', linhas: corpo });
      continue;
    }
    if (!linha.trim()) { fechar(); i++; continue; }
    const h = linha.match(RE_TITULO);
    if (h) { fechar(); blocos.push({ tipo: 'titulo', nivel: Math.min(h[1].length, 3), texto: h[2] }); i++; continue; }
    if (RE_REGRA.test(linha)) { fechar(); blocos.push({ tipo: 'regra' }); i++; continue; }
    if (/^\s*>/.test(linha)) {
      fechar();
      const corpo = [];
      while (i < linhas.length && /^\s*>/.test(linhas[i])) corpo.push(linhas[i++].replace(/^\s*>\s?/, ''));
      blocos.push({ tipo: 'citacao', paragrafos: agruparParagrafos(corpo) });
      continue;
    }
    const item = linha.match(RE_ITEM);
    if (item) {
      fechar();
      const ordenada = /\d/.test(item[2]);
      // Item da MESMA espécie (marcador × número): um `1.` depois de `-` abre outra lista.
      const mesmaEspecie = (l) => { const m = l.match(RE_ITEM); return m && /\d/.test(m[2]) === ordenada ? m : null; };
      const itens = [];
      while (i < linhas.length) {
        const m = mesmaEspecie(linhas[i]);
        if (m) {
          itens.push({ nivel: Math.min(2, Math.floor(m[1].length / 2)), texto: m[3].trim() });
          i++;
        } else if (linhas[i].trim() && /^\s+\S/.test(linhas[i]) && !RE_ITEM.test(linhas[i]) && itens.length) {
          itens[itens.length - 1].texto += ` ${linhas[i].trim()}`; // continuação indentada
          i++;
        } else if (!linhas[i].trim() && i + 1 < linhas.length && mesmaEspecie(linhas[i + 1])) {
          i++; // lista "solta": linha em branco entre itens
        } else break;
      }
      blocos.push({ tipo: 'lista', ordenada, itens });
      continue;
    }
    if (/^\s*\|/.test(linha) && i + 1 < linhas.length && RE_SEPARADOR_TABELA.test(linhas[i + 1])) {
      fechar();
      const cabecalho = dividirCelulas(linha);
      const alinhamentos = dividirCelulas(linhas[i + 1]).map(alinhamentoDaColuna);
      i += 2;
      const corpo = [];
      while (i < linhas.length && /^\s*\|/.test(linhas[i])) corpo.push(dividirCelulas(linhas[i++]));
      blocos.push({ tipo: 'tabela', cabecalho, alinhamentos, linhas: corpo });
      continue;
    }
    paragrafo.push(linha.trim());
    i++;
  }
  fechar();
  return blocos;
}

// Ênfase inline: código, ***negrito-itálico***, **negrito**/__negrito__, *itálico*/_itálico_
// (sublinhado só fora de palavra — `run_id` não vira itálico), [texto](url), escapes.
const RE_INLINE = new RegExp([
  String.raw`(\\([\\\x60*_\[\]()#>|~-]))`,
  String.raw`(\x60+)(.+?)\3`,
  String.raw`\*\*\*(?=\S)(.*?\S)\*\*\*`,
  String.raw`(?<!\w)___(?=\S)(.*?\S)___(?!\w)`,
  String.raw`\*\*(?=\S)(.*?\S)\*\*`,
  String.raw`(?<!\w)__(?=\S)(.*?\S)__(?!\w)`,
  String.raw`(?<!\*)\*(?=[^\s*])(.*?[^\s*])\*(?!\*)`,
  String.raw`(?<!\w)_(?=[^\s_])(.*?[^\s_])_(?!\w)`,
  String.raw`\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)`,
].join('|'));

function mesclarRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.texto) continue;
    const ultimo = out[out.length - 1];
    if (ultimo && !!ultimo.negrito === !!r.negrito && !!ultimo.italico === !!r.italico && !!ultimo.codigo === !!r.codigo) ultimo.texto += r.texto;
    else out.push({ ...r });
  }
  return out;
}

export function parseInline(texto, base = {}) {
  const runs = [];
  let resto = String(texto ?? '');
  while (resto.length) {
    const m = RE_INLINE.exec(resto);
    if (!m) { runs.push({ ...base, texto: resto }); break; }
    if (m.index > 0) runs.push({ ...base, texto: resto.slice(0, m.index) });
    if (m[1]) runs.push({ ...base, texto: m[2] });
    else if (m[3]) runs.push({ ...base, codigo: true, texto: m[4] });
    else if (m[5] !== undefined) runs.push(...parseInline(m[5], { ...base, negrito: true, italico: true }));
    else if (m[6] !== undefined) runs.push(...parseInline(m[6], { ...base, negrito: true, italico: true }));
    else if (m[7] !== undefined) runs.push(...parseInline(m[7], { ...base, negrito: true }));
    else if (m[8] !== undefined) runs.push(...parseInline(m[8], { ...base, negrito: true }));
    else if (m[9] !== undefined) runs.push(...parseInline(m[9], { ...base, italico: true }));
    else if (m[10] !== undefined) runs.push(...parseInline(m[10], { ...base, italico: true }));
    else if (m[11] !== undefined) {
      runs.push(...parseInline(m[11], base));
      if (m[12] && m[12] !== m[11]) runs.push({ ...base, texto: ` (${m[12]})` }); // a URL não se perde
    }
    resto = resto.slice(m.index + m[0].length);
  }
  return mesclarRuns(runs);
}

/** Título sem acento, sem numeração (`III –`, `2.1`) e em maiúsculas, para comparar com `quebra_de_pagina_antes`. */
export function tituloCanonico(texto) {
  return semAcento(texto)
    .toUpperCase()
    .replace(/[*_`]/g, '')
    .replace(/^\s*(?:[IVXLCDM]+|\d+(?:\.\d+)*)(?:\s*[-–—.:)]+\s*|\s+)/, '')
    .replace(/[\s.:;–—-]+$/, '')
    .trim();
}

export function abrePagina(texto, lista) {
  const t = tituloCanonico(texto);
  return (Array.isArray(lista) ? lista : []).some((x) => tituloCanonico(x) === t);
}

// ---------------------------------------------------------------------------
// Blocos → .docx (biblioteca `docx`, pure JS)
// ---------------------------------------------------------------------------
let docxCache = null;
async function carregarDocx() {
  if (docxCache) return docxCache;
  // O bundle do `docx` lê `globalThis.localStorage` ao carregar (shim de util-deprecate).
  // No Node 26 o acessor preguiçoso desse global dispara um ExperimentalWarning sem
  // consequência ("--localstorage-file was not provided"). Durante o import, o acessor
  // é sombreado por `undefined` (o shim só testa se existe) e restaurado em seguida.
  const acessor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sombrear = !!(acessor && acessor.get && acessor.configurable);
  if (sombrear) Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true, enumerable: acessor.enumerable });
  try {
    docxCache = await import('docx');
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') throw new ErroReal('biblioteca `docx` não instalada — rode `npm install docx` na raiz do projeto');
    throw e;
  } finally {
    if (sombrear) Object.defineProperty(globalThis, 'localStorage', acessor);
  }
  return docxCache;
}

/** Converte Markdown em .docx no estilo dado. Devolve o Buffer do arquivo. */
export async function markdownParaDocx(markdown, estilo, { titulo = '', quebraDePagina = true } = {}) {
  const d = await carregarDocx();
  const E = estilo;
  const blocos = parseMarkdown(markdown);
  const cm = (v) => Math.round(Number(v) * 567); // twips
  const hp = (ptv) => Math.round(Number(ptv) * 2); // meio-ponto
  const tw = (ptv) => Math.round(Number(ptv) * 20); // vigésimos de ponto
  const ln = (mult) => Math.round(Number(mult) * 240); // 240 = uma linha
  const AL = { justificado: d.AlignmentType.JUSTIFIED, esquerda: d.AlignmentType.LEFT, direita: d.AlignmentType.RIGHT, centralizado: d.AlignmentType.CENTER };
  const alinhar = (a, padrao = 'justificado') => AL[a] || AL[padrao];
  const fonte = E.fonte.familia;
  const num = (v, padrao) => (typeof v === 'number' && Number.isFinite(v) ? v : padrao);
  const P = E.paragrafo;
  const C = { recuo_esquerda_cm: 4, tamanho_pt: 10, entrelinha: 1, italico: false, espaco_depois_pt: 6, ...(E.citacao || {}) };
  const T = { bordas: true, tamanho_pt: E.fonte.tamanho_pt, ...(E.tabela || {}) };
  const recuoLista = cm(num(E.listas && E.listas.recuo_cm, 1.25));

  const run = (r, extra = {}) => {
    const o = { text: r.texto };
    if (r.negrito || extra.bold) o.bold = true;
    if (r.italico || extra.italics) o.italics = true;
    if (r.codigo) o.font = 'Courier New';
    else if (extra.font) o.font = extra.font;
    if (extra.size) o.size = extra.size;
    return new d.TextRun(o);
  };
  const runs = (inline, extra) => inline.map((r) => run(r, extra));
  const espacamento = { line: ln(P.entrelinha), lineRule: d.LineRuleType.AUTO, after: tw(num(P.espaco_depois_pt, 6)) };

  const tabela = (b) => {
    const ncols = Math.max(b.cabecalho.length, ...b.linhas.map((l) => l.length), 1);
    const largura = cm(E.pagina.largura_cm - E.margens_cm.esquerda - E.margens_cm.direita);
    const colunas = Array.from({ length: ncols }, () => Math.floor(largura / ncols));
    const borda = T.bordas ? { style: d.BorderStyle.SINGLE, size: 4, color: '000000' } : { style: d.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const bordas = { top: borda, bottom: borda, left: borda, right: borda, insideHorizontal: borda, insideVertical: borda };
    const cel = (texto, i, negrito) => new d.TableCell({
      width: { size: colunas[i], type: d.WidthType.DXA },
      children: [new d.Paragraph({
        alignment: alinhar(b.alinhamentos[i], 'esquerda'),
        spacing: { line: 240, after: 0 },
        children: runs(parseInline(texto ?? ''), { bold: negrito, size: hp(T.tamanho_pt) }),
      })],
    });
    const linha = (cels, negrito) => new d.TableRow({
      tableHeader: negrito || undefined,
      children: Array.from({ length: ncols }, (_, i) => cel(cels[i] ?? '', i, negrito)),
    });
    return new d.Table({
      width: { size: largura, type: d.WidthType.DXA },
      columnWidths: colunas,
      borders: bordas,
      rows: [linha(b.cabecalho, true), ...b.linhas.map((l) => linha(l, false))],
    });
  };

  const filhos = [];
  let instanciaNumerada = 0;
  blocos.forEach((b, idx) => {
    switch (b.tipo) {
      case 'titulo': {
        const quebra = quebraDePagina && idx > 0 && abrePagina(b.texto, E.quebra_de_pagina_antes);
        filhos.push(new d.Paragraph({
          heading: [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3][b.nivel - 1],
          children: runs(parseInline(b.texto)),
          pageBreakBefore: quebra || undefined,
          keepNext: true,
        }));
        break;
      }
      case 'paragrafo':
        filhos.push(new d.Paragraph({
          children: runs(parseInline(b.texto)),
          alignment: alinhar(P.alinhamento),
          spacing: espacamento,
          indent: num(P.recuo_primeira_linha_cm, 0) > 0 ? { firstLine: cm(P.recuo_primeira_linha_cm) } : undefined,
        }));
        break;
      case 'citacao':
        for (const p of b.paragrafos) {
          filhos.push(new d.Paragraph({
            style: 'Citacao',
            children: runs(parseInline(p), { italics: !!C.italico, size: hp(C.tamanho_pt) }),
          }));
        }
        break;
      case 'lista':
        if (b.ordenada) instanciaNumerada += 1;
        for (const item of b.itens) {
          filhos.push(new d.Paragraph({
            children: runs(parseInline(item.texto)),
            numbering: { reference: b.ordenada ? 'numeros' : 'marcadores', level: item.nivel, instance: b.ordenada ? instanciaNumerada : undefined },
            alignment: alinhar(P.alinhamento),
            spacing: { ...espacamento, after: tw(3) },
          }));
        }
        break;
      case 'tabela':
        filhos.push(tabela(b));
        filhos.push(new d.Paragraph({ children: [], spacing: { after: 0 } })); // Word exige parágrafo depois de tabela
        break;
      case 'codigo':
        for (const l of b.linhas) {
          filhos.push(new d.Paragraph({ style: 'Codigo', children: [new d.TextRun({ text: l || ' ', font: 'Courier New', size: hp(10) })] }));
        }
        break;
      case 'regra':
        filhos.push(new d.Paragraph({
          children: [],
          border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: '808080', space: 1 } },
          spacing: { after: tw(6) },
        }));
        break;
      default:
        break;
    }
  });

  const cab = { escritorio: '', oab: '', endereco: '', linhas_extras: [], tamanho_pt: 9, ...(E.cabecalho || {}) };
  const linhasCab = [cab.escritorio, cab.oab, cab.endereco, ...(Array.isArray(cab.linhas_extras) ? cab.linhas_extras : [])]
    .filter((l) => typeof l === 'string' && l.trim());
  const headers = linhasCab.length
    ? { default: new d.Header({ children: linhasCab.map((l, i) => new d.Paragraph({
      alignment: d.AlignmentType.CENTER,
      spacing: { line: 240, after: i === linhasCab.length - 1 ? tw(6) : 0 },
      children: [new d.TextRun({ text: l, bold: i === 0 || undefined, size: hp(cab.tamanho_pt), font: fonte })],
    })) }) }
    : undefined;

  const rod = { numeracao_de_pagina: true, formato: 'Página {n} de {total}', alinhamento: 'direita', tamanho_pt: 9, ...(E.rodape || {}) };
  const runsRodape = String(rod.formato || 'Página {n} de {total}').split(/(\{n\}|\{total\})/).filter(Boolean).map((parte) => {
    if (parte === '{n}') return new d.TextRun({ children: [d.PageNumber.CURRENT], size: hp(rod.tamanho_pt), font: fonte });
    if (parte === '{total}') return new d.TextRun({ children: [d.PageNumber.TOTAL_PAGES], size: hp(rod.tamanho_pt), font: fonte });
    return new d.TextRun({ text: parte, size: hp(rod.tamanho_pt), font: fonte });
  });
  const footers = rod.numeracao_de_pagina
    ? { default: new d.Footer({ children: [new d.Paragraph({ alignment: alinhar(rod.alinhamento, 'direita'), children: runsRodape })] }) }
    : undefined;

  const estiloTitulo = (n) => {
    const t = { tamanho_pt: E.fonte.tamanho_pt, negrito: true, maiusculas: false, alinhamento: 'esquerda', espaco_antes_pt: 12, espaco_depois_pt: 6, ...E.titulos[`h${n}`] };
    return {
      run: { size: hp(t.tamanho_pt), bold: !!t.negrito, allCaps: !!t.maiusculas, font: fonte, color: '000000' },
      paragraph: { alignment: alinhar(t.alinhamento, 'esquerda'), spacing: { before: tw(t.espaco_antes_pt), after: tw(t.espaco_depois_pt), line: ln(P.entrelinha) }, outlineLevel: n - 1 },
    };
  };
  const nivelLista = (n, format, text) => ({
    level: n, format, text, alignment: d.AlignmentType.LEFT,
    style: { paragraph: { indent: { left: recuoLista * (n + 1), hanging: Math.min(360, recuoLista) } } },
  });

  const doc = new d.Document({
    creator: 'LegalSquad',
    title: titulo,
    description: FRASE_FINAL,
    styles: {
      default: {
        document: { run: { font: fonte, size: hp(E.fonte.tamanho_pt) }, paragraph: { alignment: alinhar(P.alinhamento), spacing: { line: ln(P.entrelinha) } } },
        heading1: estiloTitulo(1),
        heading2: estiloTitulo(2),
        heading3: estiloTitulo(3),
      },
      paragraphStyles: [
        {
          id: 'Citacao', name: 'Citação recuada', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: hp(C.tamanho_pt), italics: !!C.italico, font: fonte },
          paragraph: { indent: { left: cm(C.recuo_esquerda_cm) }, spacing: { line: ln(C.entrelinha), after: tw(C.espaco_depois_pt) }, alignment: d.AlignmentType.JUSTIFIED },
        },
        {
          id: 'Codigo', name: 'Bloco de código', basedOn: 'Normal', next: 'Normal',
          run: { font: 'Courier New', size: hp(10) },
          paragraph: { spacing: { line: 240, after: 0 }, alignment: d.AlignmentType.LEFT },
        },
      ],
    },
    numbering: {
      config: [
        { reference: 'marcadores', levels: [nivelLista(0, d.LevelFormat.BULLET, '•'), nivelLista(1, d.LevelFormat.BULLET, '–'), nivelLista(2, d.LevelFormat.BULLET, '·')] },
        { reference: 'numeros', levels: [nivelLista(0, d.LevelFormat.DECIMAL, '%1.'), nivelLista(1, d.LevelFormat.LOWER_LETTER, '%2)'), nivelLista(2, d.LevelFormat.LOWER_ROMAN, '%3.')] },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: cm(E.pagina.largura_cm), height: cm(E.pagina.altura_cm) },
          margin: { top: cm(E.margens_cm.superior), bottom: cm(E.margens_cm.inferior), left: cm(E.margens_cm.esquerda), right: cm(E.margens_cm.direita), header: cm(1.25), footer: cm(1.25) },
        },
      },
      headers,
      footers,
      children: filhos,
    }],
  });
  return d.Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// PDF — só quando há LibreOffice. Ausência não é erro: fica registrada no termo.
// ---------------------------------------------------------------------------
/** `LEGALSQUAD_SOFFICE` aponta o binário; senão, procura `soffice` no PATH. */
export function localizarSoffice(env = process.env) {
  if (typeof env.LEGALSQUAD_SOFFICE === 'string' && env.LEGALSQUAD_SOFFICE.trim()) {
    return existsSync(env.LEGALSQUAD_SOFFICE) ? env.LEGALSQUAD_SOFFICE : null;
  }
  const nomes = process.platform === 'win32' ? ['soffice.exe', 'soffice.com', 'soffice'] : ['soffice'];
  for (const p of String(env.PATH || '').split(delimiter)) {
    if (!p) continue;
    for (const n of nomes) {
      const c = join(p, n);
      try { if (statSync(c).isFile()) return c; } catch { /* segue */ }
    }
  }
  return null;
}

function converterPdf({ soffice, docxPath, outDir }) {
  // Perfil próprio: não briga com um LibreOffice aberto nem com o lock do perfil do usuário.
  const perfil = mkdtempSync(join(tmpdir(), 'ls-soffice-'));
  try {
    execFileSync(soffice, [`-env:UserInstallation=${pathToFileURL(perfil).href}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, docxPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
    });
    const pdf = join(outDir, `${basename(docxPath, extname(docxPath))}.pdf`);
    if (!existsSync(pdf)) return { gerado: false, motivo: 'conversão falhou: soffice não produziu o PDF', arquivo: null };
    return { gerado: true, motivo: null, arquivo: basename(pdf) };
  } catch (e) {
    const detalhe = String((e && e.stderr) || (e && e.message) || e).split('\n').find((l) => l.trim()) || 'erro desconhecido';
    return { gerado: false, motivo: `conversão falhou: ${detalhe.trim()}`, arquivo: null };
  } finally {
    rmSync(perfil, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Leitura do que o run deixou
// ---------------------------------------------------------------------------
/**
 * Onde o run DE VERDADE deixou os artefatos, da pasta mais específica para a
 * mais geral.
 *
 * O runner grava por `squad-path` em `output/{run_id}/v{N}/arquivo.md` — o
 * escopo por run e o versionamento existem desde a Fase 0. O empacotador,
 * porém, só varria a RAIZ de `output/`, e a chamada do runner
 * (`empacotar.mjs squads/{name} --run {run_id}`, sem `--artefato`) portanto
 * nunca achava nada: a Fase 4 (pacote pronto para protocolar) falhava em todo
 * run real, e a única razão de ninguém ter visto é que nenhum run real tinha
 * acontecido. Pior que falhar: com um `.md` esquecido na raiz de `output/` por
 * um fluxo antigo, ela empacotaria a peça ERRADA em silêncio.
 *
 * A versão mais alta vence, e a raiz fica por último, para instalação anterior
 * ao escopo por run continuar funcionando.
 */
function pastasDeArtefato(outputDir, runId) {
  const pastas = [];
  const runDir = runId ? join(outputDir, String(runId)) : null;
  if (runDir && existsSync(runDir)) {
    const versoes = readdirSync(runDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((x, y) => Number(y.slice(1)) - Number(x.slice(1)));
    for (const v of versoes) pastas.push(join(runDir, v));
    pastas.push(runDir);
  }
  pastas.push(outputDir);
  return pastas;
}

function escolherArtefato({ squadDir, outputDir, pedido, runId = null }) {
  const pastas = pastasDeArtefato(outputDir, runId);
  if (pedido) {
    const candidatos = [
      ...pastas.map((d) => join(d, pedido)),
      join(squadDir, pedido),
      isAbsolute(pedido) ? pedido : resolve(pedido),
    ];
    const achado = candidatos.find((c) => { try { return statSync(c).isFile(); } catch { return false; } });
    if (!achado) throw new ErroReal(`artefato não encontrado: ${pedido} (procurado em ${candidatos.join(', ')})`);
    return achado;
  }
  if (!existsSync(outputDir)) throw new ErroReal(`sem pasta output/ em ${squadDir} — nada a empacotar`);
  // UM predicado só, para a escolha da pasta e para a listagem dentro dela.
  // Com dois, o empacotador elegia a pasta pelo nome e depois a esvaziava pelo
  // conteúdo, respondendo "nenhum artefato de entrega" numa pasta que ele mesmo
  // acabara de eleger por ter um. A marca no cabeçalho ("NÃO PROTOCOLAR")
  // exclui: num run real, o arquivo de pendências internas disputou com a peça,
  // e só não foi embrulhado no lugar dela porque havia DOIS candidatos e o
  // empacotador recusou por ambiguidade. Com um só, teria entregado o errado.
  const ehEntregaNaPasta = (dir, nome) => {
    if (!/\.md$/i.test(nome) || !ehArtefatoDeEntrega(nome)) return false;
    try { return ehArtefatoDeEntrega(nome, readFileSync(join(dir, nome), 'utf8')); } catch { return true; }
  };
  const comEntrega = pastas.find((d) => existsSync(d) && readdirSync(d, { withFileTypes: true })
    .some((e) => e.isFile() && ehEntregaNaPasta(d, e.name)));
  const alvo = comEntrega || outputDir;
  const entregas = readdirSync(alvo, { withFileTypes: true })
    .filter((e) => e.isFile() && ehEntregaNaPasta(alvo, e.name))
    .map((e) => e.name)
    .sort();
  if (!entregas.length) {
    // Os `.md` que ESTÃO lá e foram recusados por nome — `ehArtefatoDeEntrega`
    // filtra rascunho (`minuta`, `rascunho`, `draft`) e interno (`revisao`,
    // `intake`, `foco`, `diagnostico`…). Sem nomeá-los, a mensagem dizia
    // "nenhum artefato de entrega (.md)" com o arquivo à vista na pasta, e
    // quem gravou a peça como `minuta.md` — o nome que os prompts usam para
    // ela em PROSA — era mandado procurar o que não estava faltando.
    const recusados = pastas.filter(existsSync).flatMap((d) => readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !ehArtefatoDeEntrega(e.name))
      .map((e) => relative(outputDir, join(d, e.name)) || e.name));
    throw new ErroReal(recusados.length
      ? `nenhum artefato de ENTREGA em ${pastas.join(', ')}: os .md encontrados têm nome de rascunho ou de peça interna (${[...new Set(recusados)].sort().join(', ')}) e o empacotador os ignora de propósito. Renomeie a peça final (ex.: "contestacao.md") ou indique com --artefato <arquivo.md>`
      : `nenhum artefato de entrega (.md) em ${pastas.join(', ')} — indique com --artefato <arquivo.md>`);
  }
  if (entregas.length > 1) throw new ErroReal(`artefato ambíguo — há ${entregas.length} entregas na raiz de output/: ${entregas.join(', ')}. Indique uma com --artefato <arquivo.md>`);
  return join(alvo, entregas[0]);
}

function lerMarkdown(caminho) {
  let buf;
  try { buf = readFileSync(caminho); } catch (e) { throw new ErroReal(`Markdown ilegível (${caminho}): ${e.message}`); }
  if (!buf.length || !buf.toString('utf8').trim()) throw new ErroReal(`Markdown ilegível (${caminho}): arquivo vazio`);
  if (buf.subarray(0, 8192).includes(0)) throw new ErroReal(`Markdown ilegível (${caminho}): não é texto`);
  return { buffer: buf, texto: buf.toString('utf8') };
}

function localizarManifesto(artefatoPath, artefatoBuffer) {
  const nome = basename(artefatoPath);
  const dir = dirname(artefatoPath);
  // Convenção do hook (`peca.md.citation-gate.json`) primeiro; depois a forma curta (`peca.citation-gate.json`).
  const candidatos = [join(dir, `${nome}${MANIFEST_SUFFIX}`), join(dir, `${basename(nome, extname(nome))}${MANIFEST_SUFFIX}`)];
  const achado = candidatos.find((c) => existsSync(c));
  if (!achado) return null;
  const dados = lerJson(achado);
  if (!dados || typeof dados !== 'object') return { arquivo: basename(achado), dados: null, ilegivel: true, hashConfere: false };
  const declarado = String(dados.artifact_sha256 || '').replace(/^sha256:/i, '').toLowerCase();
  return { arquivo: basename(achado), dados, ilegivel: false, hashConfere: declarado === sha256(artefatoBuffer) };
}

/** Marcadores de pendência no artefato, com a linha (1-based) onde aparecem. */
export function pendenciasDoArtefato(texto) {
  const out = [];
  String(texto).replace(/\r\n?/g, '\n').split('\n').forEach((linha, i) => {
    for (const m of linha.matchAll(PENDING_MARKER)) out.push({ linha: i + 1, marcador: m[0], trecho: truncar(linha.trim(), 120) });
    for (const m of linha.matchAll(TEMA_MARKER)) out.push({ linha: i + 1, marcador: m[0], trecho: truncar(linha.trim(), 120) });
  });
  return out.sort((a, b) => a.linha - b.linha);
}

/** Status de citação do manifesto → rótulo do termo. Tudo que não é um dos três é "pendente". */
export function classificarStatus(status) {
  const bruto = String(status ?? '').trim();
  const s = normalizar(bruto).replace(/[\s_-]+/g, ' ').trim();
  if (s === 'verificada' || s === 'verificado') return 'VERIFICADA';
  if (/^nao encontrad[ao]$/.test(s)) return 'NÃO ENCONTRADA';
  if (s === 'divergente') return 'DIVERGENTE';
  return bruto ? `pendente (${bruto})` : 'pendente (sem status)';
}

// ---------------------------------------------------------------------------
// Índice dos autos (autos/_index.yaml) — `documentos:` em bloco YAML, um mapa por item
// ---------------------------------------------------------------------------
function escalar(v) {
  const s = String(v ?? '').trim().replace(/\s+#.*$/, '');
  const semAspas = s.replace(/^(["'])(.*)\1$/, '$2');
  if (semAspas !== s) return semAspas;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

export function lerIndiceAutos(texto) {
  const docs = [];
  let dentro = false;
  let atual = null;
  for (const bruta of String(texto).replace(/\r\n?/g, '\n').split('\n')) {
    if (!bruta.trim() || /^\s*#/.test(bruta)) continue;
    if (/^documentos:\s*(?:\[\s*\]\s*)?$/.test(bruta)) { dentro = !/\[/.test(bruta); continue; }
    if (!dentro) continue;
    if (/^\S/.test(bruta)) { dentro = false; continue; } // outra chave de topo encerra o bloco
    const item = bruta.match(/^\s*-\s*(?:([\w.-]+):\s*(.*))?$/);
    if (item) { atual = {}; docs.push(atual); if (item[1]) atual[item[1]] = escalar(item[2]); continue; }
    const kv = bruta.match(/^\s+([\w.-]+):\s*(.*)$/);
    if (kv && atual) atual[kv[1]] = escalar(kv[2]);
  }
  return docs.filter((d) => typeof d.arquivo === 'string' && d.arquivo.trim());
}

/** Cruza o índice com a peça: `arquivo` (sem extensão) ou `tipo` mencionado no texto → "citado na peça". */
export function cruzarAnexos(documentos, textoPeca) {
  const texto = ` ${normalizar(textoPeca).replace(/[-_]/g, ' ').replace(/\s+/g, ' ')} `;
  const citados = [];
  const naoCitados = [];
  for (const doc of documentos) {
    const stem = normalizar(basename(doc.arquivo, extname(doc.arquivo)));
    const formas = [stem, stem.replace(/^\d+[-_. ]*/, '')].map((f) => f.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()).filter((f) => f.length >= 4);
    let casou = null;
    if (formas.some((f) => texto.includes(f))) casou = 'arquivo';
    else if (typeof doc.tipo === 'string' && doc.tipo.trim()) {
      const tipo = normalizar(doc.tipo).replace(/[-_]/g, ' ').trim();
      if (new RegExp(`(?<![a-z0-9])${escapeRe(tipo)}s?(?![a-z0-9])`).test(texto)) casou = 'tipo';
    }
    (casou ? citados : naoCitados).push({ ...doc, casou });
  }
  return { citados, naoCitados };
}

// ---------------------------------------------------------------------------
// Os documentos do pacote — cada um só com o que os ledgers provam
// ---------------------------------------------------------------------------
export function gerarTermo(t) {
  const L = [];
  L.push(`# Termo de conferência — ${t.squad} · run ${t.runId}`);
  L.push('');
  L.push(`Gerado em ${t.geradoEm} por \`scripts/empacotar.mjs\` a partir dos ledgers do run (\`run-state.json\`, \`review-state.json\`, manifesto do Citation Gate) — nada abaixo foi escrito à mão.`);
  L.push('');
  L.push(`- Peça: \`${t.artefato.nome}\` → \`${t.artefato.docx}\` · SHA-256 \`${t.artefato.sha256}\``);
  L.push(`- Estilo: ${t.estilo.nome} v${t.estilo.versao} (${t.estilo.origem}: \`${t.estilo.arquivo}\`)`);
  L.push(t.pdf.gerado ? `- PDF: gerado (\`${t.pdf.arquivo}\`)` : `- PDF não gerado: ${t.pdf.motivo}`);
  L.push('');

  L.push('## 1. Citações (Citation Gate)');
  L.push('');
  const totais = { VERIFICADA: 0, 'NÃO ENCONTRADA': 0, DIVERGENTE: 0, pendente: 0 };
  if (!t.manifesto) {
    L.push(AVISO_MANIFESTO_AUSENTE);
  } else if (t.manifesto.ilegivel) {
    L.push(`Citações: manifesto \`${t.manifesto.arquivo}\` ilegível (JSON inválido) — Citation Gate não registrou conferência válida`);
  } else {
    const m = t.manifesto.dados;
    const cits = Array.isArray(m.citations) ? m.citations : [];
    L.push(`Manifesto \`${t.manifesto.arquivo}\` · conferido por ${m.verified_by || 'não informado'} em ${m.verified_at || 'data não informada'} · escopo ${m.scope || 'não informado'} · gate ${m.gate_status || 'não informado'} · hash do artefato: ${t.manifesto.hashConfere ? 'confere' : 'DIVERGE — a peça mudou depois da conferência; refaça o Citation Gate'}`);
    L.push('');
    if (!cits.length) {
      L.push(m.scope === 'sem_citacoes_materiais' ? 'Nenhuma citação material declarada (`scope: sem_citacoes_materiais`).' : 'Manifesto sem citações listadas.');
    } else {
      L.push('| # | Citação | Status | Fonte | Consultada em |');
      L.push('|---|---|---|---|---|');
      cits.forEach((c, i) => {
        const rotulo = classificarStatus(c && c.status);
        totais[rotulo.startsWith('pendente') ? 'pendente' : rotulo] += 1;
        L.push(`| ${i + 1} | ${celula(c && c.title) || '(sem título)'} | ${rotulo} | ${celula(c && c.source_url) || 'não informada'} | ${celula(c && c.consulted_at) || 'não informada'} |`);
      });
      L.push('');
      L.push(`Totais: ${totais.VERIFICADA} verificada(s) · ${totais['NÃO ENCONTRADA']} não encontrada(s) · ${totais.DIVERGENTE} divergente(s) · ${totais.pendente} pendente(s).`);
    }
  }
  L.push('');

  L.push('## 2. Gates (ciclos e REJECTs)');
  L.push('');
  const gates = t.medicao && t.medicao.gates;
  if (!gates || !Object.keys(gates).length) {
    L.push('Gates: sem `review-state.json` — nenhum gate registrado no ledger.');
  } else {
    L.push('| Gate | Ciclos | REJECT | Teto | Status |');
    L.push('|---|---|---|---|---|');
    for (const [g, v] of Object.entries(gates)) L.push(`| ${celula(g)} | ${v.ciclos} | ${v.rejeicoes} | ${v.teto ?? 'não declarado'} | ${v.status ?? 'não registrado'} |`);
  }
  L.push('');

  L.push('## 3. Paradas humanas (checkpoints)');
  L.push('');
  const cps = t.run && ehObjeto(t.run.checkpoints) ? Object.entries(t.run.checkpoints) : [];
  if (!t.run) {
    L.push('Paradas humanas: sem `run-state.json` — nenhuma parada registrada.');
  } else if (!cps.length) {
    L.push('Nenhuma parada humana registrada no `run-state.json`.');
  } else {
    const em = ehObjeto(t.run.checkpoints_em) ? t.run.checkpoints_em : {};
    L.push('| Parada | Registrada em | Resposta (dado sigiloso mascarado) |');
    L.push('|---|---|---|');
    for (const [step, resposta] of cps) L.push(`| ${celula(step)} | ${celula(em[step]) || 'carimbo ausente'} | ${celula(truncar(mascararSigilo(resposta), 240)) || '(vazia)'} |`);
  }
  L.push('');

  L.push('## 4. Pendências no artefato');
  L.push('');
  if (!t.pendencias.length) {
    L.push(`Nenhum marcador de pendência (\`[A CONFERIR]\`, \`[NÃO VERIFICADO]\`, \`[TEMA A CONFERIR]\`…) em \`${t.artefato.nome}\`.`);
  } else {
    L.push('| Linha | Marcador | Trecho |');
    L.push('|---|---|---|');
    for (const p of t.pendencias) L.push(`| ${p.linha} | ${celula(p.marcador)} | ${celula(p.trecho)} |`);
  }
  L.push('');

  L.push(paraMarkdown(t.medicao));
  L.push('');
  L.push('---');
  L.push('');
  L.push(`**${FRASE_FINAL}**`);
  L.push('');
  return L.join('\n');
}

export function gerarAnexos(a) {
  const L = [];
  L.push(`# Anexos — documentos a juntar · ${a.squad} · run ${a.runId}`);
  L.push('');
  if (!a.indice) {
    L.push(AVISO_INDICE_AUSENTE(a.squadRel));
    L.push('');
    return L.join('\n');
  }
  const { citados, naoCitados } = a.cruzamento;
  L.push(`Cruzamento de \`${a.indice}\` (${citados.length + naoCitados.length} documento(s)) com o texto de \`${a.artefato}\`. Critério: o nome do arquivo (sem extensão) ou o \`tipo\` aparece na peça — cruzamento textual, confira antes de protocolar.`);
  L.push('');
  L.push('## Citados na peça (juntar)');
  L.push('');
  if (!citados.length) L.push('Nenhum documento do índice é mencionado na peça.');
  else {
    L.push('| Arquivo | Tipo | Páginas | Casou por |');
    L.push('|---|---|---|---|');
    for (const d of citados) L.push(`| ${celula(d.arquivo)} | ${celula(d.tipo) || '—'} | ${celula(d.paginas) || '—'} | ${d.casou} |`);
  }
  L.push('');
  L.push('## Nos autos, não citados');
  L.push('');
  if (!naoCitados.length) L.push('Nenhum — todo documento do índice é citado na peça.');
  else {
    L.push('| Arquivo | Tipo | Páginas |');
    L.push('|---|---|---|');
    for (const d of naoCitados) L.push(`| ${celula(d.arquivo)} | ${celula(d.tipo) || '—'} | ${celula(d.paginas) || '—'} |`);
  }
  L.push('');
  return L.join('\n');
}

const RE_PRAZO = /prazo|data[\s-]*fatal|\bfatal\b|vencimento|tempestiv|dead-?line/i;

export function gerarProximosPassos(p) {
  const L = [];
  L.push(`# Próximos passos · ${p.squad} · run ${p.runId}`);
  L.push('');
  L.push('## Prazo');
  L.push('');
  const cps = p.run && ehObjeto(p.run.checkpoints) ? Object.entries(p.run.checkpoints) : [];
  const em = p.run && ehObjeto(p.run.checkpoints_em) ? p.run.checkpoints_em : {};
  const comPrazo = cps.filter(([step, resposta]) => RE_PRAZO.test(step) || RE_PRAZO.test(String(resposta ?? '')));
  if (!comPrazo.length) {
    L.push(`- Prazo: ${PRAZO_NAO_INFORMADO} — nenhum checkpoint do \`run-state.json\` menciona prazo ou data fatal. O empacotador **não calcula** prazo.`);
  } else {
    L.push('Transcrito dos checkpoints (o empacotador **não calcula** prazo — confira a contagem):');
    L.push('');
    for (const [step, resposta] of comPrazo) L.push(`- ${step}${em[step] ? ` (registrado em ${em[step]})` : ''}: ${mascararSigilo(String(resposta ?? '')).replace(/\s+/g, ' ').trim()}`);
  }
  L.push('');
  L.push('## Antes de protocolar');
  L.push('');
  L.push(`- [ ] Revisar e assinar a peça (\`${p.docx}\`) — protocolar após revisão humana.`);
  if (p.pendencias.length) L.push(`- [ ] Resolver as ${p.pendencias.length} pendência(s) marcadas no artefato (linhas ${p.pendencias.map((x) => x.linha).join(', ')}) — ver TERMO-DE-CONFERENCIA.md §4.`);
  else L.push('- [x] Nenhum marcador de pendência no artefato.');
  if (!p.manifesto) L.push('- [ ] Rodar o Citation Gate: manifesto ausente — nenhuma citação foi conferida.');
  else if (p.manifesto.ilegivel) L.push('- [ ] Refazer o Citation Gate: manifesto ilegível.');
  else if (!p.manifesto.hashConfere) L.push('- [ ] Refazer o Citation Gate: a peça mudou depois da conferência (hash diverge).');
  else if (p.citacoesProblema) L.push(`- [ ] Resolver ${p.citacoesProblema} citação(ões) não verificada(s) listadas no termo.`);
  else L.push('- [x] Citações conferidas (manifesto do Citation Gate confere com a peça).');
  if (!p.anexos.indice) L.push(`- [ ] Gerar o índice dos autos e listar os anexos: ${AVISO_INDICE_AUSENTE(p.squadRel)}.`);
  else L.push(`- [ ] Juntar os anexos listados em ANEXOS.md (${p.anexos.cruzamento.citados.length} citado(s) na peça; ${p.anexos.cruzamento.naoCitados.length} nos autos sem citação — decidir).`);
  if (p.pdf.gerado) L.push(`- [ ] Conferir o PDF (\`${p.pdf.arquivo}\`) antes do protocolo.`);
  else L.push(`- [ ] PDF não gerado: ${p.pdf.motivo} — gerar quando houver LibreOffice, ou protocolar o .docx conforme o sistema do tribunal.`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// O empacotamento
// ---------------------------------------------------------------------------
export async function empacotar({ squadDir, runId = null, artefato = null, semPdf = false, agora = null, env = process.env } = {}) {
  const dir = resolve(squadDir);
  let ehPasta = false;
  try { ehPasta = statSync(dir).isDirectory(); } catch { /* inexistente */ }
  if (!ehPasta) throw new ErroReal(`pasta do squad inexistente: ${squadDir}`);
  const outputDir = join(dir, 'output');
  const raiz = raizDoProjeto(dir);
  const squadRel = relative(raiz, dir) || basename(dir);
  const squadNome = basename(dir);
  const geradoEm = agora || new Date().toISOString();

  const runParaBusca = String(runId || (lerJson(join(dir, 'run-state.json')) || {}).runId || '').trim() || null;
  const artefatoPath = escolherArtefato({ squadDir: dir, outputDir, pedido: artefato, runId: runParaBusca });
  const { buffer: artefatoBuffer, texto } = lerMarkdown(artefatoPath);
  const estiloInfo = carregarEstilo(raiz);
  const run = lerJson(join(dir, 'run-state.json'));
  const runIdFinal = String(runId || (run && run.runId) || 'sem-run').trim();
  const pacoteDir = join(outputDir, 'pacote', runIdFinal);
  rmSync(pacoteDir, { recursive: true, force: true }); // idempotente por run_id: a pasta é regravada inteira
  mkdirSync(pacoteDir, { recursive: true });

  const base = basename(artefatoPath, extname(artefatoPath));
  const nomeDocx = `${base}.docx`;
  writeFileSync(join(pacoteDir, nomeDocx), await markdownParaDocx(texto, estiloInfo.estilo, { titulo: base }));

  let pdf;
  if (semPdf) pdf = { gerado: false, motivo: '--sem-pdf', arquivo: null };
  else {
    const soffice = localizarSoffice(env);
    pdf = soffice ? converterPdf({ soffice, docxPath: join(pacoteDir, nomeDocx), outDir: pacoteDir }) : { gerado: false, motivo: 'LibreOffice ausente', arquivo: null };
  }

  const manifesto = localizarManifesto(artefatoPath, artefatoBuffer);
  const medicao = medirSquad(dir, { agora });
  const pendencias = pendenciasDoArtefato(texto);
  const citacoesProblema = manifesto && manifesto.dados && Array.isArray(manifesto.dados.citations)
    ? manifesto.dados.citations.filter((c) => classificarStatus(c && c.status) !== 'VERIFICADA').length
    : 0;

  const termo = gerarTermo({
    squad: squadNome, runId: runIdFinal, geradoEm,
    artefato: { nome: basename(artefatoPath), docx: nomeDocx, sha256: sha256(artefatoBuffer) },
    estilo: estiloInfo, pdf, manifesto, medicao, run, pendencias,
  });
  writeFileSync(join(pacoteDir, 'TERMO-DE-CONFERENCIA.md'), termo);
  const estiloTermo = { ...estiloInfo.estilo, paragrafo: { ...estiloInfo.estilo.paragrafo, entrelinha: 1, recuo_primeira_linha_cm: 0 } };
  writeFileSync(join(pacoteDir, 'TERMO-DE-CONFERENCIA.docx'), await markdownParaDocx(termo, estiloTermo, { titulo: 'Termo de conferência', quebraDePagina: false }));

  const indicePath = join(dir, 'autos', '_index.yaml');
  const anexos = { indice: null, cruzamento: { citados: [], naoCitados: [] } };
  if (existsSync(indicePath)) {
    anexos.indice = relative(dir, indicePath);
    anexos.cruzamento = cruzarAnexos(lerIndiceAutos(readFileSync(indicePath, 'utf8')), texto);
  }
  writeFileSync(join(pacoteDir, 'ANEXOS.md'), gerarAnexos({ squad: squadNome, runId: runIdFinal, squadRel, artefato: basename(artefatoPath), ...anexos }));
  writeFileSync(join(pacoteDir, 'PROXIMOS-PASSOS.md'), gerarProximosPassos({
    squad: squadNome, runId: runIdFinal, squadRel, run, pendencias, manifesto, citacoesProblema, anexos, pdf, docx: nomeDocx,
  }));

  const arquivos = readdirSync(pacoteDir).filter((n) => n !== 'MANIFESTO.json').sort().map((n) => {
    const buf = readFileSync(join(pacoteDir, n));
    return { nome: n, sha256: sha256(buf), bytes: buf.length };
  });
  const manifestoPacote = {
    schema_version: '1',
    kind: 'legalsquad.pacote-de-protocolo',
    squad: squadNome,
    run_id: runIdFinal,
    gerado_em: geradoEm,
    gerado_por: 'scripts/empacotar.mjs',
    artefato: { origem: relative(dir, artefatoPath), sha256: sha256(artefatoBuffer) },
    estilo: { nome: estiloInfo.nome, versao: estiloInfo.versao, origem: estiloInfo.origem, arquivo: estiloInfo.arquivo, base: estiloInfo.base },
    citation_gate: manifesto ? { manifesto: manifesto.arquivo, hash_confere: manifesto.hashConfere } : null,
    pdf,
    arquivos,
  };
  writeFileSync(join(pacoteDir, 'MANIFESTO.json'), `${JSON.stringify(manifestoPacote, null, 2)}\n`);

  return { pacoteDir, runId: runIdFinal, artefato: artefatoPath, docx: nomeDocx, pdf, estilo: manifestoPacote.estilo, arquivos: [...arquivos.map((a) => a.nome), 'MANIFESTO.json'], pendencias: pendencias.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const squadDir = args.find((a, i) => !a.startsWith('--') && !['--run', '--artefato', '--agora'].includes(args[i - 1]));
  if (!squadDir) {
    process.stderr.write('uso: empacotar.mjs squads/<nome> [--run <run_id>] [--artefato <arquivo.md>] [--sem-pdf] [--json]\n');
    process.exit(1);
  }
  empacotar({ squadDir, runId: valor('--run'), artefato: valor('--artefato'), semPdf: args.includes('--sem-pdf'), agora: valor('--agora') })
    .then((r) => {
      if (args.includes('--json')) {
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      } else {
        process.stdout.write(`pacote: ${relative(process.cwd(), r.pacoteDir) || r.pacoteDir}\n`);
        process.stdout.write(`  ${r.arquivos.join(' · ')}\n`);
        if (!r.pdf.gerado) process.stdout.write(`  PDF não gerado: ${r.pdf.motivo}\n`);
        if (r.pendencias) process.stdout.write(`  pendências no artefato: ${r.pendencias} (ver TERMO-DE-CONFERENCIA.md)\n`);
      }
      process.exit(0);
    })
    .catch((e) => {
      process.stderr.write(`empacotar: ${e instanceof ErroReal ? e.message : (e && e.stack) || e}\n`);
      process.exit(1);
    });
}
