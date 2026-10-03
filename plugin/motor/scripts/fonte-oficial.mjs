#!/usr/bin/env node
// Fonte oficial por código: baixa as fontes que a peça cita, guarda a cópia
// local com hash, resolve registro e inteiro teor do STJ e reabre pela fonte
// registrada para dizer se mudou. O verificador de citações lê a cópia local;
// o LLM fica só com o juízo de fidelidade.
//
//   node scripts/fonte-oficial.mjs --pesquisa <pesquisa.md> [--peca <minuta.md>] --out <dir>
//   node scripts/fonte-oficial.mjs --fontes <tabela.json|manifesto.json|https://...> --out <dir>
//   node scripts/fonte-oficial.mjs --stj "AgRg no HC 1.054.751/SC" [--out <dir>] [--json]
//   node scripts/fonte-oficial.mjs --reabrir <manifesto.json|tabela.json> --out <dir> --json
//
// Navegação guiada (o chefe conduz, passo a passo, até a página oficial; o caminho vira receita):
//   node scripts/fonte-oficial.mjs --navegar --objetivo "<o que achar>" --url <início oficial> --out <dir>
//        [--tipo <tipo de fonte>] [--param nome=valor ...] [--max-passos 12] [--max-tempo 300] [--decisor chefe|ollama]
//   node scripts/fonte-oficial.mjs --passo <sessão> --clicar N | --digitar N "texto" | --enviar N |
//        --selecionar N "opção" | --voltar | --ler [parte] | --procurar "texto" | --gravar [--reconhece "<regex>"] [--url-da-fonte <url>] | --fechar
//   node scripts/fonte-oficial.mjs --receita <id|arquivo.json> --param nome=valor --out <dir>
//   node scripts/fonte-oficial.mjs --listar-receitas
//
// Opções: --cache <dir> (padrão acervo/_fontes) · --forcar (ignora o cache) ·
//   --playwright auto|on|off (padrão auto) · --playwright-modulo <caminho do pacote> ·
//   --espera <ms> (entre pedidos ao mesmo host; padrão 2000) · --timeout <ms> · --json ·
//   --receitas-dir <dir> (padrão acervo/_receitas; `off` desliga as receitas)
//
// Escada de motores: fetch com cabeçalhos de navegador → Playwright headless só
// diante de gateway ou desafio de JavaScript → `acesso_falhou` imediato em captcha
// ou login. Captcha e credencial não se resolvem nunca. Um pedido por vez.
// Cada acesso vira uma linha em `<out>/INDEX.jsonl`, para auditoria.
// `--stj` só aceita o documento cujo bloco "Processo" e cujo cabeçalho de inteiro teor
// casam com a citação (recursos internos, classe, número, UF, registro); fora disso é
// `acesso_falhou` com `processo-nao-localizado-na-pagina` ou `processo-divergente`.
//
// `--reabrir` grava a cópia nova em `<out>/reabertura/<sha1>.<data>.<ext>` e nunca por cima da
// registrada; compara pelo texto extraído (ou pelo PDF sem os metadados voláteis, ou pelo trecho),
// nunca só pelos bytes; e a linha do índice leva o resultado real (verificada, verificada_no_acervo,
// fonte_mudou, acesso_falhou, sem_evidencia, cancelada). Resposta vazia, página de erro e documento de outro
// processo são `acesso_falhou` com motivo, nunca `ok`.
//
// Sai com 0 quando tudo abriu, 1 quando alguma fonte ficou `acesso_falhou` ou
// `fonte_mudou`, ou (na reabertura) `cancelada` no acervo (o chamador decide o que fazer),
// 2 em erro de uso.

