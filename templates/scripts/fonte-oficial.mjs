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
// Opções: --cache <dir> (padrão acervo/_fontes) · --forcar (ignora o cache) ·
//   --playwright auto|on|off (padrão auto) · --playwright-modulo <caminho do pacote> ·
//   --espera <ms> (entre pedidos ao mesmo host; padrão 2000) · --timeout <ms> · --json
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
// fonte_mudou, acesso_falhou, sem_evidencia). Resposta vazia, página de erro e documento de outro
// processo são `acesso_falhou` com motivo, nunca `ok`.
//
// Sai com 0 quando tudo abriu, 1 quando alguma fonte ficou `acesso_falhou` ou
// `fonte_mudou` (o chamador decide o que fazer), 2 em erro de uso.

import { createHash, X509Certificate } from 'node:crypto';
import { connect as conectarTls, rootCertificates } from 'node:tls';
import { request as pedirHttps } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
const CLASSES_STJ = { HC: 'HC', RHC: 'RHC', RESP: 'RESP', ARESP: 'ARESP', ERESP: 'ERESP', RMS: 'RMS', MS: 'MS', CC: 'CC', PET: 'PET', MC: 'MC', AI: 'AI' };

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
  if (status === 403) return RE_CAPTCHA.test(amostra) ? { bloqueio: 'captcha' } : { gateway: '403' };
  if (status === 429) return { gateway: '429' };
  if (status >= 500) return { gateway: `http-${status}` };
  if (status >= 400) return { bloqueio: `http-${status}` };
  if (RE_CAPTCHA.test(amostra)) return { bloqueio: 'captcha' };
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

  const baixadoEm = agora().toISOString();
  if (!classe.ok) {
    const motivo = classe.bloqueio || classe.gateway || 'desconhecido';
    // A instrução só onde o navegador resolveria: desafio de JavaScript, 403, home do SCON, gateway do e-SAJ.
    const instrucao = classe.semPlaywright && classe.gateway && GATEWAY_DE_NAVEGADOR(classe.gateway) ? { instrucao: INSTRUCAO_PLAYWRIGHT } : {};
    return {
      url, host: u.hostname, motor, status: 'acesso_falhou', motivo, url_final: resposta.urlFinal || url, http: resposta.status || null,
      baixado_em: baixadoEm, ...(classe.semPlaywright ? { aviso: classe.semPlaywright } : {}), ...instrucao,
    };
  }

  const corpo = resposta.corpo;
  const tipo = classe.tipo;
  const html = tipo === 'html' ? decodificarHtml(corpo, resposta.contentType) : null;
  const texto = tipo === 'pdf' ? textoDePdf(corpo, pdftotext) : tipo === 'html' ? textoDeHtml(html) : normalizarTexto(corpo.toString('utf8'));
  const invalido = motivoDeConteudoInvalido(url, corpo, tipo, texto, conferirPedido);
  if (invalido) {
    return { url, host: u.hostname, motor, status: 'acesso_falhou', motivo: invalido, url_final: resposta.urlFinal, http: resposta.status, tipo, bytes: corpo.length, baixado_em: baixadoEm };
  }
  const { arquivo, textoArquivo } = out ? gravarCopia(out, url, tipo, corpo, texto || null, new Date(baixadoEm), sempreComData) : { arquivo: null, textoArquivo: null };
  const entrada = {
    url, host: u.hostname, motor, status: 'ok', motivo: null, url_final: resposta.urlFinal, http: resposta.status,
    tipo, arquivo, texto: textoArquivo, bytes: corpo.length,
    sha256_bytes: sha256(corpo), sha256_texto: texto ? sha256(texto) : null,
    hash_de: texto ? 'texto' : 'bytes', baixado_em: baixadoEm,
  };
  gravarCache(cache, { ...entrada, arquivo: arquivo || nomeLocal(url, tipo) }, corpo, texto);
  return { ...entrada, texto_extraido: texto, ...(devolverCorpo ? { corpo, html } : {}) };
}

// --- STJ: registro, data de publicação e inteiro teor ----------------------

const RE_CLASSE_STJ = /\b(HC|RHC|REsp|AREsp|EREsp|RMS|MS|CC|Pet|MC|AI)\s*(?:n[ºo.]?\s*)?([\d.]+)\s*(?:[-/]\s*([A-Z]{2})\b)?/i;
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
    const id = linha.match(/^(.*?)\b(HC|RHC|REsp|AREsp|EREsp|RMS|MS|CC|Pet|MC|AI)\s+(\d+)\s+([A-Z]{2})\s+(\d{4}\/\d{7}-\d)/);
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
  [/EMBARGOS\sDE\sDIVERG[ÊE]NCIA\sEM\s(?:AGRAVO\sEM\s)?(?:RECURSO\sESPECIAL|RESP)$/, 'ERESP'],
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
function chaveDeTrecho(texto) {
  return normalizarTexto(texto).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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
      if (porTrecho || (hashTexto && hashTexto === hashDoAcervo)) {
        saida.citations.push({
          title: c.title, source_url: c.source_url, status: 'verificada_no_acervo', origem: 'acervo', consulted_at: new Date().toISOString(),
          sha256_texto: hashDoAcervo, sha256_bytes: null, trecho_presente: porTrecho || null, comparado_por: 'acervo',
          fonte_local: acervo, verificador: 'reabertura',
        });
        saida.resumo.no_acervo += 1;
        continue;
      }
    }
    // A cópia registrada é achada ANTES do download novo, que vai para outra pasta e nunca a substitui.
    const registrada = copiaRegistrada(c.source_url, { fonteLocal: acervo ? null : fonteLocal, out: opts.out, raiz, hashBytes, hashTexto, pdftotext });
    const entrada = await baixar(c.source_url, { ...opts, pdftotext, forcar: true, cache: null, out: dirReabertura, sempreComData: true, devolverCorpo: true });
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

