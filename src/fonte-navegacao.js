// Navegação guiada nas fontes oficiais: o chefe do run conduz um navegador de verdade, passo a
// passo, até a página oficial que a citação exige (súmula, Tema, acórdão, inteiro teor, lei), e o
// caminho que deu certo vira receita determinística, reaproveitada sem navegação na próxima vez.
//
// O método é o do browser-use (MIT; aprendido, não copiado): a página vira uma LISTA NUMERADA dos
// elementos com que se pode interagir (link, campo, botão, lista), com texto visível e rótulo; quem
// decide olha a lista e o objetivo e devolve UMA ação ("clique no 7", "digite 1234 no 3"); o código
// age, confere o resultado e observa de novo, com limite de passos e de tempo e memória curta do
// caminho. Aqui quem decide é o Claude da sessão (o chefe, que roda os scripts); um modelo local
// (Ollama) pluga no mesmo ponto, `criarDecisor`, sem dependência nova.
//
// Limite inegociável, em código: captcha, desafio anti-robô, login e bloqueio encerram a sessão como
// `acesso_falhou`, com o motivo e a instrução de conferir no navegador do profissional ou no acervo
// assinado. O navegador não digita em campo de senha nem em campo de captcha, não se disfarça (o
// User-Agent é o do Chromium headless, que se declara como tal), não usa proxy e espera entre ações
// no mesmo domínio. Só fonte oficial: a sessão começa em host `.jus.br`, `.gov.br` ou `.leg.br` e a
// navegação de página inteira para fora deles é recusada.
//
// A sessão persiste entre comandos: um Chromium headless com o perfil dentro da pasta do run
// (`<out>/navegacao/<sessão>/perfil`), aberto por `--navegar` e reatado a cada `--passo` pelo
// protocolo de depuração local (127.0.0.1). Um vigia separado mata o navegador e apaga o perfil
// quando o prazo da sessão passa, mesmo que ninguém chame `--fechar`.
//
// A lógica vive no bloco abaixo, copiado VERBATIM para `scripts/fonte-oficial.mjs` e
// `templates/scripts/fonte-oficial.mjs` (guardado por `sync-blocos`), ao lado do bloco
// `fonte-oficial`, de que usa as funções: o script roda num projeto sem `src/`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import {
  ESPERA_PADRAO_MS, INSTRUCAO_PLAYWRIGHT, sha1, ehHostOficial, normalizarTexto, chaveDeTrecho,
  registrarResposta, baixar, detectarPlaywright, detectarPdftotext, linhaDeIndice, nomeDaMarcaDeNavegacao,
  baixarComFetch, classificarResposta, lerCache, TIMEOUT_PADRAO_MS,
} from './fonte-oficial.js';

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

export {
  NAV_MAX_PASSOS,
  NAV_MAX_TEMPO_S,
  INSTRUCAO_BARREIRA,
  ErroDeUso,
  hostAceito,
  dirDaSessao,
  lerSessao,
  iniciarNavegacao,
  executarPasso,
  textoContem,
  faltamParametros,
  parametrizar,
  preencher,
  caminhoLimpo,
  montarReceita,
  erroDoReconhece,
  listarReceitas,
  acharReceita,
  receitasNoTexto,
  executarReceita,
  sugestaoDeNavegacao,
  marcaDeNavegacao,
  estadoEmTexto,
  validarDecisao,
  criarDecisor,
  navegarComDecisor,
  textoDoResultado,
  escolherParaMostrar,
};
