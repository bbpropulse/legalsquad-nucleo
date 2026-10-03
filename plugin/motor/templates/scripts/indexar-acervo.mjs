#!/usr/bin/env node
// Indexador do acervo do LegalSquad.
// Varre acervo/ e (re)gera acervo/_index.yaml — o catálogo que os agentes de
// pesquisa consultam ANTES da web (best-practice `pesquisa-jurisprudencial`).
// Uso: npm run indexar-acervo
//      node scripts/indexar-acervo.js --root /caminho/do/projeto [--strict]
// A pasta acervo/casos/ é IGNORADA (dados sensíveis de cliente — LGPD/sigilo).
//
// A raiz é parametrizável porque o pack-apply (F3) instala o pacote de área no
// projeto do USUÁRIO e precisa reindexar lá, não dentro do pacote. Sem `--root`
// o default é a pasta que contém este script — o comportamento antigo, intacto.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `--root DIR`, `--root=DIR` ou o primeiro argumento posicional. Flags conhecidas
// (--strict) nunca são confundidas com raiz.
function raizDosArgumentos(argv, padrao) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) {
        console.error('--root exige um diretório.');
        process.exit(1);
      }
      return resolve(argv[i + 1]);
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) {
        console.error('--root exige um diretório.');
        process.exit(1);
      }
      return resolve(value);
    }
    if (!arg.startsWith('-')) return resolve(arg);
  }
  return padrao;
}

// Opções para o DEPÓSITO da máquina (src/deposito.js), que indexa cada pacote de
// acervo uma vez, na origem, em vez de cada projeto reindexar 60 mil julgados:
//   --acervo DIR       a pasta de acervo a varrer (no lugar de <raiz>/acervo)
//   --subarvore REL    varre só essa subpasta, mas grava os caminhos relativos
//                      à pasta de acervo (ex.: `_packs/acervo.x/...`)
//   --saida ARQUIVO    onde gravar (no lugar de <acervo>/_index.yaml)
function opcao(argv, nome) {
  const i = argv.indexOf(nome);
  if (i !== -1) return argv[i + 1] ? resolve(argv[i + 1]) : null;
  const prefixo = `${nome}=`;
  const arg = argv.find((a) => a.startsWith(prefixo));
  return arg ? resolve(arg.slice(prefixo.length)) : null;
}
// As opções do depósito levam valor; `raizDosArgumentos` não pode confundir o
// valor delas com a raiz posicional (`--root` continua sendo dele).
const OPCOES_DO_DEPOSITO = ['--acervo', '--subarvore', '--saida'];
function argvSemOpcoesDoDeposito(argv) {
  const fora = [];
  for (let i = 0; i < argv.length; i++) {
    if (OPCOES_DO_DEPOSITO.includes(argv[i])) { i++; continue; }
    if (OPCOES_DO_DEPOSITO.some((o) => argv[i].startsWith(`${o}=`))) continue;
    fora.push(argv[i]);
  }
  return fora;
}

const ARGV = process.argv.slice(2);
const PROJETO = raizDosArgumentos(argvSemOpcoesDoDeposito(ARGV), join(__dirname, '..'));
const ROOT = opcao(ARGV, '--acervo') || join(PROJETO, 'acervo');
const SUBARVORE = (() => { const i = ARGV.indexOf('--subarvore'); if (i !== -1) return ARGV[i + 1] || null; const a = ARGV.find((x) => x.startsWith('--subarvore=')); return a ? a.slice('--subarvore='.length) : null; })();
const SAIDA = opcao(ARGV, '--saida') || join(ROOT, '_index.yaml');
const VAULT_MAP = join(PROJETO, '_legalsquad', '_memory', 'vault-map.yaml');

const STRICT = ARGV.includes('--strict'); // CI: falha (exit 1) se houver wikilink quebrado

// Fail-closed com diagnóstico: raiz errada é o erro mais provável de quem passa
// `--root`, e um stack de ENOENT não diz qual pasta faltou.
if (!existsSync(ROOT)) {
  console.error(`Pasta de acervo não existe: ${ROOT}`);
  console.error('Passe --root <diretório do projeto> ou crie o acervo antes de indexar.');
  process.exit(1);
}

