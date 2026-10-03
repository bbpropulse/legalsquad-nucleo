// Inventário "runner × scripts": todo comando que um texto lido por agente manda rodar
// (`node scripts/<x>.mjs <sub> --flag`, `npx legalsquad <sub> --flag`, `squad-state <sub>`, hooks),
// e a verdade de cada script (subcomandos, flags que o código lê, flags que ele exige), lida do
// próprio código. Usado por `tests/runner-x-scripts.test.js` e pelo piso automático dos
// squads-modelo (`squad-modelo --piso`, sobre o squad compilado do modelo); rodado à mão,
// inventaria pastas quaisquer:
//
//   node tests/runner-x-scripts-inventario.js <arquivo-ou-pasta> [...]
//
// Mora em `src/` (e não em `tests/`) porque o piso roda na instalação do aluno e do curador, que
// não levam `tests/`; lá os hooks vêm do modelo de IDE (`templates/ide-templates/claude-code/`).
//
// Por que existe: nas medições de 26 e 27/09/2026, todo run achou um desvio entre o texto e o
// script (flag que não existe, flag obrigatória que o texto não dizia, subcomando que o script
// não tem, arquivo que o texto manda ler e ninguém grava). O parser da maioria dos scripts aceita
// qualquer `--x` em silêncio, então o desvio só aparecia no run.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Na instalação distribuída não há `.claude/hooks/` na raiz do motor: os hooks vêm do modelo de IDE.
// A chave continua `.claude/hooks/<x>.mjs`, que é como o texto do squad os chama.
const real = (rel) => (rel.startsWith('.claude/hooks') && !existsSync(join(ROOT, rel)) ? `templates/ide-templates/claude-code/${rel}` : rel);
const ler = (rel) => readFileSync(join(ROOT, real(rel)), 'utf8');

// ---------------------------------------------------------------------------
// 1. Os textos: onde há comando.
// ---------------------------------------------------------------------------

/**
 * Trechos de texto que podem conter comando: cada linha lógica dos blocos cercados (com as
 * continuações `\` juntadas) e cada código em linha dos parágrafos (que pode quebrar linha).
 * Arquivo YAML: cada linha. Devolve `{ linha, trecho, contexto, bloco }`.
 */
