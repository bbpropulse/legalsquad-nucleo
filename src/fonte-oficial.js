// Fonte oficial por código: acesso, cópia local e hash das fontes que a peça cita.
//
// Medido no run de paridade de 15/09/2026: o verificador de citações (só com
// WebFetch) devolveu 10 `acesso_falhou` em 26 citações: a página de resultados
// do STJ redireciona para a home sem User-Agent de navegador, o e-SAJ responde
// com um gateway de login em JavaScript, o STF e o Planalto caíram por TLS e por
// conexão resetada. Nenhuma citação estava errada; faltava acesso, e acesso não
// é juízo: é código. Este módulo baixa cada fonte oficial que a pesquisa cita,
// guarda a cópia local com hash de texto e de bytes, e reabre pela fonte
// registrada para dizer se mudou. O LLM fica só com a fidelidade.
//
// Escada de motores, nesta ordem: fetch com cabeçalhos de navegador (resolve
// STJ, STF, Planalto, Câmara e o fallback anônimo do e-SAJ) → Playwright headless
// só diante de gateway ou desafio de JavaScript → `acesso_falhou` imediato em
// captcha ou login. Captcha e credencial não se resolvem nunca; isso é código.
//
// Disciplina: um pedido por vez, espera entre pedidos ao mesmo host, uma
// repetição no máximo, sem dado de cliente na URL. Todo acesso vai para o índice
// do run, para auditoria.
//
// A lógica vive no bloco abaixo, copiado VERBATIM para `scripts/fonte-oficial.mjs`
// e `templates/scripts/fonte-oficial.mjs` (guardado por `sync-blocos`): o script é
// distribuído ao aluno e roda num projeto sem `src/`.
import { createHash, X509Certificate } from 'node:crypto';
import { connect as conectarTls, rootCertificates } from 'node:tls';
import { request as pedirHttps } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

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
 * O charset do cabeçalho Content-Type manda; sem ele, o `<meta>` das primeiras linhas; sem nenhum, UTF-8.
 */