const SKIP_DIRS = new Set(['casos']); // sigilo de cliente — nunca indexar
const TIPO_POR_PASTA = {
  jurisprudencia: 'jurisprudencia',
  doutrina: 'doutrina',
  legislacao: 'legislacao',
  sumulas: 'sumula',
  teses: 'tese',
  'teses-modelos': 'modelo',
};
const EXT_OK = new Set(['.md', '.pdf', '.txt', '.docx', '.rtf']);
// Formatos binários: se houver um .md irmão (mesmo nome), indexa só o .md legível
// (os agentes leem markdown; o .docx fica como fonte original não indexada).
const PREFER_MD_OVER = new Set(['.docx', '.rtf']);
// Packs de acervo do SPEC (docs/specs/acervo-server/SPEC.md) chegam como
// `.jsonl.zst` — um contêiner comprimido de N documentos, não um documento.
// Este indexador ainda NÃO sabe abri-los (é trabalho do F3). Até lá eles são
// reportados, nunca silenciados: "não sei ler" ≠ "não existe".
const EXT_PACK = ['.jsonl.zst'];
const ehPack = (nome) => EXT_PACK.some((suf) => nome.toLowerCase().endsWith(suf));
const packsEncontrados = [];
// VERIFIED_OFFICIAL_OCR: o documento veio da fonte oficial, mas o texto foi lido
// por OCR (PDF digitalizado) e pode ter erro de leitura; a citação literal se
// confere na fonte. Sem esse valor, quem gravou um acórdão escaneado só tinha
// VERIFIED_OFFICIAL, que promete texto fiel, ou a quarentena (medido em
// 24/09/2026: um agente se autocertificou como VERIFIED_OFFICIAL).
const CONFIANCA_VALIDA = new Set(['VERIFIED_OFFICIAL', 'VERIFIED_OFFICIAL_OCR', 'DISCOVERY_ONLY', 'QUARANTINED']);
// As duas confianças "oficiais" só valem com prova: a URL da fonte oficial e a
// data da consulta. Sem elas, a declaração é palavra de quem gravou, e o índice
// rebaixa para DISCOVERY_ONLY com aviso (o arquivo não é tocado).
const CONFIANCA_OFICIAL = new Set(['VERIFIED_OFFICIAL', 'VERIFIED_OFFICIAL_OCR']);

// Situação do verbete (vigente, cancelada, superada, revogada, parcialmente cancelada, alterada):
// cópia do bloco canônico de src/situacao-acervo.js. O índice grava `situacao` quando o arquivo a
// declara (campo do frontmatter ou marca no corpo); sem sinal, não grava nada e o verbete é vigente.
// O Citation Gate lê o campo: súmula cancelada não sai VERIFICADA (a 228 do TST saía, 29/09/2026).
// >>> situacao-acervo:begin
/** Os valores que o campo `situacao` aceita (frontmatter do acervo e entrada do índice). */
const SITUACOES_DO_ACERVO = new Set(['vigente', 'cancelada', 'superada', 'revogada', 'parcialmente_cancelada', 'alterada']);
/** Situação que tira o verbete do fundamento: a citação não se verifica por ele. */
const SITUACOES_QUE_IMPEDEM = new Set(['cancelada', 'superada', 'revogada']);
/** Situação que deixa o verbete de pé, com a ressalva de conferir o trecho ou a redação citada. */
const SITUACOES_COM_AVISO = new Set(['parcialmente_cancelada', 'alterada']);

const MARCAS_DA_SITUACAO = [
  [/^PARCIALMENTE\s+CANCELAD[AO]S?\b/u, 'parcialmente_cancelada'],
  [/^CANCELAD[AO]S?\b/u, 'cancelada'],
  [/^SUPERAD[AO]S?\b/u, 'superada'],
  [/^REVOGAD[AO]S?\b/u, 'revogada'],
  [/^(?:ALTERAD|REVISAD|MODIFICAD)[AO]S?\b/u, 'alterada'],
];

