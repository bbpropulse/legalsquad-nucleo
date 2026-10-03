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
 *   PROXIMOS-PASSOS.md       prazo TRANSCRITO do `prazo-fatal.json` do motor determinístico (nunca
 *                            calculado aqui) e onde ler o que os checkpoints disseram; protocolo após revisão
 *   MANIFESTO.json           SHA-256 de cada arquivo e a versão do estilo usado
 *
 * Regras: sai 0 ao gerar; sai 1 só em erro real (pasta inexistente, artefato
 * ambíguo, Markdown ilegível, estilo ausente/inválido). Idempotente por run_id:
 * regrava a mesma pasta. Resposta livre de checkpoint e pedido de reabertura não
 * entram no pacote (podem trazer nome de parte ou de testemunha): o termo registra
 * a decisão e aponta o `run-state.json`, que fica no escritório. Nada aqui calcula
 * prazo nem inventa número: o que o ledger não tem sai como "não medido"/"não informado".
 *
 * Uso:
 *   node scripts/empacotar.mjs squads/<nome> [--run <run_id>] [--artefato <arquivo.md>] [--sem-pdf] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DATA_MARKER, ErroReal, TEMA_MARKER, artefatosDaConferencia, ocorrenciasDePendencia, escolherArtefato, idsDeStep, medirSquad, paraMarkdown, tipoDaParada } from './run-metricas.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ESTILO_CORE = 'estilo-forense.json';
const ESTILO_ESCRITORIO = 'estilo-escritorio.json';
const MANIFEST_SUFFIX = '.citation-gate.json';

export const FRASE_FINAL = 'Rascunho técnico. Revisão e assinatura do(a) profissional responsável são obrigatórias.';
export const AVISO_MANIFESTO_AUSENTE = 'Citações: manifesto ausente, o Citation Gate não registrou conferência';
export const AVISO_INDICE_AUSENTE = (squadRel, { semProcesso = false } = {}) => `${semProcesso ? 'Índice dos documentos do cliente ausente' : 'Índice de autos ausente'}: rode \`node scripts/indexar-autos.mjs ${squadRel}\``;
export const PRAZO_NAO_INFORMADO = 'prazo não informado no intake';

// Erro que justifica exit 1; tudo o mais é degradação registrada no termo. A classe
// mora em `run-metricas.mjs`, junto do escolhedor da peça, que também a lança.
export { ErroReal, artefatosDaConferencia };

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normalizar = (s) => semAcento(s).toLowerCase();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mkdirIfNeeded = (p) => { mkdirSync(p, { recursive: true }); return p; };
const celula = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
const truncar = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * `processo:` do squad.yaml (judicial · administrativo · nenhum), gravado pelo compilador quando o
 * design o declara. Sem processo (contrato, escritura, requerimento ao registro), não há autos:
 * todo documento do índice é do cliente, nada está "já nos autos" e o ato é assinar ou protocolar.
 */