function decodificarHtml(buffer, contentType = '') {
  const cabeca = buffer.subarray(0, 4096).toString('latin1');
  const doCabecalho = String(contentType || '').match(/charset=["']?([\w-]+)/i)?.[1];
  const charset = (doCabecalho || cabeca.match(/charset=["']?([\w-]+)/i)?.[1] || 'utf-8').toLowerCase();
  return buffer.toString(/^(iso-8859-1|latin1|windows-1252|cp1252)$/.test(charset) ? 'latin1' : 'utf8');
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ordm: 'º', ordf: 'ª', sect: '§' };
function textoDeHtml(html) {
  return normalizarTexto(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&([a-z]+);/gi, (m, e) => ENTIDADES[e.toLowerCase()] ?? m),
  );
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
const RE_JS_CHALLENGE = /enable JavaScript|habilite o JavaScript|document\.cookie\s*=\s*["']__?(?:test|challenge)/i;

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
  if (RE_JS_CHALLENGE.test(amostra)) return { gateway: 'js-challenge' };
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
  const ext = tipo === 'pdf' ? '.pdf' : tipo === 'json' ? '.json' : tipo === 'html' ? '.html' : '.txt';
  return `${sha1(url)}${ext}`;
}

function lerCache(cacheDir, url) {
  if (!cacheDir) return null;
  const meta = join(cacheDir, `${sha1(url)}.json`);
  if (!existsSync(meta)) return null;
  try {
    const entrada = JSON.parse(readFileSync(meta, 'utf8'));
    if (!entrada || entrada.status !== 'ok' || !entrada.arquivo || !existsSync(join(cacheDir, basename(entrada.arquivo)))) return null;
    return { ...entrada, arquivo: join(cacheDir, basename(entrada.arquivo)), texto: entrada.texto ? join(cacheDir, basename(entrada.texto)) : null };
  } catch { return null; }
}

function gravarCache(cacheDir, entrada, corpo, texto) {
  if (!cacheDir) return;
  mkdirSync(cacheDir, { recursive: true });
  const arquivo = join(cacheDir, basename(entrada.arquivo));
  writeFileSync(arquivo, corpo);
  let textoNome = null;
  if (texto) {
    textoNome = `${sha1(entrada.url)}.txt`;
    writeFileSync(join(cacheDir, textoNome), texto);
  }
  writeFileSync(join(cacheDir, `${sha1(entrada.url)}.json`), JSON.stringify({ ...entrada, arquivo: basename(arquivo), texto: textoNome }, null, 1));
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
 * Baixa UMA fonte oficial pela escada de motores e devolve a entrada do índice.
 * Nunca lança por acesso: acesso que falha é uma entrada `acesso_falhou` com motivo.
 */
async function baixar(url, opts = {}) {
  const {
    out = null, cache = null, forcar = false, playwright = 'auto', playwrightModulo = 'playwright',
    esperaMs = ESPERA_PADRAO_MS, timeoutMs = TIMEOUT_PADRAO_MS, fetchImpl = globalThis.fetch,
    pdftotext = detectarPdftotext(), agora = () => new Date(), jar = criarJar(), ultimoAcesso = new Map(), log = () => {}, devolverCorpo = false,
    permitirHttp = false,
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
      mkdirSync(out, { recursive: true });
      arquivo = join(out, basename(emCache.arquivo));
      copyFileSync(emCache.arquivo, arquivo);
      if (emCache.texto && existsSync(emCache.texto)) { texto = join(out, basename(emCache.texto)); copyFileSync(emCache.texto, texto); }
    }
    return { ...emCache, motor: 'cache', arquivo, texto, cache: true };
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
    return {
      url, host: u.hostname, motor, status: 'acesso_falhou', motivo, url_final: resposta.urlFinal || url, http: resposta.status || null,
      baixado_em: baixadoEm, ...(classe.semPlaywright ? { aviso: classe.semPlaywright } : {}),
    };
  }

  const corpo = resposta.corpo;
  const tipo = classe.tipo;
  const html = tipo === 'html' ? decodificarHtml(corpo, resposta.contentType) : null;
  const texto = tipo === 'pdf' ? textoDePdf(corpo, pdftotext) : tipo === 'html' ? textoDeHtml(html) : normalizarTexto(corpo.toString('utf8'));
  const arquivo = out ? join(out, nomeLocal(url, tipo)) : null;
  const textoArquivo = out && texto ? join(out, `${sha1(url)}.txt`) : null;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(arquivo, corpo);
    if (textoArquivo) writeFileSync(textoArquivo, texto);
  }
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

/** "AgRg no HC 1.054.751/SC" → { classe: 'HC', numero: '1054751', uf: 'SC', busca: <URL da página oficial de resultados> } */
const BASE_STJ = 'https://processo.stj.jus.br';
function interpretarCitacaoStj(citacao, base = BASE_STJ) {
  const texto = String(citacao || '').trim();
  const m = texto.match(/\b(HC|RHC|REsp|AREsp|EREsp|RMS|MS|CC|Pet|MC|AI)\s*(?:n[ºo.]?\s*)?([\d.]+)\s*(?:[-/]\s*([A-Z]{2}))?/i);
  if (!m) return null;
  const classe = CLASSES_STJ[m[1].toUpperCase()];
  const numero = m[2].replace(/\D/g, '');
  const uf = m[3] ? m[3].toUpperCase() : null;
  const busca = `${base}/SCON/pesquisar.jsp?acao=pesquisar&novaConsulta=true&i=1&b=ACOR&livre=&processo=${numero}&classe=${classe}`;
  return { classe, numero, uf, busca };
}

function urlInteiroTeorStj(registro, dtPublicacao, base = BASE_STJ) {
  return `${base}/SCON/GetInteiroTeorDoAcordao?num_registro=${String(registro).replace(/\D/g, '')}&dt_publicacao=${dtPublicacao}`;
}

/** "08/09/2026" → "20260908", para ordenar datas de publicação sem depender de Date. */
const chaveDeData = (d) => String(d || '').split('/').reverse().join('');

/**
 * Da página oficial de resultados: o link de inteiro teor do documento que casa com o
 * número (o próprio site o monta com registro e data de publicação) ou, sem link,
 * o registro e a data do bloco "Processo" correspondente. Quando o mesmo registro tem
 * mais de um acórdão publicado (afetação e mérito de um repetitivo), vale o mais recente:
 * medido no run de 16/09/2026, o REsp 2.048.687/BA devolvia a afetação de 29/05/2024 no
 * lugar do mérito de 08/09/2026, e o verificador precisou buscar o mérito à mão.
 */
function extrairInteiroTeorStj(html, numero, base = BASE_STJ) {
  const texto = String(html || '');
  const digitos = String(numero || '').replace(/\D/g, '');
  const links = [...texto.matchAll(/GetInteiroTeorDoAcordao\?num_registro=(\d+)&(?:amp;)?dt_publicacao=(\d{2}\/\d{2}\/\d{4})/g)];
  const numeroPontuado = digitos.replace(/\B(?=(\d{3})+(?!\d))/g, '\\.?');
  const reNumero = new RegExp(`(?:^|\\D)${numeroPontuado}(?!\\d)`);
  const blocos = texto.split(/class="documento"|class="paragrafoBRS"/);
  const alvo = blocos.find((b) => reNumero.test(b.replace(/<[^>]+>/g, '')) && /\d{4}\/\d{7}-\d/.test(b));
  const registro = (alvo || texto).match(/(\d{4}\/\d{7}-\d)/)?.[1] || null;
  if (registro) {
    const doRegistro = links.filter((l) => l[1] === registro.replace(/\D/g, ''));
    const link = doRegistro.sort((a, b) => chaveDeData(b[2]).localeCompare(chaveDeData(a[2])))[0];
    if (link) return { registro, dt_publicacao: link[2], url_inteiro_teor: urlInteiroTeorStj(link[1], link[2], base), publicacoes: doRegistro.length };
    const depois = alvo ? texto.slice(texto.indexOf(alvo)) : texto;
    const data = depois.match(/Data da Publica[\s\S]{0,300}?(?:DJEN|DJe|DJ)\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] || null;
    if (data) return { registro, dt_publicacao: data, url_inteiro_teor: urlInteiroTeorStj(registro, data, base) };
  }
  if (links.length === 1) return { registro: links[0][1], dt_publicacao: links[0][2], url_inteiro_teor: urlInteiroTeorStj(links[0][1], links[0][2], base) };
  return null;
}

async function resolverStj(citacao, opts = {}) {
  const base = opts.baseStj || BASE_STJ;
  const alvo = interpretarCitacaoStj(citacao, base);
  if (!alvo) return { citacao, status: 'acesso_falhou', motivo: 'citacao-nao-reconhecida' };
  const pagina = await baixar(alvo.busca, { ...opts, out: null, cache: null, devolverCorpo: true });
  if (pagina.status !== 'ok') return { citacao, ...alvo, status: 'acesso_falhou', motivo: `resultados: ${pagina.motivo}`, url_busca: alvo.busca };
  const dados = extrairInteiroTeorStj(pagina.html || '', alvo.numero, base);
  if (!dados) return { citacao, ...alvo, status: 'acesso_falhou', motivo: 'registro-nao-encontrado-na-pagina', url_busca: alvo.busca };
  const teor = await baixar(dados.url_inteiro_teor, opts);
  return { citacao, ...alvo, ...dados, url_busca: alvo.busca, inteiro_teor: teor, status: teor.status, motivo: teor.motivo || null };
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
 * Para cada citação registrada (manifesto ou tabela do cartório), refaz o acesso e compara.
 * Devolve no formato que `gate-verdict --citacoes` aceita: `verificada` quando o hash bate,
 * o trecho continua presente ou a cópia do acervo ainda o traz; `fonte_mudou` só quando um
 * hash registrado não bate E o trecho sumiu (isto é, quando há prova de que a fonte é outra);
 * `acesso_falhou` quando não abriu. `sem_hash` fica numa lista à parte, porque não há o que
 * comparar por código: sem hash e sem trecho, ou só trecho e ele não foi localizado (o que
 * não prova mudança, só que o código não confirmou; a conferência humana decide).
 */
async function reabrir(citacoes, opts = {}) {
  const lista = Array.isArray(citacoes?.citations) ? citacoes.citations : Array.isArray(citacoes) ? citacoes : [];
  const raiz = typeof opts.raiz === 'string' && opts.raiz ? opts.raiz : process.cwd();
  const saida = { citations: [], sem_hash: [], resumo: { igual: 0, mudou: 0, sem_hash: 0, acesso_falhou: 0 } };
  for (const c of lista) {
    if (!c || typeof c.source_url !== 'string') continue;
    const ev = c.evidence || {};
    const hashTexto = c.sha256_texto || ev.sha256_texto || null;
    const hashBytes = c.sha256_bytes || ev.sha256_bytes || null;
    const trecho = c.trecho || ev.trecho || null;
    if (!hashTexto && !hashBytes && !trecho) {
      saida.sem_hash.push({ title: c.title, source_url: c.source_url, motivo: 'sem-evidencia' });
      saida.resumo.sem_hash += 1;
      continue;
    }
    const acervo = arquivoDoAcervo(c.fonte_local || ev.fonte_local, raiz);
    if (acervo && trecho) {
      const conteudo = readFileSync(acervo, 'utf-8');
      if (trechoPresenteEm(conteudo, trecho) === true) {
        const texto = normalizarTexto(conteudo);
        saida.citations.push({
          title: c.title, source_url: c.source_url, status: 'verificada', consulted_at: new Date().toISOString(),
          sha256_texto: sha256(texto), sha256_bytes: null, trecho_presente: true, comparado_por: 'acervo',
          fonte_local: acervo, verificador: 'reabertura',
        });
        saida.resumo.igual += 1;
        continue;
      }
    }
    const entrada = await baixar(c.source_url, { ...opts, forcar: true });
    const agora = entrada.baixado_em;
    if (entrada.status !== 'ok') {
      saida.citations.push({ title: c.title, source_url: c.source_url, status: 'acesso_falhou', consulted_at: agora, motivo: entrada.motivo, verificador: 'reabertura' });
      saida.resumo.acesso_falhou += 1;
      continue;
    }
    const igual = hashTexto && entrada.sha256_texto ? hashTexto === entrada.sha256_texto : hashBytes ? hashBytes === entrada.sha256_bytes : false;
    const trechoPresente = trecho ? trechoPresenteEm(entrada.texto_extraido, trecho) : null;
    if (!igual && trechoPresente !== true && !hashTexto && !hashBytes) {
      // Só havia trecho, e ele não foi localizado: o código não confirmou, mas também não
      // provou mudança. Vai para a lista de quem precisa de conferência humana, sem derrubar
      // a confirmação que o verificador já deu (uma contestação apagaria as confirmações).
      saida.sem_hash.push({ title: c.title, source_url: c.source_url, motivo: 'trecho-nao-localizado', fonte_local: entrada.arquivo, sha256_texto: entrada.sha256_texto });
      saida.resumo.sem_hash += 1;
      continue;
    }
    const status = igual || trechoPresente === true ? 'verificada' : 'fonte_mudou';
    saida.citations.push({
      title: c.title, source_url: c.source_url, status, consulted_at: agora,
      sha256_texto: entrada.sha256_texto, sha256_bytes: entrada.sha256_bytes, trecho_presente: trechoPresente,
      comparado_por: igual ? (hashTexto && entrada.sha256_texto ? 'texto' : 'bytes') : trechoPresente === true ? 'trecho' : 'hash',
      fonte_local: entrada.arquivo, verificador: 'reabertura',
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

export {
  UA_NAVEGADOR,
  decodificarHtml,
  ehHostOficial,
  sha256,
  normalizarTexto,
  textoDeHtml,
  textoDePdf,
  detectarPdftotext,
  extrairUrls,
  urlsDeCitacoes,
  classificarResposta,
  criarJar,
  baixarComFetch,
  intermediarioDe,
  baixarComCadeia,
  detectarPlaywright,
  baixarComPlaywright,
  variantesDeGateway,
  baixar,
  interpretarCitacaoStj,
  urlInteiroTeorStj,
  extrairInteiroTeorStj,
  resolverStj,
  reabrir,
  trechoPresenteEm,
  chaveDeTrecho,
  arquivoDoAcervo,
  linhaDeIndice,
};