const FORA_DO_INDICE = new Set(['texto_extraido', 'corpo', 'html']);

/** O índice guarda o caminho da cópia, nunca o corpo: um JSONL de run não é lugar para megabytes de PDF. */
function linhaDeIndice(entrada) {
  const resto = Object.fromEntries(Object.entries(entrada).filter(([chave]) => !FORA_DO_INDICE.has(chave)));
  return `${JSON.stringify(resto)}\n`;
}
// <<< fonte-oficial:end

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USO = `Uso:
  node scripts/fonte-oficial.mjs --pesquisa <pesquisa.md> [--peca <minuta.md>] --out <dir>
  node scripts/fonte-oficial.mjs --fontes <tabela.json|manifesto.json|https://...> --out <dir>
  node scripts/fonte-oficial.mjs --stj "AgRg no HC 1.054.751/SC" [--out <dir>] [--json]
  node scripts/fonte-oficial.mjs --reabrir <manifesto.json|tabela.json> --out <dir> --json
Opções: --cache <dir> · --forcar · --playwright auto|on|off · --playwright-modulo <caminho> · --espera <ms> · --timeout <ms> · --json`;

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
  return { total: entradas.length, ok: ok.length, acesso_falhou: falhas.length, por_motor: porMotor, falhas: falhas.map((e) => ({ url: e.url, motivo: e.motivo, aviso: e.aviso || null, instrucao: e.instrucao || null })) };
}

/** A instrução de instalar o Playwright, uma vez, quando alguma fonte precisou do navegador que não há. */
function avisarInstrucao(resumo) {
  const instrucao = resumo.falhas.map((f) => f.instrucao).find(Boolean);
  if (instrucao) console.error(`fonte-oficial: ${instrucao}`);
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const modos = ['pesquisa', 'fontes', 'stj', 'reabrir'].filter((m) => flags[m] !== undefined);
  if (modos.length !== 1) die(USO);
  const opts = opcoesDe(flags);

  if (flags.pesquisa !== undefined) {
    if (typeof flags.pesquisa !== 'string') die(USO);
    let texto = readFileSync(flags.pesquisa, 'utf8');
    if (typeof flags.peca === 'string') texto += `\n${readFileSync(flags.peca, 'utf8')}`;
    const urls = extrairUrls(texto);
    if (!opts.out) die('--out é obrigatório em --pesquisa: é onde ficam as cópias que o verificador lê');
    const entradas = await baixarTodas(urls, opts);
    const resumo = resumir(entradas);
    if (flags.json) console.log(JSON.stringify({ modo: 'pesquisa', out: opts.out, ...resumo, entradas: semCorpo(entradas) }, null, 1));
    else console.log(`fonte-oficial: ${resumo.ok}/${resumo.total} fonte(s) baixada(s) em ${opts.out}${resumo.acesso_falhou ? `; ${resumo.acesso_falhou} sem acesso: ${resumo.falhas.map((f) => `${f.url} (${f.motivo})`).join('; ')}` : ''}`);
    if (!flags.json) avisarInstrucao(resumo);
    process.exit(resumo.acesso_falhou ? 1 : 0);
  }

  if (flags.fontes !== undefined) {
    if (typeof flags.fontes !== 'string') die(USO);
    // A URL direta também vale (uma ou várias, separadas por espaço ou vírgula): medido em 26/09/2026
    // (mandado de segurança, motor 0.9.54), `--fontes https://...` caía em "não consegui ler como JSON:
    // ENOENT", sem dizer que o modo aceitava só arquivo.
    const diretas = flags.fontes.trim().split(/[\s,]+/).filter(Boolean);
    const soUrls = diretas.length > 0 && diretas.every((u) => /^https?:\/\//i.test(u));
    if (!soUrls && !existsSync(flags.fontes)) die(`--fontes espera o caminho de um JSON com citations[].source_url (a tabela do verificador ou o manifesto) ou a URL da fonte (https://...); "${flags.fontes}" não é arquivo nem URL`);
    const urls = [...new Set(soUrls ? diretas : urlsDeCitacoes(lerJson(flags.fontes)))];
    if (!opts.out) die('--out é obrigatório em --fontes');
    const entradas = await baixarTodas(urls, opts);
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
    const saida = await reabrir(objeto, { ...opts, jar, ultimoAcesso });
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
      console.log(`fonte-oficial: reabertas ${saida.citations.length - saida.resumo.sem_hash} fonte(s): ${saida.resumo.igual} igual(is) na fonte oficial, ${saida.resumo.no_acervo} conferida(s) só no acervo assinado (verificada_no_acervo), ${saida.resumo.mudou} mudou/mudaram, ${saida.resumo.acesso_falhou} sem acesso; ${saida.resumo.sem_hash} sem o que comparar por código (status sem_evidencia em citations[]: vão a um votante no gate final)${naoLocalizados ? `, ${naoLocalizados} delas com trecho não localizado na fonte` : ''}`);
    }
    process.exit(saida.resumo.mudou || saida.resumo.acesso_falhou ? 1 : 0);
  }
}

main().catch((erro) => die(`fonte-oficial: ${erro && erro.stack ? erro.stack : erro}`, 2));