export function processoDoSquad(squadDir) {
  try {
    const m = readFileSync(join(squadDir, 'squad.yaml'), 'utf8').match(/^processo:[ \t]*["']?(judicial|administrativo|nenhum)\b/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * `delivery_type:` do squad.yaml (legal-draft · legal-analysis · content · research). Só `legal-draft`
 * é peça que se protocola ou assina; o resto (parecer, relatório, boletim, roteiro) é entrega interna
 * ao escritório ou ao cliente. Medido no m7 da 0.9.81: o boletim interno de triagem saiu com
 * "protocolar após revisão humana" e "juntar com a peça Doc. 01 e Doc. 05" nos próximos passos.
 */
export function deliveryTypeDoSquad(squadDir) {
  try {
    const m = readFileSync(join(squadDir, 'squad.yaml'), 'utf8').match(/^delivery_type:[ \t]*["']?([\w-]+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * A linha de status de trabalho no alto da minuta ("Status: minuta (rascunho técnico ...). Versão:
 * v12. Memória aplicada: ..."): é material do revisor, não do documento. Sai do .docx e do .pdf e vai
 * à NOTA-AO-REVISOR. Medido no m6 da 0.9.81: a linha era a primeira do contrato no .md, no .docx e
 * no .pdf entregues, com "advogada comum", "memória vazia", "veto pessoal" e a versão errada. Só no
 * alto (antes do primeiro título, ou nas três primeiras linhas com texto) e só com o rótulo de status
 * e um termo de trabalho (rascunho, minuta, versão, memória, revisão humana).
 */
const LINHA_DE_STATUS = /^\s*(?:\*\*)?(?:status|situa[çc][ãa]o do documento)(?:\*\*)?\s*:(?:\*\*)?\s*(.+)$/i;
const TERMO_DE_TRABALHO = /\b(?:rascunho|minuta|vers[ãa]o|mem[óo]ria|revis[ãa]o humana|campos a preencher|dados a confirmar)\b/i;
export function separarLinhaDeStatus(texto) {
  const linhas = String(texto ?? '').split('\n');
  const status = [];
  let comTexto = 0;
  let noFrontmatter = linhas[0] === '---';
  const fica = [];
  for (const [i, l] of linhas.entries()) {
    if (noFrontmatter) { fica.push(l); if (i > 0 && l === '---') noFrontmatter = false; continue; }
    const alto = comTexto < 3 && !fica.some((x, k) => k > 0 && /^\s{0,3}#{1,6}\s/.test(x));
    if (alto && LINHA_DE_STATUS.test(l) && TERMO_DE_TRABALHO.test(l)) { status.push(l.trim()); continue; }
    if (l.trim()) comTexto += 1;
    fica.push(l);
  }
  return { peca: fica.join('\n').replace(/^(---\n[\s\S]*?\n---\n)\n+/, '$1\n'), status };
}

/**
 * `originaria: true` do squad.yaml (L4, HC de 27/09/2026, motor 0.9.60): a peça abre processo novo
 * no tribunal. Os autos do índice são os de origem: o que a peça cita deles vai junto, como cópia,
 * e não há prazo do último ato a contar para o protocolo.
 */
export function originariaDoSquad(squadDir) {
  try {
    return /^originaria:[ \t]*["']?true\b/m.test(readFileSync(join(squadDir, 'squad.yaml'), 'utf8'));
  } catch { return false; }
}

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
 * Resposta de checkpoint não entra no pacote: só a decisão, quando ela é uma das
 * opções que o próprio runner oferece.
 *
 * O pacote copiava a resposta livre do profissional (240 caracteres no termo, a
 * resposta inteira nos próximos passos) com CPF, e-mail e telefone mascarados.
 * Máscara por padrão não pega nome: medido em 24/09/2026, o termo de um run
 * criminal levou "as declarações da mãe e do empregador" de uma escalada, e o
 * relato de um intake traz o nome da parte, da criança ou da testemunha. O
 * pacote sai do escritório (vai ao cliente, ao correspondente, ao protocolo);
 * o `run-state.json`, não. Então o termo diz QUAL opção foi escolhida, pelo
 * rótulo do motor (texto nosso, sem dado do caso), e aponta o registro completo.
 */
const DECISOES = [
  [/^aprovar e seguir\b/, 'Aprovar e seguir'],
  [/^ajust/, 'Ajustar'],
  [/^red-?team\b/, 'Red-team antes de seguir'],
  [/^voltar\b/, 'Voltar à redação'],
  [/^concluir\b/, 'Concluir mesmo assim, sob responsabilidade do profissional'],
  [/^seguir com (?:a |as )?ressalvas?\b/, 'Seguir com ressalva'],
  [/^confirm[oa]\b/, 'Confirmado'],
];
export function decisaoDaResposta(resposta) {
  const t = normalizar(resposta).replace(/^[\s"'“”«»([*_-]+/, '').trim();
  if (!t) return '(vazia)';
  const achada = DECISOES.find(([re]) => re.test(t));
  return achada ? achada[1] : 'resposta livre, não transcrita';
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
  if (erros.length) throw new ErroReal(`estilo inválido (${origem}): campos ausentes ou inválidos: ${erros.join(', ')}`);
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
    docxCache = await import(await localizarDocx());
  } catch (e) {
    if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND')) throw new ErroReal('biblioteca `docx` não encontrada nem no projeto nem no motor; rode `npm install docx` na raiz do projeto');
    throw e;
  } finally {
    if (sombrear) Object.defineProperty(globalThis, 'localStorage', acessor);
  }
  return docxCache;
}

/**
 * Onde está o `docx`: no `node_modules/` do projeto (quem rodou `npm install`)
 * ou, sem isso, no do MOTOR, que o declara como dependência e é instalado
 * junto com ele. O `init --yes` do assistente não instala dependências do
 * projeto, e o empacotamento da entrega não pode falhar por causa disso
 * (achado num processo real, 15/09/2026). O caminho do motor vem do atalho
 * (`_legalsquad/motor/motor.json`) ou do registro da máquina (`~/.legalsquad/motor.json`).
 */
async function localizarDocx() {
  const { createRequire } = await import('node:module');
  const raiz = raizDoProjeto(process.cwd());
  const bases = [join(raiz, 'package.json'), join(process.cwd(), 'package.json')];
  for (const registro of [join(raiz, '_legalsquad', 'motor', 'motor.json'), join(process.env.HOME || process.env.USERPROFILE || '', '.legalsquad', 'motor.json')]) {
    try {
      const bin = JSON.parse(readFileSync(registro, 'utf8')).bin;
      if (bin) bases.push(bin);
    } catch { /* sem registro */ }
  }
  for (const base of bases) {
    try {
      return pathToFileURL(createRequire(base).resolve('docx')).href;
    } catch { /* não está aqui */ }
  }
  return 'docx';
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
// O escolhedor da peça (`escolherArtefato` e as pastas do run) mora em
// `run-metricas.mjs`, importado acima: a métrica de pendências tem de medir a
// mesma peça que o pacote embrulha (G22 da medição de 24/09/2026).

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

/**
 * Marcadores de pendência da peça, com a linha (1-based) do arquivo onde aparecem, pela mesma regra
 * do `manifesto-final` e da métrica do run (`ocorrenciasDePendencia`, bloco `pendencia`): na nota ao
 * revisor, o marcador que só repete o da peça e o que só o nomeia não contam, e o que só a nota tem
 * conta. O `[TEMA A CONFERIR]` da nota é pergunta ao revisor e não conta; fora dela, conta.
 * Medido em 26/09/2026 (despejo, motor 0.9.54): o PROXIMOS-PASSOS mandava resolver 19 pendências, e
 * o manifesto tinha 14 (as cinco a mais repetiam a peça na nota). Medido no teste de ponta a ponta de
 * 30/09/2026 (achado 29): com a nota inteira fora, o empacotador disse 32 e o manifesto, 34 (as duas
 * a mais só estavam na nota).
 */
export function pendenciasDoArtefato(texto) {
  const normal = String(texto).replace(/\r\n?/g, '\n');
  const inicios = [0];
  for (let i = 0; i < normal.length; i++) if (normal[i] === '\n') inicios.push(i + 1);
  const linhaDe = (pos) => {
    let lo = 0;
    let hi = inicios.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (inicios[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const linhas = normal.split('\n');
  const out = ocorrenciasDePendencia(normal)
    .filter((o) => !o.mencao && !(o.repeteDaPeca && DATA_MARKER.test(o.marcador)))
    .map((o) => { const l = linhaDe(o.indice); return { linha: l + 1, marcador: o.marcador, trecho: truncar(linhas[l].trim(), 120), ...(o.naNota ? { na_nota: true } : {}) }; });
  let naNota = false;
  linhas.forEach((linha, i) => {
    const marcador = linha.match(RE_NOTA_AO_REVISOR);
    if (marcador) { naNota = marcador[1] === 'inicio'; return; }
    if (naNota) return;
    for (const m of linha.matchAll(TEMA_MARKER)) out.push({ linha: i + 1, marcador: m[0], trecho: truncar(linha.trim(), 120) });
  });
  return out.sort((a, b) => a.linha - b.linha);
}

/**
 * Status de citação do manifesto → rótulo do termo. Tudo que não é um dos cinco é "pendente".
 * `verificada_no_acervo` é conferência (na cópia do acervo assinado, não na página do tribunal) e
 * o hook a aceita na final: medido em 25/09/2026 (apelação e HC, motor 0.9.50), o termo a contava
 * como "pendente" ("29 pendente(s)") e o PROXIMOS-PASSOS mandava resolver 29 citações conferidas.
 */
export const VERIFICADA_NO_ACERVO = 'VERIFICADA NO ACERVO';
const ROTULOS_VERIFICADOS = new Set(['VERIFICADA', VERIFICADA_NO_ACERVO]);
export const citacaoConferida = (status) => ROTULOS_VERIFICADOS.has(classificarStatus(status));
export function classificarStatus(status) {
  const bruto = String(status ?? '').trim();
  const s = normalizar(bruto).replace(/[\s_-]+/g, ' ').trim();
  if (s === 'verificada' || s === 'verificado') return 'VERIFICADA';
  if (s === 'verificada no acervo' || s === 'verificado no acervo') return VERIFICADA_NO_ACERVO;
  if (/^nao encontrad[ao]$/.test(s)) return 'NÃO ENCONTRADA';
  if (s === 'divergente') return 'DIVERGENTE';
  // Súmula cancelada, revogada ou superada (29/09/2026): não é conferência nem pendência de acesso,
  // é citação que sai da peça. Conta à parte, e o termo diz por quê.
  if (/^(?:cancelad[ao]|revogad[ao]|superad[ao])$/.test(s)) return 'CANCELADA';
  return bruto ? `pendente (${bruto})` : 'pendente (sem status)';
}

// ---------------------------------------------------------------------------
// A nota ao revisor sai da peça protocolada: cópia do bloco canônico de
// src/nota-ao-revisor.js (medido em 25/09/2026, alimentos/reclamação: a "Nota
// técnica ao advogado revisor" saiu no .docx e no .pdf do pacote).
// >>> nota-ao-revisor:begin
/** As duas linhas que delimitam a nota ao revisor, sozinhas na linha. */
export const NOTA_AO_REVISOR_INICIO = '<!-- nota-ao-revisor:inicio -->';
export const NOTA_AO_REVISOR_FIM = '<!-- nota-ao-revisor:fim -->';
const RE_NOTA_AO_REVISOR = /^[ \t]*<!--\s*nota-ao-revisor:(inicio|fim)\s*-->[ \t]*$/;

/**
 * Separa a peça da nota ao revisor. Devolve `{ peca, nota, blocos, erro }`: `peca`
 * é o texto sem os blocos (e sem as linhas de marcador), `nota` é o miolo dos
 * blocos, `blocos` quantos havia. Marcador fora de ordem (fim sem início, início
 * dentro de outro, início sem fim) é `erro`, e aí nada se separa: `peca` volta
 * como veio e `nota` vazia, para ninguém tirar da peça metade do que devia.
 */
export function separarNotaAoRevisor(texto) {
  const linhas = String(texto ?? '').split('\n');
  const peca = [];
  const nota = [];
  let aberto = -1;
  let blocos = 0;
  for (const [i, linha] of linhas.entries()) {
    const m = linha.replace(/\r$/, '').match(RE_NOTA_AO_REVISOR);
    if (!m) { (aberto >= 0 ? nota : peca).push(linha); continue; }
    if (m[1] === 'inicio') {
      if (aberto >= 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor aberta na linha ${i + 1} dentro de outra (aberta na linha ${aberto + 1})` };
      aberto = i;
      continue;
    }
    if (aberto < 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor fechada na linha ${i + 1} sem ter sido aberta` };
    aberto = -1;
    blocos += 1;
  }
  if (aberto >= 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor aberta na linha ${aberto + 1} e nunca fechada (${NOTA_AO_REVISOR_FIM})` };
  return { peca: peca.join('\n'), nota: nota.join('\n').trim(), blocos, erro: null };
}
// <<< nota-ao-revisor:end

// ---------------------------------------------------------------------------
// Onde estão os autos: cópia do bloco canônico de src/autos-path.js (segue o
// `caso.json`). Medido na medição de 24/09/2026: os 8 squads criados com
// `--caso` saíram com "Índice de autos ausente" no ANEXOS.md, porque o
// empacotador só olhava `squads/<nome>/autos/`.
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
// O bloco vem inteiro para não divergir; aqui só `pastaDeAutos` é usada.
void resolverAutos;

// O PDF integral do PJe separado por documento: cópia do bloco canônico de src/autos-pje.js.
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
void rodapeDaPagina;
void separarPecasPje;

// ---------------------------------------------------------------------------
// Índice dos autos (autos/_index.yaml) — `documentos:` em bloco YAML, um mapa por item
// ---------------------------------------------------------------------------
function escalar(v) {
  // Valor entre aspas é lido inteiro: o `#` de dentro é texto, não comentário. Medido em 25/09/2026
  // (HC, motor 0.9.50): a `primeira_pagina` "# Auto ... (cópia extraída dos autos) ## fls. 2 ..."
  // era cortada no " ##" como se fosse comentário, e os 26 documentos saíam sem folha.
  const bruto = String(v ?? '').trim();
  const entreAspas = bruto.match(/^(["'])(.*)\1(?:\s+#.*)?$/);
  if (entreAspas) return entreAspas[2];
  const s = bruto.replace(/\s+#.*$/, '');
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  // O indexador grava `paginas: null` para arquivo que não é PDF: o texto "null" saía na tabela.
  if (s === 'null' || s === '~') return null;
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
  // O PDF integral do PJe vira os documentos dele (bloco `pje:`), cada um com o Num. e a folha inicial.
  return expandirPecasPje(docs.filter((d) => typeof d.arquivo === 'string' && d.arquivo.trim()), lerPecasPje(texto));
}

/**
 * Os números de documento que a peça cita: "Doc. 04", "Docs. 01, 02 e 03", "Doc. 01 e Doc. 03",
 * "Docs. 05 a 07" (intervalo de até 30). Letra depois do número ("Doc. R-02", "Doc. 04-A") não é o
 * documento N do índice.
 */
function documentosCitados(texto) {
  const numeros = new Set();
  for (const m of String(texto).matchAll(/\bdocs?\.?\s*(?:n[o°º.]*\s*)?(\d{1,3}(?:\s*(?:,|e|a)\s*\d{1,3}(?![\d.,]\d))*)(?![\w-])/gi)) {
    const partes = m[1].split(/\s*(,|e|a)\s*/);
    let anterior = null;
    let faixa = false;
    for (const p of partes) {
      if (p === 'a') { faixa = true; continue; }
      if (p === ',' || p === 'e') continue;
      const n = Number(p);
      if (faixa && anterior !== null && n > anterior && n - anterior <= 30) for (let k = anterior + 1; k < n; k += 1) numeros.add(k);
      numeros.add(n);
      anterior = n;
      faixa = false;
    }
  }
  return numeros;
}

/**
 * Os documentos que a peça cita só para dizer que ficam de fora ("O laudo de vistoria de entrada
 * (Doc. 07) não instrui a inicial"): número → a frase. Conta só o documento em que TODA menção
 * pelo número está numa frase que o exclui; uma menção que o usa basta para ele ser citado.
 * Medido em 26/09/2026 (despejo, motor 0.9.54): o ANEXOS.md mandava juntar o Doc. 07, que a
 * peça declara fora. Não há como ter certeza pela frase: o documento vai para "a decidir", com a
 * frase ao lado.
 */
const RE_EXCLUI_DOCUMENTO = /\bnao\s+(?:instrui|instruem|acompanha|acompanham|integra|integram|sera|serao|e|sao|foi|foram|vai|vao)\s+(?:\w+\s+){0,2}?(?:juntad|anexad|instrui|acompanh|integr)|\bnao\s+(?:instrui|instruem|acompanha|acompanham|integra|integram|se\s+junta|se\s+juntam|juntamos|juntaremos)\b|\b(?:fica|ficam)\s+(?:de\s+)?fora\b|\bdeixa(?:m)?\s+de\s+(?:ser\s+)?junt|\bexcluid[oa]s?\s+d[oa]s?\s+(?:anexos|juntada|instrucao)|\bsem\s+juntar\b/;
const RE_REFERENCIA_A_DOCUMENTO = /\bdocs?\.?\s*(?:n[o°º.]*\s*)?(\d{1,3}(?:\s*(?:,|e|a)\s*\d{1,3}(?![\d.,]\d))*)(?![\w-])/gi;
function numerosDaReferencia(lista) {
  const numeros = [];
  const partes = lista.split(/\s*(,|e|a)\s*/);
  let anterior = null;
  let faixa = false;
  for (const p of partes) {
    if (p === 'a') { faixa = true; continue; }
    if (p === ',' || p === 'e') continue;
    const n = Number(p);
    if (faixa && anterior !== null && n > anterior && n - anterior <= 30) for (let k = anterior + 1; k < n; k += 1) numeros.push(k);
    numeros.push(n);
    anterior = n;
    faixa = false;
  }
  return numeros;
}
export function documentosExcluidos(textoPeca) {
  const texto = String(textoPeca ?? '');
  const frases = new Map();
  for (const m of texto.matchAll(RE_REFERENCIA_A_DOCUMENTO)) {
    // A oração: do fim da anterior (ponto seguido de maiúscula, ponto e vírgula ou quebra de linha)
    // ao fim desta. "O Doc. 08 fica de fora; o Doc. 08 prova o reajuste" são duas.
    const antes = texto.slice(0, m.index);
    const inicio = Math.max(antes.lastIndexOf('\n') + 1, antes.lastIndexOf(';') + 1, ...[...antes.matchAll(/[.!?]\s+(?=[A-ZÀ-Ú])/g)].map((f) => f.index + f[0].length));
    const resto = texto.slice(m.index + m[0].length);
    const fimRelativo = resto.search(/[.!?](?:\s+[A-ZÀ-Ú]|\s*$|\s*\n)|;|\n/);
    const fim = m.index + m[0].length + (fimRelativo < 0 ? resto.length : fimRelativo + 1);
    const frase = texto.slice(inicio, fim).trim();
    const exclui = RE_EXCLUI_DOCUMENTO.test(normalizar(frase));
    for (const n of numerosDaReferencia(m[1])) {
      if (!frases.has(n)) frases.set(n, { exclui: true, frase: '' });
      const f = frases.get(n);
      f.exclui = f.exclui && exclui;
      if (exclui && !f.frase) f.frase = frase;
    }
  }
  return new Map([...frases].filter(([, f]) => f.exclui).map(([n, f]) => [n, f.frase]));
}

/** As folhas dos autos que a peça cita ("fls. 12", "fls. 12-14", "fls. 12 a 14", "f. 3"): cada número. */
function folhasCitadas(texto) {
  const folhas = new Set();
  for (const m of String(texto).matchAll(/\b(?:e-)?fls?\.\s*(\d+)(?:\s*(?:-|a)\s*(\d+))?/gi)) {
    const de = Number(m[1]);
    const ate = m[2] ? Number(m[2]) : de;
    for (let k = de; k <= Math.min(ate, de + 500); k += 1) folhas.add(k);
  }
  return folhas;
}

/**
 * Cruza o índice com a peça: o documento é "citado" quando a peça o nomeia pelo próprio número
 * ("Doc. 04"), por uma folha dele (a folha inicial do índice, `fls. N`, e as seguintes até o fim do
 * documento) ou pelo nome do arquivo (sem extensão). O `tipo` não conta: é nome de categoria, que
 * vários documentos dividem. Medido na negativação de 24/09/2026 (motor 0.9.49): os 14 documentos
 * saíram citados "por tipo", e o Doc. 14 (declaração de fatos da cliente, que a peça não cita)
 * entrou porque a palavra "declaração" aparece no texto.
 * Cada documento leva `numero`, a posição dele no índice (1-based): é por ela que o
 * ANEXOS.md o nomeia, nunca pelo nome do arquivo (ver `gerarAnexos`).
 */
export function cruzarAnexos(documentos, textoPeca) {
  const texto = ` ${normalizar(textoPeca).replace(/[-_]/g, ' ').replace(/\s+/g, ' ')} `;
  const porNumero = documentosCitados(normalizar(textoPeca));
  const porFolha = folhasCitadas(normalizar(textoPeca));
  const excluidos = documentosExcluidos(textoPeca);
  const citados = [];
  const naoCitados = [];
  documentos.forEach((doc, i) => {
    const stem = normalizar(basename(doc.arquivo, extname(doc.arquivo)));
    // O documento do PJe é um trecho do PDF integral: o nome do arquivo é de todos eles, e não o identifica.
    const formas = doc.num ? [] : [stem, stem.replace(/^\d+[-_. ]*/, '')].map((f) => f.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()).filter((f) => f.length >= 4);
    const folha = String(folhaInicial(doc) || '').match(/^(?:e-)?fls?\.\s*(\d+)/);
    const paginas = Number.isInteger(doc.paginas) && doc.paginas > 0 ? doc.paginas : 1;
    let casou = null;
    // Citado pelo número só para ser excluído não casa pelo número; folha ou nome do arquivo ainda casam.
    const excluido = excluidos.get(i + 1);
    // O documento do PJe se cita pelo Num. (`Num. 12345678 - Pág. 3`, `ID 12345678`), nunca pelo
    // "Doc. NN" da posição no índice: o "Doc. 04" da peça é o anexo da inicial, não o quarto do PDF.
    if (doc.num && new RegExp(`\\b${doc.num}\\b`).test(texto)) casou = 'pje';
    else if (!doc.num && porNumero.has(i + 1) && !excluido) casou = 'doc';
    else if (folha && Array.from({ length: paginas }, (_, k) => Number(folha[1]) + k).some((f) => porFolha.has(f))) casou = 'folha';
    else if (!excluido && formas.some((f) => texto.includes(f))) casou = 'arquivo';
    (casou ? citados : naoCitados).push({ ...doc, numero: i + 1, casou, ...(excluido && !casou ? { excluido_pela_peca: excluido } : {}) });
  });
  return { citados, naoCitados };
}

/**
 * O que se junta com a peça. Documento dos autos (`origem: autos` no índice ou, sem ela, com
 * folha `fls. N`) já está no processo: a peça
 * o cita pela folha e ninguém o junta de novo. Sem folha, está fora dos autos: junta-se o que a
 * peça cita e, citado ou não, o instrumento de mandato (procuração, substabelecimento), que
 * acompanha a peça sem precisar ser mencionado no texto. Medido em 25/09/2026 (apelação e HC,
 * motor 0.9.50): o ANEXOS mandava juntar 18 documentos que já estavam nos autos e marcava a
 * procuração do escritório (Doc. 25, fora dos autos) como "não citado", a decidir.
 */
const RE_MANDATO = /^(?:procurac|substabelec)/;
export function separarAnexos({ citados = [], naoCitados = [] } = {}, { semProcesso = false, originaria = false } = {}) {
  // A origem que o indexador gravou (bloco `autos-origem`) decide; sem ela, a folha do processo.
  // Sem processo, não há autos: todo documento é do cliente, e o que a peça cita vai com ela.
  const dosAutos = (d) => (semProcesso ? false : d.origem === 'autos' ? true : d.origem === 'cliente' ? false : /^(?:e-)?fls?\./.test(folhaInicial(d) || ''));
  // Na peça originária, os autos são os de origem: nada está nos autos do processo que ela abre.
  const nosAutos = (d) => !originaria && dosAutos(d);
  const mandato = (d) => RE_MANDATO.test(normalizar(d.tipo || ''));
  const aJuntar = [
    ...citados.filter((d) => !nosAutos(d)).map((d) => ({ ...d, motivo: originaria && dosAutos(d) ? 'origem' : 'citado' })),
    ...naoCitados.filter((d) => !nosAutos(d) && mandato(d)).map((d) => ({ ...d, motivo: 'mandato' })),
  ].sort((a, b) => a.numero - b.numero);
  return {
    aJuntar,
    jaNosAutos: citados.filter(nosAutos),
    nosAutosNaoCitados: naoCitados.filter(nosAutos),
    foraNaoCitados: naoCitados.filter((d) => !nosAutos(d) && !mandato(d)),
  };
}

/**
 * A folha onde o documento começa, lida do começo do texto que o indexador guardou
 * (`primeira_pagina` abre com `## fls. N`, `## e-fls. N` ou `## p. N` quando o
 * documento foi convertido com folhas). Sem isso, `null`: nunca folha inventada.
 */
export function folhaInicial(doc) {
  // O documento do PJe traz a folha inicial do índice (bloco `pje:`), que é a página do PDF integral.
  if (doc && Number.isInteger(doc.folha_inicial)) return `fls. ${doc.folha_inicial}`;
  // O conversor abre a cópia extraída com o título (`# Auto de ... (cópia extraída dos autos) ##
  // fls. 2 ...`, numa linha só no índice): a folha vem logo depois dele. Medido em 25/09/2026 (HC,
  // motor 0.9.50): os 26 documentos saíam "folha não consta".
  const m = String(doc && doc.primeira_pagina != null ? doc.primeira_pagina : '').match(/^\s*(?:#\s[^\n#]{0,300}?\s)?#{1,6}\s*((?:e-)?fls?\.|p\.)\s*(\d+)/i);
  return m ? `${m[1].toLowerCase()} ${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Os documentos do pacote — cada um só com o que os ledgers provam
// ---------------------------------------------------------------------------
export function gerarTermo(t) {
  const L = [];
  L.push(`# Termo de conferência · ${t.squad} · run ${t.runId}`);
  L.push('');
  L.push(`Gerado em ${t.geradoEm} por \`scripts/empacotar.mjs\` a partir dos ledgers do run (\`run-state.json\`, \`review-state.json\`, manifesto do Citation Gate); nada abaixo foi escrito à mão.`);
  L.push('');
  L.push(`- Peça: \`${t.artefato.nome}\` → \`${t.artefato.docx}\` · SHA-256 \`${t.artefato.sha256}\``);
  if (t.notaAoRevisor) L.push(`- Nota ao revisor: fora da peça, em \`${t.notaAoRevisor}\` (o bloco \`nota-ao-revisor\` da final não entra no .docx nem no .pdf)`);
  L.push(`- Estilo: ${t.estilo.nome} v${t.estilo.versao} (${t.estilo.origem}: \`${t.estilo.arquivo}\`)`);
  L.push(t.pdf.gerado ? `- PDF: gerado (\`${t.pdf.arquivo}\`)` : `- PDF não gerado: ${t.pdf.motivo}`);
  L.push('');

  L.push('## 1. Citações (Citation Gate)');
  L.push('');
  const totais = { VERIFICADA: 0, [VERIFICADA_NO_ACERVO]: 0, 'NÃO ENCONTRADA': 0, DIVERGENTE: 0, CANCELADA: 0, pendente: 0 };
  if (!t.manifesto) {
    L.push(AVISO_MANIFESTO_AUSENTE);
  } else if (t.manifesto.ilegivel) {
    L.push(`Citações: manifesto \`${t.manifesto.arquivo}\` ilegível (JSON inválido), o Citation Gate não registrou conferência válida`);
  } else {
    const m = t.manifesto.dados;
    const cits = Array.isArray(m.citations) ? m.citations : [];
    L.push(`Manifesto \`${t.manifesto.arquivo}\` · conferido por ${m.verified_by || 'não informado'} em ${m.verified_at || 'data não informada'} · escopo ${m.scope || 'não informado'} · gate ${m.gate_status || 'não informado'} · hash do artefato: ${t.manifesto.hashConfere ? 'confere' : 'DIVERGE, a peça mudou depois da conferência; refaça o Citation Gate'}`);
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
      const noAcervo = totais[VERIFICADA_NO_ACERVO];
      L.push(`Totais: ${totais.VERIFICADA} verificada(s)${noAcervo ? ` na fonte oficial · ${noAcervo} verificada(s) no acervo` : ''} · ${totais['NÃO ENCONTRADA']} não encontrada(s) · ${totais.DIVERGENTE} divergente(s)${totais.CANCELADA ? ` · ${totais.CANCELADA} cancelada(s)` : ''} · ${totais.pendente} pendente(s).`);
      if (totais.CANCELADA) {
        L.push('');
        L.push('"Cancelada" é súmula que o acervo ou a fonte declara cancelada, revogada ou superada: súmula cancelada: não fundamente nela. A citação sai da peça antes do protocolo.');
      }
      if (noAcervo) {
        L.push('');
        L.push('"Verificada no acervo" é citação conferida na cópia do acervo assinado (a captura oficial que o curador distribui), não na página do tribunal: é conferência, não pendência. O caminho da cópia lida está no manifesto, em `evidence.fonte_local`.');
      }
    }
  }
  L.push('');

  L.push('## 2. Gates (ciclos e REJECTs)');
  L.push('');
  const gates = t.medicao && t.medicao.gates;
  if (!gates || !Object.keys(gates).length) {
    L.push('Gates: sem `review-state.json`, nenhum gate registrado no ledger.');
  } else {
    L.push('| Gate | Laços | Ciclos | REJECT | Teto | Status |');
    L.push('|---|---|---|---|---|---|');
    for (const [g, v] of Object.entries(gates)) L.push(`| ${celula(g)} | ${v.lacos ?? 1} | ${v.ciclos} | ${v.rejeicoes} | ${v.teto ?? 'não declarado'} | ${v.status ?? 'não registrado'} |`);
    // Um gate com mais de um laço (o Citation Gate roda na redação e de novo na
    // conferência final) mostra cada rodada: é o que o run de 15/09/2026 escondia.
    const comHistorico = Object.entries(gates).filter(([, v]) => Array.isArray(v.rodadas) && v.rodadas.length > 1);
    if (comHistorico.length) {
      L.push('');
      L.push('Gates com mais de um laço no run, rodada a rodada (o ledger guarda o laço anterior em `historico`):');
      L.push('');
      for (const [g, v] of comHistorico) {
        v.rodadas.forEach((r, i) => L.push(`- ${celula(g)} · laço ${i + 1}${r.loop ? ` (\`${celula(r.loop)}\` → \`${celula(r.target) || '?'}\`)` : ''}: ${r.ciclos} ciclo(s), ${r.rejeicoes} REJECT, teto ${r.teto ?? 'não declarado'}, ${r.status ?? 'não registrado'}`));
      }
    }
  }
  L.push('');

  // Checkpoint e escalada separados pela mesma régua da métrica (G22), e a
  // resposta livre fica fora do pacote (ver `decisaoDaResposta`).
  L.push('## 3. Paradas humanas e escaladas');
  L.push('');
  const cps = t.run && ehObjeto(t.run.checkpoints) ? Object.entries(t.run.checkpoints) : [];
  const registro = `${t.squadRel || `squads/${t.squad}`}/run-state.json`;
  if (!t.run) {
    L.push('Paradas humanas: sem `run-state.json`, nenhuma parada registrada.');
  } else if (!cps.length) {
    L.push('Nenhuma parada humana registrada no `run-state.json`.');
  } else {
    const em = ehObjeto(t.run.checkpoints_em) ? t.run.checkpoints_em : {};
    const ids = idsDeStep(t.run);
    L.push('| Parada | Tipo | Registrada em | Decisão |');
    L.push('|---|---|---|---|');
    // A escalada repetida (a meta reprovada duas vezes) aparece uma vez por registro, pelo histórico
    // do ledger; o mapa guarda só a última resposta de cada chave.
    const hist = Array.isArray(t.run.escaladas_historico) ? t.run.escaladas_historico.filter((e) => e && typeof e.step === 'string') : [];
    const doHistorico = new Set(hist.map((e) => e.step));
    const linhas = [
      ...cps.filter(([step]) => !doHistorico.has(step)).map(([step, resposta]) => ({ step, resposta, em: em[step] })),
      ...hist.map((e) => ({ step: e.step, resposta: e.resposta, em: e.em })),
    ].sort((a, b) => String(a.em || '').localeCompare(String(b.em || '')));
    // O tipo que a métrica deu (ela lê os steps do pipeline, L20); sem medição, a régua do ledger.
    const tipoMedido = new Map((t.medicao && t.medicao.run && Array.isArray(t.medicao.run.paradas) ? t.medicao.run.paradas : []).map((p) => [p.id, p.tipo]));
    for (const { step, resposta, em: quando } of linhas) L.push(`| ${celula(step)} | ${tipoMedido.get(step) || tipoDaParada(step, ids)} | ${celula(quando) || 'carimbo ausente'} | ${decisaoDaResposta(resposta)} |`);
    L.push('');
    L.push(`O texto das respostas não vem para o pacote, porque resposta livre pode trazer nome de parte, de criança ou de testemunha. O registro completo fica no escritório, em \`${registro}\` (campo \`checkpoints\`).`);
  }
  L.push('');

  const reab = t.run && Array.isArray(t.run.reaberturas) ? t.run.reaberturas : [];
  if (reab.length) {
    L.push('## 3b. Revisões depois da entrega (run reaberto)');
    L.push('');
    L.push('A peça foi alterada depois de uma entrega aprovada, pelo caminho do run reaberto: o pedido do profissional virou fixes do redator, a versão seguinte passou pelos mesmos gates, e o pacote entregue antes está guardado em `anteriores/`. Nada foi editado à mão.');
    L.push('');
    L.push('| # | Reaberto em | Modo | Entrega anterior |');
    L.push('|---|---|---|---|');
    for (const r of reab) L.push(`| ${celula(r.numero)} | ${celula(r.em) || 'carimbo ausente'} | ${celula(r.modo)} | ${celula(r.versao_anterior) || '?'}${r.entregue_em ? ` (${celula(r.entregue_em)})` : ''} |`);
    L.push('');
    L.push(`O pedido de cada reabertura é texto livre do profissional e também fica fora do pacote: está em \`${registro}\` (campo \`reaberturas\`).`);
    L.push('');
  }

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

/**
 * O ANEXOS sem processo: a pasta é do cliente, nada está "já nos autos", e o que a peça cita vai
 * com ela (como anexo do contrato, documento da escritura, instrução do requerimento).
 */
function gerarAnexosSemProcesso(L, a, { citados, naoCitados, aJuntar, foraNaoCitados }) {
  L.push(`Cruzamento do índice dos documentos do cliente (${citados.length + naoCitados.length} documento(s)) com o texto de \`${a.artefato}\`. Critério: a peça cita o documento pelo número (Doc. NN), por uma página dele ou pelo nome do arquivo; o tipo do documento não basta. Sem processo, não há autos: todo documento citado acompanha a peça. É cruzamento textual: confira antes de assinar ou protocolar.`);
  L.push('');
  L.push('Cada documento aparece pelo número dele no índice (Doc. 01 é o primeiro da lista) e pelo tipo. O nome do arquivo não entra no pacote, porque pode trazer nome de parte ou de criança: a correspondência entre o número e o arquivo está no índice (`_index.yaml`), que fica no escritório.');
  L.push('');
  L.push('## A juntar com a peça');
  L.push('');
  if (!aJuntar.length) L.push('Nada a juntar: a peça não cita documento do cliente, e não há procuração no índice.');
  else {
    L.push('| Documento | Tipo | Páginas | Por quê |');
    L.push('|---|---|---|---|');
    for (const d of aJuntar) {
      const porque = d.motivo === 'mandato' ? 'procuração: acompanha a peça, citada ou não' : `citado na peça (${CASOU_POR[d.casou] || d.casou})`;
      L.push(`| ${numeroDoc(d)} | ${celula(d.tipo) || NAO_CONSTA} | ${celula(d.paginas) || NAO_CONSTA} | ${porque} |`);
    }
  }
  L.push('');
  if (foraNaoCitados.length) {
    L.push('## Não citados na peça (a decidir)');
    L.push('');
    tabelaADecidir(L, foraNaoCitados);
  }
  return L.join('\n');
}

// Sigilo (G13 da medição de 24/09/2026): o nome do arquivo dos autos pode trazer o
// nome de uma criança ("certidao-nascimento-helena") ou do cliente, e o ANEXOS.md vai
// no pacote. O documento sai pelo número (a posição no índice), o tipo e a folha; o
// nome real fica no índice dos autos, que é do escritório e não entra no pacote.
const NAO_CONSTA = 'não consta';
// O documento do PJe sai pelo Num. dele no PJe, que é como o processo o identifica.
const numeroDoc = (d) => (d.num ? `Num. ${d.num}` : `Doc. ${String(d.numero).padStart(2, '0')}`);
const CASOU_POR = { doc: 'Doc. NN', folha: 'folha', arquivo: 'nome do arquivo', pje: 'Num. do PJe' };

/** A tabela "a decidir"; o documento que a peça cita só para excluir leva a frase dela como nota. */
function tabelaADecidir(L, docs) {
  const comNota = docs.some((d) => d.excluido_pela_peca);
  L.push(comNota ? '| Documento | Tipo | Páginas | Nota |' : '| Documento | Tipo | Páginas |');
  L.push(comNota ? '|---|---|---|---|' : '|---|---|---|');
  for (const d of docs) {
    const nota = d.excluido_pela_peca ? `a peça o declara fora: "${truncar(d.excluido_pela_peca.replace(/\s+/g, ' '), 160)}"` : '';
    L.push(`| ${numeroDoc(d)} | ${celula(d.tipo) || NAO_CONSTA} | ${celula(d.paginas) || NAO_CONSTA} |${comNota ? ` ${celula(nota)} |` : ''}`);
  }
  L.push('');
}

export function gerarAnexos(a) {
  const L = [];
  L.push(`# Anexos: documentos a juntar · ${a.squad} · run ${a.runId}`);
  L.push('');
  const semProcesso = a.processo === 'nenhum';
  if (!a.indice) {
    L.push(AVISO_INDICE_AUSENTE(a.squadRel, { semProcesso }));
    L.push('');
    return L.join('\n');
  }
  const { citados, naoCitados } = a.cruzamento;
  const originaria = a.originaria === true;
  // Na inicial a ajuizar (`processo: a_ajuizar`), nada está nos autos: o processo nasce com ela.
  const { aJuntar, jaNosAutos, nosAutosNaoCitados, foraNaoCitados } = separarAnexos(a.cruzamento, { semProcesso: semProcesso || a.processo === 'a_ajuizar', originaria });
  if (semProcesso) return gerarAnexosSemProcesso(L, a, { citados, naoCitados, aJuntar, foraNaoCitados });
  L.push(originaria
    ? `Cruzamento do índice dos autos de origem (${citados.length + naoCitados.length} documento(s)) com o texto de \`${a.artefato}\`. Critério: a peça cita o documento pelo número (Doc. NN), por uma folha dele ou pelo nome do arquivo; o tipo do documento não basta. A peça é originária: abre processo novo, e todo documento que ela cita se junta, inclusive a cópia do que está nos autos de origem (a folha de lá identifica a cópia). É cruzamento textual: confira antes de protocolar.`
    : `Cruzamento do índice dos autos (${citados.length + naoCitados.length} documento(s)) com o texto de \`${a.artefato}\`. Critério: a peça cita o documento pelo número (Doc. NN), por uma folha dele ou pelo nome do arquivo; o tipo do documento não basta. Documento com folha no índice já está no processo e não se junta de novo; sem folha, conta como fora dos autos. É cruzamento textual: confira antes de protocolar.`);
  L.push('');
  L.push('Cada documento aparece pelo número dele no índice dos autos (Doc. 01 é o primeiro da lista), pelo tipo e pela folha. O nome do arquivo não entra no pacote, porque pode trazer nome de parte ou de criança: a correspondência entre o número e o arquivo está no índice dos autos (`_index.yaml`), que fica no escritório.');
  L.push('');
  if ([...citados, ...naoCitados].some((d) => d.num)) {
    L.push('O PDF integral do PJe entra separado nos documentos dele: cada um aparece pelo Num. do PJe e pela folha do PDF onde começa (a correspondência com o `Num. X - Pág. Y` do rodapé está no bloco `pje:` do índice). A peça cita pelo Num. ou pela folha.');
    L.push('');
  }
  L.push('## A juntar com a peça');
  L.push('');
  if (!aJuntar.length) L.push('Nada a juntar: todo documento que a peça cita já está nos autos, e não há procuração fora deles.');
  else {
    L.push('| Documento | Tipo | Páginas | Por quê |');
    L.push('|---|---|---|---|');
    for (const d of aJuntar) {
      const porque = d.motivo === 'mandato' ? 'procuração fora dos autos: acompanha a peça, citada ou não' : d.motivo === 'origem' ? `citado na peça (${CASOU_POR[d.casou] || d.casou}), cópia dos autos de origem (${folhaInicial(d) || 'folha não consta'})` : `citado na peça (${CASOU_POR[d.casou] || d.casou}), fora dos autos`;
      L.push(`| ${numeroDoc(d)} | ${celula(d.tipo) || NAO_CONSTA} | ${celula(d.paginas) || NAO_CONSTA} | ${porque} |`);
    }
  }
  L.push('');
  if (originaria) {
    // Sem "já nos autos": o processo que a peça abre não tem autos ainda.
    const origemNaoCitados = naoCitados.filter((d) => d.origem === 'autos' || (d.origem !== 'cliente' && /^(?:e-)?fls?\./.test(folhaInicial(d) || '')));
    L.push('## Nos autos de origem, não citados');
    L.push('');
    if (!origemNaoCitados.length) L.push('Nenhum.');
    else {
      L.push('| Documento | Tipo | Folha inicial | Páginas |');
      L.push('|---|---|---|---|');
      for (const d of origemNaoCitados) L.push(`| ${numeroDoc(d)} | ${celula(d.tipo) || NAO_CONSTA} | ${folhaInicial(d) || NAO_CONSTA} | ${celula(d.paginas) || NAO_CONSTA} |`);
    }
    L.push('');
    const origem = new Set(origemNaoCitados);
    const fora = foraNaoCitados.filter((d) => !origem.has(d));
    if (fora.length) {
      L.push('## Fora dos autos, não citados (a decidir)');
      L.push('');
      tabelaADecidir(L, fora);
    }
    return L.join('\n');
  }
  L.push('## Já nos autos, citados na peça (não se juntam de novo)');
  L.push('');
  if (!jaNosAutos.length) L.push('Nenhum.');
  else {
    L.push('| Documento | Tipo | Folha inicial | Páginas | Casou por |');
    L.push('|---|---|---|---|---|');
    for (const d of jaNosAutos) L.push(`| ${numeroDoc(d)} | ${celula(d.tipo) || NAO_CONSTA} | ${folhaInicial(d) || NAO_CONSTA} | ${celula(d.paginas) || NAO_CONSTA} | ${CASOU_POR[d.casou] || d.casou} |`);
  }
  L.push('');
  L.push('## Nos autos, não citados');
  L.push('');
  if (!nosAutosNaoCitados.length) L.push('Nenhum.');
  else {
    L.push('| Documento | Tipo | Folha inicial | Páginas |');
    L.push('|---|---|---|---|');
    for (const d of nosAutosNaoCitados) L.push(`| ${numeroDoc(d)} | ${celula(d.tipo) || NAO_CONSTA} | ${folhaInicial(d) || NAO_CONSTA} | ${celula(d.paginas) || NAO_CONSTA} |`);
  }
  L.push('');
  if (foraNaoCitados.length) {
    L.push('## Fora dos autos, não citados (a decidir)');
    L.push('');
    tabelaADecidir(L, foraNaoCitados);
  }
  return L.join('\n');
}

const RE_PRAZO = /prazo|data[\s-]*fatal|\bfatal\b|vencimento|tempestiv|dead-?line/i;
const PRAZO_FATAL_ARQUIVO = 'prazo-fatal.json';
const PRAZO_FATAL_MD = 'prazo-fatal.md';
/** A resposta do intake que diz não haver prazo em curso ("não há prazo processual", "sem prazo"). */
// "a peça não tem prazo" (L4, medição de 27/09/2026) não casava: só "não há", "sem", "nenhum".
const RE_SEM_PRAZO = /\b(?:n[ãa]o\s+(?:h[áa]|tem|possui|existe|corre|se\s+sujeita\s+a|est[áa]\s+sujeit[oa]\s+a)|sem|nenhum|inexiste)\s+(?:nenhum\s+)?prazo\b/i;
// A tese sobre prazo ("excesso de prazo", "prazo razoável da prisão") não é prazo para protocolar:
// o diagnóstico do HC a trazia, e o pacote lia o checkpoint como prazo em curso.
const RE_PRAZO_COMO_TESE = /\b(?:excesso|dilac[ãa]o|razoabilidade|razo[áa]vel\s+durac[ãa]o)\s+(?:de|do|da)\s+prazo\b|\bprazo\s+razo[áa]vel\b/gi;
const falaDePrazo = (texto) => RE_PRAZO.test(String(texto ?? '').replace(RE_PRAZO_COMO_TESE, ''));
const RE_DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * O `prazo-fatal.json` que a calculadora determinística da área grava (o squad o
 * declara como artefato). Achado no run de 15/09/2026: o step de triagem gravou o
 * prazo em `v1/prazo-fatal.json` e o pacote saiu com "prazo não informado", porque
 * o empacotador só lia os checkpoints. Procura da pasta da peça para fora
 * (`vN/` → pasta do run → `output/`), depois nas `vN/` irmãs da maior para a
 * menor (a mesma ordem do `squad-path --modo leitura`) e em `output/diagnostico/`.
 * Devolve `{ arquivo, dados }`, `{ arquivo, erro }` (presente mas ilegível ou sem
 * `data_limite`: é pendência, não ausência) ou `null`.
 */
function candidatosDoPrazo({ outputDir, artefatoPath }, nome) {
  const candidatos = [];
  const raizOutput = resolve(outputDir);
  const versoesDe = (pasta) => {
    let subpastas;
    try { subpastas = readdirSync(pasta, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name); } catch { subpastas = []; }
    return subpastas.sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))).map((v) => join(pasta, v));
  };
  let pasta = dirname(resolve(artefatoPath));
  while (pasta.startsWith(raizOutput)) {
    candidatos.push(join(pasta, nome));
    for (const v of versoesDe(pasta)) candidatos.push(join(v, nome));
    // A fase zero grava em `<run>/diagnostico/vN/` (o step de prazo do compilador escreve em
    // `output/diagnostico/`, que o runner resolve por run). Medido em 25/09/2026: o mandado de
    // segurança tinha `diagnostico/v1/prazo-fatal.json` e o pacote não o achava.
    const diag = join(pasta, 'diagnostico');
    candidatos.push(join(diag, nome));
    for (const v of versoesDe(diag)) candidatos.push(join(v, nome));
    if (pasta === raizOutput) break;
    pasta = dirname(pasta);
  }
  return [...new Set(candidatos)];
}

export function localizarPrazoFatal({ outputDir, artefatoPath }) {
  const arquivo = candidatosDoPrazo({ outputDir, artefatoPath }, PRAZO_FATAL_ARQUIVO).find((c) => existsSync(c));
  if (!arquivo) return null;
  const dados = lerJson(arquivo);
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return { arquivo, erro: 'JSON ilegível' };
  if (typeof dados.data_limite !== 'string' || !RE_DATA_ISO.test(dados.data_limite)) return { arquivo, erro: 'sem `data_limite` no formato AAAA-MM-DD' };
  return { arquivo, dados };
}

/**
 * A contagem de prazo que o squad gravou em texto (`prazo-fatal.md`, o artefato do step de prazo
 * que o compilador gera), quando não há `prazo-fatal.json`. O empacotador não lê data de texto: só
 * aponta o arquivo. Medido em 25/09/2026 (apelação, motor 0.9.50): a contagem dava a data-limite
 * no dia do run, e o pacote dizia "Nenhum prazo contado neste run".
 */
export function localizarContagemDePrazo({ outputDir, artefatoPath }) {
  return candidatosDoPrazo({ outputDir, artefatoPath }, PRAZO_FATAL_MD).find((c) => existsSync(c)) || null;
}

/**
 * O último ato que a identificação do caso registrou (`identificacao.json`): só a data e a folha.
 * O nome do ato é texto e pode trazer nome de parte; não vem para o pacote.
 */
export function ultimoAtoDaIdentificacao(squadDir) {
  const id = lerJson(join(squadDir, 'identificacao.json'));
  const ato = id && ehObjeto(id.ultimo_ato) ? id.ultimo_ato : null;
  if (!ato || typeof ato.data !== 'string' || !RE_DATA_ISO.test(ato.data)) return null;
  const folha = typeof ato.folha === 'string' && /^(?:e-)?fls?\.\s*\d+(?:\s*(?:-|a)\s*\d+)?$/i.test(ato.folha.trim()) ? ato.folha.trim() : null;
  return { data: ato.data, folha };
}

const dataBr = (iso) => (typeof iso === 'string' && RE_DATA_ISO.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);

export function gerarProximosPassos(p) {
  const L = [];
  // Entrega interna (parecer, relatório, boletim, roteiro): nada se protocola nem se junta.
  const interna = typeof p.deliveryType === 'string' && p.deliveryType !== '' && p.deliveryType !== 'legal-draft';
  L.push(`# Próximos passos · ${p.squad} · run ${p.runId}`);
  L.push('');
  L.push('## Prazo');
  L.push('');
  const pf = p.prazoFatal || null;
  if (pf && pf.dados) {
    const d = pf.dados;
    const regra = [
      Number.isInteger(d.prazo_dias) ? `${d.prazo_dias} dia(s)` : null,
      typeof d.contagem === 'string' ? d.contagem : null,
      typeof d.inicio_contagem === 'string' ? `contados de ${dataBr(d.inicio_contagem)}` : typeof d.data_intimacao === 'string' ? `marco ${dataBr(d.data_intimacao)}` : null,
      d.prazo_dobro === true ? 'em dobro' : null,
      d.prorrogado_por_dia_nao_util === true ? 'prorrogado por dia não útil' : null,
    ].filter(Boolean).join('; ');
    L.push(`- **Data-limite: ${dataBr(d.data_limite)}**, transcrita de \`${pf.arquivoRel}\` (motor determinístico da área${regra ? `: ${regra}` : ''}). O empacotador **não calcula** prazo: confira o marco e a contagem.`);
    if (typeof p.geradoEm === 'string' && p.geradoEm.slice(0, 10) > d.data_limite) {
      L.push(`- **ATENÇÃO: a data-limite (${dataBr(d.data_limite)}) é anterior à data deste pacote (${dataBr(p.geradoEm.slice(0, 10))}).** Ou o prazo já venceu, ou o marco está errado; conferir antes de qualquer ${interna ? 'ato' : 'protocolo'}.`);
    }
    const avisos = Array.isArray(d.avisos) ? d.avisos.filter((a) => typeof a === 'string' && a.trim()) : [];
    for (const a of avisos) L.push(`  - aviso do motor: ${a.trim()}`);
  } else if (pf && pf.erro) {
    L.push(`- **Prazo a conferir: \`${pf.arquivoRel}\` existe, mas ${pf.erro}.** O run tentou registrar o prazo e o registro não é legível; não ${interna ? 'use a data' : 'protocole'} sem refazer a contagem pelo motor da área.`);
  }
  const cps = p.run && ehObjeto(p.run.checkpoints) ? Object.entries(p.run.checkpoints) : [];
  const em = p.run && ehObjeto(p.run.checkpoints_em) ? p.run.checkpoints_em : {};
  const comPrazo = cps.filter(([step, resposta]) => falaDePrazo(step) || falaDePrazo(resposta));
  // Sem prazo contado, a seção fala a língua do advogado: se o intake disse que não há prazo em
  // curso, é isso que se diz; o arquivo que o motor não gravou não é problema de ninguém. Medido na
  // negativação de 24/09/2026 (motor 0.9.49): petição inicial sem prazo processual ("Prazo: não há
  // prazo processual") e o pacote dizia "nenhum `prazo-fatal.json` no run", como se faltasse algo.
  const semPrazoEmCurso = comPrazo.some(([, resposta]) => RE_SEM_PRAZO.test(String(resposta ?? '')));
  // Sem `prazo-fatal.json`, a contagem em texto do squad e o último ato da identificação dizem ao
  // advogado onde está o prazo, sem transcrever texto livre (medido em 25/09/2026, apelação com a
  // data-limite no dia do run e o pacote dizendo "Nenhum prazo contado neste run").
  const ato = p.ultimoAto ? `${dataBr(p.ultimoAto.data)}${p.ultimoAto.folha ? ` (${p.ultimoAto.folha})` : ''}` : null;
  // A peça originária abre processo novo: o último ato dos autos de origem não é marco de prazo.
  const originaria = p.originaria === true;
  const contagem = !pf && p.contagemDePrazo && !semPrazoEmCurso ? p.contagemDePrazo : null;
  if (contagem) {
    // Contagem em texto é o registro do step de prazo quando a área não tem calculadora para ele (a
    // defesa administrativa, com duas leituras de contagem): não é falta. Medido em 26/09/2026 (motor
    // 0.9.58): o pacote dizia "sem o registro prazo-fatal.json", como se o run tivesse pulado algo.
    L.push(`- **Prazo em curso: a data-limite está na contagem do run, em \`${contagem}\`.** O pacote não transcreve data de texto (só a que a calculadora da área registra): abra o arquivo e confira a data-limite, e a leitura adotada quando houver mais de uma, antes de qualquer outro item. Se ela for hoje ou já tiver passado, ${interna ? 'o ato' : 'o protocolo'} vem antes de tudo.`);
    if (ato) L.push(`- Último ato registrado na identificação do caso: ${ato}. É o marco a conferir na contagem.`);
  }
  if (originaria && !pf && !contagem) {
    L.push(`- Peça originária: abre processo novo, e não há prazo do último ato a contar para o protocolo.${semPrazoEmCurso || !comPrazo.length ? '' : ' Se o intake registrou prazo de outra natureza, ele está no registro abaixo.'} A urgência, quando houver, é a do caso, registrada no intake.`);
    if (comPrazo.length && !semPrazoEmCurso) {
      L.push(`- Leia o que ${comPrazo.length === 1 ? 'este checkpoint registrou' : 'estes checkpoints registraram'} sobre prazo, em \`${p.squadRel || `squads/${p.squad}`}/run-state.json\` (campo \`checkpoints\`). A resposta não vem para o pacote, porque texto livre pode trazer nome de parte ou de testemunha.`);
      for (const [step] of comPrazo) L.push(`  - \`${step}\`${em[step] ? `, registrado em ${em[step]}` : ''}`);
    }
  } else if (!comPrazo.length) {
    if (!pf && !contagem) L.push(`- Nenhum prazo contado neste run (${PRAZO_NAO_INFORMADO}). Se houver prazo em curso, conte-o antes de ${interna ? 'agir' : 'protocolar'}: o pacote **não calcula** prazo.`);
    if (!pf && !contagem && ato) L.push(`- Último ato registrado na identificação do caso: ${ato}.`);
  } else {
    // O que o profissional disse sobre prazo fica no ledger do escritório: a
    // resposta é texto livre e traz nome de parte junto (ver `decisaoDaResposta`).
    const registro = `${p.squadRel || `squads/${p.squad}`}/run-state.json`;
    if (!pf && semPrazoEmCurso) L.push('- Sem prazo processual em curso, pelo que o intake registrou: não há data-limite a conferir neste pacote.');
    else if (!pf && !contagem) {
      L.push(`- **Prazo em curso, sem data-limite registrada no run:** o intake registrou prazo, e o run não gravou a contagem. Conte o prazo${ato ? ` a partir do último ato registrado na identificação do caso, ${ato},` : ''} antes de ${interna ? 'agir' : 'protocolar'}. O pacote **não calcula** prazo.`);
    }
    L.push(`- ${pf ? 'Confira a data-limite acima contra o que' : semPrazoEmCurso ? 'Se o caso mudou, releia o que' : 'Leia o que'} ${comPrazo.length === 1 ? 'este checkpoint registrou' : 'estes checkpoints registraram'} sobre prazo, em \`${registro}\` (campo \`checkpoints\`). A resposta não vem para o pacote, porque texto livre pode trazer nome de parte ou de testemunha.`);
    for (const [step] of comPrazo) L.push(`  - \`${step}\`${em[step] ? `, registrado em ${em[step]}` : ''}`);
  }
  L.push('');
  const semProcesso = p.processo === 'nenhum';
  L.push(interna ? '## Antes de entregar' : semProcesso ? '## Antes de assinar ou protocolar' : '## Antes de protocolar');
  L.push('');
  if (contagem) L.push(`- [ ] Conferir a data-limite em \`${contagem}\` antes de ${interna ? 'entregar' : 'protocolar'}.`);
  if (interna) L.push(`- [ ] Revisar o documento (\`${p.docx}\`) e entregá-lo só após revisão humana: é entrega interna (${p.deliveryType}), não peça a assinar nem a levar ao processo.`);
  else if (semProcesso) L.push(`- [ ] Revisar a peça (\`${p.docx}\`); assinar, levar a registro ou protocolar só após revisão humana.`);
  else L.push(`- [ ] Revisar e assinar a peça (\`${p.docx}\`); protocolar após revisão humana.`);
  if (p.pendencias.length) L.push(`- [ ] Resolver as ${p.pendencias.length} pendência(s) marcadas no artefato (linhas ${p.pendencias.map((x) => x.linha).join(', ')}); ver TERMO-DE-CONFERENCIA.md §4.`);
  else L.push('- [x] Nenhum marcador de pendência no artefato.');
  if (!p.manifesto) L.push('- [ ] Rodar o Citation Gate: manifesto ausente, nenhuma citação foi conferida.');
  else if (p.manifesto.ilegivel) L.push('- [ ] Refazer o Citation Gate: manifesto ilegível.');
  else if (!p.manifesto.hashConfere) L.push('- [ ] Refazer o Citation Gate: a peça mudou depois da conferência (hash diverge).');
  else if (p.citacoesProblema) L.push(`- [ ] Resolver ${p.citacoesProblema} citação(ões) não verificada(s) listadas no termo.`);
  else L.push('- [x] Citações conferidas (manifesto do Citation Gate confere com a peça).');
  if (!p.anexos.indice) L.push(`- [ ] Gerar o índice ${semProcesso ? 'dos documentos do cliente' : 'dos autos'} e listar os anexos: ${AVISO_INDICE_AUSENTE(p.squadRel, { semProcesso })}.`);
  else if (interna) {
    const citados = p.anexos.cruzamento.citados || [];
    L.push(citados.length ? `- [x] Entrega interna: nada se junta; ${citados.length === 1 ? 'o documento citado está' : `os ${citados.length} documentos citados estão`} em ANEXOS.md, para consulta (${citados.map(numeroDoc).join(', ')}).` : '- [x] Entrega interna: nada se junta.');
  } else {
    const { aJuntar, jaNosAutos, foraNaoCitados } = separarAnexos(p.anexos.cruzamento, { semProcesso, originaria });
    if (aJuntar.length) L.push(`- [ ] Juntar com a peça ${aJuntar.length === 1 ? 'o documento' : `os ${aJuntar.length} documentos`} de ANEXOS.md, seção "A juntar com a peça" (${aJuntar.map(numeroDoc).join(', ')})${originaria ? ', inclusive a cópia do que está nos autos de origem: a peça abre processo novo' : ''}.`);
    else L.push(semProcesso ? '- [x] Nada a juntar: a peça não cita documento do cliente (ANEXOS.md).' : originaria ? '- [x] Nada a juntar: a peça não cita documento do índice (ANEXOS.md).' : '- [x] Nada a juntar: o que a peça cita já está nos autos (ANEXOS.md).');
    if (jaNosAutos.length) L.push(`  - ${jaNosAutos.length} documento(s) citado(s) na peça já estão nos autos e não se juntam de novo.`);
    if (foraNaoCitados.length) L.push(`- [ ] Decidir sobre ${foraNaoCitados.length} documento(s) ${semProcesso ? 'do cliente' : 'fora dos autos'} que a peça não cita (ANEXOS.md).`);
  }
  if (p.pdf.gerado) L.push(`- [ ] Conferir o PDF (\`${p.pdf.arquivo}\`) antes ${interna ? 'da entrega' : semProcesso ? 'da assinatura ou do protocolo' : 'do protocolo'}.`);
  else L.push(`- [ ] PDF não gerado: ${p.pdf.motivo}; gerar quando houver LibreOffice, ou ${interna ? 'entregar o .docx' : semProcesso ? 'usar o .docx conforme quem recebe o ato' : 'protocolar o .docx conforme o sistema do tribunal'}.`);
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
  // Run reaberto depois da entrega: o pacote entregue antes fica guardado em
  // `anteriores/r<N>/` (a entrega anterior é prova do que o profissional aprovou),
  // e o pacote da raiz passa a ser o da revisão corrente. Sem reabertura, a pasta
  // é regravada inteira, idempotente por run_id, como sempre foi.
  const reaberturas = run && Array.isArray(run.reaberturas) ? run.reaberturas : [];
  if (reaberturas.length && existsSync(pacoteDir)) {
    const anteriores = join(pacoteDir, 'anteriores');
    const n = reaberturas.length;
    const guardado = join(anteriores, `r${n}`);
    if (!existsSync(guardado)) {
      mkdirSync(anteriores, { recursive: true });
      for (const e of readdirSync(pacoteDir, { withFileTypes: true })) {
        if (e.name === 'anteriores') continue;
        renameSync(join(pacoteDir, e.name), join(mkdirIfNeeded(guardado), e.name));
      }
    }
    for (const e of readdirSync(pacoteDir, { withFileTypes: true })) if (e.name !== 'anteriores') rmSync(join(pacoteDir, e.name), { recursive: true, force: true });
  } else {
    rmSync(pacoteDir, { recursive: true, force: true }); // idempotente por run_id: a pasta é regravada inteira
  }
  mkdirSync(pacoteDir, { recursive: true });

  const base = basename(artefatoPath, extname(artefatoPath));
  const nomeDocx = `${base}.docx`;
  // A nota ao revisor (status, matriz, riscos: o que o contrato de saída da skill pede)
  // sai da peça protocolada e vai à parte. Medido em 25/09/2026, alimentos/reclamação: a
  // "Nota técnica ao advogado revisor" estava no .docx e no .pdf do pacote. Bloco mal
  // formado não se adivinha: o pacote não sai com metade da nota dentro da peça.
  const separada = separarNotaAoRevisor(texto);
  if (separada.erro) throw new ErroReal(`${basename(artefatoPath)}: ${separada.erro}; a nota ao revisor não sai da peça, e o pacote não foi gerado`);
  // O documento que vai à contraparte (a proposta dentro do roteiro interno) sai em arquivo próprio:
  // medido no m4 de 01/10/2026 (motor 0.9.80), a minuta da proposta à rede saiu no mesmo .docx do
  // roteiro sigiloso, com a faixa e o limite do cliente. O bloco é o que a peça delimita entre
  // <!-- para-a-contraparte:inicio --> e <!-- para-a-contraparte:fim -->.
  const marcaContraparte = /^[ \t]*<!--\s*para-a-contraparte:(inicio|fim)\s*-->[ \t]*\r?$/;
  const linhasDaPeca = separada.peca.split('\n');
  const paraContraparte = [];
  let naContraparte = false;
  for (const l of linhasDaPeca) {
    const m = l.match(marcaContraparte);
    if (m) { naContraparte = m[1] === 'inicio'; continue; }
    if (naContraparte) paraContraparte.push(l);
  }
  if (naContraparte) throw new ErroReal(`${basename(artefatoPath)}: bloco para-a-contraparte aberto e nunca fechado; o pacote não foi gerado`);
  // A linha de status de trabalho sai do documento entregável e vai à nota ao revisor.
  const comStatus = separarLinhaDeStatus(linhasDaPeca.filter((l) => !marcaContraparte.test(l)).join('\n'));
  const textoDaPeca = comStatus.peca;
  writeFileSync(join(pacoteDir, nomeDocx), await markdownParaDocx(textoDaPeca, estiloInfo.estilo, { titulo: base }));
  let docContraparte = null;
  if (paraContraparte.join('').trim()) {
    docContraparte = `${base}-para-a-contraparte`;
    writeFileSync(join(pacoteDir, `${docContraparte}.md`), `${paraContraparte.join('\n').trim()}\n`);
    writeFileSync(join(pacoteDir, `${docContraparte}.docx`), await markdownParaDocx(paraContraparte.join('\n'), estiloInfo.estilo, { titulo: docContraparte }));
  }
  // Os anexos que a final diz trazer e o `manifesto-final` resolveu (`<final>.anexos.json`): vão ao
  // pacote. Medido em 01/10/2026: a contingência do m2 ("segue anexa como arquivo próprio") e o
  // Anexo I do m3 ficaram fora do pacote.
  const anexosDaFinal = lerJson(`${artefatoPath}.anexos.json`);
  const anexosLevados = [];
  for (const [k, a] of (anexosDaFinal && Array.isArray(anexosDaFinal.anexos) ? anexosDaFinal.anexos : []).entries()) {
    const origem = [resolve(raiz, a.arquivo), resolve(a.arquivo)].find((c) => existsSync(c));
    if (!origem) throw new ErroReal(`${basename(artefatoPath)}: o anexo "${a.referencia}" (${a.arquivo}) que a final diz trazer não existe; o pacote não foi gerado`);
    const nome = `ANEXO-${String(k + 1).padStart(2, '0')}-${basename(origem)}`;
    writeFileSync(join(pacoteDir, nome), readFileSync(origem));
    anexosLevados.push({ referencia: a.referencia, arquivo: nome });
  }
  const notaAoRevisor = separada.nota || comStatus.status.length ? 'NOTA-AO-REVISOR.md' : null;
  if (notaAoRevisor) {
    const status = comStatus.status.length ? `## Linha de status de trabalho\n\nEstava no alto da minuta; não integra o documento entregue (o .docx e o .pdf saem sem ela).\n\n${comStatus.status.map((l) => `> ${l}`).join('\n')}\n\n` : '';
    writeFileSync(join(pacoteDir, notaAoRevisor), `# Nota ao revisor · ${basename(artefatoPath)}\n\nMaterial de revisão que a minuta trouxe no bloco \`nota-ao-revisor\` (o que o contrato de saída da skill pede). Não integra a peça a protocolar: o .docx e o .pdf saem sem ele.\n\n${status}${separada.nota || ''}\n`);
  }

  let pdf;
  if (semPdf) pdf = { gerado: false, motivo: '--sem-pdf', arquivo: null };
  else {
    const soffice = localizarSoffice(env);
    pdf = soffice ? converterPdf({ soffice, docxPath: join(pacoteDir, nomeDocx), outDir: pacoteDir }) : { gerado: false, motivo: 'LibreOffice ausente', arquivo: null };
  }

  const manifesto = localizarManifesto(artefatoPath, artefatoBuffer);
  // A métrica mede a MESMA peça que o pacote embrulha (G22): sem isto, somava as
  // pendências dos arquivos de apoio e da fase zero no termo.
  const medicao = medirSquad(dir, { agora, runId: runParaBusca, artefato: artefatoPath });
  const pendencias = pendenciasDoArtefato(texto);
  const citacoesProblema = manifesto && manifesto.dados && Array.isArray(manifesto.dados.citations)
    ? manifesto.dados.citations.filter((c) => !citacaoConferida(c && c.status)).length
    : 0;

  const termo = gerarTermo({
    squad: squadNome, runId: runIdFinal, geradoEm, squadRel,
    artefato: { nome: basename(artefatoPath), docx: nomeDocx, sha256: sha256(artefatoBuffer) },
    estilo: estiloInfo, pdf, manifesto, medicao, run, pendencias, notaAoRevisor,
  });
  writeFileSync(join(pacoteDir, 'TERMO-DE-CONFERENCIA.md'), termo);
  const estiloTermo = { ...estiloInfo.estilo, paragrafo: { ...estiloInfo.estilo.paragrafo, entrelinha: 1, recuo_primeira_linha_cm: 0 } };
  writeFileSync(join(pacoteDir, 'TERMO-DE-CONFERENCIA.docx'), await markdownParaDocx(termo, estiloTermo, { titulo: 'Termo de conferência', quebraDePagina: false }));

  // Os autos do squad ou, por `caso.json`, os da pasta do caso (bloco `autos-path`).
  const indicePath = join(pastaDeAutos(dir), '_index.yaml');
  const anexos = { indice: null, indiceSha256: null, cruzamento: { citados: [], naoCitados: [] } };
  if (existsSync(indicePath)) {
    const bruto = readFileSync(indicePath);
    anexos.indice = relative(dir, indicePath);
    anexos.indiceSha256 = sha256(bruto);
    anexos.cruzamento = cruzarAnexos(lerIndiceAutos(bruto.toString('utf8')), textoDaPeca);
  }
  const processo = processoDoSquad(dir);
  const originaria = originariaDoSquad(dir);
  writeFileSync(join(pacoteDir, 'ANEXOS.md'), gerarAnexos({ squad: squadNome, runId: runIdFinal, squadRel, artefato: basename(artefatoPath), processo, originaria, ...anexos }));
  const prazoBruto = localizarPrazoFatal({ outputDir, artefatoPath });
  const prazoFatal = prazoBruto ? { ...prazoBruto, arquivoRel: relative(dir, prazoBruto.arquivo) } : null;
  const contagemBruta = prazoFatal ? null : localizarContagemDePrazo({ outputDir, artefatoPath });
  writeFileSync(join(pacoteDir, 'PROXIMOS-PASSOS.md'), gerarProximosPassos({
    squad: squadNome, runId: runIdFinal, squadRel, run, pendencias, manifesto, citacoesProblema, anexos, pdf, docx: nomeDocx, prazoFatal, geradoEm, processo, originaria, deliveryType: deliveryTypeDoSquad(dir),
    contagemDePrazo: contagemBruta ? relative(dir, contagemBruta) : null, ultimoAto: ultimoAtoDaIdentificacao(dir),
  }));

  // Só arquivos: `anteriores/` (pacotes de entregas anteriores, no run reaberto)
  // não entra no manifesto do pacote corrente; ler a pasta como arquivo dava EISDIR.
  const arquivos = readdirSync(pacoteDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name !== 'MANIFESTO.json').map((e) => e.name).sort().map((n) => {
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
    // O número de cada documento no ANEXOS.md é a posição no índice: o hash diz de
    // qual índice, para um índice regerado depois (documento novo no meio) não
    // mudar em silêncio o que "Doc. 05" quer dizer.
    anexos: anexos.indice ? { indice_sha256: anexos.indiceSha256, documentos: anexos.cruzamento.citados.length + anexos.cruzamento.naoCitados.length } : null,
    prazo_fatal: prazoFatal ? { arquivo: prazoFatal.arquivoRel, data_limite: prazoFatal.dados ? prazoFatal.dados.data_limite : null, erro: prazoFatal.erro || null } : null,
    pdf,
    arquivos,
  };
  writeFileSync(join(pacoteDir, 'MANIFESTO.json'), `${JSON.stringify(manifestoPacote, null, 2)}\n`);

  return { pacoteDir, runId: runIdFinal, artefato: artefatoPath, docx: nomeDocx, pdf, estilo: manifestoPacote.estilo, ...(docContraparte ? { para_a_contraparte: `${docContraparte}.docx` } : {}), ...(anexosLevados.length ? { anexos_da_final: anexosLevados } : {}), arquivos: [...arquivos.map((a) => a.nome), 'MANIFESTO.json'], pendencias: pendencias.length, prazo_fatal: manifestoPacote.prazo_fatal };
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