import { createHash, X509Certificate } from 'node:crypto';
import { connect as conectarTls, rootCertificates } from 'node:tls';
import { request as pedirHttps } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { join, basename, extname, resolve, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Situação do verbete no acervo (cancelada, superada, revogada...): cópia VERBATIM de
// src/situacao-acervo.js. A reabertura no acervo não confirma súmula que a cópia declara
// fora do fundamento (guardada por scripts/sync-blocos.mjs).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Lógica de acesso e hash — cópia VERBATIM de src/fonte-oficial.js.
// Este script é distribuído ao usuário (templates/scripts/) e roda num projeto
// que NÃO tem src/ — por isso a lógica é embutida em vez de importada. A cópia
// é guardada por scripts/sync-blocos.mjs: se divergir, a suíte quebra.
// ---------------------------------------------------------------------------
// >>> fonte-oficial:begin
const UA_NAVEGADOR = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const HOSTS_OFICIAIS = [/\.jus\.br$/i, /\.gov\.br$/i, /\.leg\.br$/i];
const MAX_REDIRECIONAMENTOS = 6;
const ESPERA_PADRAO_MS = 2000;
const TIMEOUT_PADRAO_MS = 45000;

/** Classes do STJ que a página de resultados aceita em `classe=`; o que vem antes ("AgRg no", "EDcl no") é ignorado. */
// EAREsp (embargos de divergência em agravo em recurso especial): o teste de ponta a ponta de
// 30/09/2026 não achou o EAREsp 1.883.876-RS porque a sigla não era reconhecida.
const CLASSES_STJ = { HC: 'HC', RHC: 'RHC', RESP: 'RESP', ARESP: 'ARESP', ERESP: 'ERESP', EARESP: 'EARESP', RMS: 'RMS', MS: 'MS', CC: 'CC', PET: 'PET', MC: 'MC', AI: 'AI' };

const ehHostOficial = (host) => HOSTS_OFICIAIS.some((re) => re.test(String(host || '')));

function sha256(dados) {
  return createHash('sha256').update(dados).digest('hex');
}

function sha1(texto) {
  return createHash('sha1').update(String(texto)).digest('hex');
}

/** Texto comparável: NFC, sem caractere de controle, espaço colapsado. É o que o hash de texto assina. */
function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- tirar o caractere de controle é justamente o serviço: ele entra no hash e faz a mesma página parecer outra
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Páginas de tribunal ainda vêm em ISO-8859-1; decodificar como UTF-8 estraga acento e hash.
 * O charset do cabeçalho Content-Type manda; sem ele, o `<meta>` das primeiras linhas. Sem
 * nenhum, os bytes decidem: UTF-8 quando são UTF-8 válido, Windows-1252 quando não são.
 * Medido na medição de 24/09/2026: o Planalto (Lei 12.016/2009, CLT compilada) serve
 * ISO-8859-1 sem declarar charset em lugar nenhum; lido como UTF-8, todo acento virava
 * U+FFFD no `.txt`, o trecho com acento que o verificador copiou do `.html` não era mais
 * achado, e a reabertura deu "fonte mudou" falso em 6 citações da Lei 12.016.
 */
function decodificarHtml(buffer, contentType = '') {
  const cabeca = buffer.subarray(0, 4096).toString('latin1');
  const doCabecalho = String(contentType || '').match(/charset=["']?([\w-]+)/i)?.[1];
  const declarado = (doCabecalho || cabeca.match(/charset=["']?([\w-]+)/i)?.[1] || '').toLowerCase();
  if (declarado) return buffer.toString(/^(iso-8859-1|latin1|windows-1252|cp1252)$/.test(declarado) ? 'latin1' : 'utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try { return new TextDecoder('windows-1252').decode(buffer); } catch { return buffer.toString('latin1'); }
  }
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ordm: 'º', ordf: 'ª', sect: '§' };
const decodificarEntidades = (texto) => texto
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&([a-z]+);/gi, (m, e) => ENTIDADES[e.toLowerCase()] ?? m);

const TAGS_RISCADO = new Set(['strike', 's', 'del']);
const TAGS_VAZIAS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr', 'col', 'area', 'base', 'source']);
const RE_LINE_THROUGH = /text-decoration[\w-]*\s*:[^;"'>]*line-through/i;

/**
 * Texto da página, com o que ela risca marcado no lugar exato: `⟦riscado: …⟧`.
 *
 * Medido na medição de 24/09/2026 (contestação trabalhista): a CLT compilada do Planalto
 * risca a redação revogada com `<strike>` ou com `text-decoration: line-through`, e apagar a
 * tag deixava a expressão revogada do art. 791-A, § 4º, no `.txt` como se fosse vigente. O
 * avesso também foi medido: um script improvisado marcou [RISCADO] o parágrafo inteiro do
 * art. 840, § 3º, e do art. 223-G, § 1º, onde o risco cobre só a âncora vazia do dispositivo.
 * Por isso a marca cobre exatamente o texto riscado, e riscado sem letra nem número (âncora,
 * espaço) não marca nada. Página sem risco dá o mesmo texto de antes, byte a byte.
 */
function textoDeHtml(html) {
  const limpo = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const abertos = new Map(); // nome da tag → quantas estão abertas
  const riscos = []; // { nome, nivel } de cada elemento que risca e ainda não fechou
  let saida = '';
  let riscado = '';
  const fecharRisco = () => {
    if (!riscado) return;
    const interno = normalizarTexto(riscado);
    saida += /[\p{L}\p{N}]/u.test(interno) ? ` ⟦riscado: ${interno}⟧ ` : riscado;
    riscado = '';
  };
  const emitir = (pedaco) => { if (riscos.length) riscado += pedaco; else saida += pedaco; };
  for (const parte of limpo.split(/(<[^>]+>)/)) {
    if (!parte) continue;
    if (parte[0] !== '<' || parte.length < 2) { emitir(decodificarEntidades(parte)); continue; }
    emitir(' ');
    const m = parte.match(/^<\s*(\/)?\s*([a-z][\w-]*)/i);
    if (!m) continue;
    const nome = m[2].toLowerCase();
    if (TAGS_VAZIAS.has(nome) || /\/\s*>$/.test(parte)) continue;
    const fechar = (nivel) => {
      const eraRiscado = riscos.length > 0;
      for (let i = riscos.length - 1; i >= 0; i -= 1) if (riscos[i].nome === nome && riscos[i].nivel >= nivel) riscos.splice(i, 1);
      if (eraRiscado && !riscos.length) fecharRisco();
    };
    if (m[1]) {
      const nivel = abertos.get(nome) || 0;
      if (nivel > 0) abertos.set(nome, nivel - 1);
      fechar(nivel);
      continue;
    }
    // `<p>` não se aninha: um novo parágrafo fecha o anterior, mesmo sem `</p>`.
    if (nome === 'p' && abertos.get('p')) { fechar(0); abertos.set('p', 0); }
    const nivel = (abertos.get(nome) || 0) + 1;
    abertos.set(nome, nivel);
    if (TAGS_RISCADO.has(nome) || RE_LINE_THROUGH.test(parte)) riscos.push({ nome, nivel });
  }
  fecharRisco();
  return normalizarTexto(saida);
}

/** `pdftotext` (poppler) quando existe; `LEGALSQUAD_PDFTOTEXT` aponta o binário, `0` desliga. */
function detectarPdftotext() {
  const env = process.env.LEGALSQUAD_PDFTOTEXT;
  if (env !== undefined) return ['0', 'nao', 'off', ''].includes(env.trim().toLowerCase()) ? null : env;
  const r = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  return r.error ? null : 'pdftotext';
}

function textoDePdf(buffer, pdftotext) {
  if (!pdftotext) return null;
  const r = spawnSync(pdftotext, ['-layout', '-', '-'], { input: buffer, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return normalizarTexto(r.stdout);
}

/** URLs `https://` de fonte oficial num texto (pesquisa, tabela, manifesto), sem repetição, sem a pontuação que fecha a frase. */
function extrairUrls(texto) {
  const vistas = new Set();
  const urls = [];
  for (const m of String(texto || '').matchAll(/https:\/\/[^\s<>"'`)\]]+/g)) {
    let url = m[0].replace(/[.,;:!?*]+$/g, '');
    try {
      const u = new URL(url);
      if (!ehHostOficial(u.hostname)) continue;
      url = u.toString();
    } catch { continue; }
    if (vistas.has(url)) continue;
    vistas.add(url);
    urls.push(url);
  }
  return urls;
}

function urlsDeCitacoes(objeto) {
  const lista = Array.isArray(objeto?.citations) ? objeto.citations : Array.isArray(objeto) ? objeto : [];
  // http:// passa aqui de propósito: `baixar` o recusa com motivo (nao-https) e o índice registra, em vez de a fonte sumir em silêncio
  return lista.map((c) => c && c.source_url).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
}

// --- classificação da resposta ---------------------------------------------

const RE_CAPTCHA = /g-recaptcha|hcaptcha|cf-chl|challenge-platform|__cf_chl|Just a moment|turnstile/i;
/**
 * O script de detecção que o Cloudflare injeta em TODA página que ele serve
 * (`/cdn-cgi/challenge-platform/scripts/jsd/main.js`), com o conteúdo inteiro ao lado. Não é
 * desafio: medido em 27/09/2026 (negativação, motor 0.9.61, L22), a página de temas repetitivos
 * do STJ abriu com o Tema 59 e o REsp 1.083.291/RS na tela, o `challenge-platform` do script casou
 * o padrão de captcha, e a pesquisa citou o repetitivo sem o número do Tema "por captcha".
 */
const RE_DETECCAO_CLOUDFLARE = /\/cdn-cgi\/challenge-platform\/scripts\/jsd\/[^'"\s<]*/gi;
const ehCaptcha = (amostra) => RE_CAPTCHA.test(amostra.replace(RE_DETECCAO_CLOUDFLARE, ' '));
const RE_LOGIN = /type=["']?password/i;
const RE_ESAJ_GATEWAY = /sajcas\/verificarLogin\.js|usuarioLogadoNoCasServer/i;
const RE_JS_CHALLENGE_COOKIE = /document\.cookie\s*=\s*["']__?(?:test|challenge)/i;
// "Essa pagina depende do javascript para abrir, favor habilitar o javascript do seu browser!" é o
// casco do site do Banco Central (medido na negativação de 24/09/2026: 114 caracteres de texto,
// gravados `ok` no índice e no cache do acervo). O padrão antigo só via "habilite o JavaScript".
const RE_AVISO_DE_JAVASCRIPT = /enable JavaScript|JavaScript (?:is )?(?:required|disabled)|habilit(?:e|ar) o JavaScript|ative o JavaScript|depende do JavaScript/i;
/** Letras e números visíveis abaixo dos quais uma página que pede JavaScript não tem conteúdo próprio. */
const TEXTO_MINIMO_DE_PAGINA = 400;

/**
 * Desafio de JavaScript é página que só pede o navegador: o cookie de teste plantado por script,
 * ou o aviso "habilite o JavaScript" numa página sem conteúdo visível fora do `<noscript>`.
 * Medido na medição de 24/09/2026 (defeito 14): o "Livro de Súmulas" do TST abre com fetch
 * (200, 213 KB, portal Liferay com 4 mil caracteres de texto), e o `<noscript>` "habilite o
 * JavaScript no seu navegador" do rodapé casava o padrão: o índice gravou `acesso_falhou:
 * js-challenge` numa página que abriu, nos runs da contestação e da reclamação.
 */
function ehDesafioJs(amostra) {
  if (RE_JS_CHALLENGE_COOKIE.test(amostra)) return true;
  if (!RE_AVISO_DE_JAVASCRIPT.test(amostra)) return false;
  const visivel = textoDeHtml(amostra.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '));
  return (visivel.match(/[\p{L}\p{N}]/gu) || []).length < TEXTO_MINIMO_DE_PAGINA;
}

/**
 * O que dizer quando falta o navegador: o `package.json` do projeto (templates/package.json) já
 * declara o `playwright`, e o `init` instala o Chromium quando roda sem `--skip-deps`.
 */
const INSTRUCAO_PLAYWRIGHT = 'Para abrir por código página com desafio de JavaScript, instale o Playwright na pasta do projeto: rode `npm install` (o package.json do projeto já declara o playwright) e `npx playwright install chromium`, e repita o comando. Sem ele, a citação dessa página só se confere no acervo assinado (verificada_no_acervo) ou por um votante.';
/**
 * O que dizer diante do captcha, que nenhum motor resolve e o código não contorna. Sem isto o
 * índice dizia só `captcha`, e quem lia não sabia o que fazer com a citação (L22).
 */
const INSTRUCAO_CAPTCHA = 'A página pediu captcha, que o código não resolve nem contorna: confira a fonte abrindo a página no navegador (quem conferir registra o que leu, com a data), ou pela cópia do acervo assinado (verificada_no_acervo); sem conferência, a citação sai da peça ou vai sem o dado que só essa página daria.';
/** Gateways que o navegador resolve; rede, TLS e timeout não mudam com Playwright. */
const GATEWAY_DE_NAVEGADOR = (gateway) => !/^(rede|tls|timeout|redirect|redirecionamentos)/.test(String(gateway || ''));

/**
 * O que a resposta é, antes de qualquer decisão: conteúdo bom, gateway que um
 * navegador (ou uma variante conhecida) resolve, ou bloqueio que ninguém resolve.
 * Só olha status, tipo e os primeiros bytes; quem decide o motor seguinte é `baixar`.
 */
function classificarResposta({ urlPedida, urlFinal, status, contentType, corpo }) {
  const tipo = String(contentType || '').toLowerCase();
  const ehPdf = tipo.includes('application/pdf') || (corpo && corpo.subarray(0, 5).toString('latin1') === '%PDF-');
  if (ehPdf) return { ok: true, tipo: 'pdf' };
  const amostra = corpo ? corpo.subarray(0, 200000).toString('utf8') : '';
  if (status === 403) return ehCaptcha(amostra) ? { bloqueio: 'captcha' } : { gateway: '403' };
  if (status === 429) return { gateway: '429' };
  if (status >= 500) return { gateway: `http-${status}` };
  if (status >= 400) return { bloqueio: `http-${status}` };
  if (ehCaptcha(amostra)) return { bloqueio: 'captcha' };
  if (RE_ESAJ_GATEWAY.test(amostra)) return { gateway: 'esaj-login' };
  if (/\/sajcas\/login/i.test(urlFinal || '')) return { bloqueio: 'login' };
  if (RE_LOGIN.test(amostra) && !/docTexto/.test(amostra)) return { bloqueio: 'login' };
  if (ehDesafioJs(amostra)) return { gateway: 'desafio-js' };
  // STJ: pediu a busca e recebeu a home (redirect sem UA de navegador)
  try {
    const pedida = new URL(urlPedida);
    const final = new URL(urlFinal || urlPedida);
    if (/pesquisar\.jsp/i.test(pedida.pathname) && !/pesquisar\.jsp/i.test(final.pathname)) return { gateway: 'scon-home' };
  } catch { /* URL inválida já teria falhado antes */ }
  return { ok: true, tipo: tipo.includes('html') ? 'html' : tipo.includes('json') ? 'json' : 'texto' };
}

// --- cookie jar mínimo, por host ------------------------------------------

function criarJar() {
  const porHost = new Map();
  return {
    guardar(host, setCookies) {
      if (!Array.isArray(setCookies) || !setCookies.length) return;
      const jar = porHost.get(host) || new Map();
      for (const linha of setCookies) {
        const par = String(linha).split(';')[0];
        const i = par.indexOf('=');
        if (i > 0) jar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
      }
      porHost.set(host, jar);
    },
    cabecalho(host) {
      const jar = porHost.get(host);
      if (!jar || !jar.size) return null;
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

function cabecalhosDeNavegador(url, referer, jar) {
  const u = new URL(url);
  const h = {
    'User-Agent': UA_NAVEGADOR,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5',
    Referer: referer || `${u.origin}/`,
  };
  const cookie = jar && jar.cabecalho(u.hostname);
  if (cookie) h.Cookie = cookie;
  return h;
}

/** fetch com redirecionamentos seguidos à mão (para ver o gateway no caminho) e cookies por host. */
async function baixarComFetch(url, { referer = null, jar = criarJar(), timeoutMs = TIMEOUT_PADRAO_MS, fetchImpl = globalThis.fetch } = {}) {
  let atual = url;
  let ultimoReferer = referer;
  for (let salto = 0; salto <= MAX_REDIRECIONAMENTOS; salto += 1) {
    const controlador = new AbortController();
    const timer = setTimeout(() => controlador.abort(), timeoutMs);
    let resposta;
    try {
      resposta = await fetchImpl(atual, { headers: cabecalhosDeNavegador(atual, ultimoReferer, jar), redirect: 'manual', signal: controlador.signal });
    } catch (erro) {
      clearTimeout(timer);
      const mensagem = String(erro && (erro.cause && erro.cause.message || erro.message)).split('\n')[0];
      const motivo = erro && erro.name === 'AbortError' ? 'timeout' : /certificate|CERT|TLS|SSL/i.test(mensagem) ? 'tls' : `rede: ${mensagem}`;
      return { erro: motivo, urlFinal: atual };
    }
    clearTimeout(timer);
    const host = new URL(atual).hostname;
    const setCookies = typeof resposta.headers.getSetCookie === 'function' ? resposta.headers.getSetCookie() : [];
    jar.guardar(host, setCookies);
    if ([301, 302, 303, 307, 308].includes(resposta.status)) {
      const destino = resposta.headers.get('location');
      if (!destino) return { erro: `redirect ${resposta.status} sem location`, urlFinal: atual };
      ultimoReferer = atual;
      atual = new URL(destino, atual).toString();
      continue;
    }
    const corpo = Buffer.from(await resposta.arrayBuffer());
    return { status: resposta.status, urlFinal: atual, contentType: resposta.headers.get('content-type') || '', corpo };
  }
  return { erro: 'redirecionamentos demais', urlFinal: atual };
}

// --- cadeia incompleta: o site não manda o intermediário ---------------------
// Caso real (STF, 16/09/2026): `www.stf.jus.br` serve o certificado da folha sem
// o intermediário da CA. O navegador busca esse elo pelo endereço que o próprio
// certificado carrega (AIA) e a página abre; o Node não busca, e todo informativo
// do STF virava `acesso_falhou: tls` com a fonte no ar. Buscar o elo é o que o
// navegador faz, e não afrouxa nada: o intermediário ainda precisa fechar numa
// raiz do sistema e o nome do host ainda é conferido. O que NÃO fazemos, nunca, é
// desligar a verificação — fonte de prova aberta sem verificar certificado não é
// fonte de prova.
const intermediariosPorHost = new Map();

/** SNI não aceita IP: contra um endereço literal, o nome do servidor não vai. */
const nomeDeServidor = (host) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') ? undefined : host);

/** O endereço do intermediário vem do certificado do servidor, lido sem confiar nele. */
async function uriDoIntermediario(host, timeoutMs) {
  return new Promise((resolve) => {
    let respondido = false;
    const fim = (valor) => { if (!respondido) { respondido = true; resolve(valor); } };
    const s = conectarTls({ host, port: 443, servername: nomeDeServidor(host), rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = s.getPeerX509Certificate();
      const achado = cert && cert.infoAccess ? String(cert.infoAccess).match(/CA Issuers - URI:(\S+)/) : null;
      fim(achado ? achado[1] : null);
      s.destroy();
    });
    s.on('error', () => fim(null));
    s.on('timeout', () => { fim(null); s.destroy(); });
  });
}

/** Baixa o intermediário (DER ou PEM) e devolve PEM; o certificado se autentica sozinho ao ser verificado. */
async function intermediarioDe(host, { timeoutMs = TIMEOUT_PADRAO_MS, fetchImpl = globalThis.fetch } = {}) {
  if (intermediariosPorHost.has(host)) return intermediariosPorHost.get(host);
  let pem = null;
  try {
    const uri = await uriDoIntermediario(host, timeoutMs);
    if (uri && /^https?:\/\//i.test(uri)) {
      const resposta = await fetchImpl(uri, { headers: { 'User-Agent': UA_NAVEGADOR }, signal: AbortSignal.timeout(timeoutMs) });
      if (resposta.ok) {
        const bytes = Buffer.from(await resposta.arrayBuffer());
        if (bytes.length && bytes.length < 64 * 1024) pem = new X509Certificate(bytes).toString();
      }
    }
  } catch { pem = null; }
  intermediariosPorHost.set(host, pem);
  return pem;
}

/** Um GET por `node:https`, para poder completar a cadeia em `ca`; mesmos cabeçalhos, cookies e redirecionamentos do fetch. */
async function baixarComCadeia(url, { referer = null, jar = criarJar(), timeoutMs = TIMEOUT_PADRAO_MS, ca } = {}) {
  let atual = url;
  let ultimoReferer = referer;
  for (let salto = 0; salto <= MAX_REDIRECIONAMENTOS; salto += 1) {
    const u = new URL(atual);
    const r = await new Promise((resolve) => {
      let req;
      try {
        req = pedirHttps({ host: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, servername: nomeDeServidor(u.hostname), headers: cabecalhosDeNavegador(atual, ultimoReferer, jar), ca }, (res) => {
          const pedacos = [];
          res.on('data', (d) => pedacos.push(d));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(pedacos) }));
        });
      } catch (erro) {
        resolve({ erro: String(erro && erro.message).split('\n')[0] });
        return;
      }
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (erro) => resolve({ erro: String(erro && erro.message).split('\n')[0] }));
      req.end();
    });
    if (r.erro) return { erro: /timeout/i.test(r.erro) ? 'timeout' : /certificate|CERT|TLS|SSL/i.test(r.erro) ? 'tls' : `rede: ${r.erro}`, urlFinal: atual };
    jar.guardar(u.hostname, r.headers['set-cookie'] || []);
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const destino = r.headers.location;
      if (!destino) return { erro: `redirect ${r.status} sem location`, urlFinal: atual };
      ultimoReferer = atual;
      atual = new URL(destino, atual).toString();
      continue;
    }
    return { status: r.status, urlFinal: atual, contentType: r.headers['content-type'] || '', corpo: r.corpo };
  }
  return { erro: 'redirecionamentos demais', urlFinal: atual };
}

// --- Playwright (opcional) --------------------------------------------------

/** O pacote pode existir sem o navegador (caso real: pacote 1.58 com binários de outra versão). Diz qual dos dois falta. */
async function detectarPlaywright(modulo = 'playwright') {
  let pw;
  try {
    pw = await import(modulo);
  } catch (erro) {
    return { disponivel: false, motivo: `Playwright ausente (${String(erro && erro.message).split('\n')[0]}); instale com npm install e npx playwright install chromium` };
  }
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) return { disponivel: false, motivo: 'Playwright sem chromium exportado' };
  let executavel;
  try { executavel = chromium.executablePath(); } catch { /* pacote sem binário declarado */ }
  if (!executavel || !existsSync(executavel)) {
    return { disponivel: false, motivo: 'Playwright sem navegador: rode npx playwright install chromium' };
  }
  return { disponivel: true, chromium };
}

async function baixarComPlaywright(url, { chromium, timeoutMs = TIMEOUT_PADRAO_MS, esperaMs = 1500 } = {}) {
  const navegador = await chromium.launch({ headless: true });
  try {
    const contexto = await navegador.newContext({ locale: 'pt-BR', userAgent: UA_NAVEGADOR, acceptDownloads: true });
    const pagina = await contexto.newPage();
    const origem = new URL(url).origin;
    // Primeiro a origem, para o site plantar os cookies de sessão; depois o alvo pela API de rede
    // do mesmo contexto, que herda cookies e UA e devolve PDF como bytes, sem "download".
    await pagina.goto(`${origem}/`, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null);
    await pagina.waitForTimeout(esperaMs);
    const resposta = await contexto.request.get(url, { timeout: timeoutMs, headers: { Referer: `${origem}/` } });
    const corpo = Buffer.from(await resposta.body());
    return { status: resposta.status(), urlFinal: resposta.url(), contentType: resposta.headers()['content-type'] || '', corpo };
  } catch (erro) {
    return { erro: `playwright: ${String(erro && erro.message).split('\n')[0]}`, urlFinal: url };
  } finally {
    await navegador.close().catch(() => null);
  }
}

// --- baixar: a escada ------------------------------------------------------

function nomeLocal(url, tipo) {
  return `${sha1(url)}${extensaoDoTipo(tipo)}`;
}

function extensaoDoTipo(tipo) {
  return tipo === 'pdf' ? '.pdf' : tipo === 'json' ? '.json' : tipo === 'html' ? '.html' : '.txt';
}

/** "2026-09-24T11:08:53.392Z" → "20260924T110853Z": a data que vai no nome da cópia. */
const carimboDeData = (quando) => quando.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Onde gravar sem apagar prova. A cópia no `--out` do run é o que o verificador leu e o que a
 * evidência registrada (hash, `fonte_local`) aponta: um download novo com outros bytes vai para
 * o mesmo nome com a data (`<sha1>.<AAAAMMDDTHHMMSSZ>.pdf`), e a anterior fica. Mesmos bytes
 * reaproveitam o nome. Com `sempreComData` (a reabertura), o nome leva a data sempre.
 * Medido na medição de 24/09/2026 (defeito 36): `--reabrir` baixou por cima de
 * `fontes/<sha1>.pdf` do REsp 158.843-MG, e a cópia que o verificador registrou sumiu.
 */
function destinoSemApagar(dir, base, ext, corpo, quando, sempreComData = false) {
  const hash = sha256(corpo);
  const livre = (b) => {
    const p = join(dir, `${b}${ext}`);
    return !existsSync(p) || sha256(readFileSync(p)) === hash ? p : null;
  };
  if (!sempreComData) {
    const p = livre(base);
    if (p) return { arquivo: p, base };
  }
  const datado = `${base}.${carimboDeData(quando)}`;
  for (let i = 0; ; i += 1) {
    const b = i ? `${datado}-${i}` : datado;
    const p = livre(b);
    if (p) return { arquivo: p, base: b };
  }
}

/** Grava a cópia e o texto no `--out` pelo `destinoSemApagar`; devolve os caminhos gravados. */
function gravarCopia(out, url, tipo, corpo, texto, quando, sempreComData) {
  mkdirSync(out, { recursive: true });
  const { arquivo, base } = destinoSemApagar(out, sha1(url), extensaoDoTipo(tipo), corpo, quando, sempreComData);
  writeFileSync(arquivo, corpo);
  let textoArquivo = null;
  if (texto) {
    textoArquivo = join(out, `${base}.txt`);
    if (textoArquivo !== arquivo) writeFileSync(textoArquivo, texto);
  }
  return { arquivo, textoArquivo };
}

/**
 * Versão do texto extraído de HTML guardado no cache. A 2 decodifica página sem charset pelos
 * bytes e marca o riscado (medição de 24/09/2026); cópia de HTML gravada antes dela traz o
 * `.txt` com acento corrompido e o riscado misturado ao vigente, e não é reaproveitada.
 */
const EXTRATOR_HTML = 2;

function lerCache(cacheDir, url) {
  if (!cacheDir) return null;
  const meta = join(cacheDir, `${sha1(url)}.json`);
  if (!existsSync(meta)) return null;
  try {
    const entrada = JSON.parse(readFileSync(meta, 'utf8'));
    if (!entrada || entrada.status !== 'ok' || !entrada.arquivo || !existsSync(join(cacheDir, basename(entrada.arquivo)))) return null;
    if (entrada.tipo === 'html' && entrada.extrator_html !== EXTRATOR_HTML) return null;
    // Resposta vazia gravada como ok antes da conferência de conteúdo (defeito 37): não é cópia.
    if (entrada.bytes === 0) return null;
    // Nem o casco sem conteúdo que a conferência de 0.9.49 deixava passar (negativação, 24/09/2026:
    // duas respostas vazias do Banco Central no cache do acervo). Conferido de novo na leitura.
    const arquivo = join(cacheDir, basename(entrada.arquivo));
    if (entrada.tipo !== 'pdf') {
      const corpo = readFileSync(arquivo);
      const texto = entrada.texto && existsSync(join(cacheDir, basename(entrada.texto))) ? readFileSync(join(cacheDir, basename(entrada.texto)), 'utf8') : corpo.toString('utf8');
      if (motivoDeConteudoInvalido(entrada.url, corpo, entrada.tipo, texto, false)) return null;
    }
    return { ...entrada, arquivo: join(cacheDir, basename(entrada.arquivo)), texto: entrada.texto ? join(cacheDir, basename(entrada.texto)) : null };
  } catch { return null; }
}

function gravarCache(cacheDir, entrada, corpo, texto) {
  if (!cacheDir) return;
  mkdirSync(cacheDir, { recursive: true });
  const arquivo = join(cacheDir, nomeLocal(entrada.url, entrada.tipo));
  writeFileSync(arquivo, corpo);
  let textoNome = null;
  if (texto) {
    textoNome = `${sha1(entrada.url)}.txt`;
    // Resposta em texto puro: o arquivo JÁ é o .txt; gravar o texto normalizado por cima trocaria os bytes que o hash assina.
    if (textoNome !== basename(arquivo)) writeFileSync(join(cacheDir, textoNome), texto);
  }
  const versao = entrada.tipo === 'html' ? { extrator_html: EXTRATOR_HTML } : {};
  writeFileSync(join(cacheDir, `${sha1(entrada.url)}.json`), JSON.stringify({ ...entrada, arquivo: basename(arquivo), texto: textoNome, ...versao }, null, 1));
}

/** Variante que o próprio gateway do e-SAJ usa para quem não está logado: a mesma URL com `casChecked=true`. */
function variantesDeGateway(url, gateway) {
  if (gateway === 'esaj-login' && !/casChecked=true/.test(url)) return [`${url}${url.includes('?') ? '&' : '?'}casChecked=true`];
  return [];
}

async function dormir(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/**
 * Letras e números nas cadeias de um JSON abaixo dos quais ele não é o documento (o casco de uma
 * API sem conteúdo). A página HTML que só o script preencheria é o desafio de JavaScript
 * (`ehDesafioJs`), decidido antes, pelo aviso que ela mesma dá.
 */
const TEXTO_MINIMO_DE_JSON = 40;
const letrasDe = (texto) => (String(texto || '').match(/[\p{L}\p{N}]/gu) || []).length;

/**
 * JSON que chegou mas não traz texto: a soma das letras das cadeias é menor que o mínimo. Medido
 * na negativação de 24/09/2026: a API de normativos do Banco Central respondeu 200 com
 * `{"navegacao":null,"view":"views/exibenormativo.aspx","conteudo":[]}` (67 bytes), e o índice e o
 * cache gravaram `ok`.
 */
function jsonSemConteudo(bruto) {
  let dados;
  try { dados = JSON.parse(bruto); } catch { return false; }
  let letras = 0;
  const visitar = (v) => {
    if (typeof v === 'string') letras += letrasDe(v);
    else if (Array.isArray(v)) v.forEach(visitar);
    else if (v && typeof v === 'object') Object.values(v).forEach(visitar);
  };
  visitar(dados);
  return letras < TEXTO_MINIMO_DE_JSON;
}

/** Página de erro servida com 200: a frase de erro no começo de um texto curto. */
const RE_PAGINA_DE_ERRO = /\b(?:p[áa]gina|documento|arquivo|recurso|conte[úu]do)\s+(?:solicitad[oa]\s+)?n[ãa]o\s+(?:foi\s+)?(?:encontrad[oa]|localizad[oa]|dispon[íi]vel|existe)|\bnot found\b|\binternal server error\b|\bservice unavailable\b|\bocorreu um erro\b|\berro interno\b|\berro (?:404|500)\b|\bjava\.[a-z.]+exception\b/i;
const TEXTO_MAXIMO_DE_PAGINA_DE_ERRO = 1500;

/** O registro que a URL de inteiro teor do STJ pede (`num_registro=`), só dígitos; null fora dela. */
function registroPedidoStj(url) {
  try {
    const u = new URL(url);
    if (!/GetInteiroTeorDoAcordao$/i.test(u.pathname)) return null;
    const registro = String(u.searchParams.get('num_registro') || '').replace(/\D/g, '');
    return registro || null;
  } catch { return null; }
}

/**
 * Resposta que chegou mas não é o documento: vazia, página de erro com 200, HTML sem texto
 * nenhum, ou inteiro teor do STJ cujo cabeçalho traz outro registro. Devolve o motivo, ou null.
 * Medido na medição de 24/09/2026 (defeito 37): `GetPDFINFJ?edicao=` respondeu 200 com zero
 * bytes, e o índice e o cache gravaram `ok`.
 */
function motivoDeConteudoInvalido(url, corpo, tipo, texto, conferirPedido) {
  if (!corpo || !corpo.length) return 'resposta-vazia';
  if (tipo !== 'pdf') {
    if (!corpo.toString('utf8').trim()) return 'resposta-vazia';
    if (!texto) return 'pagina-sem-texto';
    if (tipo === 'json' && jsonSemConteudo(corpo.toString('utf8'))) return 'json-sem-conteudo';
    const erro = texto.length < TEXTO_MAXIMO_DE_PAGINA_DE_ERRO ? texto.match(RE_PAGINA_DE_ERRO) : null;
    if (erro && erro.index < 400) return 'pagina-de-erro';
  }
  const pedido = conferirPedido ? registroPedidoStj(url) : null;
  if (pedido && texto) {
    const cabecalho = cabecalhoInteiroTeorStj(texto);
    if (cabecalho && cabecalho.registro.replace(/\D/g, '') !== pedido) return 'processo-divergente';
  }
  return null;
}

/**
 * Baixa UMA fonte oficial pela escada de motores e devolve a entrada do índice.
 * Nunca lança por acesso: acesso que falha é uma entrada `acesso_falhou` com motivo.
 */
async function baixar(url, opts = {}) {
  const {
    out = null, cache = null, forcar = false, playwright = 'auto', playwrightModulo = 'playwright',
    esperaMs = ESPERA_PADRAO_MS, timeoutMs = TIMEOUT_PADRAO_MS, fetchImpl = globalThis.fetch,
    pdftotext = detectarPdftotext(), agora = () => new Date(), jar = criarJar(), ultimoAcesso = new Map(), log = () => {}, devolverCorpo = false,
    permitirHttp = false, sempreComData = false, conferirPedido = true,
  } = opts;
  let u;
  try { u = new URL(url); } catch { return { url, status: 'acesso_falhou', motivo: 'url-invalida', motor: null }; }
  // Fonte oficial é https; http só entra em teste, contra um servidor de fixture local.
  if (u.protocol !== 'https:' && !(permitirHttp && u.protocol === 'http:')) return { url, host: u.hostname, status: 'acesso_falhou', motivo: 'nao-https', motor: null };

  const emCache = !forcar && lerCache(cache, url);
  if (emCache) {
    let arquivo = emCache.arquivo;
    let texto = emCache.texto;
    if (out) {
      const corpo = readFileSync(emCache.arquivo);
      const textoDoCache = emCache.texto && existsSync(emCache.texto) ? readFileSync(emCache.texto, 'utf8') : null;
      ({ arquivo, textoArquivo: texto } = gravarCopia(out, url, emCache.tipo, corpo, textoDoCache, agora(), sempreComData));
    }
    // `baixado_em` é a data do download que o cache guardou, às vezes de outro run; a hora em
    // que este run recebeu a cópia vai em `servido_do_cache_em`. Medido em 25/09/2026
    // (alimentos): o verificador copiou o `baixado_em` da véspera como `consulted_at`.
    return { ...emCache, motor: 'cache', arquivo, texto, cache: true, servido_do_cache_em: agora().toISOString() };
  }

  // Um pedido por vez, com espera por host: o tribunal não leva rajada.
  const ultimo = ultimoAcesso.get(u.hostname) || 0;
  const falta = ultimo + esperaMs - Date.now();
  if (falta > 0) await dormir(falta);

  const classificar = (r, pedida) => (r.erro ? { gateway: r.erro } : classificarResposta({ urlPedida: pedida, ...r }));
  let resposta = await baixarComFetch(url, { jar, timeoutMs, fetchImpl });
  ultimoAcesso.set(u.hostname, Date.now());
  let motor = 'fetch';
  let classe = classificar(resposta, url);

  // Uma repetição em 429/5xx/rede/timeout/tls, depois da espera.
  if (classe.gateway && /^(429|http-5|rede|timeout|tls)/.test(String(classe.gateway))) {
    log(`  ${classe.gateway}; repetindo uma vez`);
    await dormir(esperaMs);
    resposta = await baixarComFetch(url, { jar, timeoutMs, fetchImpl });
    ultimoAcesso.set(u.hostname, Date.now());
    classe = classificar(resposta, url);
  }

  // Cadeia incompleta: completa pelo AIA do próprio certificado e refaz o pedido, com verificação normal.
  if (classe.gateway === 'tls' && u.protocol === 'https:') {
    const pem = await intermediarioDe(u.hostname, { timeoutMs, fetchImpl });
    if (pem) {
      log('  cadeia incompleta; completando pelo certificado do próprio site');
      await dormir(esperaMs);
      const r = await baixarComCadeia(url, { jar, timeoutMs, ca: [...rootCertificates, pem] });
      ultimoAcesso.set(u.hostname, Date.now());
      const c = classificar(r, url);
      if (c.ok) { resposta = r; classe = c; motor = 'fetch+cadeia'; }
    }
  }

  // Gateway com variante conhecida (e-SAJ anônimo) antes de pagar o navegador.
  if (classe.gateway) {
    for (const variante of variantesDeGateway(url, classe.gateway)) {
      await dormir(esperaMs);
      const r = await baixarComFetch(variante, { jar, timeoutMs, fetchImpl, referer: url });
      ultimoAcesso.set(u.hostname, Date.now());
      const c = classificar(r, variante);
      if (c.ok) { resposta = r; classe = c; motor = 'fetch+casChecked'; break; }
    }
  }

  // Playwright só para gateway; bloqueio (captcha, login) nunca vai ao navegador.
  if (classe.gateway && playwright !== 'off') {
    const pw = await detectarPlaywright(playwrightModulo);
    if (pw.disponivel) {
      log(`  ${classe.gateway}; abrindo com Playwright`);
      await dormir(esperaMs);
      const r = await baixarComPlaywright(url, { chromium: pw.chromium, timeoutMs });
      ultimoAcesso.set(u.hostname, Date.now());
      const c = classificar(r, url);
      if (c.ok) { resposta = r; classe = c; motor = 'playwright'; } else classe = { ...c, motorTentado: 'playwright' };
    } else {
      classe = { ...classe, semPlaywright: pw.motivo };
    }
  }

  if (!classe.ok) {
    const motivo = classe.bloqueio || classe.gateway || 'desconhecido';
    // A instrução do navegador só onde ele resolveria (desafio de JavaScript, 403, home do SCON, gateway
    // do e-SAJ); o captcha leva a sua, que manda conferir à mão ou no acervo.
    const instrucao = classe.bloqueio === 'captcha' ? { instrucao: INSTRUCAO_CAPTCHA }
      : classe.semPlaywright && classe.gateway && GATEWAY_DE_NAVEGADOR(classe.gateway) ? { instrucao: INSTRUCAO_PLAYWRIGHT } : {};
    return {
      url, host: u.hostname, motor, status: 'acesso_falhou', motivo, url_final: resposta.urlFinal || url, http: resposta.status || null,
      baixado_em: agora().toISOString(), ...(classe.semPlaywright ? { aviso: classe.semPlaywright } : {}), ...instrucao,
    };
  }
  return registrarResposta(url, resposta, { classe, motor, out, cache, pdftotext, agora, sempreComData, conferirPedido, devolverCorpo });
}

/**
 * O que se faz com a resposta que chegou, venha ela da escada de `baixar` ou da navegação guiada:
 * classificar (quando quem chama ainda não classificou), extrair o texto, recusar o que não é o
 * documento (vazia, página de erro, sem texto, outro processo), gravar a cópia no `--out` e no
 * cache e devolver a entrada do índice. As checagens são as mesmas para os dois caminhos, de
 * propósito: página aberta por clique não ganha passe que a página baixada não tem.
 */
function registrarResposta(url, resposta, opts = {}) {
  const {
    motor = 'fetch', out = null, cache = null, pdftotext = detectarPdftotext(), agora = () => new Date(),
    sempreComData = false, conferirPedido = true, devolverCorpo = false,
  } = opts;
  const host = (() => { try { return new URL(url).hostname; } catch { return null; } })();
  const baixadoEm = agora().toISOString();
  const classe = opts.classe || classificarResposta({ urlPedida: url, ...resposta });
  if (!classe.ok) {
    return { url, host, motor, status: 'acesso_falhou', motivo: classe.bloqueio || classe.gateway || 'desconhecido', url_final: resposta.urlFinal || url, http: resposta.status || null, baixado_em: baixadoEm };
  }
  const corpo = resposta.corpo;
  const tipo = classe.tipo;
  const html = tipo === 'html' ? decodificarHtml(corpo, resposta.contentType) : null;
  const texto = tipo === 'pdf' ? textoDePdf(corpo, pdftotext) : tipo === 'html' ? textoDeHtml(html) : normalizarTexto(corpo.toString('utf8'));
  const invalido = motivoDeConteudoInvalido(url, corpo, tipo, texto, conferirPedido);
  if (invalido) {
    return { url, host, motor, status: 'acesso_falhou', motivo: invalido, url_final: resposta.urlFinal, http: resposta.status, tipo, bytes: corpo.length, baixado_em: baixadoEm };
  }
  const { arquivo, textoArquivo } = out ? gravarCopia(out, url, tipo, corpo, texto || null, new Date(baixadoEm), sempreComData) : { arquivo: null, textoArquivo: null };
  const entrada = {
    url, host, motor, status: 'ok', motivo: null, url_final: resposta.urlFinal, http: resposta.status,
    tipo, arquivo, texto: textoArquivo, bytes: corpo.length,
    sha256_bytes: sha256(corpo), sha256_texto: texto ? sha256(texto) : null,
    hash_de: texto ? 'texto' : 'bytes', baixado_em: baixadoEm,
  };
  gravarCache(cache, { ...entrada, arquivo: arquivo || nomeLocal(url, tipo) }, corpo, texto);
  return { ...entrada, texto_extraido: texto, ...(devolverCorpo ? { corpo, html, content_type: resposta.contentType || '' } : {}) };
}

// --- STJ: registro, data de publicação e inteiro teor ----------------------

const RE_CLASSE_STJ = /\b(HC|RHC|REsp|EAREsp|AREsp|EREsp|RMS|MS|CC|Pet|MC|AI)\s*(?:n[ºo.]?\s*)?([\d.]+)\s*(?:[-/]\s*([A-Z]{2})\b)?/i;
const RE_REGISTRO_STJ = /\b(\d{4}\/\d{7}-\d)\b/;

/**
 * Os recursos internos que vêm antes da classe ("EDcl no AgInt no", "AgInt nos EDcl no"),
 * como lista comparável, na ordem. "AgRg no HC" e "HC" são acórdãos diferentes do mesmo
 * registro, e o STJ lista os dois na mesma busca. Só siglas de recurso contam: o que a
 * pesquisa escreve antes da citação ("STJ, Terceira Turma,") não é recurso.
 */
const SIGLAS_RECURSO_INTERNO = new Set(['agrg', 'agint', 'edcl', 'proafr', 'rcd', 'qo', 're']);
const recursosInternos = (prefixo) => String(prefixo || '').toLowerCase().split(/[^a-z]+/).filter((p) => SIGLAS_RECURSO_INTERNO.has(p));

/** "AgRg no HC 1.054.751/SC" → { classe: 'HC', numero: '1054751', uf: 'SC', recursos: ['agrg'], registro, busca: <URL da página oficial de resultados> } */
const BASE_STJ = 'https://processo.stj.jus.br';
function interpretarCitacaoStj(citacao, base = BASE_STJ) {
  const texto = String(citacao || '').trim();
  const m = texto.match(RE_CLASSE_STJ);
  if (!m) return null;
  const classe = CLASSES_STJ[m[1].toUpperCase()];
  const numero = m[2].replace(/\D/g, '');
  const uf = m[3] ? m[3].toUpperCase() : null;
  const recursos = recursosInternos(texto.slice(0, m.index));
  const registro = texto.slice(m.index).match(RE_REGISTRO_STJ)?.[1] || null;
  const busca = `${base}/SCON/pesquisar.jsp?acao=pesquisar&novaConsulta=true&i=1&b=ACOR&livre=&processo=${numero}&classe=${classe}`;
  return { classe, numero, uf, recursos, registro, busca };
}

function urlInteiroTeorStj(registro, dtPublicacao, base = BASE_STJ) {
  return `${base}/SCON/GetInteiroTeorDoAcordao?num_registro=${String(registro).replace(/\D/g, '')}&dt_publicacao=${dtPublicacao}`;
}

/** "08/09/2026" → "20260908", para ordenar datas de publicação sem depender de Date. */
const chaveDeData = (d) => String(d || '').split('/').reverse().join('');

const RE_LINK_INTEIRO_TEOR = /GetInteiroTeorDoAcordao\?num_registro=(\d+)&(?:amp;)?dt_publicacao=(\d{2}\/\d{2}\/\d{4})/g;
const somenteTexto = (html) => textoDeHtml(String(html || '').replace(/<br\s*\/?>/gi, '\n'));

/**
 * Cada `<div class="documento">` da página de resultados, lido pelo bloco "Processo"
 * (recursos internos, classe, número, UF e registro) e com os links de inteiro teor
 * DO PRÓPRIO documento. A lista de "acórdãos similares" (`acoesdocumentoSuce`) sai antes:
 * os links dela são de outros processos.
 */
function documentosStj(html) {
  const partes = String(html || '').split(/<div class="documento"[^>]*>/i).slice(1);
  return partes.map((doc) => {
    const proprio = doc.replace(/<span[^>]*acoesdocumentoSuce[^>]*>[\s\S]*?<\/span>/gi, ' ');
    const bloco = proprio.match(/docTitulo">\s*Processo\s*<\/div>\s*<div class="docTexto">([\s\S]*?)<\/div>/i)?.[1] || '';
    const [linha = ''] = bloco.split(/<br\s*\/?>/i).map(somenteTexto);
    const m = linha.match(RE_CLASSE_STJ);
    const registro = somenteTexto(bloco).match(RE_REGISTRO_STJ)?.[1] || null;
    const links = [...proprio.matchAll(RE_LINK_INTEIRO_TEOR)].map((l) => ({ registro: l[1], dt_publicacao: l[2] }));
    const dataFonte = proprio.match(/Data da Publica[\s\S]{0,300}?(?:DJEN|DJe|DJ)\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] || null;
    if (!m) return { processo: linha || null, registro, links, dataFonte };
    return {
      processo: linha,
      classe: CLASSES_STJ[m[1].toUpperCase()],
      numero: m[2].replace(/\D/g, ''),
      uf: m[3] ? m[3].toUpperCase() : null,
      recursos: recursosInternos(linha.slice(0, m.index)),
      registro, links, dataFonte,
    };
  });
}

/**
 * Os "acórdãos similares" que a página lista dentro de cada documento, cada um com a própria
 * identificação ("EDcl no REsp  1624005  DF  2014/0242725-9  Decisão:… DJe DATA:…") e o próprio
 * link de inteiro teor. Servem só quando a identificação inteira casa com o pedido: é assim
 * que o EDcl de um REsp aparece na busca pelo número do REsp.
 */
function similaresStj(html) {
  const vistos = new Set();
  const lista = [];
  for (const m of String(html || '').matchAll(/<pre>([\s\S]*?)<\/pre>\s*<span[^>]*acoesdocumentoSuce[^>]*>([\s\S]*?)<\/span>/gi)) {
    const linha = somenteTexto(m[1]);
    const id = linha.match(/^(.*?)\b(HC|RHC|REsp|EAREsp|AREsp|EREsp|RMS|MS|CC|Pet|MC|AI)\s+(\d+)\s+([A-Z]{2})\s+(\d{4}\/\d{7}-\d)/);
    const link = [...m[2].matchAll(RE_LINK_INTEIRO_TEOR)][0];
    if (!id || !link || vistos.has(`${link[1]} ${link[2]}`)) continue;
    vistos.add(`${link[1]} ${link[2]}`);
    lista.push({
      processo: `${id[1]}${id[2]} ${id[3]} / ${id[4]}`.trim(), classe: CLASSES_STJ[id[2].toUpperCase()], numero: id[3], uf: id[4],
      recursos: recursosInternos(id[1]), registro: id[5], links: [{ registro: link[1], dt_publicacao: link[2] }], dataFonte: null, similar: true,
    });
  }
  return lista;
}

/** O documento é o pedido: mesmos recursos internos, classe e número; UF e registro quando o pedido os traz. */
function documentoCasa(doc, alvo) {
  if (!doc.classe || doc.classe !== alvo.classe || doc.numero !== alvo.numero) return false;
  if (alvo.uf && doc.uf !== alvo.uf) return false;
  if (alvo.registro && doc.registro !== alvo.registro) return false;
  return (doc.recursos || []).join(' ') === (alvo.recursos || []).join(' ');
}

/**
 * Da página oficial de resultados: o link de inteiro teor do documento que É o processo
 * pedido (o próprio site o monta com registro e data de publicação) ou, sem link, o
 * registro e a data do bloco "Processo" desse documento. Nada casa, nada volta: `null`.
 *
 * Medido na medição de 24/09/2026: REsp 1.624.005-DF, REsp 1.264.820-RS e REsp
 * 1.715.438-RS trouxeram o inteiro teor de outros processos (REsp 1.340.290/MG, AREsp
 * 1.840.992/PE, AREsp 1.580.444/RJ). A busca pelo número acha o processo também na lista
 * de "acórdãos similares" de outro documento, e o extrator pegava o primeiro bloco em que
 * o número aparecia e o primeiro registro desse bloco. Agora o documento só é aceito pelo
 * bloco "Processo" dele, com classe, número, UF, recursos internos e registro conferidos.
 *
 * Quando mais de um documento casa (dois acórdãos do mesmo processo), vale o mais recente:
 * medido no run de 16/09/2026, o REsp 2.048.687/BA devolvia a afetação de 29/05/2024 no
 * lugar do mérito de 08/09/2026, e o verificador precisou buscar o mérito à mão. Só quando
 * nenhum documento casa é que a lista de similares entra, e pela identificação inteira dela.
 */
function extrairInteiroTeorStj(html, alvo, base = BASE_STJ) {
  if (!alvo || !alvo.classe || !alvo.numero) return null;
  const escolher = (docs) => {
    const candidatos = docs.filter((d) => documentoCasa(d, alvo) && d.registro);
    const publicacoes = candidatos.flatMap((d) => d.links.filter((l) => l.registro === d.registro.replace(/\D/g, '')).map((l) => ({ ...l, doc: d })));
    const link = publicacoes.sort((a, b) => chaveDeData(b.dt_publicacao).localeCompare(chaveDeData(a.dt_publicacao)))[0];
    if (link) {
      return { registro: link.doc.registro, processo: link.doc.processo, dt_publicacao: link.dt_publicacao, url_inteiro_teor: urlInteiroTeorStj(link.registro, link.dt_publicacao, base), publicacoes: publicacoes.length, ...(link.doc.similar ? { similar: true } : {}) };
    }
    const semLink = candidatos.filter((d) => d.dataFonte).sort((a, b) => chaveDeData(b.dataFonte).localeCompare(chaveDeData(a.dataFonte)))[0];
    if (semLink) return { registro: semLink.registro, processo: semLink.processo, dt_publicacao: semLink.dataFonte, url_inteiro_teor: urlInteiroTeorStj(semLink.registro, semLink.dataFonte, base) };
    return null;
  };
  return escolher(documentosStj(html)) || escolher(similaresStj(html));
}

/**
 * Classe por extenso, como o cabeçalho do inteiro teor a escreve; o mais longo antes, porque
 * "RECURSO ESPECIAL" termina "AGRAVO EM RECURSO ESPECIAL". É o formato da citação, par da
 * sigla em CLASSES_STJ: mecanismo de reconhecimento, não matéria de área.
 */
const CLASSES_STJ_EXTENSO = [
  [/EMBARGOS\sDE\sDIVERG[ÊE]NCIA\sEM\sAGRAVO\sEM\s(?:RECURSO\sESPECIAL|RESP)$/, 'EARESP'],
  [/EMBARGOS\sDE\sDIVERG[ÊE]NCIA\sEM\s(?:RECURSO\sESPECIAL|RESP)$/, 'ERESP'],
  [/AGRAVO\sEM\sRECURSO\sESPECIAL$/, 'ARESP'],
  [/RECURSO\sESPECIAL$/, 'RESP'],
  [/RECURSO\s(?:ORDIN[ÁA]RIO\s)?EM\sHABEAS\sCORPUS$/, 'RHC'],
  [/HABEAS\sCORPUS$/, 'HC'],
  [/RECURSO\s(?:ORDIN[ÁA]RIO\s)?EM\sMANDADO\sDE\sSEGURAN[ÇC]A$/, 'RMS'],
  [/MANDADO\sDE\sSEGURAN[ÇC]A$/, 'MS'],
  [/CONFLITO\sDE\sCOMPET[ÊE]NCIA$/, 'CC'],
  [/PETI[ÇC][ÃA]O$/, 'PET'],
  [/MEDIDA\sCAUTELAR$/, 'MC'],
  [/AGRAVO\sDE\sINSTRUMENTO$/, 'AI'],
];

/**
 * O cabeçalho do inteiro teor ("EDcl no AgInt no AgRg no RECURSO ESPECIAL Nº 1.340.290 - MG
 * (2012/0178353-5)"), lido nas primeiras linhas do texto. `null` quando não há cabeçalho
 * reconhecível (PDF sem texto, digitalização antiga).
 */
function cabecalhoInteiroTeorStj(texto) {
  const inicio = normalizarTexto(texto).slice(0, 4000);
  const m = inicio.match(/([A-ZÀ-Ü][A-ZÀ-Ü ]*[A-ZÀ-Ü])\s*N[º°o]\.?\s*([\d.]+)\s*-\s*([A-Z]{2})\s*\(\s*(\d{4}\/\d{7}-\d)\s*\)/);
  if (!m) return null;
  const extenso = m[1].trim();
  const classe = CLASSES_STJ_EXTENSO.find(([re]) => re.test(extenso))?.[1] || null;
  // Os recursos internos vêm colados antes da classe por extenso ("EDcl no AgInt no RECURSO ESPECIAL").
  const prefixo = inicio.slice(0, m.index).match(/(?:\b(?:AgRg|AgInt|EDcl|ProAfR|RCD|QO|RE)\s+n[oa]s?\s+)*$/)[0];
  return { texto: `${prefixo}${m[0]}`, prefixo: prefixo.trim(), classe, numero: m[2].replace(/\D/g, ''), uf: m[3], registro: m[4], recursos: recursosInternos(prefixo) };
}

/** O que no cabeçalho não bate com o pedido e com o registro que a página deu; lista vazia quando bate. */
function divergenciasDoCabecalho(cab, alvo, registro) {
  const d = [];
  if (cab.numero !== alvo.numero) d.push(`número ${cab.numero}`);
  if (alvo.uf && cab.uf !== alvo.uf) d.push(`UF ${cab.uf}`);
  if (cab.classe && cab.classe !== alvo.classe) d.push(`classe ${cab.classe}`);
  if (registro && cab.registro !== registro) d.push(`registro ${cab.registro}`);
  if (cab.recursos.join(' ') !== (alvo.recursos || []).join(' ')) d.push(`recurso interno "${cab.prefixo || 'nenhum'}"`);
  return d;
}

async function resolverStj(citacao, opts = {}) {
  const base = opts.baseStj || BASE_STJ;
  const alvo = interpretarCitacaoStj(citacao, base);
  if (!alvo) return { citacao, status: 'acesso_falhou', motivo: 'citacao-nao-reconhecida' };
  const pagina = await baixar(alvo.busca, { ...opts, out: null, cache: null, devolverCorpo: true });
  if (pagina.status !== 'ok') return { citacao, ...alvo, status: 'acesso_falhou', motivo: `resultados: ${pagina.motivo}`, url_busca: alvo.busca };
  const dados = extrairInteiroTeorStj(pagina.html || '', alvo, base);
  if (!dados) {
    // Não localizado não é "não existe": a página diz o que tinha, para a pesquisa corrigir a citação ou marcar.
    const naPagina = documentosStj(pagina.html || '').map((d) => [d.processo, d.registro].filter(Boolean).join(' ')).filter(Boolean);
    return { citacao, ...alvo, status: 'acesso_falhou', motivo: 'processo-nao-localizado-na-pagina', na_pagina: naPagina, url_busca: alvo.busca };
  }
  // A conferência do cabeçalho é feita aqui, com as divergências nomeadas; `baixar` não a repete.
  const teor = await baixar(dados.url_inteiro_teor, { ...opts, conferirPedido: false });
  if (teor.status !== 'ok') return { citacao, ...alvo, ...dados, url_busca: alvo.busca, inteiro_teor: teor, status: teor.status, motivo: teor.motivo || null };
  // Segunda conferência, no documento que de fato chegou: o cabeçalho do inteiro teor.
  const texto = teor.texto_extraido ?? (teor.texto && existsSync(teor.texto) ? readFileSync(teor.texto, 'utf8') : null);
  const cabecalho = texto ? cabecalhoInteiroTeorStj(texto) : null;
  if (!cabecalho) {
    return { citacao, ...alvo, ...dados, url_busca: alvo.busca, inteiro_teor: teor, status: 'ok', motivo: null, cabecalho_conferido: false,
      aviso: texto ? 'cabeçalho do inteiro teor não reconhecido; a identidade foi conferida só na página de resultados' : 'inteiro teor sem texto extraído (pdftotext ausente?); a identidade foi conferida só na página de resultados' };
  }
  const divergencias = divergenciasDoCabecalho(cabecalho, alvo, dados.registro);
  if (divergencias.length) {
    return { citacao, ...alvo, ...dados, url_busca: alvo.busca, inteiro_teor: { ...teor, status: 'acesso_falhou', motivo: 'processo-divergente' },
      status: 'acesso_falhou', motivo: 'processo-divergente', cabecalho: cabecalho.texto, divergencias };
  }
  return { citacao, ...alvo, ...dados, url_busca: alvo.busca, inteiro_teor: teor, status: 'ok', motivo: null, cabecalho_conferido: true, cabecalho: cabecalho.texto };
}

// --- reabrir: a fonte registrada ainda diz o mesmo? -------------------------

/** Elipses editoriais que o verificador usa para pular frases dentro de um trecho. */
const ELIPSE_EDITORIAL = /\(\.\.\.\)|\[\.\.\.\]|…|\.\.\./g;
const FRAGMENTO_MINIMO = 12;

/**
 * Forma comparável de um trecho: minúsculas, só letras e números, um espaço entre eles.
 * Travessão, aspas curvas e pontuação são o que o extrator de texto da página mais troca
 * por espaço (medido no run de 16/09/2026: o informativo do STF chegou sem os travessões
 * do acervo), e nada disso é o que a citação afirma.
 */
/**
 * Caracteres invisíveis que o extrator de PDF deixa dentro da palavra (espaço de largura zero,
 * não-juntor, juntor, juntor de palavra, BOM e hífen condicional). Saem antes de comparar, sem virar
 * espaço: medido no m2c da 0.9.82, a cópia da ADPF 323 trazia "j\u200Bá" e "cláusulas\u200B", a
 * chave lia "j a", e a reabertura deu o trecho como não localizado.
 */
// Alternância, não classe: o U+200D numa classe é sequência de junção para o lint.
const INVISIVEIS_DO_TRECHO = /\u00AD|\u200B|\u200C|\u200D|\u2060|\uFEFF/g;

function chaveDeTrecho(texto) {
  return normalizarTexto(String(texto ?? '').replace(INVISIVEIS_DO_TRECHO, '')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * O trecho registrado raramente é literal ao byte: traz "(...)" onde o verificador pulou
 * frases. Cada fragmento entre elipses é procurado na forma comparável; só fragmentos com
 * substância contam, e todos precisam estar presentes. `null` quando não há o que procurar.
 */
function trechoPresenteEm(texto, trecho) {
  const fragmentos = String(trecho || '').split(ELIPSE_EDITORIAL).map(chaveDeTrecho).filter((f) => f.length >= FRAGMENTO_MINIMO);
  if (!fragmentos.length || !texto) return null;
  const alvo = chaveDeTrecho(texto);
  return fragmentos.every((f) => alvo.includes(f));
}

const ehCaminhoAbsoluto = (p) => /^(\/|[A-Za-z]:[\\/])/.test(p);

/**
 * Evidência que aponta uma cópia do acervo assinado (`fonte_local` dentro de `acervo/`): o
 * que se reabre é o arquivo, não a web. O acervo é a fonte que o verificador leu, e a URL
 * oficial registrada ali é muitas vezes a do portal, sem o verbete (a Súmula 710/STF do
 * run de 16/09/2026 apontava a raiz do portal do STF e a reabertura pela web a deu como
 * "mudou"). Devolve o caminho quando o arquivo existe; null quando não é do acervo.
 */
function arquivoDoAcervo(fonteLocal, raiz) {
  if (typeof fonteLocal !== 'string' || !/(^|[\\/])acervo[\\/]/.test(fonteLocal)) return null;
  const caminho = ehCaminhoAbsoluto(fonteLocal) ? fonteLocal : join(raiz, fonteLocal);
  return existsSync(caminho) ? caminho : null;
}

/**
 * Metadados que o gerador de PDF troca a cada download sem tocar no conteúdo: datas do
 * dicionário Info, o `/ID` do trailer e as datas e ids do XMP. Medido na medição de
 * 24/09/2026: dois downloads seguidos do inteiro teor digitalizado do REsp 158.843-MG
 * (iText, imagem CCITT sem texto) diferem em 63 bytes, todos no ModDate, no CreationDate
 * e no `/ID`; a imagem é a mesma.
 */
const RE_METADADOS_VOLATEIS_PDF = /\/(?:ModDate|CreationDate)\s*\([^)]*\)|\/ID\s*\[\s*<[0-9A-Fa-f]*>\s*<[0-9A-Fa-f]*>\s*\]|<xmp:(?:ModifyDate|MetadataDate|CreateDate)>[^<]*<\/xmp:\w+>|<xmpMM:(?:InstanceID|DocumentID)>[^<]*<\/xmpMM:\w+>/g;

/** Hash do PDF sem os metadados voláteis: igual prova o mesmo conteúdo; diferente não prova nada. */
function sha256ConteudoPdf(buffer) {
  return sha256(Buffer.from(Buffer.from(buffer).toString('latin1').replace(RE_METADADOS_VOLATEIS_PDF, ''), 'latin1'));
}

const TIPO_POR_EXTENSAO = { '.pdf': 'pdf', '.html': 'html', '.htm': 'html', '.json': 'json', '.txt': 'texto' };

/** O texto de uma cópia local, extraído agora pelo extrator atual (o mesmo que extraiu a cópia nova). */
function textoDeCopia(bytes, tipo, pdftotext) {
  if (tipo === 'pdf') return textoDePdf(bytes, pdftotext) || null;
  if (tipo === 'html') return textoDeHtml(decodificarHtml(bytes, '')) || null;
  return normalizarTexto(bytes.toString('utf8')) || null;
}

/**
 * A cópia que a citação registrou, no disco: a `fonte_local` da evidência ou, no `--out` do run
 * (e na pasta `reabertura/` dele), um arquivo da mesma URL. Só vale a cópia cuja identidade o
 * hash registrado confirma: os bytes batem com `sha256_bytes`, ou o texto dela (ou o `.txt` ao
 * lado, que o extrator da época gravou) bate com `sha256_texto`. Sem hash registrado, nenhuma
 * cópia é "a registrada". Devolve { arquivo, tipo, bytes, texto } ou null.
 */
function copiaRegistrada(url, { fonteLocal, out, raiz, hashBytes, hashTexto, pdftotext }) {
  if (!hashBytes && !hashTexto) return null;
  const candidatos = [];
  if (typeof fonteLocal === 'string' && fonteLocal.trim()) candidatos.push(ehCaminhoAbsoluto(fonteLocal) ? fonteLocal : join(raiz, fonteLocal));
  const base = sha1(url);
  for (const dir of out ? [out, join(out, 'reabertura')] : []) {
    if (!existsSync(dir)) continue;
    for (const nome of readdirSync(dir).sort()) if (nome.startsWith(`${base}.`) && !nome.includes('.ocr.')) candidatos.push(join(dir, nome));
  }
  for (const arquivo of [...new Set(candidatos)]) {
    if (!existsSync(arquivo)) continue;
    const tipo = TIPO_POR_EXTENSAO[extname(arquivo).toLowerCase()];
    if (!tipo) continue;
    let bytes;
    try { bytes = readFileSync(arquivo); } catch { continue; }
    if (hashBytes && sha256(bytes) === hashBytes) return { arquivo, tipo, bytes, texto: textoDeCopia(bytes, tipo, pdftotext) };
    if (hashTexto && tipo === 'texto' && sha256(normalizarTexto(bytes.toString('utf8'))) === hashTexto) {
      // O `.txt` ao lado confirma a cópia pelo texto; o documento, se está ao lado, é reextraído.
      const semExt = arquivo.slice(0, -extname(arquivo).length);
      const documento = ['.pdf', '.html', '.json'].map((ext) => `${semExt}${ext}`).find((p) => existsSync(p));
      if (!documento) return { arquivo, tipo, bytes, texto: normalizarTexto(bytes.toString('utf8')) };
      const tipoDoc = TIPO_POR_EXTENSAO[extname(documento)];
      const bytesDoc = readFileSync(documento);
      return { arquivo: documento, tipo: tipoDoc, bytes: bytesDoc, texto: textoDeCopia(bytesDoc, tipoDoc, pdftotext) || normalizarTexto(bytes.toString('utf8')) };
    }
  }
  return null;
}

/**
 * Para cada citação registrada (manifesto ou tabela do cartório), refaz o acesso e compara.
 * Devolve no formato que `gate-verdict --citacoes` aceita:
 * - `verificada` quando a fonte oficial reaberta traz o mesmo conteúdo: bytes iguais, texto
 *   extraído igual (ao hash registrado ou ao texto da cópia registrada), PDF igual fora dos
 *   metadados voláteis, ou o trecho registrado ainda presente;
 * - `verificada_no_acervo` quando a evidência aponta a cópia do acervo assinado e o arquivo
 *   ainda traz o trecho (ou o hash do texto bate): a conferência é na captura oficial do
 *   curador, com o hash dela, e não se apresenta como se a página do tribunal tivesse aberto;
 * - `cancelada` quando essa cópia do acervo declara a súmula cancelada, revogada ou superada
 *   (campo `situacao` ou a marca da seção Situação, lida por `situacaoDoTexto`): existir no
 *   acervo não é estar vigente, e a citação volta ao cartório como contestação, com a
 *   `situacao` e a mensagem "súmula cancelada: não fundamente nela". Parcialmente cancelada ou
 *   alterada continua `verificada_no_acervo`, com `aviso`. Medido em 29/09/2026: a Súmula 228
 *   do TST, cancelada, passava como conferida;
 * - `fonte_mudou` só quando o TEXTO mudou (hash do texto ou texto da cópia registrada) e o
 *   trecho sumiu: bytes diferentes nunca bastam;
 * - `acesso_falhou` quando não abriu, com motivo, aviso e instrução;
 * - `sem_evidencia` quando não há o que comparar por código: sem hash e sem trecho, sem fonte,
 *   trecho não localizado, ou nenhum texto dos dois lados (PDF digitalizado sem a cópia
 *   registrada). `sem_evidencia` não é contestação: o cartório não derruba as confirmações da
 *   citação, só não conta confirmação nova, e o gate final a manda a um votante. Medido em
 *   24/09/2026 (G3, defeitos 4, 20, 29, 48): essas citações iam para uma lista `sem_hash` fora
 *   de `citations[]`, e o gate final fechava com 58 de 59 citações sem confirmação nova. A
 *   lista `sem_hash` continua, como espelho, para a narração.
 *
 * A cópia nova vai para `<out>/reabertura/<sha1>.<data>.<ext>`, e a registrada fica onde está:
 * é prova (G18, defeito 36: a reabertura antiga baixava por cima de `fontes/<sha1>.pdf`, e o
 * PDF do REsp 158.843-MG que o verificador registrou sumiu). O cache não é tocado.
 */
async function reabrir(citacoes, opts = {}) {
  const lista = Array.isArray(citacoes?.citations) ? citacoes.citations : Array.isArray(citacoes) ? citacoes : [];
  const raiz = typeof opts.raiz === 'string' && opts.raiz ? opts.raiz : process.cwd();
  const pdftotext = opts.pdftotext === undefined ? detectarPdftotext() : opts.pdftotext;
  const dirReabertura = opts.out ? join(opts.out, 'reabertura') : null;
  const saida = { citations: [], sem_hash: [], resumo: { igual: 0, no_acervo: 0, mudou: 0, sem_hash: 0, acesso_falhou: 0 } };
  const semEvidencia = (item) => {
    saida.citations.push({ status: 'sem_evidencia', consulted_at: new Date().toISOString(), verificador: 'reabertura', ...item });
    saida.sem_hash.push(item);
    saida.resumo.sem_hash += 1;
  };
  for (const c of lista) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.source_url !== 'string' || !c.source_url.trim()) {
      if (typeof c.title === 'string' && c.title.trim()) semEvidencia({ title: c.title, source_url: null, motivo: 'sem-fonte' });
      continue;
    }
    const ev = c.evidence || {};
    const hashTexto = c.sha256_texto || ev.sha256_texto || null;
    const hashBytes = c.sha256_bytes || ev.sha256_bytes || null;
    const trecho = c.trecho || ev.trecho || null;
    const fonteLocal = c.fonte_local || ev.fonte_local || null;
    if (!hashTexto && !hashBytes && !trecho) {
      semEvidencia({ title: c.title, source_url: c.source_url, motivo: 'sem-evidencia' });
      continue;
    }
    const acervo = arquivoDoAcervo(fonteLocal, raiz);
    if (acervo) {
      const conteudo = readFileSync(acervo, 'utf-8');
      const hashDoAcervo = sha256(normalizarTexto(conteudo));
      const porTrecho = trecho ? trechoPresenteEm(conteudo, trecho) === true : false;
      // A cópia do acervo que declara a súmula fora do fundamento não confirma nada: a citação
      // existe, e é justamente isso que não basta.
      const { situacao } = situacaoDoTexto(conteudo);
      if (SITUACOES_QUE_IMPEDEM.has(situacao)) {
        saida.citations.push({
          title: c.title, source_url: c.source_url, status: 'cancelada', situacao, motivo: mensagemDaSituacao(situacao), origem: 'acervo',
          consulted_at: new Date().toISOString(), sha256_texto: hashDoAcervo, sha256_bytes: null, comparado_por: 'acervo',
          fonte_local: acervo, verificador: 'reabertura',
        });
        // Só aparece no resumo quando houve: o formato de sempre continua o mesmo.
        saida.resumo.cancelada = (saida.resumo.cancelada || 0) + 1;
        continue;
      }
      if (porTrecho || (hashTexto && hashTexto === hashDoAcervo)) {
        saida.citations.push({
          title: c.title, source_url: c.source_url, status: 'verificada_no_acervo', origem: 'acervo', consulted_at: new Date().toISOString(),
          sha256_texto: hashDoAcervo, sha256_bytes: null, trecho_presente: porTrecho || null, comparado_por: 'acervo',
          fonte_local: acervo, verificador: 'reabertura',
          ...(SITUACOES_COM_AVISO.has(situacao) ? { situacao, aviso: mensagemDaSituacao(situacao) } : {}),
        });
        saida.resumo.no_acervo += 1;
        continue;
      }
    }
    // A cópia registrada é achada ANTES do download novo, que vai para outra pasta e nunca a substitui.
    const registrada = copiaRegistrada(c.source_url, { fonteLocal: acervo ? null : fonteLocal, out: opts.out, raiz, hashBytes, hashTexto, pdftotext });
    // Quem baixa pode ser a receita de navegação (o CLI injeta `baixarFonte`); sem ela, a escada de sempre.
    const baixarFonte = typeof opts.baixarFonte === 'function' ? opts.baixarFonte : baixar;
    const entrada = await baixarFonte(c.source_url, { ...opts, pdftotext, forcar: true, cache: null, out: dirReabertura, sempreComData: true, devolverCorpo: true, registrada: { sha256_texto: hashTexto, sha256_bytes: hashBytes } });
    const agora = entrada.baixado_em;
    if (entrada.status !== 'ok') {
      saida.citations.push({
        title: c.title, source_url: c.source_url, status: 'acesso_falhou', consulted_at: agora, motivo: entrada.motivo, verificador: 'reabertura',
        ...(entrada.aviso ? { aviso: entrada.aviso } : {}), ...(entrada.instrucao ? { instrucao: entrada.instrucao } : {}),
      });
      saida.resumo.acesso_falhou += 1;
      continue;
    }
    const textoNovo = entrada.texto_extraido || null;
    let igual = null;
    let por = null;
    if (hashBytes && hashBytes === entrada.sha256_bytes) { igual = true; por = 'bytes'; }
    else if (hashTexto && entrada.sha256_texto && hashTexto === entrada.sha256_texto) { igual = true; por = 'texto'; }
    else if (registrada && registrada.texto && textoNovo) { igual = sha256(registrada.texto) === entrada.sha256_texto; por = 'texto'; }
    else if (hashTexto && entrada.sha256_texto) { igual = false; por = 'texto'; }
    else if (registrada && registrada.tipo === 'pdf' && entrada.tipo === 'pdf' && sha256ConteudoPdf(registrada.bytes) === sha256ConteudoPdf(entrada.corpo)) { igual = true; por = 'conteudo-pdf'; }
    // Bytes diferentes sem texto para comparar não provam mudança: `igual` fica null.
    const trechoPresente = trecho ? trechoPresenteEm(textoNovo, trecho) : null;
    const comum = {
      title: c.title, source_url: c.source_url, consulted_at: agora, sha256_texto: entrada.sha256_texto, sha256_bytes: entrada.sha256_bytes,
      fonte_local: entrada.arquivo, ...(registrada ? { fonte_registrada: registrada.arquivo } : {}),
    };
    // Cópia gravada por navegação guiada (a página que o clique abriu, não a que a URL devolve
    // sozinha) comparada com um download cego da mesma URL: texto diferente ali não prova mudança,
    // prova só que a URL sem os cliques serve outra coisa. Sem receita que refaça o caminho, vai a
    // um votante, nunca a `fonte_mudou`.
    if (igual === false && trechoPresente !== true && !entrada.receita && copiaDeNavegacao(opts.out, c.source_url)) {
      semEvidencia({ ...comum, motivo: 'copia-de-navegacao-sem-receita' });
      continue;
    }
    if (igual !== true && trechoPresente !== true && igual !== false) {
      // Nada provou igualdade nem mudança: só trecho, e ele não foi localizado; ou nenhum texto dos
      // dois lados. Volta como `sem_evidencia`, sem derrubar a confirmação que o verificador já
      // deu (uma contestação apagaria as confirmações), e vai a um votante.
      semEvidencia({ ...comum, motivo: trecho && textoNovo ? 'trecho-nao-localizado' : 'sem-texto-comparavel' });
      continue;
    }
    const status = igual === true || trechoPresente === true ? 'verificada' : 'fonte_mudou';
    saida.citations.push({
      ...comum, status, trecho_presente: trechoPresente,
      comparado_por: igual === true ? por : trechoPresente === true ? 'trecho' : por,
      verificador: 'reabertura',
    });
    saida.resumo[status === 'verificada' ? 'igual' : 'mudou'] += 1;
  }
  return saida;
}

/**
 * A marca que a navegação guiada deixa ao lado da cópia que gravou (`navegacao-<sha1 da URL>.json`
 * no `--out`): a cópia veio de cliques, e a URL sozinha pode não servir o mesmo documento.
 */
const nomeDaMarcaDeNavegacao = (url) => `navegacao-${sha1(url)}.json`;
function copiaDeNavegacao(out, url) {
  if (!out || !url) return false;
  return existsSync(join(out, nomeDaMarcaDeNavegacao(url)));
}

const FORA_DO_INDICE = new Set(['texto_extraido', 'corpo', 'html', 'content_type']);

/** O índice guarda o caminho da cópia, nunca o corpo: um JSONL de run não é lugar para megabytes de PDF. */
function linhaDeIndice(entrada) {
  const resto = Object.fromEntries(Object.entries(entrada).filter(([chave]) => !FORA_DO_INDICE.has(chave)));
  return `${JSON.stringify(resto)}\n`;
}
// <<< fonte-oficial:end

// ---------------------------------------------------------------------------
// Navegação guiada e receitas: cópia VERBATIM de src/fonte-navegacao.js
// (guardada por scripts/sync-blocos.mjs, como o bloco acima).
// ---------------------------------------------------------------------------
// >>> fonte-navegacao:begin
const NAV_MAX_PASSOS = 12;
const NAV_MAX_TEMPO_S = 300;
const NAV_TIMEOUT_ACAO_MS = 30000;
const NAV_ELEMENTOS_NA_LISTA = 80;
const NAV_TRECHO = 1200;
const NAV_PAGINA_DE_LEITURA = 12000;
const NAV_MAX_RECEITAS_POR_PESQUISA = 20;
/** As ações que tocam a página e contam no limite de passos; ler, procurar, gravar e fechar não contam. */
const ACOES_QUE_CONTAM = new Set(['abrir', 'clicar', 'digitar', 'enviar', 'selecionar', 'voltar']);
/** As que podem fazer pedido ao site: antes delas, a espera por domínio. */
const ACOES_QUE_PEDEM = new Set(['abrir', 'clicar', 'enviar', 'selecionar', 'voltar']);
const MOTIVOS_DE_BARREIRA = new Set(['captcha', 'login', 'desafio-anti-robo', 'limite-de-acesso', 'http-403', 'http-401']);

const INSTRUCAO_BARREIRA = 'A página pediu captcha, login ou verificação anti-robô, ou recusou o acesso: o navegador guiado não resolve nem contorna nada disso. Confira a fonte abrindo a página no navegador do profissional (quem conferir registra o que leu, com a data) ou pela cópia do acervo assinado (verificada_no_acervo); sem conferência, a citação sai da peça ou vai sem o dado que só essa página daria.';

// --- o que roda dentro da página (texto, para valer igual em qualquer quadro) -----------------

/** Seletores do que se pode interagir; `[onclick]` e `summary` só quando não embrulham outro alvo. */
const SELETOR_INTERATIVO = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=combobox], [role=searchbox], [role=textbox], summary, [onclick]';

/**
 * Numera os elementos visíveis a partir de `inicio`, marca cada um com `data-ls-n` (é por essa marca
 * que a ação acha o alvo no comando seguinte, mesmo reatando o navegador) e devolve a descrição.
 */
const JS_ELEMENTOS = `(inicio) => {
  const SEL = ${JSON.stringify(SELETOR_INTERATIVO)};
  const visivel = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0; };
  const limpo = (t, n) => String(t || '').replace(/\\s+/g, ' ').trim().slice(0, n || 100);
  for (const e of document.querySelectorAll('[data-ls-n]')) e.removeAttribute('data-ls-n');
  const rotuloDe = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return aria;
    const ids = el.getAttribute('aria-labelledby');
    if (ids) { const t = ids.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((x) => x.innerText).join(' '); if (t.trim()) return t; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
    const pai = el.closest('label'); if (pai && pai !== el) return pai.innerText;
    return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
  };
  const tipoDe = (el) => {
    const t = el.tagName.toLowerCase(); const r = el.getAttribute('role');
    if (t === 'a') return 'link';
    if (t === 'select') return 'lista';
    if (t === 'textarea') return 'campo';
    if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); if (['submit', 'button', 'image', 'reset'].includes(ty)) return 'botao'; if (ty === 'checkbox') return 'caixa'; if (ty === 'radio') return 'opcao'; return 'campo'; }
    if (t === 'button' || r === 'button') return 'botao';
    if (r === 'link') return 'link'; if (r === 'tab') return 'aba'; if (r === 'checkbox') return 'caixa';
    if (['textbox', 'searchbox', 'combobox'].includes(r)) return 'campo';
    return r || 'clicavel';
  };
  const zona = (el) => el.closest('main, article, [role=main], #conteudo, #content, .conteudo, .content') ? 'conteudo'
    : el.closest('nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]') ? 'moldura' : 'pagina';
  const itens = []; let n = inicio;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visivel(el) || el.closest('[aria-hidden="true"]')) continue;
    const tag = el.tagName.toLowerCase();
    if (!['a', 'button', 'input', 'select', 'textarea'].includes(tag) && el.querySelector('a[href], button, input, select, textarea')) continue;
    n += 1; el.setAttribute('data-ls-n', String(n));
    const tipo = tipoDe(el);
    const ty = (el.getAttribute('type') || '').toLowerCase();
    const item = { n, tipo, tag, texto: tag === 'select' ? '' : limpo(el.innerText || (tipo === 'botao' ? el.value : ''), 120), rotulo: limpo(rotuloDe(el), 80), zona: zona(el) };
    if (el.id) item.id = el.id;
    if (el.getAttribute('name')) item.name = el.getAttribute('name');
    if (tag === 'a') item.href = el.href;
    if (tag === 'input') item.input = ty || 'text';
    if (ty === 'password') item.senha = true;
    if (tipo === 'campo' && ty !== 'password' && el.value) item.valor = limpo(el.value, 60);
    if (tag === 'select') { item.opcoes = [...el.options].slice(0, 15).map((o) => limpo(o.text, 40)); item.valor = limpo(el.options[el.selectedIndex] && el.options[el.selectedIndex].text, 40); }
    if (el.disabled) item.desabilitado = true;
    itens.push(item);
  }
  return itens;
}`;

/**
 * Barreira que o código não atravessa: captcha visível (widget, quadro do provedor, imagem ou campo
 * de captcha, texto "não sou um robô"), página de desafio anti-robô (Cloudflare), login (campo de
 * senha visível). O reCAPTCHA invisível (a insígnia, `size=invisible`) não pede nada a ninguém e só
 * vira aviso.
 */
const JS_BARREIRA = `() => {
  const visivel = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const algum = (sel) => [...document.querySelectorAll(sel)].some(visivel);
  const titulo = document.title || '';
  const corpo = (document.body && document.body.innerText || '').slice(0, 6000);
  const html = document.documentElement ? document.documentElement.outerHTML.slice(0, 300000) : '';
  const quadrosDeCaptcha = [...document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="recaptcha/enterprise/bframe"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"]')]
    .filter((f) => visivel(f) && !/size=invisible/.test(f.getAttribute('src') || ''));
  const widget = algum('.g-recaptcha:not([data-size=invisible]), .h-captcha, .cf-turnstile, #challenge-form, #challenge-stage, #cf-challenge-running, img[src*="captcha" i], img[id*="captcha" i], input[name*="captcha" i], input[id*="captcha" i]');
  const textoDeCaptcha = /n[ãa]o sou um rob[ôo]|I'?m not a robot|verify you are human|confirme que voc[êe] [ée] humano|digite os caracteres (?:da|na) imagem|c[óo]digo da imagem/i.test(corpo);
  const desafio = /^(?:Just a moment|Attention Required|Um momento)/i.test(titulo.trim()) || /__cf_chl_|cf-chl-(?:bypass|widget)|challenge-platform\\/h\\//.test(html);
  const login = algum('input[type=password]');
  const invisivel = /grecaptcha-badge|recaptcha\\/api\\.js\\?render=|size=invisible/.test(html);
  return { captcha: quadrosDeCaptcha.length > 0 || widget || textoDeCaptcha, desafio, login, recaptcha_invisivel: invisivel };
}`;

/**
 * O botão "copiar link" do próprio site (link permanente do documento) escreve na área de
 * transferência. Na página, a escrita é anotada em vez de ir ao sistema: o endereço que o site
 * declara como o do documento vira candidato a fonte no `--gravar`.
 */
const JS_VIGIAR_COPIA = `() => {
  if (window.__lsVigiaCopia) return;
  window.__lsVigiaCopia = true;
  window.__lsCopiado = null;
  const anotar = (t) => { window.__lsCopiado = String(t || '').slice(0, 2000); return Promise.resolve(); };
  try { if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: anotar, configurable: true }); } catch (e) { /* sem área de transferência */ }
  document.addEventListener('copy', (e) => {
    const dados = e.clipboardData && e.clipboardData.getData('text/plain');
    const selecao = String(document.getSelection() || '');
    if (dados || selecao) window.__lsCopiado = String(dados || selecao).slice(0, 2000);
  }, true);
}`;

/** O endereço que a página declara como seu: `link rel=canonical` ou `og:url`. */
const JS_CANONICO = `() => {
  const l = document.querySelector('link[rel=canonical]');
  const m = document.querySelector('meta[property="og:url"]');
  return (l && l.href) || (m && m.content) || null;
}`;

/** O texto útil: o conteúdo principal quando a página marca um (main, article), senão o corpo. */
const JS_TEXTO = `() => {
  const principal = document.querySelector('main, article, [role=main], #conteudo, #content');
  const bruto = principal && principal.innerText && principal.innerText.trim().length > 200 ? principal.innerText : (document.body ? document.body.innerText : '');
  let status = null;
  try { const nav = performance.getEntriesByType('navigation')[0]; status = nav && nav.responseStatus || null; } catch (e) { status = null; }
  return { titulo: document.title || '', texto: String(bruto || ''), tipo: document.contentType || '', status };
}`;

/**
 * Acha na página o alvo de um passo gravado, pela identidade que não depende da posição na lista:
 * id, name, href, texto visível, rótulo. Marca o achado com `data-ls-n="alvo"`; devolve se achou.
 */
const JS_ACHAR_ALVO = `(alvo) => {
  const SEL = ${JSON.stringify(SELETOR_INTERATIVO)};
  const visivel = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
  const chave = (t) => String(t || '').normalize('NFC').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();
  for (const e of document.querySelectorAll('[data-ls-n="alvo"]')) e.removeAttribute('data-ls-n');
  let melhor = null; let nota = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visivel(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (alvo.tag && tag !== alvo.tag) continue;
    let pontos = 0;
    if (alvo.id && el.id === alvo.id) pontos += 4;
    if (alvo.name && el.getAttribute('name') === alvo.name) pontos += 3;
    if (alvo.href && tag === 'a' && el.href === alvo.href) pontos += 3;
    const texto = chave(el.innerText || el.value);
    if (alvo.texto && texto && texto === chave(alvo.texto)) pontos += 2;
    const rotulo = chave(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'));
    if (alvo.rotulo && rotulo && rotulo === chave(alvo.rotulo)) pontos += 1;
    if (pontos > nota) { nota = pontos; melhor = el; }
  }
  if (!melhor || nota < 2) return false;
  melhor.setAttribute('data-ls-n', 'alvo');
  return true;
}`;

// --- sessão: arquivo, navegador, vigia ------------------------------------------------------

const agoraMs = () => Date.now();
const semCampos = (objeto, ...campos) => Object.fromEntries(Object.entries(objeto).filter(([chave]) => !campos.includes(chave)));
const esperar = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function idDeSessao(quando = new Date()) {
  const carimbo = quando.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `nav-${carimbo}-${sha1(`${quando.getTime()}-${Math.random()}`).slice(0, 6)}`;
}

/** A pasta da sessão: o caminho que `--navegar` devolveu, ou o id dentro de `<out>/navegacao/`. */
function dirDaSessao(ref, out) {
  if (!ref || typeof ref !== 'string') return null;
  if (existsSync(join(ref, 'sessao.json'))) return resolve(ref);
  if (out && existsSync(join(out, 'navegacao', ref, 'sessao.json'))) return resolve(join(out, 'navegacao', ref));
  return null;
}

function lerSessao(dir) {
  return JSON.parse(readFileSync(join(dir, 'sessao.json'), 'utf8'));
}

function gravarSessao(dir, sessao) {
  writeFileSync(join(dir, 'sessao.json'), `${JSON.stringify(sessao, null, 1)}\n`);
}

function anotarNoIndice(out, linha) {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  appendFileSync(join(out, 'INDEX.jsonl'), linhaDeIndice(linha));
}

/** Host aceito na navegação: oficial; em teste (`permitirHttp`), também o servidor de fixture local. */
function hostAceito(url, permitirHttp) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:' && ehHostOficial(u.hostname)) return true;
  return Boolean(permitirHttp) && /^https?:$/.test(u.protocol) && ['127.0.0.1', 'localhost'].includes(u.hostname);
}

/**
 * O vigia: um processo Node à parte que mata o navegador e apaga o perfil quando o prazo da sessão
 * passa. É o que garante que um chefe que esqueceu o `--fechar` não deixa Chromium rodando.
 */
const JS_VIGIA = "const [pid, ms, perfil] = process.argv.slice(1); setTimeout(() => { try { process.kill(-Number(pid)); } catch (e) { try { process.kill(Number(pid)); } catch (e2) { /* já saiu */ } } setTimeout(() => { try { require('fs').rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* já foi */ } process.exit(0); }, 3000); }, Number(ms));";

async function lancarNavegador(chromium, dirSessao, prazoMs) {
  const perfil = join(dirSessao, 'perfil');
  mkdirSync(perfil, { recursive: true });
  const executavel = chromium.executablePath();
  // Sem User-Agent trocado: o Chromium headless se apresenta como é ("HeadlessChrome").
  const filho = spawn(executavel, [
    '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${perfil}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--lang=pt-BR', '--window-size=1280,900', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  filho.unref();
  filhosDesteProcesso.set(filho.pid, filho);
  const arquivoDaPorta = join(perfil, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(arquivoDaPorta); i += 1) await esperar(100);
  if (!existsSync(arquivoDaPorta)) {
    try { process.kill(filho.pid); } catch { /* não subiu */ }
    return { erro: 'o navegador não abriu a porta de depuração em 15 s' };
  }
  let porta = '';
  for (let i = 0; i < 20 && !/^\d+$/.test(porta); i += 1) { porta = readFileSync(arquivoDaPorta, 'utf8').split('\n')[0].trim(); if (!/^\d+$/.test(porta)) await esperar(50); }
  const vigia = spawn(process.execPath, ['-e', JS_VIGIA, String(filho.pid), String(Math.max(0, prazoMs - agoraMs()) + 20000), perfil], { detached: true, stdio: 'ignore' });
  vigia.unref();
  return { pid: filho.pid, porta: Number(porta), vigia: vigia.pid };
}

/** Os navegadores lançados por este processo: o estado de saída deles vem do próprio objeto (um filho morto e não colhido ainda responde a `kill 0`). */
const filhosDesteProcesso = new Map();
const vivo = (pid) => {
  const filho = filhosDesteProcesso.get(pid);
  if (filho) return filho.exitCode === null && filho.signalCode === null;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Mata o grupo do processo (o Chromium e os filhos dele) quando o sistema deixa; senão, o processo. */
function matar(pid, sinal = 'SIGTERM') {
  if (process.platform !== 'win32') { try { process.kill(-pid, sinal); return; } catch { /* sem grupo */ } }
  try { process.kill(pid, sinal); } catch { /* já saiu */ }
}

async function encerrarNavegador(dirSessao, sessao) {
  const nav = sessao.navegador || {};
  if (nav.vigia) matar(nav.vigia);
  if (nav.pid) {
    matar(nav.pid);
    for (let i = 0; i < 50 && vivo(nav.pid); i += 1) await esperar(100);
    if (vivo(nav.pid)) matar(nav.pid, 'SIGKILL');
  }
  // O perfil é do navegador desta sessão, criado por ela: some junto. A pasta da sessão (sessao.json) fica, para auditoria.
  const perfil = join(dirSessao, 'perfil');
  for (let i = 0; i < 20; i += 1) {
    try { rmSync(perfil, { recursive: true, force: true }); if (!existsSync(perfil)) break; } catch { /* o navegador ainda solta os arquivos */ }
    await esperar(100);
  }
}

/**
 * Reata o navegador da sessão na aba em que o último passo parou. A ordem das abas não sobrevive à
 * reconexão (medido no STF em 27/09/2026: o link da súmula abriu em aba nova, e o `--gravar`
 * seguinte reatou na aba da busca): a aba ativa é a que está na URL que o último passo observou.
 */
async function conectar(chromium, sessao) {
  const navegador = await chromium.connectOverCDP(`http://127.0.0.1:${sessao.navegador.porta}`, { timeout: 10000 });
  const contexto = navegador.contexts()[0];
  const paginas = contexto.pages();
  const naUrl = sessao.url_atual ? paginas.filter((p) => p.url() === sessao.url_atual) : [];
  const pagina = naUrl[naUrl.length - 1] || paginas[paginas.length - 1] || await contexto.newPage();
  return { navegador, contexto, pagina };
}

/** Espera a página assentar sem confiar no evento de carga (o visualizador de PDF o perde). */
async function assentar(pagina, timeoutMs = NAV_TIMEOUT_ACAO_MS) {
  await esperar(300);
  const limite = agoraMs() + timeoutMs;
  while (agoraMs() < limite) {
    const estado = await pagina.evaluate('document.readyState').catch(() => null);
    if (estado === 'complete' || estado === 'interactive') break;
    await esperar(200);
  }
  await pagina.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => null);
  // Página que monta o conteúdo depois da carga (medido no portal de legislação do Planalto em
  // 27/09/2026: título e corpo vazios no DOMContentLoaded): espera o corpo ter texto, até 8 s.
  const ate = agoraMs() + 8000;
  while (agoraMs() < ate) {
    const letras = await pagina.evaluate('(document.body && document.body.innerText || "").trim().length').catch(() => 0);
    if (letras > 40) break;
    await esperar(300);
  }
}

/**
 * Pode-se passar por aqui? Host oficial por http ou https: o portal que ainda linka `http://` redireciona
 * para `https://` (medido no STF em 27/09/2026, o link "Súmulas" do portal de jurisprudência). Gravar
 * continua exigindo https (`hostAceito`).
 */
function hostNavegavel(url, permitirHttp) {
  if (hostAceito(url, permitirHttp)) return true;
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) && ehHostOficial(u.hostname); } catch { return false; }
}

/** A navegação de página inteira para fora da fonte oficial é recusada no próprio navegador. */
async function prenderAFonteOficial(contexto, permitirHttp) {
  await contexto.route(() => true, (rota) => {
    const pedido = rota.request();
    const quadro = (() => { try { return pedido.frame(); } catch { return null; } })();
    const principal = quadro && !quadro.parentFrame();
    if (pedido.isNavigationRequest() && principal && !hostNavegavel(pedido.url(), permitirHttp) && !/^(about|data|blob|chrome-error):/.test(pedido.url())) return rota.abort('blockedbyclient');
    return rota.continue();
  }).catch(() => null);
}

// --- observar ---------------------------------------------------------------------------------

async function barreiraDaPagina(pagina) {
  const b = await pagina.evaluate(`(${JS_BARREIRA})()`).catch(() => null);
  if (!b) return { motivo: null };
  if (b.captcha) return { motivo: 'captcha', recaptcha_invisivel: b.recaptcha_invisivel };
  if (b.desafio) return { motivo: 'desafio-anti-robo', recaptcha_invisivel: b.recaptcha_invisivel };
  if (b.login) return { motivo: 'login', recaptcha_invisivel: b.recaptcha_invisivel };
  return { motivo: null, recaptcha_invisivel: b.recaptcha_invisivel };
}

/** Numera os elementos de todos os quadros (o principal primeiro), com a numeração contínua. */
async function numerarElementos(pagina) {
  const itens = [];
  for (const quadro of pagina.frames().slice(0, 6)) {
    const url = quadro.url();
    if (!url || /^about:blank$/.test(url)) continue;
    const doQuadro = await quadro.evaluate(`(${JS_ELEMENTOS})(${itens.length})`).catch(() => []);
    for (const item of doQuadro) itens.push(quadro === pagina.mainFrame() ? item : { ...item, quadro: url });
  }
  return itens;
}

/** O que mostrar da lista: campos, botões e listas sempre; links do conteúdo antes dos da moldura. */
function escolherParaMostrar(itens, limite = NAV_ELEMENTOS_NA_LISTA, filtro = null) {
  if (filtro) {
    const alvo = chaveDeTrecho(filtro);
    return itens.filter((i) => [i.texto, i.rotulo, i.href, i.name, i.id].some((v) => v && chaveDeTrecho(v).includes(alvo))).slice(0, 50);
  }
  if (itens.length <= limite) return itens;
  const peso = (i) => (i.tipo !== 'link' ? 0 : i.zona === 'conteudo' ? 1 : i.zona === 'pagina' ? 2 : 3);
  return [...itens].sort((a, b) => peso(a) - peso(b) || a.n - b.n).slice(0, limite).sort((a, b) => a.n - b.n);
}

async function observar(pagina, { filtro = null, trecho = NAV_TRECHO } = {}) {
  const texto = await pagina.evaluate(`(${JS_TEXTO})()`).catch(() => ({ titulo: '', texto: '', tipo: '', status: null }));
  const barreira = await barreiraDaPagina(pagina);
  const itens = barreira.motivo ? [] : await numerarElementos(pagina);
  const util = normalizarTexto(texto.texto);
  return {
    url: pagina.url(), titulo: normalizarTexto(texto.titulo), tipo_conteudo: texto.tipo, http: texto.status,
    trecho: util.slice(0, trecho), tamanho_texto: util.length, barreira: barreira.motivo,
    ...(barreira.recaptcha_invisivel ? { aviso: 'a página carrega o reCAPTCHA invisível; o navegador guiado não o contorna: se o site recusar, é acesso_falhou' } : {}),
    elementos: escolherParaMostrar(itens, NAV_ELEMENTOS_NA_LISTA, filtro), elementos_total: itens.length,
    todos: itens,
  };
}

// --- agir -------------------------------------------------------------------------------------

async function elementoMarcado(pagina, n) {
  for (const quadro of pagina.frames()) {
    const el = await quadro.$(`[data-ls-n="${n}"]`).catch(() => null);
    if (el) return el;
  }
  return null;
}

/** Espera entre pedidos ao mesmo domínio: o tribunal não leva rajada, nem de navegador. */
async function respeitarRitmo(sessao, url, esperaMs) {
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  const ultimo = (sessao.ultimo_acesso || {})[host] || 0;
  await esperar(ultimo + esperaMs - agoraMs());
}

function anotarAcesso(sessao, ...urls) {
  sessao.ultimo_acesso = sessao.ultimo_acesso || {};
  for (const url of urls) {
    try { sessao.ultimo_acesso[new URL(url).hostname] = agoraMs(); } catch { /* sem host */ }
  }
}

class ErroDeUso extends Error {}

/** O que a sessão guarda de cada elemento: a identidade que a receita usa para achá-lo de novo. */
const descricoesParaReceita = (itens) => (itens || []).map(({ n, tag, tipo, texto, rotulo, id, name, href, input }) => ({ n, tag, tipo, texto, rotulo, id, name, href, input }));

/**
 * Uma ação sobre a página. Recusa por código o que não se faz: digitar em campo de senha (credencial
 * não entra) ou de captcha (captcha não se resolve). Devolve a página ativa depois da ação (link com
 * `target=_blank` abre aba nova, e a sessão segue nela).
 */
async function agir(pagina, contexto, acao, sessao, { esperaMs = ESPERA_PADRAO_MS } = {}) {
  const antes = pagina.url();
  if (ACOES_QUE_PEDEM.has(acao.acao)) await respeitarRitmo(sessao, acao.url || antes, esperaMs);
  const abas = contexto.pages().length;
  const alvo = ['clicar', 'digitar', 'enviar', 'selecionar'].includes(acao.acao) ? await elementoMarcado(pagina, acao.n) : null;
  if (['clicar', 'digitar', 'enviar', 'selecionar'].includes(acao.acao) && !alvo) {
    throw new ErroDeUso(`o elemento [${acao.n}] não existe na página atual; a lista mudou: use os números da última resposta`);
  }
  if (alvo && ['digitar', 'enviar'].includes(acao.acao)) {
    const campo = await alvo.evaluate((el) => ({ tipo: (el.getAttribute('type') || '').toLowerCase(), nome: `${el.getAttribute('name') || ''} ${el.id || ''} ${el.getAttribute('placeholder') || ''}` })).catch(() => ({ tipo: '', nome: '' }));
    if (campo.tipo === 'password') throw new ErroDeUso('campo de senha: o navegador guiado não digita credencial; página com login é acesso_falhou');
    if (/captcha/i.test(campo.nome) && acao.acao === 'digitar') throw new ErroDeUso('campo de captcha: captcha não se resolve; é acesso_falhou');
  }
  // O envio de formulário fica anotado (destino e campos): no --gravar, o mesmo envio por GET é o
  // candidato a URL que serve o documento sozinha, quando a página final não tem uma.
  const formulario = alvo && ['clicar', 'enviar'].includes(acao.acao) ? await alvo.evaluate(capturarFormulario, acao.acao).catch(() => null) : null;
  if (acao.acao === 'clicar') await pagina.evaluate(`(${JS_VIGIAR_COPIA})()`).catch(() => null);
  const t = { timeout: NAV_TIMEOUT_ACAO_MS };
  switch (acao.acao) {
    // Até o DOMContentLoaded: com `commit`, a observação seguinte ainda lia o about:blank (medido no Planalto, 27/09/2026: 0 elementos).
    case 'abrir': await pagina.goto(acao.url, { waitUntil: 'domcontentloaded', ...t }); break;
    case 'clicar': await alvo.click({ timeout: 10000 }); break;
    case 'digitar': await alvo.fill(String(acao.texto ?? ''), { timeout: 10000 }); break;
    case 'enviar': {
      const tag = await alvo.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
      if (['input', 'textarea'].includes(tag)) await alvo.press('Enter', { timeout: 10000 });
      else await alvo.click({ timeout: 10000 });
      break;
    }
    case 'selecionar': {
      const opcao = String(acao.opcao ?? acao.texto ?? '');
      await alvo.selectOption({ label: opcao }, { timeout: 10000 }).catch(() => alvo.selectOption(opcao, { timeout: 10000 }));
      break;
    }
    case 'voltar': {
      const volta = await pagina.goBack({ waitUntil: 'commit', ...t }).catch(() => null);
      if (!volta && contexto.pages().length > 1) { await pagina.close().catch(() => null); }
      break;
    }
    default: throw new ErroDeUso(`ação desconhecida: ${acao.acao}`);
  }
  await esperar(acao.acao === 'digitar' ? 0 : 500);
  const paginas = contexto.pages();
  const ativa = paginas.length > abas || acao.acao === 'voltar' ? paginas[paginas.length - 1] : pagina;
  if (acao.acao !== 'digitar') await assentar(ativa);
  anotarAcesso(sessao, antes, ativa.url());
  const copiado = acao.acao === 'clicar' && ativa === pagina ? await pagina.evaluate('window.__lsCopiado || null').catch(() => null) : null;
  return { pagina: ativa, nova_aba: paginas.length > abas, ...(formulario ? { formulario } : {}), ...(copiado ? { copiado } : {}) };
}

/**
 * Roda na página: o formulário que o clique (num botão de envio) ou o Enter (num campo) submete,
 * com os campos como ficaram, sem senha. `null` quando não há envio de formulário.
 */
function capturarFormulario(el, acao) {
  const f = el.form || el.closest('form');
  if (!f) return null;
  const tag = el.tagName.toLowerCase();
  const tipo = (el.getAttribute('type') || '').toLowerCase();
  const envia = acao === 'enviar' || (tag === 'button' && !['button', 'reset'].includes(tipo)) || (tag === 'input' && ['submit', 'image'].includes(tipo));
  if (!envia) return null;
  const campos = new URLSearchParams();
  for (const c of f.elements) {
    if (!c.name || c.disabled || (c.type || '').toLowerCase() === 'password') continue;
    const t = (c.type || '').toLowerCase();
    if (['submit', 'button', 'image', 'reset', 'file'].includes(t)) continue;
    if (['checkbox', 'radio'].includes(t) && !c.checked) continue;
    if (c.tagName.toLowerCase() === 'select' && c.multiple) { for (const o of c.selectedOptions) campos.append(c.name, o.value); continue; }
    campos.append(c.name, c.value);
  }
  if (el.name && (tag === 'button' || ['submit', 'image'].includes(tipo))) campos.append(el.name, el.value || '');
  return { action: f.action, method: (f.getAttribute('method') || 'get').toLowerCase(), campos: campos.toString().slice(0, 4000) };
}

/** O envio de formulário anotado, refeito por GET: destino + campos na query. */
function urlDoFormulario(formulario) {
  if (!formulario || !formulario.action) return null;
  try { const u = new URL(formulario.action); u.search = formulario.campos || ''; return u.toString(); } catch { return null; }
}

// --- parâmetros: o que variou entre um uso e outro --------------------------------------------

const ehNumero = (v) => /^[\d.\-/]+$/.test(String(v)) && /\d/.test(String(v));
const soDigitos = (v) => String(v).replace(/\D/g, '');

/** O texto traz o valor pedido? Número vale com ou sem pontuação ("1.234" = "1234"); texto, pela chave. */
function textoContem(texto, valor) {
  if (valor === undefined || valor === null || valor === '') return true;
  if (ehNumero(valor)) {
    const alvo = soDigitos(valor);
    return (String(texto || '').match(/\d[\d.\-/]*/g) || []).some((m) => soDigitos(m) === alvo);
  }
  return chaveDeTrecho(texto).includes(chaveDeTrecho(valor));
}

function faltamParametros(texto, params) {
  return Object.entries(params || {}).filter(([, v]) => !textoContem(texto, v)).map(([k]) => k);
}

const escaparRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Troca cada valor de parâmetro pelo seu nome entre chaves, só onde ele aparece inteiro. */
function parametrizar(texto, params) {
  let saida = String(texto ?? '');
  const pares = Object.entries(params || {}).filter(([, v]) => String(v).length >= 1).sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [nome, valor] of pares) {
    const variantes = new Set([String(valor)]);
    if (ehNumero(valor)) variantes.add(soDigitos(valor));
    // Número se separa só de outro dígito ("l8078.htm" é a Lei 8.078 no Planalto; "18078" não é); texto, de letra e dígito.
    const borda = ehNumero(valor) ? '\\d' : '[\\p{L}\\p{N}]';
    for (const v of variantes) saida = saida.replace(new RegExp(`(?<!${borda})${escaparRe(v)}(?!${borda})`, 'gu'), `{${nome}}`);
  }
  return saida;
}

function preencher(texto, params) {
  return String(texto ?? '').replace(/\{([\w-]+)\}/g, (m, nome) => (params && params[nome] !== undefined ? String(params[nome]) : m));
}

function temTodos(texto, params) {
  return Object.keys(params || {}).every((nome) => String(texto).includes(`{${nome}}`));
}

// --- conferir se uma URL serve o documento sozinha ----------------------------------------------

/**
 * O script de detecção que o Cloudflare injeta em página servida (`/cdn-cgi/challenge-platform/
 * scripts/jsd/…`) não é desafio: a página veio inteira. Na classificação da navegação ele sai da
 * amostra (só da amostra: os bytes gravados são os que chegaram). Medido na prova de 27/09/2026: a
 * URL permanente do Tema 1076 no STJ abriu com o tema na tela e foi dada como captcha por esse
 * trecho. O desafio de verdade (Just a moment, cf-chl, recaptcha) continua barreira.
 */
const RE_DETECCAO_CLOUDFLARE_NAV = /\/cdn-cgi\/challenge-platform\/scripts\/jsd\/[^'"\s<]*/gi;

function classificarParaNavegacao(url, resposta) {
  const corpo = resposta.corpo ? Buffer.from(resposta.corpo.toString('latin1').replace(RE_DETECCAO_CLOUDFLARE_NAV, ' '), 'latin1') : resposta.corpo;
  return classificarResposta({ urlPedida: url, ...resposta, corpo });
}

/**
 * Busca uma URL para conferir se ela serve o documento sozinha, sem gravar nada: do cache quando há
 * cópia (e o cache vale), senão um GET com os cabeçalhos e a espera por domínio de sempre; diante de
 * gateway (desafio de JavaScript, TLS, 5xx), a escada inteira de `baixar`. Barreira volta como está.
 */
async function buscarParaConferir(url, opts = {}) {
  const { pdftotext, esperaMs = ESPERA_PADRAO_MS, ultimoAcesso = new Map(), timeoutMs = TIMEOUT_PADRAO_MS } = opts;
  if (!opts.forcar && opts.cache && lerCache(opts.cache, url)) {
    const e = await baixar(url, { ...opts, out: null });
    const texto = e.texto && existsSync(e.texto) ? readFileSync(e.texto, 'utf8') : null;
    return { ...e, texto_extraido: texto, do_cache: true };
  }
  let host;
  try { host = new URL(url).hostname; } catch { return { url, status: 'acesso_falhou', motivo: 'url-invalida' }; }
  await esperar((ultimoAcesso.get(host) || 0) + esperaMs - agoraMs());
  const r = await baixarComFetch(url, { timeoutMs });
  ultimoAcesso.set(host, agoraMs());
  const classe = r.erro ? { gateway: r.erro } : classificarParaNavegacao(url, r);
  if (classe.ok) return { ...registrarResposta(url, r, { classe, motor: 'fetch', out: null, cache: null, pdftotext, devolverCorpo: true }), resposta: r };
  if (classe.bloqueio) return { url, status: 'acesso_falhou', motivo: classe.bloqueio, http: r.status || null };
  const e = await baixar(url, { ...opts, forcar: true, cache: null, out: null, devolverCorpo: true, ultimoAcesso });
  return e.status === 'ok' ? { ...e, resposta: { status: e.http, urlFinal: e.url_final, contentType: e.content_type, corpo: e.corpo } } : e;
}

/** Grava no run o que `buscarParaConferir` trouxe e a conferência aprovou, sem pedir de novo ao site. */
async function gravarConferida(conferida, url, { motor, out, cache, pdftotext, ...opts }) {
  if (conferida.do_cache) return baixar(url, { ...opts, out, cache, pdftotext });
  const r = conferida.resposta;
  return registrarResposta(url, r, { classe: classificarParaNavegacao(url, r), motor: motor || conferida.motor || 'fetch', out, cache, pdftotext });
}

// --- iniciar, passo, gravar, fechar ------------------------------------------------------------

const slug = (t) => normalizarTexto(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'fonte';

function resumoDoPasso(h) {
  const alvo = h.alvo ? ` [${h.alvo.n}] ${h.alvo.texto || h.alvo.rotulo || h.alvo.name || h.alvo.tag}` : '';
  const texto = h.texto !== undefined ? ` "${h.texto}"` : h.opcao !== undefined ? ` "${h.opcao}"` : '';
  const destino = h.url_depois && h.url_depois !== h.url_antes ? ` → ${h.url_depois}` : '';
  return `${h.passo}. ${h.acao}${alvo}${texto}${h.acao === 'abrir' ? ` ${h.url_depois || h.url}` : destino}`;
}

/** A parte da sessão que volta ao chefe a cada passo: onde está, o que há, o que fez, o que falta. */
function estadoPublico(sessao, obs, extra = {}) {
  const restante = Math.max(0, Math.round((Date.parse(sessao.prazo_em) - agoraMs()) / 1000));
  return {
    sessao: sessao.dir, id: sessao.id, estado: sessao.estado, objetivo: sessao.objetivo,
    ...(Object.keys(sessao.params || {}).length ? { parametros: sessao.params } : {}),
    passo: sessao.passos, max_passos: sessao.max_passos, passos_restantes: Math.max(0, sessao.max_passos - sessao.passos), segundos_restantes: restante,
    ...(obs ? { url: obs.url, titulo: obs.titulo, trecho: obs.trecho, tamanho_texto: obs.tamanho_texto, elementos: obs.elementos, elementos_total: obs.elementos_total, ...(obs.aviso ? { aviso: obs.aviso } : {}) } : {}),
    memoria: (sessao.historico || []).slice(-6).map(resumoDoPasso),
    ...extra,
  };
}

async function fecharComFalha(dir, sessao, motivo, extra = {}) {
  sessao.estado = MOTIVOS_DE_BARREIRA.has(motivo) ? 'barreira' : motivo.startsWith('limite') ? 'limite' : 'falhou';
  sessao.encerrada_em = new Date().toISOString();
  sessao.motivo = motivo;
  await encerrarNavegador(dir, sessao);
  gravarSessao(dir, sessao);
  const url = extra.url || sessao.url_atual || sessao.inicio;
  const barreira = MOTIVOS_DE_BARREIRA.has(motivo);
  anotarNoIndice(sessao.out, {
    url, host: (() => { try { return new URL(url).hostname; } catch { return null; } })(), motor: 'navegacao', status: 'acesso_falhou', motivo,
    sessao: sessao.id, objetivo: sessao.objetivo, passo: sessao.passos, caminho: (sessao.historico || []).map(resumoDoPasso),
    ...(barreira ? { instrucao: INSTRUCAO_BARREIRA } : {}), baixado_em: new Date().toISOString(),
  });
  return { status: 'acesso_falhou', motivo, ...(barreira ? { instrucao: INSTRUCAO_BARREIRA } : {}), ...estadoPublico(sessao, null, extra) };
}

function anotarPasso(sessao, entrada) {
  sessao.historico = sessao.historico || [];
  sessao.historico.push(entrada);
  anotarNoIndice(sessao.out, {
    url: entrada.url_antes || entrada.url, url_final: entrada.url_depois || null, status: 'passo', motor: 'navegacao', sessao: sessao.id, passo: entrada.passo,
    acao: entrada.acao, ...(entrada.alvo ? { alvo: { n: entrada.alvo.n, tag: entrada.alvo.tag, texto: entrada.alvo.texto || entrada.alvo.rotulo || null } } : {}),
    ...(entrada.texto !== undefined ? { texto_digitado: entrada.texto } : {}), ...(entrada.opcao !== undefined ? { opcao: entrada.opcao } : {}),
    titulo: entrada.titulo || null, objetivo: sessao.objetivo, em: new Date().toISOString(),
  });
}

async function playwrightOuInstrucao(opts) {
  const pw = await detectarPlaywright(opts.playwrightModulo || 'playwright');
  if (pw.disponivel) return pw;
  return { disponivel: false, resposta: { status: 'acesso_falhou', motivo: 'sem-playwright', aviso: pw.motivo, instrucao: INSTRUCAO_PLAYWRIGHT } };
}

/**
 * `--navegar`: abre o navegador na URL de início (fonte oficial) e devolve a primeira observação.
 * `params` são os valores que o chefe vai procurar (o número do Tema, do processo): a receita os
 * troca por `{nome}`, e o `--gravar` confere que a página final os traz.
 */
async function iniciarNavegacao({ objetivo, url, out, tipo = null, params = {}, maxPassos = NAV_MAX_PASSOS, maxTempoS = NAV_MAX_TEMPO_S, ...opts } = {}) {
  if (!objetivo || !String(objetivo).trim()) throw new ErroDeUso('--objetivo é obrigatório: é o que a navegação procura, e é o que a receita descreve');
  if (!out) throw new ErroDeUso('--out é obrigatório: a sessão, as cópias e o INDEX.jsonl ficam na pasta fontes/ do run');
  if (!hostAceito(url, opts.permitirHttp)) throw new ErroDeUso(`a navegação guiada só começa em fonte oficial por https (.jus.br, .gov.br, .leg.br); "${url}" não é`);
  const pw = await playwrightOuInstrucao(opts);
  if (!pw.disponivel) return pw.resposta;
  const quando = new Date();
  const id = idDeSessao(quando);
  const dir = join(resolve(out), 'navegacao', id);
  mkdirSync(dir, { recursive: true });
  const sessao = {
    formato: 1, id, dir, objetivo: String(objetivo).trim(), tipo: tipo ? slug(tipo) : null, params: { ...params }, inicio: url,
    out: resolve(out), cache: opts.cache || null, receitas: opts.receitas || null,
    criada_em: quando.toISOString(), prazo_em: new Date(quando.getTime() + maxTempoS * 1000).toISOString(),
    max_passos: maxPassos, passos: 0, estado: 'aberta', historico: [], ultimo_acesso: {},
    // A configuração de acesso é da sessão: os passos seguintes herdam, sem repetir flags.
    espera_ms: opts.esperaMs ?? ESPERA_PADRAO_MS, playwright_modulo: opts.playwrightModulo || 'playwright', permitir_http: Boolean(opts.permitirHttp),
  };
  const nav = await lancarNavegador(pw.chromium, dir, Date.parse(sessao.prazo_em));
  if (nav.erro) { sessao.estado = 'falhou'; gravarSessao(dir, sessao); return { status: 'acesso_falhou', motivo: 'navegador-nao-abriu', aviso: nav.erro }; }
  sessao.navegador = nav;
  gravarSessao(dir, sessao);
  return executarPasso(dir, { acao: 'abrir', url }, { ...opts, chromium: pw.chromium });
}

/**
 * Um passo numa sessão aberta: reata o navegador, age, observa, anota. Ler e procurar não tocam o
 * site. Barreira fecha a sessão como `acesso_falhou`; passo além do limite ou fora do prazo também.
 */
async function executarPasso(dir, acao, optsDoChamador = {}) {
  const sessao = lerSessao(dir);
  sessao.dir = dir;
  const opts = { ...optsDoChamador, esperaMs: sessao.espera_ms ?? ESPERA_PADRAO_MS, playwrightModulo: sessao.playwright_modulo || optsDoChamador.playwrightModulo, permitirHttp: Boolean(sessao.permitir_http) };
  if (sessao.estado !== 'aberta') return { status: 'sessao-encerrada', motivo: sessao.motivo || sessao.estado, ...estadoPublico(sessao, null) };
  if (acao.acao === 'fechar') {
    sessao.estado = 'fechada'; sessao.encerrada_em = new Date().toISOString();
    await encerrarNavegador(dir, sessao); gravarSessao(dir, sessao);
    anotarNoIndice(sessao.out, { url: sessao.url_atual || sessao.inicio, status: 'passo', motor: 'navegacao', sessao: sessao.id, passo: sessao.passos, acao: 'fechar', objetivo: sessao.objetivo, em: new Date().toISOString() });
    return { status: 'fechada', ...estadoPublico(sessao, null) };
  }
  if (agoraMs() > Date.parse(sessao.prazo_em)) return await fecharComFalha(dir, sessao, 'limite-de-tempo');
  if (ACOES_QUE_CONTAM.has(acao.acao) && sessao.passos >= sessao.max_passos) return await fecharComFalha(dir, sessao, 'limite-de-passos');
  const chromium = opts.chromium || (await playwrightOuInstrucao(opts)).chromium;
  if (!chromium) return { status: 'acesso_falhou', motivo: 'sem-playwright', instrucao: INSTRUCAO_PLAYWRIGHT };
  let conexao;
  try { conexao = await conectar(chromium, sessao); } catch (erro) {
    return await fecharComFalha(dir, sessao, agoraMs() > Date.parse(sessao.prazo_em) ? 'limite-de-tempo' : 'navegador-caiu', { aviso: String(erro && erro.message).split('\n')[0] });
  }
  const { navegador, contexto } = conexao;
  let { pagina } = conexao;
  try {
    await prenderAFonteOficial(contexto, opts.permitirHttp);
    const tempoRestante = Date.parse(sessao.prazo_em) - agoraMs();
    const comPrazo = async (p) => {
      let relogio;
      try {
        return await Promise.race([p, new Promise((_, recusar) => { relogio = setTimeout(() => recusar(new Error('limite-de-tempo')), Math.max(1000, tempoRestante)); })]);
      } finally { clearTimeout(relogio); }
    };

    if (acao.acao === 'ler' || acao.acao === 'procurar') {
      const obs = await observar(pagina, { filtro: acao.acao === 'procurar' ? acao.texto : null });
      if (obs.barreira) return await fecharComFalha(dir, sessao, obs.barreira, { url: obs.url });
      sessao.ultimos_elementos = descricoesParaReceita(obs.todos);
      const extra = {};
      if (acao.acao === 'ler') {
        const texto = normalizarTexto((await pagina.evaluate(`(${JS_TEXTO})()`).catch(() => ({ texto: '' }))).texto);
        const parte = Math.max(1, Number(acao.parte) || 1);
        extra.texto = texto.slice((parte - 1) * NAV_PAGINA_DE_LEITURA, parte * NAV_PAGINA_DE_LEITURA);
        extra.parte = parte; extra.partes = Math.max(1, Math.ceil(texto.length / NAV_PAGINA_DE_LEITURA));
      } else {
        const texto = normalizarTexto((await pagina.evaluate(`(${JS_TEXTO})()`).catch(() => ({ texto: '' }))).texto);
        const chave = String(acao.texto || '').toLowerCase();
        const achados = [];
        for (let i = texto.toLowerCase().indexOf(chave); chave && i >= 0 && achados.length < 5; i = texto.toLowerCase().indexOf(chave, i + chave.length)) achados.push(texto.slice(Math.max(0, i - 160), i + chave.length + 160));
        extra.no_texto = achados;
      }
      gravarSessao(dir, sessao);
      return { status: 'ok', ...estadoPublico(sessao, obs, extra) };
    }

    if (acao.acao === 'gravar') {
      const r = await comPrazo(gravarPaginaDaSessao(pagina, contexto, sessao, opts));
      if (r.fechar) return await fecharComFalha(dir, sessao, r.motivo, { url: r.url });
      if (r.status !== 'ok') { gravarSessao(dir, sessao); return { ...r, ...estadoPublico(sessao, null) }; }
      sessao.estado = 'gravada'; sessao.encerrada_em = new Date().toISOString();
      await encerrarNavegador(dir, sessao); gravarSessao(dir, sessao);
      return { ...r, ...estadoPublico(sessao, null) };
    }

    // Ações que tocam a página.
    const antes = pagina.url();
    const descricao = acao.n ? (sessao.ultimos_elementos || []).find((e) => e.n === Number(acao.n)) || null : null;
    let resultado;
    try {
      resultado = await comPrazo(agir(pagina, contexto, { ...acao, n: acao.n ? Number(acao.n) : undefined }, sessao, opts));
    } catch (erro) {
      if (erro instanceof ErroDeUso) { gravarSessao(dir, sessao); return { status: 'erro', erro: erro.message, ...estadoPublico(sessao, null) }; }
      if (String(erro && erro.message) === 'limite-de-tempo') return await fecharComFalha(dir, sessao, 'limite-de-tempo');
      const msg = String(erro && erro.message).split('\n')[0];
      // Navegação recusada para fora da fonte oficial: a página fica onde estava.
      if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(msg)) {
        gravarSessao(dir, sessao);
        return { status: 'erro', erro: 'o destino está fora das fontes oficiais (.jus.br, .gov.br, .leg.br): a navegação guiada não sai delas', ...estadoPublico(sessao, null) };
      }
      gravarSessao(dir, sessao);
      return { status: 'erro', erro: `a ação não se completou: ${msg}`, ...estadoPublico(sessao, null) };
    }
    pagina = resultado.pagina;
    sessao.passos += 1;
    const obs = await observar(pagina);
    sessao.url_atual = obs.url;
    anotarPasso(sessao, {
      passo: sessao.passos, acao: acao.acao, ...(acao.url ? { url: acao.url } : {}), ...(descricao ? { alvo: descricao } : {}),
      ...(acao.acao === 'digitar' ? { texto: String(acao.texto ?? '') } : {}), ...(acao.acao === 'selecionar' ? { opcao: String(acao.opcao ?? acao.texto ?? '') } : {}),
      url_antes: antes === 'about:blank' ? null : antes, url_depois: obs.url, titulo: obs.titulo, ...(resultado.nova_aba ? { nova_aba: true } : {}),
      ...(resultado.formulario ? { formulario: resultado.formulario } : {}), ...(resultado.copiado ? { copiado: resultado.copiado } : {}),
    });
    if (obs.barreira) return await fecharComFalha(dir, sessao, obs.barreira, { url: obs.url });
    if (!hostNavegavel(obs.url, opts.permitirHttp)) {
      // O navegador recusou sair da fonte oficial (ou a página caiu num erro): volta para onde estava.
      if (antes && hostAceito(antes, opts.permitirHttp)) await pagina.goto(antes, { waitUntil: 'commit', timeout: NAV_TIMEOUT_ACAO_MS }).then(() => assentar(pagina)).catch(() => null);
      const aqui = await observar(pagina);
      sessao.url_atual = aqui.url;
      sessao.ultimos_elementos = descricoesParaReceita(aqui.todos);
      gravarSessao(dir, sessao);
      return { status: 'erro', erro: `o destino (${obs.url}) está fora das fontes oficiais (.jus.br, .gov.br, .leg.br) ou não abriu: a navegação guiada não sai delas`, ...estadoPublico(sessao, aqui) };
    }
    if (obs.http === 429) return await fecharComFalha(dir, sessao, 'limite-de-acesso', { url: obs.url });
    if (obs.http === 403 || obs.http === 401) return await fecharComFalha(dir, sessao, `http-${obs.http}`, { url: obs.url });
    sessao.ultimos_elementos = descricoesParaReceita(obs.todos);
    gravarSessao(dir, sessao);
    return { status: 'ok', ...estadoPublico(sessao, obs, resultado.copiado ? { copiado: resultado.copiado } : {}) };
  } finally {
    // Desatar, não fechar: o navegador segue aberto para o próximo passo, até o prazo.
    await navegador.close().catch(() => null);
  }
}

/**
 * O conteúdo servido pela URL sozinha (sem os cliques) confere com a página que a navegação achou?
 * Com parâmetros, todos presentes; sem eles, o título da página presente e o texto de tamanho parecido.
 */
function reproduzPelaUrl(direta, params, renderizado) {
  if (!direta || direta.status !== 'ok' || !direta.texto_extraido) return false;
  if (Object.keys(params || {}).length) return faltamParametros(direta.texto_extraido, params).length === 0;
  const titulo = chaveDeTrecho(renderizado.titulo || '');
  const tamanhoOk = direta.texto_extraido.length >= 0.5 * (renderizado.texto || '').length;
  return tamanhoOk && (!titulo || chaveDeTrecho(direta.texto_extraido).includes(titulo));
}

/** O documento na página ativa: o HTML renderizado, ou os bytes do PDF que o visualizador mostra. */
async function capturarDocumento(pagina, contexto) {
  const info = await pagina.evaluate(`(${JS_TEXTO})()`).catch(() => ({ titulo: '', texto: '', tipo: '', status: null }));
  const url = pagina.url();
  if (info.tipo && !/html|xml/i.test(info.tipo)) {
    // PDF (ou outro binário) aberto pelo visualizador: os bytes vêm pelo mesmo contexto, com os mesmos cookies, num pedido só.
    const r = await contexto.request.get(url, { timeout: NAV_TIMEOUT_ACAO_MS });
    return { info, resposta: { status: r.status(), urlFinal: r.url(), contentType: r.headers()['content-type'] || info.tipo, corpo: Buffer.from(await r.body()) } };
  }
  const html = await pagina.content();
  return { info, resposta: { status: info.status || 200, urlFinal: url, contentType: 'text/html; charset=utf-8', corpo: Buffer.from(html, 'utf8') } };
}

/**
 * `--gravar`: grava a página atual como fonte, pelo mesmo caminho e com as mesmas checagens do
 * download por código (`registrarResposta`: vazia, página de erro, sem texto, desafio, captcha, login,
 * processo divergente), confere que os parâmetros pedidos estão nela e registra no INDEX.jsonl o
 * caminho seguido. Quando a URL sozinha serve o mesmo documento, grava essa cópia (é a que a
 * reabertura vai comparar) e a receita ganha o atalho; quando não serve, grava o documento que a
 * navegação abriu, marca a cópia como de navegação e a receita refaz os cliques.
 */
async function gravarPaginaDaSessao(pagina, contexto, sessao, opts) {
  const barreira = await barreiraDaPagina(pagina);
  if (barreira.motivo) return { fechar: true, motivo: barreira.motivo, url: pagina.url() };
  const url = pagina.url();
  if (!hostAceito(url, opts.permitirHttp)) return { status: 'erro', erro: `a página atual (${url}) não é fonte oficial; nada foi gravado` };
  const { info, resposta } = await capturarDocumento(pagina, contexto);
  const pdftotext = opts.pdftotext === undefined ? detectarPdftotext() : opts.pdftotext;
  const classeDaPagina = classificarParaNavegacao(url, resposta);
  const previa = registrarResposta(url, resposta, { classe: classeDaPagina, motor: 'navegacao', out: null, cache: null, pdftotext });
  if (previa.status !== 'ok') {
    if (MOTIVOS_DE_BARREIRA.has(previa.motivo)) return { fechar: true, motivo: previa.motivo, url };
    anotarNoIndice(sessao.out, { url, motor: 'navegacao', status: 'acesso_falhou', motivo: previa.motivo, sessao: sessao.id, passo: sessao.passos, objetivo: sessao.objetivo, baixado_em: previa.baixado_em });
    return { status: 'acesso_falhou', motivo: previa.motivo, url, erro: 'a página atual não é um documento gravável; nada foi gravado, a sessão continua aberta' };
  }
  const faltam = faltamParametros(previa.texto_extraido, sessao.params);
  if (faltam.length) {
    return { status: 'acesso_falhou', motivo: 'pedido-ausente-na-pagina', faltam, url, erro: `a página atual não traz ${faltam.map((k) => `${k}=${sessao.params[k]}`).join(', ')}; nada foi gravado, a sessão continua aberta` };
  }
  // Uma URL serve o mesmo documento sozinha? Primeiro a da página; depois, se ela chegou por envio de
  // formulário, o mesmo envio por GET. Um pedido por candidato, pela escada de sempre, com a espera.
  // Candidatos, nesta ordem: o que o chefe indicou (--url-da-fonte), o link permanente que o botão
  // "copiar link" do site entregou nesta página, a própria URL, a canônica que a página declara e o
  // envio de formulário refeito por GET. Cada um só vale se a URL sozinha trouxer o mesmo documento.
  const ultimoAcesso = new Map(Object.entries(sessao.ultimo_acesso || {}));
  const historico = [...(sessao.historico || [])].reverse();
  const envio = historico.find((h) => h.formulario);
  const copiado = historico.find((h) => h.copiado && /^https?:\/\//.test(h.copiado.trim()) && h.url_depois === url);
  const canonico = await pagina.evaluate(`(${JS_CANONICO})()`).catch(() => null);
  const candidatos = [...new Set([opts.urlDaFonte, copiado && copiado.copiado.trim(), url, canonico, urlDoFormulario(envio && envio.formulario)]
    .filter((u) => typeof u === 'string' && u && hostAceito(u, opts.permitirHttp)))].slice(0, 4);
  let direta = null;
  let urlDaFonte = url;
  let reproduz = false;
  for (const candidato of candidatos) {
    direta = await buscarParaConferir(candidato, { ...opts, pdftotext, forcar: true, cache: null, ultimoAcesso, log: () => {} });
    anotarAcesso(sessao, candidato);
    if (reproduzPelaUrl(direta, sessao.params, { titulo: info.titulo, texto: previa.texto_extraido })) { reproduz = true; urlDaFonte = candidato; break; }
  }
  const entrada = reproduz
    ? await gravarConferida(direta, urlDaFonte, { motor: direta.motor, out: sessao.out, cache: sessao.cache, pdftotext })
    // Sem reprodução pela URL, nada de cache: a mesma URL, pedida sem os cliques, é outra página.
    : registrarResposta(url, resposta, { classe: classeDaPagina, motor: 'navegacao', out: sessao.out, cache: null, pdftotext });
  if (entrada.status !== 'ok') return { status: 'acesso_falhou', motivo: entrada.motivo, url };
  const caminho = (sessao.historico || []).map(resumoDoPasso);
  let receita = null;
  if (opts.semReceita !== true) {
    receita = montarReceita(sessao, { urlFinal: urlDaFonte, reproduz, reconhece: opts.reconhece || null });
    receita.arquivo = salvarReceita(receita, sessao.receitas);
  }
  if (!reproduz) {
    anotarMarcaDeNavegacao(sessao.out, url, { sessao: sessao.id, objetivo: sessao.objetivo, receita: receita ? receita.id : null, parametros: sessao.params, sha256_texto: entrada.sha256_texto, sha256_bytes: entrada.sha256_bytes, gravada_em: entrada.baixado_em });
  }
  const linha = {
    ...entrada, via: 'navegacao', sessao: sessao.id, objetivo: sessao.objetivo, caminho, reabre_por_url: reproduz,
    ...(urlDaFonte !== url ? { url_da_pagina: url, url_por: urlDaFonte === opts.urlDaFonte ? 'indicada-pelo-chefe' : copiado && urlDaFonte === copiado.copiado.trim() ? 'link-permanente-do-site' : urlDaFonte === canonico ? 'canonica' : 'formulario-por-get' } : {}),
    ...(Object.keys(sessao.params || {}).length ? { parametros: sessao.params } : {}),
    ...(receita ? { receita: receita.id, receita_arquivo: receita.arquivo } : {}),
    ...(reproduz ? {} : { aviso: 'a URL desta página, pedida sem os cliques, não serve o mesmo documento: a reabertura refaz o caminho pela receita (sem receita, a conferência final vai a um votante)' }),
  };
  anotarNoIndice(sessao.out, linha);
  return { status: 'ok', gravada: semCampos(linha, 'texto_extraido', 'corpo', 'html', 'content_type'), ...(receita ? { receita: { id: receita.id, arquivo: receita.arquivo, atalho: receita.atalho || null, passos: receita.passos.length, reconhece: receita.reconhece || null } } : {}) };
}

// --- receitas ---------------------------------------------------------------------------------

/** O caminho sem os desvios: cada `voltar` desfaz a última ação que mudou de página (e o que foi digitado nela). */
function caminhoLimpo(historico) {
  const pilha = [];
  for (const h of historico || []) {
    if (h.acao !== 'voltar') { pilha.push(h); continue; }
    while (pilha.length) {
      const ultimo = pilha.pop();
      if (ultimo.acao === 'abrir' || (ultimo.url_depois && ultimo.url_depois !== ultimo.url_antes) || ultimo.nova_aba) break;
    }
  }
  return pilha;
}

/** A identidade do alvo, com o que variou trocado pelo nome do parâmetro. */
function alvoDaReceita(alvo, params) {
  if (!alvo) return null;
  const saida = { tag: alvo.tag, tipo: alvo.tipo };
  for (const campo of ['id', 'name', 'href', 'texto', 'rotulo']) if (alvo[campo]) saida[campo] = parametrizar(alvo[campo], params);
  return saida;
}

function montarReceita(sessao, { urlFinal, reproduz, reconhece = null, agora = new Date() }) {
  const params = sessao.params || {};
  const dominio = new URL(urlFinal).hostname;
  const tipo = sessao.tipo || slug(sessao.objetivo);
  const passos = caminhoLimpo(sessao.historico).map((h) => {
    const p = { acao: h.acao };
    if (h.acao === 'abrir') p.url = parametrizar(h.url || h.url_depois, params);
    if (h.alvo) p.alvo = alvoDaReceita(h.alvo, params);
    if (h.texto !== undefined) p.texto = parametrizar(h.texto, params);
    if (h.opcao !== undefined) p.opcao = parametrizar(h.opcao, params);
    return p;
  });
  const urlParametrizada = parametrizar(urlFinal, params);
  const atalho = reproduz && temTodos(urlParametrizada, params) ? urlParametrizada : null;
  const receita = {
    formato: 1, id: `${dominio}/${tipo}`, dominio, tipo, descricao: parametrizar(sessao.objetivo, params),
    parametros: Object.keys(params), exemplo: { ...params }, inicio: parametrizar(sessao.inicio, params),
    passos, ...(atalho ? { atalho } : {}), confere: { parametros_no_texto: Object.keys(params).length > 0 },
    gravada_em: agora.toISOString(), origem: 'navegacao', sessao: sessao.id, usos: 0, quebrada: false, falhas: [],
  };
  if (reconhece) {
    const erro = erroDoReconhece(reconhece, receita.parametros);
    if (erro) receita.aviso_reconhece = erro;
    else receita.reconhece = reconhece;
  }
  return receita;
}

/** O padrão que liga a receita a uma citação precisa compilar e ter um grupo nomeado por parâmetro. */
function erroDoReconhece(padrao, parametros) {
  let re;
  try { re = new RegExp(padrao, 'iu'); } catch (erro) { return `--reconhece não compila: ${erro.message}`; }
  const grupos = new Set([...String(padrao).matchAll(/\(\?<([\w]+)>/g)].map((m) => m[1]));
  const faltam = (parametros || []).filter((p) => !grupos.has(p));
  if (faltam.length) return `--reconhece precisa de um grupo nomeado por parâmetro: falta (?<${faltam[0]}>…)`;
  return re ? null : 'padrão vazio';
}

function caminhoDaReceita(dirReceitas, receita) {
  return join(dirReceitas, receita.dominio, `${receita.tipo}.json`);
}

function salvarReceita(receita, dirReceitas) {
  if (!dirReceitas) return null;
  const arquivo = caminhoDaReceita(dirReceitas, receita);
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, `${JSON.stringify(semCampos(receita, 'arquivo'), null, 1)}\n`);
  return arquivo;
}

/**
 * As receitas que valem neste projeto: as gravadas aqui (`acervo/_receitas/`) primeiro, depois as que
 * a curadoria distribui nos pacotes (`acervo/_packs/<pacote>/_receitas/`). A do projeto vence a de
 * pacote com o mesmo id: é assim que uma receita curada que quebrou fica marcada sem tocar no pacote.
 */
function listarReceitas({ receitas = null, pacotes = null } = {}) {
  const dirs = [];
  if (receitas && existsSync(receitas)) dirs.push({ dir: receitas, origem: 'projeto' });
  if (pacotes && existsSync(pacotes)) {
    for (const pack of readdirSync(pacotes, { withFileTypes: true })) {
      if (pack.isDirectory() && existsSync(join(pacotes, pack.name, '_receitas'))) dirs.push({ dir: join(pacotes, pack.name, '_receitas'), origem: `pacote:${pack.name}` });
    }
  }
  const porId = new Map();
  for (const { dir, origem } of dirs) {
    for (const dominio of readdirSync(dir, { withFileTypes: true })) {
      if (!dominio.isDirectory()) continue;
      for (const nome of readdirSync(join(dir, dominio.name))) {
        if (!nome.endsWith('.json')) continue;
        try {
          const receita = JSON.parse(readFileSync(join(dir, dominio.name, nome), 'utf8'));
          if (!receita || receita.formato !== 1 || !receita.id || porId.has(receita.id)) continue;
          porId.set(receita.id, { ...receita, arquivo: join(dir, dominio.name, nome), origem_arquivo: origem });
        } catch { /* receita ilegível não vale */ }
      }
    }
  }
  return [...porId.values()];
}

function acharReceita(ref, lista) {
  if (!ref) return null;
  if (existsSync(ref) && ref.endsWith('.json')) {
    try { const r = JSON.parse(readFileSync(ref, 'utf8')); return { ...r, arquivo: resolve(ref), origem_arquivo: 'arquivo' }; } catch { return null; }
  }
  return lista.find((r) => r.id === ref) || null;
}

/** As citações de um texto que alguma receita reconhece, com os parâmetros tirados do próprio texto. */
function receitasNoTexto(texto, lista, limite = NAV_MAX_RECEITAS_POR_PESQUISA) {
  const achados = [];
  const vistos = new Set();
  for (const receita of lista) {
    if (!receita.reconhece || receita.quebrada) continue;
    let re;
    try { re = new RegExp(receita.reconhece, 'giu'); } catch { continue; }
    for (const m of String(texto || '').matchAll(re)) {
      const params = { ...(m.groups || {}) };
      if ((receita.parametros || []).some((p) => !params[p])) continue;
      const chave = `${receita.id} ${JSON.stringify(params)}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      achados.push({ receita, params, citacao: m[0] });
      if (achados.length >= limite) return achados;
    }
  }
  return achados;
}

function marcarQuebrada(receita, dirReceitas, falha) {
  const atualizada = { ...receita, quebrada: true, falhas: [...(receita.falhas || []), falha].slice(-5) };
  // Receita de pacote não se edita: a marca vai para uma cópia no projeto, que vence a do pacote.
  const destino = receita.origem_arquivo === 'projeto' || receita.origem_arquivo === 'arquivo' ? receita.arquivo : dirReceitas ? caminhoDaReceita(dirReceitas, receita) : null;
  if (destino) {
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, `${JSON.stringify(semCampos(atualizada, 'arquivo', 'origem_arquivo'), null, 1)}\n`);
  }
  return atualizada;
}

function anotarUso(receita, via) {
  if (receita.origem_arquivo !== 'projeto' && receita.origem_arquivo !== 'arquivo') return;
  try {
    const conteudo = JSON.parse(readFileSync(receita.arquivo, 'utf8'));
    conteudo.usos = (conteudo.usos || 0) + 1;
    conteudo.ultimo_uso = { em: new Date().toISOString(), via };
    writeFileSync(receita.arquivo, `${JSON.stringify(conteudo, null, 1)}\n`);
  } catch { /* contador não é prova */ }
}

/** O comando que o chefe roda quando a receita não serve: navegar a partir do início dela. */
function sugestaoDeNavegacao(receita, params, out) {
  const objetivo = preencher(receita.descricao, params);
  const inicio = preencher(receita.inicio, params);
  const comParams = Object.entries(params || {}).map(([k, v]) => ` --param ${k}=${JSON.stringify(String(v))}`).join('');
  return {
    objetivo, url: inicio, tipo: receita.tipo, parametros: params,
    comando: `node scripts/fonte-oficial.mjs --navegar --objetivo ${JSON.stringify(objetivo)} --url ${inicio} --tipo ${receita.tipo}${comParams} --out ${out || '{pasta do run}/fontes'}`,
  };
}

/**
 * Refaz uma receita com os parâmetros da citação: primeiro o atalho (a URL da página final, quando
 * ela serve o documento sozinha), pela escada de sempre; depois os passos gravados, num navegador
 * headless descartável, com a mesma espera e a mesma detecção de barreira. Página que não confere
 * (alvo sumido, parâmetro ausente no fim) marca a receita como quebrada e devolve o pedido de
 * navegação. Barreira não quebra receita: é `acesso_falhou` com a instrução, como em todo lugar.
 */
/**
 * O valor vai no formato do exemplo gravado: se o número foi digitado só com dígitos ("1076"), a
 * citação "Tema 1.076" preenche "1076". Medido na prova de 27/09/2026: o STJ não acha "1.076" no
 * campo do número do tema, e a receita boa parecia quebrada.
 */
function normalizarParametros(receita, params) {
  const saida = { ...params };
  for (const [nome, valor] of Object.entries(params || {})) {
    const exemplo = receita.exemplo && receita.exemplo[nome];
    if (typeof exemplo === 'string' && /^\d+$/.test(exemplo) && ehNumero(valor)) saida[nome] = soDigitos(valor);
  }
  return saida;
}

async function executarReceita(receita, paramsDaCitacao, opts = {}) {
  const { out = null, receitas: dirReceitas = null } = opts;
  const params = normalizarParametros(receita, paramsDaCitacao);
  const falta = (receita.parametros || []).filter((p) => params[p] === undefined || params[p] === '');
  const base = { receita: receita.id, parametros: params };
  if (falta.length) return { status: 'acesso_falhou', motivo: 'parametro-ausente', faltam: falta, ...base };
  const navegar = sugestaoDeNavegacao(receita, params, out);
  if (receita.quebrada) return { status: 'acesso_falhou', motivo: 'receita-quebrada', url: preencher(receita.inicio, params), navegar, ...base };
  const pdftotext = opts.pdftotext === undefined ? detectarPdftotext() : opts.pdftotext;
  const quebrar = (motivo, extra = {}) => {
    marcarQuebrada(receita, dirReceitas, { em: new Date().toISOString(), motivo, parametros: params, ...extra });
    const url = extra.url || preencher(receita.inicio, params);
    return { url, status: 'acesso_falhou', motivo: 'receita-quebrada', detalhe: motivo, ...extra, navegar, ...base };
  };

  if (receita.atalho) {
    const url = preencher(receita.atalho, params);
    const direta = await buscarParaConferir(url, { ...opts, pdftotext });
    if (direta.status === 'ok') {
      if (!faltamParametros(direta.texto_extraido || '', params).length) {
        // Conferiu: agora sim grava no run e no cache, com os bytes que já chegaram.
        const entrada = await gravarConferida(direta, url, { ...opts, pdftotext });
        anotarUso(receita, 'atalho');
        return { ...entrada, via: 'receita:atalho', ...base };
      }
    } else if (MOTIVOS_DE_BARREIRA.has(direta.motivo)) {
      return { ...direta, instrucao: INSTRUCAO_BARREIRA, ...base };
    }
    if (!receita.passos || !receita.passos.length) {
      if (direta.status === 'ok') return { url, status: 'acesso_falhou', motivo: 'pedido-ausente-na-pagina', faltam: faltamParametros(direta.texto_extraido || '', params), aviso: 'o atalho abriu, mas a página não traz o pedido: confira a citação antes de concluir que não existe', navegar, ...base };
      return quebrar(`atalho: ${direta.motivo}`, { url });
    }
  }
  if (!receita.passos || !receita.passos.length) return quebrar('receita-sem-passos');

  const pw = await playwrightOuInstrucao(opts);
  if (!pw.disponivel) return { ...pw.resposta, url: preencher(receita.inicio, params), navegar, ...base };
  let navegador;
  try {
    navegador = await pw.chromium.launch({ headless: true, channel: 'chromium' }).catch(() => pw.chromium.launch({ headless: true }));
    const contexto = await navegador.newContext({ locale: 'pt-BR' });
    await prenderAFonteOficial(contexto, opts.permitirHttp);
    let pagina = await contexto.newPage();
    const sessao = { ultimo_acesso: {} };
    const esperaMs = opts.esperaMs ?? ESPERA_PADRAO_MS;
    for (let i = 0; i < receita.passos.length; i += 1) {
      const passo = receita.passos[i];
      if (passo.acao === 'abrir') {
        const url = preencher(passo.url, params);
        if (!hostAceito(url, opts.permitirHttp)) return quebrar('inicio-fora-da-fonte-oficial', { url });
        ({ pagina } = await agir(pagina, contexto, { acao: 'abrir', url }, sessao, { esperaMs }));
      } else {
        if (passo.alvo) {
          const alvo = Object.fromEntries(Object.entries(passo.alvo).map(([k, v]) => [k, typeof v === 'string' ? preencher(v, params) : v]));
          let achou = false;
          for (const quadro of pagina.frames()) {
            if (await quadro.evaluate(`(${JS_ACHAR_ALVO})(${JSON.stringify(alvo)})`).catch(() => false)) { achou = true; break; }
          }
          if (!achou) return quebrar('alvo-nao-encontrado', { passo: i + 1, alvo: passo.alvo, url: pagina.url() });
        }
        const acao = { acao: passo.acao, n: 'alvo', ...(passo.texto !== undefined ? { texto: preencher(passo.texto, params) } : {}), ...(passo.opcao !== undefined ? { opcao: preencher(passo.opcao, params) } : {}) };
        try {
          ({ pagina } = await agir(pagina, contexto, acao, sessao, { esperaMs }));
        } catch (erro) {
          if (erro instanceof ErroDeUso) return quebrar(erro.message, { passo: i + 1, url: pagina.url() });
          throw erro;
        }
      }
      const barreira = await barreiraDaPagina(pagina);
      if (barreira.motivo) return { url: pagina.url(), status: 'acesso_falhou', motivo: barreira.motivo, instrucao: INSTRUCAO_BARREIRA, ...base };
    }
    const url = pagina.url();
    if (!hostAceito(url, opts.permitirHttp)) return quebrar('fim-fora-da-fonte-oficial', { url });
    const { resposta } = await capturarDocumento(pagina, contexto);
    const classeDaPagina = classificarParaNavegacao(url, resposta);
    const previa = registrarResposta(url, resposta, { classe: classeDaPagina, motor: 'receita', out: null, cache: null, pdftotext });
    if (previa.status !== 'ok') {
      if (MOTIVOS_DE_BARREIRA.has(previa.motivo)) return { url, status: 'acesso_falhou', motivo: previa.motivo, instrucao: INSTRUCAO_BARREIRA, ...base };
      return quebrar(`pagina-final: ${previa.motivo}`, { url });
    }
    // O caminho andou até o fim e a página não traz o pedido: a citação pode estar errada (Tema que
    // não existe, número trocado). Não é página mudada, e a receita não se marca quebrada.
    const faltam = faltamParametros(previa.texto_extraido, params);
    if (faltam.length) return { url, status: 'acesso_falhou', motivo: 'pedido-ausente-na-pagina', faltam, aviso: 'o caminho da receita chegou ao fim, mas a página não traz o pedido: confira a citação (número, tribunal) antes de concluir que não existe', navegar, ...base };
    // A página final serve sozinha pela URL? Então a cópia é a do download (a que a reabertura compara).
    const direta = await buscarParaConferir(url, { ...opts, pdftotext, forcar: true, cache: null, ultimoAcesso: new Map(Object.entries(sessao.ultimo_acesso)) });
    const reproduz = reproduzPelaUrl(direta, params, { titulo: '', texto: previa.texto_extraido });
    const entrada = reproduz
      ? await gravarConferida(direta, url, { ...opts, motor: 'receita', out, cache: opts.cache || null, pdftotext })
      : registrarResposta(url, resposta, { classe: classeDaPagina, motor: 'receita', out, cache: null, pdftotext });
    if (!reproduz) anotarMarcaDeNavegacao(out, url, { receita: receita.id, parametros: params, sha256_texto: entrada.sha256_texto, sha256_bytes: entrada.sha256_bytes, gravada_em: entrada.baixado_em });
    anotarUso(receita, 'passos');
    return { ...entrada, via: 'receita:passos', reabre_por_url: reproduz, ...base };
  } catch (erro) {
    return { url: preencher(receita.inicio, params), status: 'acesso_falhou', motivo: `receita: ${String(erro && erro.message).split('\n')[0]}`, navegar, ...base };
  } finally {
    if (navegador) await navegador.close().catch(() => null);
  }
}

/**
 * A marca de navegação ao lado das cópias no `--out` (`navegacao-<sha1 da URL>.json`): a URL veio de
 * cliques, e ela sozinha pode não servir o mesmo documento. Uma URL pode ter várias cópias (a busca
 * por POST devolve o acórdão de cada processo no mesmo endereço), então a marca guarda uma entrada
 * por cópia, com a receita, os parâmetros e o hash que a identificam.
 */
function anotarMarcaDeNavegacao(out, url, item) {
  if (!out || !url) return;
  mkdirSync(out, { recursive: true });
  const arquivo = join(out, nomeDaMarcaDeNavegacao(url));
  let marca = { url, copias: [] };
  try { if (existsSync(arquivo)) marca = JSON.parse(readFileSync(arquivo, 'utf8')); } catch { marca = { url, copias: [] }; }
  const copias = (marca.copias || []).filter((c) => !(item.sha256_texto && c.sha256_texto === item.sha256_texto) && !(item.sha256_bytes && c.sha256_bytes === item.sha256_bytes));
  writeFileSync(arquivo, `${JSON.stringify({ url, copias: [...copias, item] }, null, 1)}\n`);
}

/**
 * A cópia de navegação que uma citação registrou: a entrada da marca com o mesmo hash, ou a única
 * entrada quando não há hash para escolher. Várias entradas sem hash que decida: nenhuma (refazer o
 * caminho com os parâmetros de outra cópia daria outro documento).
 */
function marcaDeNavegacao(out, url, { sha256_texto: hashTexto = null, sha256_bytes: hashBytes = null } = {}) {
  if (!out || !url) return null;
  const arquivo = join(out, nomeDaMarcaDeNavegacao(url));
  if (!existsSync(arquivo)) return null;
  let marca;
  try { marca = JSON.parse(readFileSync(arquivo, 'utf8')); } catch { return null; }
  const copias = Array.isArray(marca.copias) ? marca.copias : [];
  const pelaHash = copias.find((c) => (hashTexto && c.sha256_texto === hashTexto) || (hashBytes && c.sha256_bytes === hashBytes));
  if (pelaHash) return pelaHash;
  return copias.length === 1 && !hashTexto && !hashBytes ? copias[0] : null;
}

// --- o decisor: quem escolhe o próximo passo --------------------------------------------------

/** A página em texto, do jeito que um decisor lê: objetivo, onde está, memória e a lista numerada. */
function estadoEmTexto(estado) {
  const linhas = [];
  linhas.push(`Sessão ${estado.id}: passo ${estado.passo} de ${estado.max_passos} (restam ${estado.passos_restantes}; ${estado.segundos_restantes} s)`);
  linhas.push(`Objetivo: ${estado.objetivo}`);
  if (estado.parametros) linhas.push(`Parâmetros: ${Object.entries(estado.parametros).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (estado.url) linhas.push(`URL: ${estado.url}`);
  if (estado.titulo) linhas.push(`Título: ${estado.titulo}`);
  if (estado.aviso) linhas.push(`Aviso: ${estado.aviso}`);
  if (estado.copiado) linhas.push(`O site copiou: ${estado.copiado} (no --gravar, é candidato a URL da fonte)`);
  if (estado.memoria && estado.memoria.length) linhas.push(`Memória:\n  ${estado.memoria.join('\n  ')}`);
  if (estado.trecho) linhas.push(`Texto (${estado.tamanho_texto} caracteres; --ler mostra tudo): ${estado.trecho}`);
  if (estado.elementos) {
    linhas.push(`Elementos (${estado.elementos.length} de ${estado.elementos_total}${estado.elementos.length < estado.elementos_total ? '; --procurar "texto" acha os outros' : ''}):`);
    for (const e of estado.elementos) {
      const partes = [`[${e.n}] ${e.tipo}`];
      if (e.texto) partes.push(`"${e.texto}"`);
      if (e.rotulo && e.rotulo !== e.texto) partes.push(`(${e.rotulo})`);
      if (e.input && e.tipo === 'campo') partes.push(`tipo=${e.input}`);
      if (e.name) partes.push(`name=${e.name}`);
      if (e.valor) partes.push(`valor="${e.valor}"`);
      if (e.opcoes) partes.push(`opções: ${e.opcoes.join(' | ')}`);
      if (e.href) partes.push(`→ ${e.href}`);
      if (e.senha) partes.push('[senha: não se digita]');
      if (e.desabilitado) partes.push('[desabilitado]');
      if (e.quadro) partes.push(`[quadro ${e.quadro}]`);
      linhas.push(`  ${partes.join(' ')}`);
    }
  }
  return linhas.join('\n');
}

const ACOES_DO_DECISOR = new Set(['clicar', 'digitar', 'enviar', 'selecionar', 'voltar', 'ler', 'gravar', 'desistir']);

/** Uma decisão só vale se for uma ação conhecida sobre um elemento que está na lista mostrada. */
function validarDecisao(decisao, estado) {
  if (!decisao || typeof decisao !== 'object' || !ACOES_DO_DECISOR.has(decisao.acao)) return { acao: 'desistir', motivo: 'decisao-invalida' };
  if (['clicar', 'digitar', 'enviar', 'selecionar'].includes(decisao.acao)) {
    const n = Number(decisao.n);
    const el = (estado.elementos || []).find((e) => e.n === n);
    if (!el) return { acao: 'desistir', motivo: `decisao-invalida: elemento ${decisao.n} fora da lista` };
    if (el.senha) return { acao: 'desistir', motivo: 'decisao-invalida: campo de senha' };
    if (decisao.acao === 'digitar' && (typeof decisao.texto !== 'string' || decisao.texto.length > 200)) return { acao: 'desistir', motivo: 'decisao-invalida: texto' };
    return { acao: decisao.acao, n, ...(decisao.texto !== undefined ? { texto: String(decisao.texto) } : {}), ...(decisao.opcao !== undefined ? { opcao: String(decisao.opcao) } : {}) };
  }
  return { acao: decisao.acao, ...(decisao.motivo ? { motivo: String(decisao.motivo).slice(0, 200) } : {}) };
}

const PROMPT_DO_DECISOR = [
  'Você conduz um navegador numa página oficial de tribunal ou de governo para achar um documento.',
  'A cada vez recebe o objetivo, a memória dos passos e a lista numerada de elementos da página.',
  'Responda SÓ um objeto JSON com uma ação: {"acao":"clicar","n":7} | {"acao":"digitar","n":3,"texto":"1234"} |',
  '{"acao":"enviar","n":3} | {"acao":"selecionar","n":5,"opcao":"STJ"} | {"acao":"voltar"} | {"acao":"ler"} |',
  '{"acao":"gravar"} quando a página atual É o documento pedido | {"acao":"desistir","motivo":"..."} quando não há caminho.',
  'Use só números que estão na lista. Nunca digite em campo de senha. Captcha e login não se resolvem: desista.',
].join('\n');

/** Só modelo local: o decisor Ollama recusa endereço que não seja desta máquina. */
function urlLocal(url) {
  try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname); } catch { return false; }
}

/**
 * O ponto de plugar quem decide. `chefe` (padrão) não decide nada: devolve `aguardar`, e a lista
 * numerada vai ao Claude da sessão, que responde com o próximo `--passo`. `ollama` é o esqueleto
 * do modelo local: DESLIGADO até `LEGALSQUAD_DECISOR_OLLAMA=1`, só fala com `localhost` (padrão
 * `http://localhost:11434`, `/api/chat`, `format: json`, temperatura 0), manda o estado em texto e
 * aceita de volta uma ação que `validarDecisao` confere. Sem dependência: `fetch` do Node.
 */
function criarDecisor(nome = 'chefe', opts = {}) {
  if (nome === 'chefe') return { nome: 'chefe', decidir: async () => ({ acao: 'aguardar' }) };
  if (nome === 'ollama') {
    const url = opts.url || process.env.LEGALSQUAD_OLLAMA_URL || 'http://localhost:11434';
    const modelo = opts.modelo || process.env.LEGALSQUAD_OLLAMA_MODELO || 'qwen2.5:7b';
    const ligado = opts.ligado ?? process.env.LEGALSQUAD_DECISOR_OLLAMA === '1';
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    return {
      nome: 'ollama', url, modelo, ligado,
      async decidir(estado) {
        if (!ligado) return { acao: 'desistir', motivo: 'decisor-ollama-desligado: ligue com LEGALSQUAD_DECISOR_OLLAMA=1 (e o Ollama rodando nesta máquina)' };
        if (!urlLocal(url)) return { acao: 'desistir', motivo: `decisor-ollama só fala com modelo local; ${url} não é desta máquina` };
        try {
          const resposta = await fetchImpl(`${url.replace(/\/$/, '')}/api/chat`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs || 60000),
            body: JSON.stringify({ model: modelo, stream: false, format: 'json', options: { temperature: 0 }, messages: [{ role: 'system', content: PROMPT_DO_DECISOR }, { role: 'user', content: estadoEmTexto(estado) }] }),
          });
          if (!resposta.ok) return { acao: 'desistir', motivo: `ollama respondeu ${resposta.status}` };
          const corpo = await resposta.json();
          return validarDecisao(JSON.parse(corpo && corpo.message ? corpo.message.content : 'null'), estado);
        } catch (erro) {
          return { acao: 'desistir', motivo: `ollama: ${String(erro && erro.message).split('\n')[0]}` };
        }
      },
    };
  }
  throw new ErroDeUso(`decisor desconhecido: ${nome} (use chefe ou ollama)`);
}

/**
 * O laço observar → decidir → agir para um decisor que decide sozinho (o modelo local). Para em
 * gravar, desistir, barreira, limite de passos ou de tempo. Com o decisor `chefe`, não roda: o
 * primeiro estado volta ao chefe, que conduz com `--passo`.
 */
async function navegarComDecisor(primeiro, decisor, opts = {}) {
  let estado = primeiro;
  const decisoes = [];
  while (estado && estado.status === 'ok' && estado.estado === 'aberta') {
    const decisao = await decisor.decidir(estado);
    decisoes.push(decisao);
    if (decisao.acao === 'aguardar') return { ...estado, decisor: decisor.nome, decisoes };
    if (decisao.acao === 'desistir') {
      const fechado = await executarPasso(estado.sessao, { acao: 'fechar' }, opts);
      return { ...fechado, status: 'desistiu', motivo: decisao.motivo || null, decisor: decisor.nome, decisoes };
    }
    const r = await executarPasso(estado.sessao, decisao, opts);
    if (r.status === 'erro') { estado = { ...estado, erro: r.erro }; if (decisoes.length > (estado.max_passos || NAV_MAX_PASSOS) * 2) break; continue; }
    estado = r;
  }
  return { ...estado, decisor: decisor.nome, decisoes };
}

/** O resultado de um passo em texto curto, para o chefe (o JSON inteiro sai com `--json`). */
function textoDoResultado(r) {
  if (!r) return '';
  if (r.status === 'ok' && r.gravada) {
    const g = r.gravada;
    const linhas = [`Gravada: ${g.url} (${g.tipo}, ${g.bytes} bytes, sha256_texto ${String(g.sha256_texto || '').slice(0, 12)}…) em ${g.arquivo}`];
    linhas.push(g.reabre_por_url ? 'A URL sozinha serve o mesmo documento: a reabertura compara por ela.' : `Aviso: ${g.aviso}`);
    if (r.receita) linhas.push(`Receita: ${r.receita.id} (${r.receita.passos} passo(s)${r.receita.atalho ? `, atalho ${r.receita.atalho}` : ', sem atalho'}) em ${r.receita.arquivo}${r.receita.reconhece ? '' : '\n  sem --reconhece: a receita não se liga sozinha a citações; use --receita <id> --param k=v, ou grave de novo com --reconhece "<regex com grupos nomeados>"'}`);
    return linhas.join('\n');
  }
  if (r.status === 'acesso_falhou' || r.status === 'sessao-encerrada' || r.status === 'desistiu') {
    return [`${r.status}: ${r.motivo || ''}${r.faltam ? ` (faltam: ${r.faltam.join(', ')})` : ''}${r.url ? ` em ${r.url}` : ''}`, r.erro || null, r.aviso || null, r.instrucao || null, r.navegar ? `Para navegar: ${r.navegar.comando}` : null].filter(Boolean).join('\n');
  }
  if (r.status === 'fechada') return `Sessão ${r.id} fechada; navegador encerrado.`;
  const linhas = [];
  if (r.status === 'erro') linhas.push(`Erro: ${r.erro}`);
  if (r.url || r.elementos) linhas.push(estadoEmTexto(r));
  if (r.texto !== undefined) linhas.push(`Texto (parte ${r.parte} de ${r.partes}):\n${r.texto}`);
  if (r.no_texto) linhas.push(r.no_texto.length ? `No texto:\n  …${r.no_texto.join('…\n  …')}…` : 'No texto: nada.');
  if (r.status === 'ok' || r.status === 'erro') linhas.push(`Próximo: node scripts/fonte-oficial.mjs --passo ${r.sessao} --clicar N | --digitar N "texto" | --enviar N | --selecionar N "opção" | --voltar | --ler [parte] | --procurar "texto" | --gravar [--reconhece "<regex>"] [--url-da-fonte <url>] | --fechar`);
  return linhas.join('\n');
}
// <<< fonte-navegacao:end

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USO = `Uso:
  node scripts/fonte-oficial.mjs --pesquisa <pesquisa.md> [--peca <minuta.md>] --out <dir>
  node scripts/fonte-oficial.mjs --fontes <tabela.json|manifesto.json|https://...> --out <dir>
  node scripts/fonte-oficial.mjs --stj "AgRg no HC 1.054.751/SC" [--out <dir>] [--json]
  node scripts/fonte-oficial.mjs --reabrir <manifesto.json|tabela.json> --out <dir> --json
  node scripts/fonte-oficial.mjs --navegar --objetivo "<o que achar>" --url <início oficial> --out <dir> [--tipo <tipo>] [--param nome=valor ...] [--max-passos 12] [--max-tempo 300] [--decisor chefe|ollama]
  node scripts/fonte-oficial.mjs --passo <sessão> --clicar N | --digitar N "texto" | --enviar N | --selecionar N "opção" | --voltar | --ler [parte] | --procurar "texto" | --gravar [--reconhece "<regex>"] [--url-da-fonte <url>] | --fechar
  node scripts/fonte-oficial.mjs --receita <id|arquivo.json> --param nome=valor --out <dir>
  node scripts/fonte-oficial.mjs --listar-receitas
Opções: --cache <dir> · --forcar · --playwright auto|on|off · --playwright-modulo <caminho> · --espera <ms> · --timeout <ms> · --receitas-dir <dir>|off · --json`;

function die(mensagem, codigo = 2) {
  console.error(mensagem);
  process.exit(codigo);
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const chave = arg.slice(2);
    const proximo = argv[i + 1];
    // `--param` se repete (um por parâmetro da navegação ou da receita).
    if (chave === 'param') { flags.param = [...(flags.param || [])]; if (proximo !== undefined && !proximo.startsWith('--')) { flags.param.push(proximo); i += 1; } continue; }
    if (proximo === undefined || proximo.startsWith('--')) flags[chave] = true;
    else { flags[chave] = proximo; i += 1; }
  }
  return { flags, positionals };
}

function lerJson(caminho) {
  try { return JSON.parse(readFileSync(caminho, 'utf8')); } catch (erro) { die(`não consegui ler ${caminho} como JSON: ${erro.message}`); }
  return null;
}

function opcoesDe(flags) {
  const playwright = typeof flags.playwright === 'string' ? flags.playwright : 'auto';
  if (!['auto', 'on', 'off'].includes(playwright)) die(`--playwright aceita auto, on ou off (recebi "${playwright}")`);
  return {
    out: typeof flags.out === 'string' ? resolve(flags.out) : null,
    cache: flags.cache === false || flags.cache === 'off' ? null : resolve(typeof flags.cache === 'string' ? flags.cache : 'acervo/_fontes'),
    forcar: flags.forcar === true,
    playwright,
    playwrightModulo: typeof flags['playwright-modulo'] === 'string' ? resolve(flags['playwright-modulo']) : 'playwright',
    esperaMs: typeof flags.espera === 'string' ? Number(flags.espera) : ESPERA_PADRAO_MS,
    timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : TIMEOUT_PADRAO_MS,
    log: flags.json ? () => {} : (m) => console.error(m),
    // Receitas de navegação: as do projeto e as que a curadoria distribui nos pacotes.
    receitas: flags['receitas-dir'] === 'off' ? null : resolve(typeof flags['receitas-dir'] === 'string' ? flags['receitas-dir'] : 'acervo/_receitas'),
    pacotes: flags['receitas-dir'] === 'off' ? null : resolve('acervo/_packs'),
    // Só para a suíte: servidor de fixture local em http e um STJ simulado.
    permitirHttp: flags['permitir-http'] === true,
    baseStj: typeof flags['base-stj'] === 'string' ? flags['base-stj'] : undefined,
  };
}

function registrarNoIndice(out, entrada) {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  appendFileSync(join(out, 'INDEX.jsonl'), linhaDeIndice(entrada));
}

/** O JSON de saída aponta as cópias; o corpo delas fica no disco (uma pesquisa com 40 fontes passa de 5 MB com o texto dentro). */
const semCorpo = (entradas) => entradas.map((e) => JSON.parse(linhaDeIndice(e)));

async function baixarTodas(urls, opts) {
  const entradas = [];
  const jar = criarJar();
  const ultimoAcesso = new Map();
  for (const url of urls) {
    opts.log(`baixando ${url}`);
    const entrada = await baixar(url, { ...opts, jar, ultimoAcesso });
    registrarNoIndice(opts.out, entrada);
    entradas.push(entrada);
    opts.log(`  ${entrada.status}${entrada.motivo ? `: ${entrada.motivo}` : ''} (${entrada.motor || 'sem motor'})${entrada.aviso ? ` · ${entrada.aviso}` : ''}`);
  }
  return entradas;
}

function resumir(entradas) {
  const ok = entradas.filter((e) => e.status === 'ok');
  const falhas = entradas.filter((e) => e.status !== 'ok');
  const porMotor = {};
  for (const e of ok) porMotor[e.motor] = (porMotor[e.motor] || 0) + 1;
  return { total: entradas.length, ok: ok.length, acesso_falhou: falhas.length, por_motor: porMotor, falhas: falhas.map((e) => ({ url: e.url, motivo: e.motivo, aviso: e.aviso || null, instrucao: e.instrucao || null, ...(e.navegar ? { navegar: e.navegar.comando } : {}) })) };
}

/**
 * O código de saída de `--pesquisa`: 1 só quando NENHUMA fonte abriu (rede fora, host que recusa
 * tudo); a falha isolada é relatada (no JSON, na linha de resumo e no INDEX.jsonl) e o comando segue
 * com 0. Medido em 26/09/2026 (K26, contrato social, motor 0.9.59): 50 de 51 fontes baixadas e um
 * `tls` num PDF do STF deram exit 1, e o chefe tratou o passo 0 como falho. A fonte que não abriu
 * continua sendo o que era: `acesso_falhou` com o motivo, que o verificador diz. O `--fontes` (as
 * fontes que a tabela ou o manifesto citam, uma a uma) segue saindo 1 com qualquer falha: ali cada
 * fonte é de uma citação.
 */
function codigoDeSaidaDaPesquisa(resumo) {
  return resumo.total > 0 && resumo.ok === 0 ? 1 : 0;
}
// Só para a suíte, com `--permitir-http`: o servidor de fixture local não é host oficial.
const URL_LOCAL_DE_TESTE = /http:\/\/127\.0\.0\.1:\d+\/[^\s<>"'`)\]]+/g;

/** A instrução de instalar o Playwright, uma vez, quando alguma fonte precisou do navegador que não há. */
function avisarInstrucao(resumo) {
  const instrucao = resumo.falhas.map((f) => f.instrucao).find(Boolean);
  if (instrucao) console.error(`fonte-oficial: ${instrucao}`);
}

/** `--param tema=1234 --param uf=SC` → { tema: '1234', uf: 'SC' }. */
function parametrosDe(lista) {
  const params = {};
  for (const item of lista || []) {
    const i = String(item).indexOf('=');
    if (i < 1) die(`--param espera nome=valor (recebi "${item}")`);
    params[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return params;
}

/** A ação de um `--passo`, pelas flags: uma e só uma. */
function acaoDoPasso(flags, positionals) {
  const nomes = ['clicar', 'digitar', 'enviar', 'selecionar', 'voltar', 'ler', 'procurar', 'gravar', 'fechar'].filter((a) => flags[a] !== undefined);
  if (nomes.length !== 1) die(`--passo precisa de uma ação: --clicar N | --digitar N "texto" | --enviar N | --selecionar N "opção" | --voltar | --ler [parte] | --procurar "texto" | --gravar | --fechar\n\n${USO}`);
  const acao = nomes[0];
  const numero = (v) => { if (!/^\d+$/.test(String(v))) die(`--${acao} espera o número do elemento na lista (recebi "${v}")`); return Number(v); };
  if (acao === 'clicar' || acao === 'enviar') return { acao, n: numero(flags[acao]) };
  if (acao === 'digitar') {
    const texto = typeof flags.texto === 'string' ? flags.texto : positionals[0];
    if (texto === undefined) die('--digitar N "texto": falta o texto');
    return { acao, n: numero(flags.digitar), texto };
  }
  if (acao === 'selecionar') {
    const opcao = typeof flags.opcao === 'string' ? flags.opcao : positionals[0];
    if (opcao === undefined) die('--selecionar N "opção": falta a opção');
    return { acao, n: numero(flags.selecionar), opcao };
  }
  if (acao === 'ler') return { acao, parte: typeof flags.ler === 'string' ? Number(flags.ler) || 1 : 1 };
  if (acao === 'procurar') { if (typeof flags.procurar !== 'string') die('--procurar "texto": falta o texto'); return { acao, texto: flags.procurar }; }
  return { acao };
}

function imprimirNavegacao(resultado, flags) {
  if (flags.json) console.log(JSON.stringify(resultado, null, 1));
  else console.log(textoDoResultado(resultado));
  const ok = ['ok', 'fechada'].includes(resultado.status);
  process.exit(ok ? 0 : resultado.status === 'erro' ? 2 : 1);
}

/**
 * Receitas antes do download cego e antes de pedir navegação: cada citação que uma receita reconhece
 * vai por ela; as URLs que ela resolveu não são baixadas de novo. Receita que falha entra no resumo
 * com o comando de navegação.
 */
async function rodarReceitas(achados, opts) {
  const entradas = [];
  const resolvidas = new Set();
  for (const { receita, params, citacao } of achados) {
    opts.log(`receita ${receita.id} para "${citacao}"`);
    const entrada = await executarReceita(receita, params, opts);
    registrarNoIndice(opts.out, { ...entrada, citacao, ...(entrada.navegar ? { navegar: entrada.navegar.comando } : {}) });
    entradas.push({ ...entrada, citacao });
    if (entrada.status === 'ok') for (const u of [entrada.url, entrada.url_final]) if (u) resolvidas.add(u);
    opts.log(`  ${entrada.status}${entrada.motivo ? `: ${entrada.motivo}` : ''}${entrada.via ? ` (${entrada.via})` : ''}`);
  }
  return { entradas, resolvidas };
}

/** A escada de sempre, com a receita de navegação na frente quando a cópia registrada veio de cliques. */
function baixarPelaReceitaQuandoNavegada(lista, out) {
  return async (url, o) => {
    const marca = marcaDeNavegacao(out, url, o.registrada || {});
    const receita = marca && marca.receita ? acharReceita(marca.receita, lista) : null;
    if (receita) {
      const e = await executarReceita(receita, marca.parametros || {}, o);
      if (e.status === 'ok') return { ...e, receita: receita.id };
    }
    return baixar(url, o);
  };
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const modos = ['pesquisa', 'fontes', 'stj', 'reabrir', 'navegar', 'passo', 'receita', 'listar-receitas'].filter((m) => flags[m] !== undefined);
  if (modos.length !== 1) die(USO);
  const opts = opcoesDe(flags);
  const receitas = opts.receitas ? listarReceitas({ receitas: opts.receitas, pacotes: opts.pacotes }) : [];

  if (flags.navegar !== undefined) {
    if (typeof flags.objetivo !== 'string' || typeof flags.url !== 'string') die(`--navegar precisa de --objetivo "<o que achar>" e --url <início oficial>\n\n${USO}`);
    let resultado;
    try {
      resultado = await iniciarNavegacao({
        objetivo: flags.objetivo, url: flags.url, tipo: typeof flags.tipo === 'string' ? flags.tipo : null, params: parametrosDe(flags.param),
        maxPassos: typeof flags['max-passos'] === 'string' ? Number(flags['max-passos']) : NAV_MAX_PASSOS,
        maxTempoS: typeof flags['max-tempo'] === 'string' ? Number(flags['max-tempo']) : NAV_MAX_TEMPO_S,
        ...opts,
      });
      const decisor = typeof flags.decisor === 'string' ? flags.decisor : 'chefe';
      if (decisor !== 'chefe' && resultado.status === 'ok') resultado = await navegarComDecisor(resultado, criarDecisor(decisor), opts);
    } catch (erro) {
      if (erro instanceof ErroDeUso) die(erro.message);
      throw erro;
    }
    if (!flags.json && resultado.instrucao && resultado.motivo === 'sem-playwright') console.error(`fonte-oficial: ${resultado.instrucao}`);
    imprimirNavegacao(resultado, flags);
  }

  if (flags.passo !== undefined) {
    const dir = dirDaSessao(typeof flags.passo === 'string' ? flags.passo : '', opts.out);
    if (!dir) die(`--passo espera a pasta da sessão que o --navegar devolveu (ou o id dela com --out); "${flags.passo}" não é`);
    const acao = acaoDoPasso(flags, positionals);
    const resultado = await executarPasso(dir, acao, {
      ...opts, reconhece: typeof flags.reconhece === 'string' ? flags.reconhece : null, semReceita: flags['sem-receita'] === true,
      urlDaFonte: typeof flags['url-da-fonte'] === 'string' ? flags['url-da-fonte'] : null,
    });
    imprimirNavegacao(resultado, flags);
  }

  if (flags['listar-receitas'] !== undefined) {
    const linhas = receitas.map((r) => ({ id: r.id, parametros: r.parametros, atalho: r.atalho || null, passos: (r.passos || []).length, reconhece: r.reconhece || null, quebrada: Boolean(r.quebrada), usos: r.usos || 0, origem: r.origem_arquivo, arquivo: r.arquivo }));
    if (flags.json) console.log(JSON.stringify({ receitas: linhas }, null, 1));
    else console.log(linhas.length ? linhas.map((r) => `${r.quebrada ? '[quebrada] ' : ''}${r.id} (${r.parametros.join(', ') || 'sem parâmetros'}; ${r.atalho ? 'atalho' : `${r.passos} passo(s)`}; ${r.usos} uso(s); ${r.origem}) ${r.arquivo}`).join('\n') : `fonte-oficial: nenhuma receita em ${opts.receitas || '(receitas desligadas)'}`);
    process.exit(0);
  }

  if (flags.receita !== undefined) {
    if (typeof flags.receita !== 'string') die(USO);
    if (!opts.out) die('--out é obrigatório em --receita');
    const receita = acharReceita(flags.receita, receitas);
    if (!receita) die(`receita "${flags.receita}" não encontrada (veja --listar-receitas)`);
    const entrada = await executarReceita(receita, parametrosDe(flags.param), opts);
    registrarNoIndice(opts.out, { ...entrada, ...(entrada.navegar ? { navegar: entrada.navegar.comando } : {}) });
    const saida = JSON.parse(linhaDeIndice(entrada));
    if (flags.json) console.log(JSON.stringify(saida, null, 1));
    else console.log(entrada.status === 'ok' ? `fonte-oficial: receita ${receita.id} (${entrada.via}) → ${entrada.url}\n  cópia: ${entrada.arquivo}` : textoDoResultado(entrada));
    process.exit(entrada.status === 'ok' ? 0 : 1);
  }

  if (flags.pesquisa !== undefined) {
    if (typeof flags.pesquisa !== 'string') die(USO);
    let texto = readFileSync(flags.pesquisa, 'utf8');
    if (typeof flags.peca === 'string') texto += `\n${readFileSync(flags.peca, 'utf8')}`;
    const urls = [...extrairUrls(texto), ...(opts.permitirHttp ? [...new Set(texto.match(URL_LOCAL_DE_TESTE) || [])] : [])];
    if (!opts.out) die('--out é obrigatório em --pesquisa: é onde ficam as cópias que o verificador lê');
    const porReceita = await rodarReceitas(receitasNoTexto(texto, receitas), opts);
    const entradas = [...porReceita.entradas, ...await baixarTodas(urls.filter((u) => !porReceita.resolvidas.has(u)), opts)];
    const resumo = resumir(entradas);
    if (flags.json) console.log(JSON.stringify({ modo: 'pesquisa', out: opts.out, ...resumo, entradas: semCorpo(entradas) }, null, 1));
    else console.log(`fonte-oficial: ${resumo.ok}/${resumo.total} fonte(s) baixada(s) em ${opts.out}${resumo.acesso_falhou ? `; ${resumo.acesso_falhou} sem acesso: ${resumo.falhas.map((f) => `${f.url} (${f.motivo})`).join('; ')}` : ''}`);
    if (!flags.json) avisarInstrucao(resumo);
    process.exit(codigoDeSaidaDaPesquisa(resumo));
  }

  if (flags.fontes !== undefined) {
    if (typeof flags.fontes !== 'string') die(USO);
    // A URL direta também vale (uma ou várias, separadas por espaço ou vírgula): medido em 26/09/2026
    // (mandado de segurança, motor 0.9.54), `--fontes https://...` caía em "não consegui ler como JSON:
    // ENOENT", sem dizer que o modo aceitava só arquivo.
    const diretas = flags.fontes.trim().split(/[\s,]+/).filter(Boolean);
    const soUrls = diretas.length > 0 && diretas.every((u) => /^https?:\/\//i.test(u));
    if (!soUrls && !existsSync(flags.fontes)) die(`--fontes espera o caminho de um JSON com citations[].source_url (a tabela do verificador ou o manifesto) ou a URL da fonte (https://...); "${flags.fontes}" não é arquivo nem URL`);
    const objeto = soUrls ? null : lerJson(flags.fontes);
    const urls = [...new Set(soUrls ? diretas : urlsDeCitacoes(objeto))];
    if (!opts.out) die('--out é obrigatório em --fontes');
    // A citação que uma receita reconhece (pelo título) vai por ela antes do download da URL.
    const citacoes = objeto ? (Array.isArray(objeto.citations) ? objeto.citations : Array.isArray(objeto) ? objeto : []) : [];
    const achados = citacoes.flatMap((c) => (c && typeof c.title === 'string' ? receitasNoTexto(c.title, receitas, 1).map((a) => ({ ...a, url: c.source_url || null })) : []));
    const porReceita = await rodarReceitas(achados, opts);
    const servidas = new Set(achados.filter((a, i) => porReceita.entradas[i] && porReceita.entradas[i].status === 'ok' && a.url).map((a) => a.url));
    const entradas = [...porReceita.entradas, ...await baixarTodas(urls.filter((u) => !porReceita.resolvidas.has(u) && !servidas.has(u)), opts)];
    const resumo = resumir(entradas);
    if (flags.json) console.log(JSON.stringify({ modo: 'fontes', out: opts.out, ...resumo, entradas: semCorpo(entradas) }, null, 1));
    else console.log(`fonte-oficial: ${resumo.ok}/${resumo.total} fonte(s) baixada(s) em ${opts.out}${resumo.acesso_falhou ? `; ${resumo.acesso_falhou} sem acesso` : ''}`);
    if (!flags.json) avisarInstrucao(resumo);
    process.exit(resumo.acesso_falhou ? 1 : 0);
  }

  if (flags.stj !== undefined) {
    if (typeof flags.stj !== 'string') die(USO);
    const resultado = await resolverStj(flags.stj, opts);
    if (resultado.inteiro_teor) registrarNoIndice(opts.out, { ...resultado.inteiro_teor, citacao: flags.stj, registro: resultado.registro, dt_publicacao: resultado.dt_publicacao, processo: resultado.processo || null, cabecalho: resultado.cabecalho || null });
    const { inteiro_teor, ...resto } = resultado;
    const saida = { ...resto, inteiro_teor: inteiro_teor ? { status: inteiro_teor.status, motivo: inteiro_teor.motivo, motor: inteiro_teor.motor, arquivo: inteiro_teor.arquivo, texto: inteiro_teor.texto, sha256_texto: inteiro_teor.sha256_texto, sha256_bytes: inteiro_teor.sha256_bytes, baixado_em: inteiro_teor.baixado_em } : null };
    if (flags.json) console.log(JSON.stringify(saida, null, 1));
    else if (saida.status === 'ok') console.log(`fonte-oficial: ${flags.stj} → registro ${saida.registro}, publicado em ${saida.dt_publicacao}\n  inteiro teor: ${saida.url_inteiro_teor}\n  cópia: ${saida.inteiro_teor.arquivo || '(sem --out)'}${saida.aviso ? `\n  aviso: ${saida.aviso}` : ''}`);
    else {
      const detalhe = saida.divergencias ? `\n  o inteiro teor é de outro processo (${saida.cabecalho}): ${saida.divergencias.join(', ')}`
        : saida.na_pagina ? `\n  a página de resultados traz: ${saida.na_pagina.length ? saida.na_pagina.join('; ') : 'nenhum documento'}` : '';
      console.log(`fonte-oficial: ${flags.stj} → ${saida.status}: ${saida.motivo}${detalhe}`);
    }
    process.exit(saida.status === 'ok' ? 0 : 1);
  }

  if (flags.reabrir !== undefined) {
    if (typeof flags.reabrir !== 'string') die(USO);
    const objeto = lerJson(flags.reabrir);
    const jar = criarJar();
    const ultimoAcesso = new Map();
    const saida = await reabrir(objeto, { ...opts, jar, ultimoAcesso, baixarFonte: baixarPelaReceitaQuandoNavegada(receitas, opts.out) });
    // Uma linha por fonte reaberta, com o resultado real: verificada, verificada_no_acervo,
    // fonte_mudou, acesso_falhou ou sem_evidencia. Medido na medição de 24/09/2026 (defeito 37):
    // o índice gravava `status: ok` para o `fonte_mudou` do REsp 158.843-MG, e quem lia o
    // INDEX.jsonl via a fonte como conferida. `sem_evidencia` sem cópia (sem fonte, sem hash
    // nem trecho) não abriu nada e não vira linha.
    for (const c of saida.citations.filter((x) => x.status !== 'sem_evidencia' || x.fonte_local)) {
      registrarNoIndice(opts.out, {
        url: c.source_url, title: c.title, status: c.status, motivo: c.motivo || null, motor: 'reabertura', origem: c.origem || 'fonte_oficial',
        comparado_por: c.comparado_por || null, sha256_texto: c.sha256_texto || null, sha256_bytes: c.sha256_bytes || null,
        arquivo: c.fonte_local || null, arquivo_registrado: c.fonte_registrada || null,
        ...(c.aviso ? { aviso: c.aviso } : {}), ...(c.instrucao ? { instrucao: c.instrucao } : {}), baixado_em: c.consulted_at,
      });
    }
    if (flags.json) console.log(JSON.stringify(saida, null, 1));
    else {
      const naoLocalizados = saida.sem_hash.filter((s) => s.motivo === 'trecho-nao-localizado').length;
      console.log(`fonte-oficial: reabertas ${saida.citations.length - saida.resumo.sem_hash} fonte(s): ${saida.resumo.igual} igual(is) na fonte oficial, ${saida.resumo.no_acervo} conferida(s) só no acervo assinado (verificada_no_acervo), ${saida.resumo.mudou} mudou/mudaram, ${saida.resumo.acesso_falhou} sem acesso;${saida.resumo.cancelada ? ` ${saida.resumo.cancelada} cancelada(s) no acervo (súmula cancelada: não fundamente nela; status cancelada em citations[]);` : ''} ${saida.resumo.sem_hash} sem o que comparar por código (status sem_evidencia em citations[]: vão a um votante no gate final)${naoLocalizados ? `, ${naoLocalizados} delas com trecho não localizado na fonte` : ''}`);
    }
    process.exit(saida.resumo.mudou || saida.resumo.acesso_falhou || saida.resumo.cancelada ? 1 : 0);
  }
}

main().catch((erro) => die(`fonte-oficial: ${erro && erro.stack ? erro.stack : erro}`, 2));