export function trechos(texto, { yaml = false } = {}) {
  const linhas = texto.split(/\r?\n/);
  const out = [];
  if (yaml) {
    linhas.forEach((l, i) => out.push({ linha: i + 1, trecho: l, contexto: l, bloco: true }));
    return out;
  }
  let i = 0;
  const paragrafo = [];
  let inicioPar = 0;
  const fecharParagrafo = () => {
    if (!paragrafo.length) return;
    const bruto = paragrafo.join('\n');
    const contexto = bruto.replace(/\n/g, ' ');
    for (const m of bruto.matchAll(/(`+)([\s\S]+?)\1/g)) {
      const linha = inicioPar + (bruto.slice(0, m.index).match(/\n/g) || []).length + 1;
      out.push({ linha, trecho: m[2].replace(/\n\s*/g, ' '), contexto, bloco: false });
    }
    paragrafo.length = 0;
  };
  while (i < linhas.length) {
    const l = linhas[i];
    const cerca = l.match(/^\s*(```|~~~)/);
    if (cerca) {
      fecharParagrafo();
      const abre = i;
      const corpo = [];
      i += 1;
      while (i < linhas.length && !linhas[i].trim().startsWith(cerca[1])) { corpo.push({ n: i, l: linhas[i] }); i += 1; }
      // Contexto do bloco: o próprio bloco e as 4 linhas antes e depois (onde o texto diz o que é obrigatório).
      const contexto = linhas.slice(Math.max(0, abre - 4), Math.min(linhas.length, i + 5)).join(' ');
      let acumulado = null;
      let inicio = 0;
      for (const { n, l: c } of corpo) {
        const continua = /\\\s*$/.test(c);
        const limpo = c.replace(/\\\s*$/, '');
        if (acumulado === null) { acumulado = limpo; inicio = n; } else acumulado += ` ${limpo.trim()}`;
        if (continua) continue;
        out.push({ linha: inicio + 1, trecho: acumulado, contexto, bloco: true });
        acumulado = null;
      }
      if (acumulado !== null) out.push({ linha: inicio + 1, trecho: acumulado, contexto, bloco: true });
      i += 1;
      continue;
    }
    if (!l.trim()) { fecharParagrafo(); i += 1; continue; }
    if (!paragrafo.length) inicioPar = i;
    paragrafo.push(l);
    i += 1;
  }
  fecharParagrafo();
  return out;
}

// O script pode vir com prefixo (`node scripts/x.mjs`, `node "$RAIZ/scripts/x.mjs"`), sem o `node`
// (`scripts/x.mjs --flag`) ou abreviado (`squad-state <sub>`, que é como o runner fala dele em prosa).
const RE_INVOCACAO = new RegExp([
  String.raw`(?<node>\bnode\s+"?)?(?:[\w.{}$/-]*/)?(?<script>(?:scripts/(?:orchestra/)?[\w-]+\.(?:mjs|js|py))|(?:\.claude/hooks/[\w-]+\.mjs)|(?:skills/[\w-]+/scripts/[\w./-]+\.mjs))"?`,
  String.raw`(?<npx>\bnpx\s+legalsquad)\b`,
  String.raw`(?<![\w/.@-])(?<cli>legalsquad)(?=\s+[a-z])`,
  String.raw`(?<![\w/.-])(?<curto>squad-state)(?:\.mjs)?(?=\s+[a-z])`,
].join('|'), 'g');

const OPERADORES = new Set(['|', '||', '&&', ';', '>', '>>', '2>&1', '&', '→', '->', '#']);

/** Tokens de um comando: aspas, `{placeholder}` e `<placeholder>` com espaço contam como um token; `[` e `]` são marcas de opcional. */
export function tokens(resto) {
  const out = [];
  let i = 0;
  const s = resto;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '[' || c === ']') { out.push(c); i += 1; continue; }
    if (c === ')' || c === '`') break;
    let tok = '';
    while (i < s.length && !/\s/.test(s[i]) && s[i] !== ']' && s[i] !== ')' && s[i] !== '`') {
      const d = s[i];
      const fecha = d === '"' ? '"' : d === "'" ? "'" : d === '{' ? '}' : d === '<' && /[\wÀ-ú{ ]/.test(s[i + 1] || '') ? '>' : null;
      if (fecha) {
        const j = s.indexOf(fecha, i + 1);
        if (j < 0) { tok += s.slice(i); i = s.length; break; }
        tok += s.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      tok += d;
      i += 1;
    }
    if (!tok) { i += 1; continue; }
    if (OPERADORES.has(tok) || /^[12]?>/.test(tok)) break;
    out.push(tok);
  }
  return out;
}

export const ehPlaceholder = (t) => /^[{<]/.test(t) || /^["']?[{<]/.test(t) || t === '...' || t === '…' || /^\$/.test(t);
export const nomeDaFlag = (t) => { const m = t.match(/^--([A-Za-z][\w-]*)/); return m ? m[1] : null; };

// Script nomeado sem o caminho (`squad-path.mjs --modo escrita`, `fonte-oficial.mjs --navegar`).
const RE_SO_O_NOME = /(?<![\w/.-])((?:squad-state|squad-path|fonte-oficial|sumario-autos|indexar-autos|empacotar|cobertura-acervo|run-metricas|verifica-contrato|verifica-redacao|verifica-citacoes)\.mjs)(?=[\s`]|$)/g;
const CAMINHO_DO_NOME = { 'verifica-redacao.mjs': '.claude/hooks/verifica-redacao.mjs', 'verifica-citacoes.mjs': '.claude/hooks/verifica-citacoes.mjs' };

/**
 * O subcomando sozinho no começo de um código em linha (`aguardar --despacho {nome} --fim`,
 * `squads --area`, `acervo ligar`): é como o runner abrevia um comando que já mostrou inteiro.
 * Conta como invocação abreviada quando vem seguido de flag, de `squads/` ou (acervo) de um
 * subcomando dele; o dono é o script cujo subcomando aceita as flags citadas.
 */
function abreviada(trecho, V) {
  const toks = tokens(trecho);
  const [sub, seg] = toks;
  if (!sub || !V) return null;
  const st = V.get('scripts/squad-state.mjs');
  const cli = V.get('legalsquad');
  const flags = toks.map(nomeDaFlag).filter(Boolean);
  const cabe = (alvo) => alvo && alvo.subs?.has(sub) && flags.every((f) => alvo.subs.get(sub).flags.has(f));
  const segue = seg && (seg.startsWith('--') || seg.startsWith('squads/'));
  if (sub === 'acervo' && seg && cli.subsAcervo.has(seg)) return 'legalsquad';
  if (!segue) return null;
  if (st.subs.has(sub) && (cabe(st) || !cli.subs.has(sub))) return 'scripts/squad-state.mjs';
  if (cli.subs.has(sub)) return 'legalsquad';
  return null;
}

/** Todas as invocações de script nos trechos de um texto. */
export function invocacoes(texto, origem, { yaml = false, V = null } = {}) {
  const out = [];
  for (const t of trechos(texto, { yaml })) {
    let achou = false;
    for (const m of t.trecho.matchAll(RE_SO_O_NOME)) {
      achou = true;
      const nome = m[1];
      const script = CAMINHO_DO_NOME[nome] || `scripts/${nome}`;
      const resto = t.trecho.slice(m.index + m[0].length);
      // Com o caminho na frente, a regex principal pega; aqui só o nome solto.
      if (/scripts\/$|hooks\/$/.test(t.trecho.slice(0, m.index))) { achou = false; continue; }
      out.push({ origem, linha: t.linha, script, forma: 'curto', bloco: t.bloco, tokens: tokens(resto), bruto: `${m[0]}${resto}`.slice(0, 220), contexto: t.contexto });
    }
    if (!t.bloco && !new RegExp(RE_INVOCACAO.source).test(t.trecho) && !achou) {
      const dono = abreviada(t.trecho, V);
      if (dono) out.push({ origem, linha: t.linha, script: dono, forma: 'curto', bloco: false, tokens: tokens(t.trecho), bruto: t.trecho.slice(0, 220), contexto: t.contexto });
      continue;
    }
    for (const m of t.trecho.matchAll(RE_INVOCACAO)) {
      const g = m.groups;
      let script;
      let forma;
      // `node skills/<skill>/scripts/x.mjs`: calculadora de pacote, não script do motor.
      if (g.script && /skills\/[\w-]+\/$/.test(m[0].slice(0, m[0].indexOf(g.script)))) { script = m[0].replace(/^node\s+"?/, '').replace(/"$/, '').replace(/^.*?(skills\/)/, '$1'); forma = 'completo'; } else if (g.script) { script = g.script; forma = g.node ? 'completo' : 'caminho'; } else if (g.npx) { script = 'legalsquad'; forma = 'completo'; } else if (g.cli) { script = 'legalsquad'; forma = 'curto'; } else { script = 'scripts/squad-state.mjs'; forma = 'curto'; }
      if (script.startsWith('scripts/') && script.endsWith('.js') === false && !existsSync(join(ROOT, script)) && existsSync(join(ROOT, 'templates', script))) script = `templates/${script}`;
      const resto = t.trecho.slice(m.index + m[0].length);
      const toks = tokens(resto);
      out.push({ origem, linha: t.linha, script, forma, bloco: t.bloco, tokens: toks, bruto: `${m[0]}${resto}`.slice(0, 220), contexto: t.contexto });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. A verdade dos scripts, lida do código.
// ---------------------------------------------------------------------------

/** Flags que um trecho de código lê: `flags.x`, `flags['x']`, `values.x`, literais '--x', listas filtradas por `flags[x]`. */
export function flagsLidas(src) {
  const out = new Set();
  for (const m of src.matchAll(/\b(?:flags|values)\.([A-Za-z_]\w*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/\b(?:flags|values)\[['"]([\w-]+)['"]\]/g)) out.add(m[1]);
  for (const m of src.matchAll(/(['"`])--([a-z][\w-]*)=?\1/g)) out.add(m[2]);
  for (const m of src.matchAll(/\[((?:\s*'[\w-]+',?)+)\]\.filter\(\((\w+)\) => flags\[\2\]/g)) for (const n of m[1].matchAll(/'([\w-]+)'/g)) out.add(n[1]);
  for (const m of src.matchAll(/^\s*'?([\w-]+)'?:\s*\{\s*type:\s*'(?:string|boolean)'/gm)) out.add(m[1]);
  return out;
}

/** Funções de topo de um arquivo: nome → { params, corpo }. */
function funcoesDeTopo(src) {
  const funcs = new Map();
  for (const m of src.matchAll(/^(?:export )?(?:async )?function (\w+)\(([^)]*)\)\s*\{/gm)) {
    const fim = src.indexOf('\n}\n', m.index);
    funcs.set(m[1], { params: m[2], corpo: src.slice(m.index, fim < 0 ? undefined : fim + 2) });
  }
  return funcs;
}

/** O que cada handler do squad-state lê de `flags`, seguindo as funções auxiliares que recebem `flags`. */
export function flagsPorHandlerDoSquadState(src = ler('scripts/squad-state.mjs')) {
  const funcs = funcoesDeTopo(src);
  const lidas = (corpo) => new Set([...corpo.matchAll(/flags\.(\w+)|flags\[['"]([\w-]+)['"]\]/g)].map((x) => x[1] || x[2]));
  const fecho = (nome, vistos = new Set()) => {
    if (vistos.has(nome) || !funcs.has(nome)) return new Set();
    vistos.add(nome);
    const f = funcs.get(nome);
    const out = lidas(f.corpo);
    for (const [outro, g] of funcs) {
      if (outro === nome || !/\bflags\b/.test(g.params)) continue;
      if (new RegExp(String.raw`\b${outro}\([^\n]*\bflags\b`).test(f.corpo)) for (const x of fecho(outro, vistos)) out.add(x);
    }
    return out;
  };
  const tabela = src.slice(src.indexOf('const commands = {'));
  const out = {};
  for (const [, sub, fn] of tabela.matchAll(/^\s+'?([\w-]+)'?: (cmd\w+),/gm)) {
    out[sub] = { handler: fn, flags: fecho(fn), corpo: funcs.get(fn)?.corpo || '' };
  }
  return out;
}

/** Flags exigidas pelas mensagens de erro: "<sub> requer --x", "--x é obrigatório em --modo", "--modo precisa de --x ... e --y". */
function obrigatoriasPelasMensagens(src) {
  const out = new Map();
  const add = (chave, flag) => { if (!out.has(chave)) out.set(chave, new Set()); out.get(chave).add(flag); };
  for (const m of src.matchAll(/['`(]([\w-]+) requer --([\w-]+)/g)) add(m[1], m[2]);
  for (const m of src.matchAll(/--([\w-]+) é obrigatório em --([\w-]+)/g)) add(m[2], m[1]);
  for (const m of src.matchAll(/--([\w-]+) precisa de --([\w-]+)[^\n]*? e --([\w-]+)/g)) { add(m[1], m[2]); add(m[1], m[3]); }
  return out;
}

/** Script → a guarda, no código, que o faz morrer sem o argumento de posição. */
export const POSICIONAL_OBRIGATORIO = {
  'scripts/squad-state.mjs': /if \(!command \|\| !dir\)/,
  'scripts/sumario-autos.mjs': /if \(!comando \|\| !entrada\)/,
  'scripts/squad-path.mjs': /if \(!caminho\) die/,
  'scripts/indexar-autos.mjs': /if \(!entrada \|\| desconhecidas\.length\)/,
  'scripts/verifica-contrato.mjs': /if \(!entrada \|\| desconhecidas\.length\)/,
  'scripts/empacotar.mjs': /if \(!squadDir\)/,
  'scripts/run-metricas.mjs': /if \(!dir\) \{/,
  'scripts/autos-para-md.py': /add_argument\('alvo'/,
};

const listaDeArquivos = (dir, filtro) => (existsSync(join(ROOT, real(dir))) ? readdirSync(join(ROOT, real(dir))).filter(filtro).map((f) => `${dir}/${f}`) : []);

/**
 * A verdade: script → { subs: Map<sub, {flags, obrigatorias}> | null, flags: Set, obrigatorias: Map, modos }.
 * `subs` nulo quando o script não tem subcomando (o primeiro argumento é caminho).
 */
export function verdade() {
  const V = new Map();

  // squad-state: a tabela exportada (o parser aceita qualquer `--x`, então a tabela é o contrato).
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'squad-state.mjs'), '--uso'], { encoding: 'utf8' });
  const uso = JSON.parse(r.stdout);
  const subs = new Map(Object.entries(uso).map(([k, v]) => [k, { flags: new Set(v.flags), obrigatorias: new Set(v.obrigatorias) }]));
  V.set('scripts/squad-state.mjs', { subs, flags: new Set([...subs.values()].flatMap((s) => [...s.flags])) });

  // Os demais: flags lidas do código; subcomandos e modos, das comparações do parser.
  const scripts = [
    ...listaDeArquivos('scripts', (f) => /\.(mjs|py)$/.test(f) && existsSync(join(ROOT, 'templates', 'scripts', f))),
    'templates/scripts/indexar-acervo.mjs',
    ...listaDeArquivos('scripts/orchestra', (f) => f.endsWith('.mjs') && !f.startsWith('_')),
    ...listaDeArquivos('.claude/hooks', (f) => f.endsWith('.mjs')),
    'scripts/validate-legal-output.mjs', 'scripts/build-metricas.mjs', 'scripts/check-legal-authorities.mjs',
  ].filter((s) => s !== 'scripts/squad-state.mjs');
  for (const s of new Set(scripts)) {
    // Os scripts do orchestra leem as flags pela `_lib.mjs` (`hasFlag('--json')`).
    const src = ler(s) + (s.startsWith('scripts/orchestra/') && /from '\.\/_lib\.mjs'/.test(ler(s)) ? ler('scripts/orchestra/_lib.mjs') : '');
    const flags = flagsLidas(src);
    const obrig = obrigatoriasPelasMensagens(src);
    const nomesDeSub = [...src.matchAll(/\bcomando\s*[!=]==\s*'([\w-]+)'/g)].map((m) => m[1]);
    const modos = (src.match(/const modos = \[([^\]]+)\]/) || [])[1];
    const entrada = { flags, obrigatorias: obrig, subs: null, modos: modos ? [...modos.matchAll(/'([\w-]+)'/g)].map((m) => m[1]) : null };
    if (nomesDeSub.length) entrada.subs = new Map([...new Set(nomesDeSub)].map((n) => [n, { flags, obrigatorias: obrig.get(n) || new Set() }]));
    V.set(s, entrada);
  }

  // A CLI: subcomandos da tabela `commands` do bin; flags das opções declaradas e de tudo o que os
  // handlers leem de `values` (o parse é `strict: false`, então uma flag fora da tabela ainda chega).
  const bin = ler('bin/legalsquad.js');
  const tabela = bin.slice(bin.indexOf('const commands = {'));
  const subsCli = new Set([...tabela.matchAll(/^ {2}'?([\w-]+)'?: \{/gm)].map((m) => m[1]));
  const flagsCli = flagsLidas(bin.slice(bin.indexOf('parseArgs({')));
  for (const f of readdirSync(join(ROOT, 'src'))) if (f.endsWith('.js') && f !== 'runner-x-scripts.js') for (const x of flagsLidas(readFileSync(join(ROOT, 'src', f), 'utf8'))) flagsCli.add(x);
  flagsCli.add('version').add('v');
  // Scripts que morrem sem o argumento de posição (a pasta do squad, o arquivo): a guarda de cada um
  // está no código (`if (!command || !dir)`, `if (!comando || !entrada)`, `if (!squadDir)`...), e o
  // teste confere que ela continua lá.
  for (const [s, guarda] of Object.entries(POSICIONAL_OBRIGATORIO)) {
    const e = V.get(s);
    if (e && guarda.test(s.endsWith('.py') ? ler(s) : ler(s))) e.posicional = true;
  }
  const acervo = readFileSync(join(ROOT, 'src', 'acervo-cli.js'), 'utf8');
  const subsAcervo = new Set([...acervo.matchAll(/\bsub === '([\w-]+)'/g)].map((m) => m[1]));
  V.set('legalsquad', { subs: new Map([...subsCli].map((n) => [n, { flags: flagsCli, obrigatorias: new Set() }])), flags: flagsCli, subsAcervo });
  return V;
}

// ---------------------------------------------------------------------------
// 3. A conferência.
// ---------------------------------------------------------------------------

/** Confere uma invocação contra a verdade. Devolve a lista de desvios (vazia quando bate). */
export function conferir(inv, V) {
  const desvios = [];
  const d = (tipo, detalhe) => desvios.push({ tipo, detalhe, origem: inv.origem, linha: inv.linha, bruto: inv.bruto });
  // Script de pacote (calculadora de skill): a verdade mora no pacote, não no motor.
  if (inv.script.startsWith('skills/')) return desvios;
  const alvo = V.get(inv.script) || V.get(inv.script.replace(/^templates\//, ''));
  if (!alvo) { d('script-inexistente', `${inv.script} não é script do motor`); return desvios; }
  const toks = inv.tokens.filter((t) => t !== '[' && t !== ']');
  const flags = toks.map(nomeDaFlag).filter(Boolean);
  let subs = [];
  if (alvo.subs) {
    const primeiro = toks[0];
    if (!primeiro || primeiro.startsWith('--')) {
      // Sem subcomando: só é desvio no comando completo (na prosa, "o `squad-state`" é nome).
      if (inv.forma === 'completo' && inv.script !== 'legalsquad') d('sem-subcomando', `${inv.script} pede um subcomando (${[...alvo.subs.keys()].join(', ')})`);
      if (inv.script === 'legalsquad' && inv.forma === 'completo' && primeiro) d('sem-subcomando', 'npx legalsquad sem subcomando antes das flags');
    } else if (!ehPlaceholder(primeiro)) {
      subs = primeiro.replace(/^["']|["']$/g, '').split('|');
      for (const s of subs) if (!alvo.subs.has(s)) d('subcomando-inexistente', `${inv.script} não tem o subcomando "${s}" (tem: ${[...alvo.subs.keys()].join(', ')})`);
      if (inv.script === 'legalsquad' && subs[0] === 'acervo' && toks[1] && !toks[1].startsWith('--') && !ehPlaceholder(toks[1]) && !alvo.subsAcervo.has(toks[1])) {
        d('subcomando-inexistente', `legalsquad acervo não tem "${toks[1]}" (tem: ${[...alvo.subsAcervo].join(', ')})`);
      }
    }
  }
  const aceitas = subs.length && subs.every((s) => alvo.subs?.has(s))
    ? new Set(subs.flatMap((s) => [...alvo.subs.get(s).flags]))
    : alvo.flags;
  for (const f of flags) if (!aceitas.has(f)) d('flag-inexistente', `--${f} não é aceita por ${inv.script}${subs.length ? ` ${subs.join('|')}` : ''}`);
  // Modos (fonte-oficial): exatamente um, e as obrigatórias dele.
  if (alvo.modos && inv.forma !== 'curto') {
    const modos = flags.filter((f) => alvo.modos.includes(f));
    if (inv.bloco || inv.forma === 'completo') {
      if (modos.length > 1) d('modos-demais', `${inv.script} aceita um modo só (${modos.join(', ')})`);
      for (const m of modos) for (const o of alvo.obrigatorias.get(m) || []) if (!flags.includes(o) && !diz(inv.contexto, o)) d('obrigatoria-omitida', `--${m} exige --${o}`);
    }
  }
  // O argumento de posição (a pasta do squad): sem ele o script morre, e placeholder conta.
  if (alvo.posicional && inv.forma === 'completo') {
    const depois = alvo.subs ? toks.slice(1) : toks;
    const ha = depois.length && !depois[0].startsWith('--');
    if (!ha && !(alvo.subs && !subs.length)) d('posicional-omitido', `${inv.script}${subs.length ? ` ${subs.join('|')}` : ''} exige o argumento de posição (a pasta do squad ou o arquivo) e o texto não o dá`);
  }
  // Obrigatórias do subcomando, só no comando completo (a prosa abreviada nomeia, não manda rodar).
  if (inv.forma === 'completo' && subs.length === 1 && alvo.subs?.has(subs[0])) {
    for (const o of alvo.subs.get(subs[0]).obrigatorias) if (!flags.includes(o) && !diz(inv.contexto, o)) d('obrigatoria-omitida', `${subs[0]} exige --${o} e o texto não diz`);
  }
  return desvios;
}

/** O contexto diz que a flag é obrigatória? */
function diz(contexto, flag) {
  return new RegExp(String.raw`--${flag}\b[^.]{0,80}obrigat|obrigat[^.]{0,80}--${flag}\b`, 'i').test(contexto || '');
}

// ---------------------------------------------------------------------------
// 4. Os textos do motor que um agente lê e executa.
// ---------------------------------------------------------------------------

export function textosDoMotor() {
  const arquivos = [
    '_legalsquad/core/runner.pipeline.md',
    'templates/ide-assets/command-body.md',
    'templates/ide-assets/instructions-body.md',
    '.claude/skills/legalsquad/SKILL.md',
    ...listaDeArquivos('.claude/agents', (f) => f.endsWith('.md')),
    ...listaDeArquivos('_legalsquad/core/prompts', (f) => f.endsWith('.md')),
    '_legalsquad/core/skills.engine.md',
  ];
  return arquivos.filter((a) => existsSync(join(ROOT, a))).map((a) => ({ origem: a, texto: ler(a), yaml: false }));
}

/** Arquivos de texto de uma pasta (steps, agentes, pipeline) para inventariar. */
export function textosDaPasta(dir) {
  const out = [];
  const andar = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '_build' || e.name === '_modelos' || e.name === 'output' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) andar(p);
      else if (/\.(md|ya?ml)$/.test(e.name)) out.push({ origem: p, texto: readFileSync(p, 'utf8'), yaml: /\.ya?ml$/.test(e.name) });
    }
  };
  if (statSync(dir).isDirectory()) andar(dir); else out.push({ origem: dir, texto: readFileSync(dir, 'utf8'), yaml: /\.ya?ml$/.test(dir) });
  return out;
}

export function inventariar(textos, V = verdade()) {
  const todas = textos.flatMap((t) => invocacoes(t.texto, t.origem, { yaml: t.yaml, V }));
  const desvios = todas.flatMap((i) => conferir(i, V));
  return { invocacoes: todas, desvios };
}