/** `"Parcialmente cancelada"`, `parcialmente-cancelada` → `parcialmente_cancelada`. */
function normalizarSituacao(valor) {
  return String(valor ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
}

/**
 * O primeiro parágrafo depois do título `## <nome>` (linhas juntas por espaço, até a linha em branco
 * ou o próximo título), ou ''. Parágrafo, não linha: o livro antigo do TST quebra a nota da fonte no
 * meio ("(cancelada por perda de eficácia a partir de 11.11.2017, pela Lei" / "13.467/2017) – Res.").
 */
function primeiroParagrafoDaSecao(linhas, nome) {
  const i = linhas.findIndex((l) => nome.test(l));
  if (i < 0) return '';
  const partes = [];
  for (const linha of linhas.slice(i + 1)) {
    if (/^#{1,6}\s/.test(linha)) break;
    const limpa = linha.replace(/^[\s>*_]+/, '').trim();
    if (!limpa) {
      if (partes.length) break;
      continue;
    }
    partes.push(limpa);
  }
  return partes.join(' ');
}

// A nota do livro do TST abre o parêntese com a palavra da situação ("(mantida)", "(nova redação)",
// "(cancelada)", "(item I cancelado ...)"); parêntese de título ("(REFLEXOS)") não é nota. Vale a
// ÚLTIMA nota do parágrafo: "(nova redação) - Res. 121/2003 ... (cancelada em decorrência ...) -
// Res. 129/2005" é a súmula que ganhou redação nova e depois foi cancelada. A nota que o livro
// antigo deixou sem fechar no fim do parágrafo ("(cancelada por perda de eficácia ..., pela Lei") vale.
const NOTA_DO_LIVRO = /\(((?:mantida|cancelad[ao]|cancelamento|nova\s+reda[çc][ãa]o|reda[çc][ãa]o|alterad[ao]|atualizad[ao]|incorporad[ao]s?|convers[ãa]o|ite(?:m|ns)|republicad[ao]|aglutinad[ao])\b[^()]*)(?:\)|$)/giu;

/**
 * A situação que o arquivo declara. Devolve `{ situacao, origem, invalida }`: `situacao` é um dos
 * `SITUACOES_DO_ACERVO` ou null (nada declarado: vigente por padrão); `origem` diz de onde veio
 * (`frontmatter`, `situacao`, `fonte`); `invalida` traz o valor do frontmatter que não é situação
 * conhecida (ignorado, e o corpo decide).
 */
function situacaoDoTexto(texto) {
  const raw = String(texto ?? '').replace(/^\uFEFF/, '');
  let invalida = null;
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw.slice(0, 8192));
  if (fm) {
    const linha = /^situacao:[ \t]*(.*?)[ \t]*$/m.exec(fm[1]);
    const valor = linha ? normalizarSituacao(linha[1]) : '';
    if (valor && SITUACOES_DO_ACERVO.has(valor)) return { situacao: valor, origem: 'frontmatter', invalida: null };
    if (valor && valor !== 'null' && valor !== '~') invalida = linha[1].trim();
  }
  const corpo = fm ? raw.slice(fm.index + fm[0].length) : raw;
  const linhas = corpo.split(/\r?\n/);
  const naSituacao = primeiroParagrafoDaSecao(linhas, /^#{2,6}\s+Situa[çc][ãa]o\s*$/iu);
  for (const [marca, situacao] of MARCAS_DA_SITUACAO) {
    if (marca.test(naSituacao)) return { situacao, origem: 'situacao', invalida };
  }
  const naFonte = primeiroParagrafoDaSecao(linhas, /^#{2,6}\s+Fonte\s+de\s+publica[çc][ãa]o\s*$/iu);
  const notas = [...naFonte.matchAll(NOTA_DO_LIVRO)];
  const nota = notas.length ? notas[notas.length - 1][1].trim() : '';
  // "cancelada" sozinha, ou seguida de "por"/"em" ("por perda de eficácia", "em decorrência da sua
  // incorporação"): "cancelada a parte final da antiga redação" é histórico de súmula vigente.
  if (/^(?:cancelad[ao]|cancelamento\s+mantido)(?=$|[\s,;]+(?:por|em|a\s+partir)\b)/iu.test(nota)) return { situacao: 'cancelada', origem: 'fonte', invalida };
  if (/^ite(?:m|ns)\b.*\bcancelad[oa]s?\b/iu.test(nota)) return { situacao: 'parcialmente_cancelada', origem: 'fonte', invalida };
  return { situacao: null, origem: null, invalida };
}

/**
 * A frase que acompanha a situação na saída de quem consome o índice: "súmula cancelada: não
 * fundamente nela" (o que impede) ou o aviso de conferir o trecho (o que só ressalva).
 */
function mensagemDaSituacao(situacao, { sumula = true } = {}) {
  const s = normalizarSituacao(situacao);
  if (SITUACOES_QUE_IMPEDEM.has(s)) {
    return sumula ? `súmula ${s}: não fundamente nela` : `precedente ${s.replace(/a$/, 'o')}: não fundamente nele`;
  }
  if (s === 'parcialmente_cancelada') return 'súmula parcialmente cancelada: confira no documento se o item citado continua vigente';
  if (s === 'alterada') return 'súmula com redação alterada: cite a redação vigente, a do documento';
  return '';
}
// <<< situacao-acervo:end
// O indexador só lê a situação; o que ela impede é o gate que decide.
void SITUACOES_COM_AVISO;
void mensagemDaSituacao;

function frontmatterDe(full) {
  if (extname(full).toLowerCase() !== '.md') return {};
  let raw;
  try { raw = readFileSync(full, 'utf8'); } catch { return {}; }
  const lida = situacaoDoTexto(raw);
  const situacao = { situacao: lida.situacao, situacaoInvalida: lida.invalida };
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return situacao;
  const value = (key) => {
    const found = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return found ? found[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  return {
    confianca: value('confianca'),
    urlOficial: value('url_oficial'),
    consultadoEm: value('consultado_em'),
    // `area_presumida: true` diz que a ÁREA do julgado é palpite de heurística
    // por termo, não declaração da fonte. Sem o campo no índice, busca e
    // cobertura tratam palpite e declaração como a mesma coisa — e num acervo
    // real isso significava reportar 2.905 julgados de direito administrativo
    // quando 1.007 tinham a área declarada.
    areaPresumida: value('area_presumida') === 'true',
    proximaRevalidacao: value('proxima_revalidacao'),
    ...situacao,
  };
}

function provenienciaDe(full) {
  const fm = frontmatterDe(full);
  const declarada = fm.confianca;
  const semProva = CONFIANCA_OFICIAL.has(declarada) && (!fm.urlOficial || !fm.consultadoEm) ? declarada : null;
  return {
    confianca: semProva ? 'DISCOVERY_ONLY'
      : CONFIANCA_VALIDA.has(declarada) ? declarada : (declarada ? 'QUARANTINED' : 'DISCOVERY_ONLY'),
    oficialSemProva: semProva,
    urlOficial: fm.urlOficial,
    consultadoEm: fm.consultadoEm,
    proximaRevalidacao: fm.proximaRevalidacao,
    areaPresumida: fm.areaPresumida,
    classificacaoInvalida: declarada && !CONFIANCA_VALIDA.has(declarada) ? declarada : null,
    situacao: fm.situacao || null,
    situacaoInvalida: fm.situacaoInvalida || null,
  };
}

/**
 * Tipo pelo nome da pasta — pulando o prefixo do pacote sincronizado.
 *
 * `acervo/` é do usuário; a única subárvore que o sync pode gravar é
 * `acervo/_packs/<pack_id>/` (ver `EXCECOES_GERENCIADAS` em pack-format). Lá
 * dentro a estrutura se REPETE — `jurisprudencia/`, `legislacao/`, `sumulas/` —,
 * então classificar pelo primeiro segmento devolvia `outro` para todo julgado
 * baixado. Ele existiria no disco e ficaria invisível para quem busca
 * jurisprudência: o `verificador-citacoes` consulta por tipo, e "não achei"
 * viraria "não existe" sobre conteúdo recém-instalado.
 */
function tipoDe(rel) {
  const partes = rel.split('/');
  // `_packs/<pack_id>/<tipo>/...` — dois segmentos de prefixo gerenciado.
  const inicio = partes[0] === '_packs' && partes.length > 2 ? 2 : 0;
  return TIPO_POR_PASTA[partes[inicio]] || 'outro';
}

// Tema (o H1) e identificador (o `processo:` do frontmatter: "Súmula 54",
// "REsp 1.132.866/SP", "Tema 1.234") de um .md, numa leitura só. O
// identificador é o que o verificador de citações procura ("existe a Súmula 54
// do STJ?"), e o nome do arquivo o traz zero-preenchido ou nem o traz: sem
// este campo a busca por número não acha o verbete que está no disco.
function cabecalhoDe(full, rel) {
  const fallback = basename(rel).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  if (extname(full).toLowerCase() !== '.md') return { tema: fallback, processo: null, tribunal: null };
  let c;
  try {
    c = readFileSync(full, 'utf8');
  } catch {
    return { tema: fallback, processo: null, tribunal: null };
  }
  const h = c.match(/^#\s+(.+)$/m);
  const tema = h ? h[1].trim().replace(/\s+/g, ' ').slice(0, 140) : fallback;
  const fm = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(c.slice(0, 8192));
  const campo = (nome) => {
    const linha = fm && new RegExp(`^${nome}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(fm[1]);
    if (!linha) return null;
    const valor = linha[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
    return valor && valor !== 'null' && valor !== '~' ? valor.slice(0, 80) : null;
  };
  // O tribunal completa o identificador: "Súmula 54" só é a Súmula 54 do STJ
  // junto com `tribunal: STJ-SUM`; sem ele, "Súmula 54 STJ" casa qualquer 54.
  // O informativo (`informativo: "0876"`) e o tema repetitivo (no título:
  // "Tema 1282", "Tema n. 220", "Tema Repetitivo 1.234") também identificam: o
  // verificador pergunta "Informativo 876" e "Tema 1282" tanto quanto "REsp".
  const informativo = (campo('informativo') || campo('boletim') || '').replace(/^0+(?=\d)/, '') || null;
  const temaRep = /\bTema\s+(?:Repetitivo\s+)?(?:n\.?\s*)?(\d[\d.]*)/i.exec(`${tema} ${campo('assunto') || ''}`);
  return { tema, processo: campo('processo'), tribunal: campo('tribunal'), informativo, temaRepetitivo: temaRep ? temaRep[1].replace(/\./g, '') : null };
}

function tagsDe(rel) {
  const stop = new Set(['crime', 'transversal', 'as', 'de', 'da', 'do', 'e', 'em', 'os', 'principais']);
  return [...new Set(
    basename(rel).replace(/\.[^.]+$/, '').toLowerCase().split(/[-_\s]+/)
      .filter((w) => w.length > 2 && !stop.has(w)),
  )].slice(0, 8);
}

// Extrai os alvos de wikilinks [[Nota]], [[Nota|alias]], [[Nota#trecho]],
// [[pasta/Nota]] de um arquivo .md. O lookbehind (?<!!) ignora embeds de mídia
// ![[arquivo.png]], que apontam para anexos e não para notas.
const WIKILINK_RE = /(?<!!)\[\[([^\]]+)\]\]/g;
function wikilinksDe(full) {
  let raw;
  try { raw = readFileSync(full, 'utf8'); } catch { return []; }
  const out = [];
  for (const m of raw.matchAll(WIKILINK_RE)) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

// True se há um vault Obsidian configurado (vault-map.yaml com vault_root não-vazio).
// Quando há, wikilinks não encontrados no acervo podem viver no vault (privado),
// então não são tratados como quebrados — apenas informados.
function vaultConfigured() {
  try {
    const m = readFileSync(VAULT_MAP, 'utf8').match(/^\s*vault_root:\s*["']?([^"'\n]*)/m);
    return !!(m && m[1].trim());
  } catch {
    return false;
  }
}

function walk(dir, acc) {
  const entries = readdirSync(dir, { withFileTypes: true });
  // Nomes-base que já têm versão .md neste diretório (para preferir o legível).
  const temMd = new Set(
    entries
      .filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.md')
      .map((e) => e.name.slice(0, -3)),
  );
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    const rel = relative(ROOT, full).split(/[/\\]/).join('/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      // Pacote de acervo já indexado na origem (depósito da máquina): o índice
      // dele viaja com o pacote em `_packs/<pack>/_index.yaml`; a busca soma os
      // dois. Reindexar 60 mil julgados por projeto era o custo que isso tira.
      if (!SUBARVORE && /^_packs\/[^/]+$/.test(rel) && existsSync(join(full, '_index.yaml'))) {
        packsComIndiceProprio.push({ rel, indice: join(full, '_index.yaml'), arquivos: contagemDoIndice(join(full, '_index.yaml')) });
        continue;
      }
      walk(full, acc);
      continue;
    }
    if (ehPack(e.name)) {
      packsEncontrados.push(rel);
      continue;
    }
    const ext = extname(e.name).toLowerCase();
    if (!EXT_OK.has(ext) || e.name === '_index.yaml' || e.name === 'README.md') continue;
    // .docx/.rtf com .md irmão → pula o binário, indexa só o .md.
    if (PREFER_MD_OVER.has(ext) && temMd.has(e.name.slice(0, -ext.length))) continue;
    const { tema, processo, tribunal, informativo, temaRepetitivo } = cabecalhoDe(full, rel);
    acc.push({
      path: rel,
      tipo: tipoDe(rel),
      tema,
      processo,
      tribunal,
      informativo,
      temaRepetitivo,
      tags: tagsDe(rel),
      links: ext === '.md' ? wikilinksDe(full) : [],
      ...provenienciaDe(full),
    });
  }
}

const packsComIndiceProprio = [];
function contagemDoIndice(caminho) {
  try {
    const m = /# Última indexação: (\d+) arquivos/.exec(readFileSync(caminho, 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

const entries = [];
if (SUBARVORE) {
  const inicio = join(ROOT, ...SUBARVORE.split('/'));
  if (!existsSync(inicio)) {
    console.error(`Subárvore não existe: ${inicio}`);
    process.exit(1);
  }
  walk(inicio, entries);
} else {
  walk(ROOT, entries);
}
entries.sort((a, b) => a.path.localeCompare(b.path));

let y = '# Índice do Acervo: GERADO por `npm run indexar-acervo` (não editar à mão; será sobrescrito).\n';
y += '# NÃO leia este arquivo inteiro (passa do limite da ferramenta Read): use `npx legalsquad search-acervo --query "<REsp 1.234.567/SP | Súmula 54 STJ | Tema 1282 | Informativo 876 STJ | tema livre>" --json` ou Grep pelo número.\n';
y += '# Os agentes de pesquisa consultam este índice ANTES da web. Pasta casos/ é omitida (sigilo).\n';
y += '# Confiança: VERIFIED_OFFICIAL exige declaração explícita; ausência = DISCOVERY_ONLY.\n';
y += '# VERIFIED_OFFICIAL_OCR = fonte oficial com texto lido por OCR (confira o trecho literal na fonte). As duas exigem url_oficial e consultado_em.\n';
y += `# Última indexação: ${entries.length} arquivos.\n\n`;
y += 'acervo:\n';
for (const it of entries) {
  y += `  - path: ${it.path}\n`;
  y += `    tipo: ${it.tipo}\n`;
  y += `    tema: ${JSON.stringify(it.tema)}\n`;
  if (it.processo) y += `    processo: ${JSON.stringify(it.processo)}\n`;
  if (it.tribunal) y += `    tribunal: ${JSON.stringify(it.tribunal)}\n`;
  if (it.informativo) y += `    informativo: ${JSON.stringify(it.informativo)}\n`;
  if (it.temaRepetitivo) y += `    tema_repetitivo: ${JSON.stringify(it.temaRepetitivo)}\n`;
  if (it.situacao) y += `    situacao: ${it.situacao}\n`;
  y += `    tags: [${it.tags.join(', ')}]\n`;
  y += `    confianca: ${it.confianca}\n`;
  if (it.oficialSemProva) y += `    confianca_declarada_sem_prova: ${it.oficialSemProva}\n`;
  if (it.areaPresumida) y += '    area_presumida: true\n';
  if (it.urlOficial) y += `    url_oficial: ${JSON.stringify(it.urlOficial)}\n`;
  if (it.consultadoEm) y += `    consultado_em: ${JSON.stringify(it.consultadoEm)}\n`;
  if (it.proximaRevalidacao) y += `    proxima_revalidacao: ${JSON.stringify(it.proximaRevalidacao)}\n`;
}
// Quem lê só este arquivo (os agentes fazem Grep em `acervo/_index.yaml` por
// `tema:`/`tags:`; não chamam `search-acervo`) precisa ver os julgados dos
// pacotes também. As entradas dos índices de pacote (gerados na origem, no
// depósito) entram aqui COPIADAS, sem revarrer os arquivos; a busca e a
// cobertura sabem que a entrada do pacote vence a repetida.
const entradasDePacotes = [];
for (const p of packsComIndiceProprio) {
  let texto;
  try { texto = readFileSync(p.indice, 'utf8'); } catch { continue; }
  const corpo = texto.split('\n').filter((l) => l && !l.startsWith('#') && l !== 'acervo:').join('\n');
  if (corpo) entradasDePacotes.push(`# --- ${p.rel} (índice do pacote, gerado no depósito; ${p.arquivos} arquivos) ---\n${corpo}`);
}
if (entradasDePacotes.length) y += `${entradasDePacotes.join('\n')}\n`;
writeFileSync(SAIDA, y, 'utf8');
const somaDosPacotes = packsComIndiceProprio.reduce((n, p) => n + p.arquivos, 0);
console.log(`Indexados ${entries.length} arquivos em ${relative(PROJETO, SAIDA).split(/[/\\]/).join('/') || SAIDA}`
  + (packsComIndiceProprio.length ? ` (+ ${somaDosPacotes} em ${packsComIndiceProprio.length} índice(s) de pacote do depósito, já prontos)` : ''));
if (packsEncontrados.length) {
  console.warn(
    `Atenção: ${packsEncontrados.length} pack(s) de acervo (.jsonl.zst) NÃO foram indexados: o indexador ainda não abre packs:`,
  );
  for (const p of packsEncontrados) console.warn(`  - ${p}`);
  console.warn('O conteúdo deles existe, mas está invisível para a busca. Não trate como acervo vazio.');
}
const oficiaisSemProva = entries.filter((it) => it.oficialSemProva);
if (oficiaisSemProva.length) {
  console.warn(`Atenção: ${oficiaisSemProva.length} arquivo(s) se declaram oficiais sem url_oficial e consultado_em; entraram no índice como DISCOVERY_ONLY:`);
  for (const it of oficiaisSemProva) console.warn(`  - ${it.path}: ${it.oficialSemProva}`);
  console.warn('Para valer como oficial, grave a URL do documento oficial e a data da consulta no frontmatter. Texto lido por OCR vai como VERIFIED_OFFICIAL_OCR.');
}
// Sigilo (P6 do teste com autos reais de 27/09/2026): o pesquisador gravou em 18 registros do acervo
// o code do squad, que trazia parte do nome da cliente. O acervo é do escritório e serve a todos os
// casos: registro que traz o code de um squad deste projeto ou o nome de uma pasta de caso
// (`casos/<nome>`) é recusado aqui (saída 1), com o caminho, para a pesquisa trocar pelo id do run.
// A linha `tags:` fica de fora (tag é assunto, e um code genérico pode coincidir com ela); nomes
// com menos de 5 letras também (`hc` casaria com qualquer texto). O arquivo não é tocado.
function nomesDoProjeto() {
  const nomes = new Set();
  for (const pasta of ['squads', 'casos']) {
    const dir = join(PROJETO, pasta);
    if (!existsSync(dir)) continue;
    let itens;
    try { itens = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of itens) if (e.isDirectory() && !/^[._]/.test(e.name) && e.name.length >= 5) nomes.add(e.name.toLowerCase());
  }
  return [...nomes];
}
const nomesDeCaso = SUBARVORE ? [] : nomesDoProjeto();
const comNomeDeCaso = [];
if (nomesDeCaso.length) {
  const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^a-z0-9-])(${nomesDeCaso.map(escapar).join('|')})(?:[^a-z0-9-]|$)`);
  for (const it of entries) {
    if (it.path.startsWith('_packs/') || !/\.(?:md|txt)$/i.test(it.path)) continue;
    let texto;
    try { texto = readFileSync(join(ROOT, it.path), 'utf8'); } catch { continue; }
    const m = texto.toLowerCase().split('\n').filter((l) => !/^\s*tags:/.test(l)).join('\n').match(re);
    if (m) comNomeDeCaso.push({ path: it.path, nome: m[1] });
  }
}
if (comNomeDeCaso.length) {
  console.error(`SIGILO: ${comNomeDeCaso.length} registro(s) do acervo trazem o code de um squad ou o nome de uma pasta de caso deste projeto:`);
  for (const it of comNomeDeCaso) console.error(`  - ${it.path}: «${it.nome}»`);
  console.error('O acervo é do escritório e serve a todos os casos: troque a origem pelo id do run (`run: "<id do run>"`), sem code de squad, nome de parte ou do caso, e rode de novo.');
  process.exitCode = 1;
}

// Situação que o frontmatter declara fora dos valores aceitos: o índice a ignora (e fica com a marca
// do corpo, se houver), e o aviso diz qual arquivo corrigir. Não trava: o verbete continua achável.
const situacoesInvalidas = entries.filter((it) => it.situacaoInvalida);
if (situacoesInvalidas.length) {
  console.warn(`Atenção: ${situacoesInvalidas.length} arquivo(s) declaram \`situacao\` fora dos valores aceitos (${[...SITUACOES_DO_ACERVO].join(', ')}); o índice seguiu a marca do corpo, se houver:`);
  for (const it of situacoesInvalidas) console.warn(`  - ${it.path}: ${it.situacaoInvalida}`);
}

const classificacoesInvalidas = entries.filter((it) => it.classificacaoInvalida);
if (classificacoesInvalidas.length) {
  console.error('Classificações de confiança inválidas foram colocadas em QUARANTINED:');
  for (const it of classificacoesInvalidas) console.error(`  - ${it.path}: ${it.classificacaoInvalida}`);
  process.exitCode = 1;
}

// --- Validação de wikilinks (saúde do grafo de conhecimento) ---
// Confere cada [[link]] do acervo contra as notas existentes. Links não
// resolvidos são "quebrados" — exceto quando há vault Obsidian configurado,
// caso em que podem viver no vault (privado, não indexado).
// Normaliza p/ comparação: minúsculas + remove SÓ extensões conhecidas (não um
// ponto qualquer — nomes jurídicos têm pontos: "Lei 11.343", "HC 126.292").
const norm = (s) => {
  const lower = s.toLowerCase();
  const ext = extname(lower);
  return EXT_OK.has(ext) ? lower.slice(0, -ext.length) : lower;
};
const known = new Set();
for (const it of entries) {
  known.add(norm(basename(it.path))); // por nome de nota
  known.add(norm(it.path)); // por caminho relativo
}
// Notas dos pacotes com índice próprio (não revarridos) também são alvos válidos.
for (const p of packsComIndiceProprio) {
  let texto;
  try { texto = readFileSync(p.indice, 'utf8'); } catch { continue; }
  for (const m of texto.matchAll(/^\s*-\s*path:\s*(.+)$/gm)) {
    const caminho = m[1].trim();
    known.add(norm(basename(caminho)));
    known.add(norm(caminho));
  }
}
const broken = [];
let totalLinks = 0;
for (const it of entries) {
  for (const link of it.links || []) {
    totalLinks++;
    const byName = norm(link.split(/[/\\]/).pop());
    const byPath = norm(link);
    if (!known.has(byName) && !known.has(byPath)) broken.push({ from: it.path, link });
  }
}

if (totalLinks > 0) {
  if (broken.length === 0) {
    console.log(`Wikilinks: ${totalLinks} verificados, 0 quebrados.`);
  } else if (vaultConfigured()) {
    console.log(`Wikilinks: ${totalLinks} verificados, ${broken.length} fora do acervo (vault configurado; podem estar no vault):`);
    for (const b of broken) console.log(`  - ${b.from} → [[${b.link}]]`);
  } else {
    console.log(`Wikilinks: ${totalLinks} verificados, ${broken.length} QUEBRADOS:`);
    for (const b of broken) console.log(`  - ${b.from} → [[${b.link}]]`);
    if (STRICT) process.exitCode = 1;
  }
}
