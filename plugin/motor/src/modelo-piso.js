// Piso automático de um squad-modelo: tudo o que se confere por código antes de publicar um modelo
// como V1, num comando só (`squad-modelo --piso <id|pasta|todos>`), para a fábrica de modelos e para
// a curadoria (PLANO-VOLUME-SQUADS-MODELO, seção 3). Nenhuma leitura humana: o dono publica modelos
// em volume antes de revisá-los, e o piso é o que garante o mínimo do que o aluno recebe com a marca
// V1.
//
// O modelo é compilado numa pasta temporária, com as skills, as best-practices e os agentes do
// projeto (o projeto não é tocado), e passa por:
//
//  1. check-squad sem erro;
//  2. nenhum marcador sem prosa;
//  3. recriar dá o mesmo: a prosa extraída do squad compilado recompila byte a byte o mesmo squad
//     (é o ciclo da curadoria, `--extrair --forcar`, que não pode perder texto);
//  4. régua da escolha com todos os modelos instalados: nenhuma falha que envolva o modelo e nenhuma
//     skill de pacote de outra área;
//  5. inventário runner × scripts sobre o squad compilado: nenhum comando com flag, subcomando ou
//     argumento errado;
//  6. varredura de fronteira: nenhum diploma de rito de outra área onde não cabe (a menção que cabe
//     de propósito o curador declara em `fronteira_aceita` no modelo.yaml, e ela vira aviso);
//  7. nenhuma lei, súmula, Tema ou precedente citado por número na prosa e no desenho (o extrator é o
//     do hook do Citation Gate, o mesmo que confere a peça do run); no modelo marcado
//     `citacao_por_numero: legado`, aviso em vez de falha;
//  8. nenhum travessão;
//  9. sigilo: nenhum CPF ou CNPJ com dígito válido, OAB plausível ou número de processo com dígito
//     válido no caso fictício, na prosa ou no desenho;
// 10. vocabulário: sem processo (`processo: nenhum`), o texto gerado não fala em juiz, autos ou folha;
// 11. a versão declarada no modelo.yaml é coerente com as provas.
//
// A saída diz, por checagem, se passou e o que falhou; o valor de um dado de sigilo nunca é repetido.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseYamlSubconjunto } from './yaml-subconjunto.js';
import { ErroDeCompilacaoDeSquad, emitirProsa, extrairProsa, marcadoresDe } from './squad-compile.js';
import { checkSquad } from './squad-check.js';
import { materializar } from './modelo-escritorio.js';
import { ErroDeModelo, PASTA_DE_MODELOS, ehModeloTransversal, listarModelos, skillsForaDaArea, testarModelos } from './squad-modelo.js';
import { maturidadeDoModelo } from './modelo-maturidade.js';
import { casaArea, ramosDaArea } from './area.js';
import { ligacaoDoProjeto, pacotesPorArquivoDoDeposito, ramosDoDeposito, skillsDoDeposito } from './deposito.js';
import { defaultBestPracticesCatalogPath } from './best-practices-catalog.js';
import { ROOT, inventariar, textosDaPasta, verdade } from './runner-x-scripts.js';
import { cnpjValido, cpfValido, detectar, redigir } from './chefe-memoria.js';

const falha = (m) => { throw new ErroDeModelo(m); };
const CODE_DO_PISO = 'piso';
const TRAVESSAO = '\u2014';

export const CHECAGENS_DO_PISO = Object.freeze([
  { id: 'check-squad', nome: 'check-squad sem erro' },
  { id: 'marcadores', nome: 'todos os marcadores com prosa' },
  { id: 'recriar', nome: 'recriar do modelo dá o mesmo squad' },
  { id: 'regua', nome: 'régua da escolha com todos os modelos, sem skill de outra área' },
  { id: 'inventario', nome: 'inventário runner × scripts sem desvio' },
  { id: 'fronteira', nome: 'varredura de fronteira' },
  { id: 'citacoes', nome: 'nenhuma lei, súmula, Tema ou precedente citado por número' },
  { id: 'travessao', nome: 'nenhum travessão' },
  { id: 'sigilo', nome: 'sigilo: nenhum dado que pareça real' },
  { id: 'vocabulario', nome: 'vocabulário da peça sem processo' },
  { id: 'maturidade', nome: 'versão coerente com as provas' },
]);

const lerYaml = (caminho, rotulo) => parseYamlSubconjunto(readFileSync(caminho, 'utf8'), rotulo, { falha });

/** O modelo pelo id (instalado em `squads/_modelos/`) ou pela pasta (a fábrica, antes de publicar). */
export function resolverModeloDoPiso(alvo, { cwd, todos = listarModelos(cwd) } = {}) {
  const porId = todos.find((m) => m.id === String(alvo));
  const caminho = resolve(cwd, String(alvo));
  if (!porId && existsSync(join(caminho, 'modelo.yaml'))) {
    const meta = lerYaml(join(caminho, 'modelo.yaml'), `${basename(caminho)}/modelo.yaml`) || {};
    const id = String(meta.id || basename(caminho));
    return { id, dir: caminho, completo: existsSync(join(caminho, 'design.yaml')) && existsSync(join(caminho, 'prosa.yaml')), meta, pasta: true };
  }
  if (!porId) falha(`modelo «${alvo}» não existe em ${PASTA_DE_MODELOS}/ nem é uma pasta com modelo.yaml`);
  return porId;
}

/** Arquivos de texto de um squad compilado (relativos), fora de `_build/` e do que é do run. */
function textosDoSquad(dir) {
  const out = [];
  const andar = (sub) => {
    let entradas;
    try { entradas = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.name.startsWith('.')) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!['_build', 'output', 'autos', 'node_modules'].includes(e.name)) andar(rel); continue; }
      if (e.isFile() && /\.(md|ya?ml|csv|json)$/.test(e.name)) out.push({ rel, texto: readFileSync(join(dir, rel), 'utf8') });
    }
  };
  andar('');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const linhaDe = (texto, indice) => texto.slice(0, indice).split('\n').length;
// Todo trecho que a saída repete passa pela redação da memória do chefe: o dado de sigilo que estiver
// perto de um achado de outra checagem (o travessão na mesma linha do CPF) não volta na saída.
// A janela não corta número ao meio (um pedaço de CPF não seria reconhecido pela redação).
function trechoDe(texto, i, f) {
  let a = Math.max(0, i - 40);
  let b = Math.min(texto.length, f + 40);
  while (a > 0 && /[\d./-]/.test(texto[a - 1])) a -= 1;
  while (b < texto.length && /[\d./-]/.test(texto[b])) b += 1;
  return redigir(texto.slice(a, b).replace(/\s+/g, ' ').trim());
}

/** Os textos que o curador escreve: o desenho, a prosa e a identidade do modelo. */
function textosDoCurador(modelo) {
  return ['modelo.yaml', 'design.yaml', 'prosa.yaml', 'discovery.yaml']
    .filter((n) => existsSync(join(modelo.dir, n)))
    .map((n) => ({ rel: n, texto: readFileSync(join(modelo.dir, n), 'utf8') }));
}

// ───────────────────────── fronteira ─────────────────────────
//
// Os diplomas de rito de uma área, pela sigla ou pelo nome (é vocabulário de citação, como no Citation
// Gate: o motor reconhece a forma, a área do modelo decide onde cabe). Medido em 22/09/2026: o texto de
// um squad penal falava em "prazo em dobro (CPC ...)" e "dias úteis", errado no processo penal. O
// processo civil é subsidiário no trabalho e no previdenciário; a CLT é matéria também do
// previdenciário (vínculo, tempo de contribuição). Um diploma é "de outra área" quando o modelo não é
// de nenhuma das áreas em que ele cabe.
const DIPLOMAS_DE_AREA = [
  { rotulo: 'diploma penal', re: /\bCPP\b|\bC[óo]digo de Processo Penal\b|\bC[óo]digo Penal\b|\bLEP\b/g, cabe: ['penal'] },
  { rotulo: 'diploma trabalhista', re: /\bCLT\b|\bConsolida[çc][ãa]o das Leis do Trabalho\b/g, cabe: ['trabalho', 'previdenciario'] },
  { rotulo: 'diploma de processo civil em modelo penal', re: /\bCPC\b|\bC[óo]digo de Processo Civil\b/g, naoCabe: ['penal'] },
];
const semAcento = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** A sigla de um diploma casado, para a lista `fronteira_aceita` do modelo.yaml. */
const SIGLA = { 'codigo de processo penal': 'cpp', 'codigo penal': 'codigo penal', 'consolidacao das leis do trabalho': 'clt', 'codigo de processo civil': 'cpc' };
const siglaDe = (t) => SIGLA[semAcento(t)] || semAcento(t);

/**
 * Menções a diploma de rito de outra área num texto. `aceitos` são as siglas que o curador declara
 * em `fronteira_aceita` no modelo.yaml, quando a menção cabe de propósito (o contrato de serviços que
 * afasta o vínculo de emprego fala da CLT): voltam com `aceito: true`, e o piso as avisa sem reprovar.
 */
export function fronteiraDoTexto(texto, area, { ramos = [], aceitos = [] } = {}) {
  const achados = [];
  if (!area) return achados;
  const eh = (a) => casaArea(String(area), a, ramos);
  const aceitas = new Set([].concat(aceitos || []).map(siglaDe));
  for (const d of DIPLOMAS_DE_AREA) {
    const foraDaArea = d.cabe ? !d.cabe.some(eh) : d.naoCabe.some(eh);
    if (!foraDaArea) continue;
    for (const m of texto.matchAll(d.re)) achados.push({ linha: linhaDe(texto, m.index), rotulo: `${d.rotulo} (${m[0]})`, trecho: trechoDe(texto, m.index, m.index + m[0].length), aceito: aceitas.has(siglaDe(m[0])) });
  }
  return achados.sort((a, b) => a.linha - b.linha);
}

// ───────────────────────── sigilo ─────────────────────────

/** Dígito verificador do número único do processo (Res. CNJ 65/2008): NNNNNNN AAAA J TR OOOO DD mod 97 = 1. */
export function cnjValido(valor) {
  const d = String(valor).replace(/\D/g, '');
  if (d.length !== 20) return false;
  const n = d.slice(0, 7);
  const dv = d.slice(7, 9);
  const resto = d.slice(9);
  if (/^0+$/.test(n + resto)) return false;
  return BigInt(`${n}${resto}${dv}`) % 97n === 1n;
}

/** Inscrição na OAB plausível: UF real (o detector já exige) e número que não é máscara (0000, 1111, 123456). */
function oabPlausivel(trecho) {
  const d = String(trecho).replace(/\D/g, '');
  if (d.length < 3 || d.length > 7) return false;
  if (/^(\d)\1+$/.test(d)) return false;
  return !'01234567890'.includes(d) && !'98765432109'.includes(d);
}

const ROTULO_DO_SIGILO = { cpf: 'CPF com dígito válido', cnpj: 'CNPJ com dígito válido', oab: 'inscrição na OAB plausível', processo_cnj: 'número de processo com dígito válido' };

/** Dados que parecem reais num texto: `{ linha, tipo }`, nunca o valor. */
export function sigiloDoTexto(texto) {
  const out = [];
  for (const a of detectar(texto)) {
    const trecho = texto.slice(a.inicio, a.fim);
    const real = a.tipo === 'cpf' ? cpfValido(trecho)
      : a.tipo === 'cnpj' ? cnpjValido(trecho)
        : a.tipo === 'oab' ? oabPlausivel(trecho)
          : a.tipo === 'processo_cnj' ? cnjValido(trecho)
            : false;
    if (real) out.push({ linha: linhaDe(texto, a.inicio), tipo: ROTULO_DO_SIGILO[a.tipo] });
  }
  return out;
}

// ───────────────────────── vocabulário ─────────────────────────

/** O texto sem código (cercado e em linha), com as quebras de linha no lugar: caminho e comando não são vocabulário. */
function semCodigo(texto) {
  return texto
    .replace(/(^|\n)(\s*)(```|~~~)[\s\S]*?\n\s*\3[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

// "Folha" de salários, de pagamento, salarial, do mês ou mensal é termo técnico de contabilidade e de
// departamento pessoal, não a página dos autos (área Contabilidade, 29/09/2026): o piso reprovava o
// modelo de rotina contábil por "folha de pagamento". "folha 12", "fl." e "folhas dos autos" seguem reprovados.
const FOLHA_TECNICA = String.raw`\s+(?:de\s+(?:sal[aá]rios?|pagamentos?)|salaria(?:l|is)|d[oe]\s+m[eê]s|mensa(?:l|is))(?![\p{L}\p{N}])`;
const RE_VOCABULARIO_DE_PROCESSO = new RegExp(String.raw`(?<![\w/.:-])(ju[ií]z(?:a|es|as)?|autos|folhas?(?!${FOLHA_TECNICA})|fls?\.)(?![\w/:-])`, 'giu');

/** "juiz", "autos", "folha" (da página, não a de pagamento) num texto de peça sem processo, fora de código e de caminho. */
export function vocabularioDeProcesso(texto) {
  const limpo = semCodigo(texto);
  const out = [];
  for (const m of limpo.matchAll(RE_VOCABULARIO_DE_PROCESSO)) out.push({ linha: linhaDe(limpo, m.index), palavra: m[1].toLowerCase(), trecho: trechoDe(texto, m.index, m.index + m[0].length) });
  return out;
}

// ───────────────────────── citações ─────────────────────────

/** O hook do Citation Gate: o da raiz do motor, ou o do modelo de IDE na instalação distribuída. */
function caminhoDoHook() {
  for (const rel of ['.claude/hooks/verifica-citacoes.mjs', 'templates/ide-templates/claude-code/.claude/hooks/verifica-citacoes.mjs']) {
    if (existsSync(join(ROOT, rel))) return join(ROOT, rel);
  }
  return null;
}

/** Citações por número num texto, pelo extrator do hook (`--citacoes`). `null` quando o hook não está. */
export function citacoesDoTexto(texto, { pasta } = {}) {
  const hook = caminhoDoHook();
  if (!hook) return null;
  const tmp = pasta || mkdtempSync(join(tmpdir(), 'legalsquad-piso-cit-'));
  const arquivo = join(tmp, `texto-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  try {
    writeFileSync(arquivo, texto, 'utf8');
    const r = spawnSync(process.execPath, [hook, '--citacoes', arquivo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) falha(`o extrator de citações do hook falhou: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    const j = JSON.parse(r.stdout);
    return [...(j.cobertas || []), ...(j.descobertas || [])].map((c) => ({ linha: c.linha, classe: c.classe, bruto: c.bruto })).sort((a, b) => a.linha - b.linha);
  } finally {
    rmSync(pasta ? arquivo : tmp, { recursive: true, force: true });
  }
}

// ───────────────────────── o piso ─────────────────────────

function compararSquads(a, b) {
  const ta = new Map(textosDoSquadTodos(a));
  const tb = new Map(textosDoSquadTodos(b));
  const diferentes = [];
  for (const rel of new Set([...ta.keys(), ...tb.keys()])) {
    if (!ta.has(rel)) diferentes.push(`${rel}: só na recriação`);
    else if (!tb.has(rel)) diferentes.push(`${rel}: sumiu na recriação`);
    else if (ta.get(rel) !== tb.get(rel)) diferentes.push(`${rel}: conteúdo diferente`);
  }
  return diferentes.sort();
}

function textosDoSquadTodos(dir) {
  const out = [];
  const andar = (sub) => {
    for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '_build') andar(rel); continue; }
      if (e.isFile()) out.push([rel, readFileSync(join(dir, rel), 'utf8')]);
    }
  };
  andar('');
  return out;
}

/** O contexto do projeto que o piso usa uma vez só (a régua, o depósito, a verdade dos scripts). */
export function contextoDoPiso(cwd, { todos = listarModelos(cwd), V = null } = {}) {
  const deposito = ligacaoDoProjeto(cwd)?.deposito || null;
  const mapa = deposito ? skillsDoDeposito(deposito) : null;
  const registros = deposito ? pacotesPorArquivoDoDeposito(deposito) : null;
  return { cwd, todos, deposito, mapa, registros, ramos: ramosDoDeposito(deposito), V: V || verdade() };
}

/**
 * Roda o piso num modelo. Devolve `{ id, dir, aprovado, checagens: [{ id, nome, ok, falhas, avisos }], maturidade }`.
 * `ctx` (de `contextoDoPiso`) evita reler o projeto quando o piso roda em todos os modelos.
 */
export function pisoDoModelo(alvo, { cwd, hoje = new Date().toISOString().slice(0, 10), ctx = null } = {}) {
  const c = ctx || contextoDoPiso(cwd);
  const modelo = typeof alvo === 'object' && alvo ? alvo : resolverModeloDoPiso(alvo, { cwd, todos: c.todos });
  if (modelo.meta?.origem?.tipo === 'escritorio') falha(`«${modelo.id}» é modelo do escritório: o piso é para o modelo de pacote, antes de publicar`);
  const meta = modelo.meta || {};
  const transversal = ehModeloTransversal(meta);
  const resultado = new Map(CHECAGENS_DO_PISO.map((x) => [x.id, { ...x, ok: true, falhas: [], avisos: [] }]));
  const reprovar = (id, msg) => { resultado.get(id).falhas.push(msg); };
  const avisar = (id, msg) => { resultado.get(id).avisos.push(msg); };
  const fechar = () => {
    const checagens = [...resultado.values()].map((x) => ({ ...x, ok: x.falhas.length === 0 }));
    return { id: modelo.id, dir: modelo.dir, aprovado: checagens.every((x) => x.ok), checagens, maturidade: maturidadeDoModelo(meta) };
  };
  if (!modelo.completo) {
    reprovar('check-squad', 'o modelo está incompleto (sem design.yaml ou prosa.yaml): nada a compilar');
    for (const id of ['marcadores', 'recriar', 'inventario', 'vocabulario']) reprovar(id, 'não conferido: o modelo não compila');
  }
  const todosComEste = [...c.todos.filter((m) => m.id !== modelo.id), modelo];
  const tmp = mkdtempSync(join(tmpdir(), 'legalsquad-piso-'));
  try {
    let design = {};
    try { design = lerYaml(join(modelo.dir, 'design.yaml'), `${modelo.id}/design.yaml`) || {}; } catch (e) { if (modelo.completo) reprovar('check-squad', `design.yaml ilegível: ${e.message}`); }
    const semProcesso = String(design?.squad?.processo || '').trim() === 'nenhum';
    let dirA = null;
    if (modelo.completo) {
      // 1 e 2. Compila e confere a estrutura e os marcadores.
      const sqA = join(tmp, 'a', 'squads');
      try {
        const rA = materializar(c.cwd, modelo, { squadsDir: sqA, code: CODE_DO_PISO, hoje, todos: todosComEste, instalar: false });
        dirA = rA.dir;
        const check = checkSquad(CODE_DO_PISO, { squadsDir: sqA, skillsDir: join(c.cwd, 'skills'), bestPracticesDir: dirname(defaultBestPracticesCatalogPath(c.cwd)), raizDoProjeto: c.cwd });
        for (const i of check.issues) (i.severity === 'error' ? reprovar : avisar)('check-squad', `[${i.code}] ${i.detail}`);
        for (const { rel, texto } of textosDoSquad(dirA)) for (const id of marcadoresDe(texto)) reprovar('marcadores', `${rel}: ${id}`);
      } catch (e) {
        if (!(e instanceof ErroDeModelo) && !(e instanceof ErroDeCompilacaoDeSquad)) throw e;
        reprovar('check-squad', `o modelo não compila com este motor: ${e.message}`);
        for (const id of ['marcadores', 'recriar', 'inventario', 'vocabulario']) reprovar(id, 'não conferido: o modelo não compila');
      }
      if (dirA) {
        // 3. Recriar: a prosa extraída do compilado recompila o mesmo squad.
        const ex = extrairProsa(CODE_DO_PISO, { squadsDir: join(tmp, 'a', 'squads'), hoje });
        for (const f of ex.faltantes) reprovar('recriar', `a extração não recupera ${f.arquivo}: ${f.id} (${f.motivo})`);
        for (const p of ex.parciais) reprovar('recriar', `a extração recupera em parte ${p.arquivo}: ${p.id}`);
        const dirM = join(tmp, 'modelo', modelo.id);
        mkdirSync(dirM, { recursive: true });
        for (const n of ['design.yaml', 'modelo.yaml', 'discovery.yaml']) if (existsSync(join(modelo.dir, n))) writeFileSync(join(dirM, n), readFileSync(join(modelo.dir, n), 'utf8'), 'utf8');
        writeFileSync(join(dirM, 'prosa.yaml'), emitirProsa({ origem: `${modelo.id} (piso)`, arquivos: ex.arquivos }), 'utf8');
        const rB = materializar(c.cwd, { ...modelo, dir: dirM }, { squadsDir: join(tmp, 'b', 'squads'), code: CODE_DO_PISO, hoje, todos: todosComEste, instalar: false });
        for (const d of compararSquads(dirA, rB.dir)) reprovar('recriar', d);

        // 5. Inventário runner × scripts no squad compilado.
        const inv = inventariar(textosDaPasta(dirA), c.V);
        for (const d of inv.desvios) reprovar('inventario', `${relative(dirA, d.origem).split(sep).join('/')}:${d.linha} [${d.tipo}] ${d.detalhe}`);

        // 10. Vocabulário: sem processo, nada de juiz, autos e folha no texto gerado.
        if (semProcesso) {
          for (const { rel, texto } of textosDoSquad(dirA)) {
            if (!/\.(md|ya?ml)$/.test(rel)) continue;
            for (const v of vocabularioDeProcesso(texto)) reprovar('vocabulario', `${rel}:${v.linha} «${v.palavra}» em «${v.trecho}»`);
          }
        } else avisar('vocabulario', `o modelo declara processo ${design?.squad?.processo ? `«${design.squad.processo}»` : 'judicial (padrão)'}: a regra vale para peça sem processo`);
      }
    }

    // 4. Régua da escolha com todos os modelos, e skills de outra área.
    const t = testarModelos(todosComEste, { ramos: c.ramos });
    if (t.sem_exemplos.includes(modelo.id)) reprovar('regua', 'sem pedidos_exemplo no modelo.yaml: nada a testar');
    for (const f of t.falhas) {
      const envolve = f.modelo === modelo.id || f.obtido === modelo.id || (f.obtido === 'ambiguo' && (f.candidatos || []).includes(modelo.id));
      if (!envolve) continue;
      reprovar('regua', `${f.modelo}: "${f.pedido}" ${f.esperado === 'escolha' ? 'devia escolher' : 'não podia escolher'} ${f.modelo}, obteve ${f.obtido} (${f.ranking.join(' · ')})`);
    }
    if (c.mapa) {
      const pacoteDoModelo = c.registros?.get(`squads/_modelos/${modelo.id}/modelo.yaml`)?.[0] || null;
      const achados = skillsForaDaArea(modelo, {
        pacoteDe: (sk) => c.registros?.get(`skills/${sk}/SKILL.md`) || c.mapa.get(sk) || null,
        ramosPorSlug: c.ramos,
        pacoteDoModelo,
        pacoteDaBestPractice: (bp) => c.registros?.get(`_legalsquad/core/best-practices/${bp}.md`) || null,
      });
      for (const x of achados) {
        if (x.area_condicional) { reprovar('regua', `o agente ${x.agente} declara a skill ${x.skill} para a área ${x.area_condicional} (skills_por_area), mas ela vem do pacote ${x.pacote}, que essa área não liga`); continue; }
        (x.best_practice ? avisar : reprovar)('regua', `${x.agente ? `o agente ${x.agente} usa` : 'o squad usa'} ${x.best_practice ? 'a best-practice' : 'a skill'} ${x.skill}, do pacote ${x.pacote}, que não é da área do modelo${transversal && !x.best_practice ? ' (no modelo transversal, a skill de área entra por skills_por_area)' : ''}`);
      }
    } else avisar('regua', 'projeto sem depósito ligado: a origem das skills não foi conferida');

    // 6 a 9. Os textos do curador: fronteira, citações por número, travessão e sigilo.
    const ramos = meta.area && !transversal ? ramosDaArea(String(meta.area), c.ramos) : [];
    if (transversal) avisar('fronteira', 'modelo transversal: serve a todas as áreas e fala do rito de cada uma; a fronteira entre áreas não se aplica');
    else if (!meta.area) avisar('fronteira', 'o modelo.yaml não declara a área: a fronteira não foi conferida');
    const pastaCit = join(tmp, 'citacoes');
    mkdirSync(pastaCit, { recursive: true });
    // A fronteira olha o que o agente lê: o squad compilado (a prosa já nos marcadores e o texto fixo
    // do motor), não os registros do desenho, que explicam por que a skill de outra área ficou de fora.
    if (dirA && !transversal) {
      for (const { rel, texto } of textosDoSquad(dirA)) {
        if (!/\.(md|ya?ml)$/.test(rel)) continue;
        for (const x of fronteiraDoTexto(texto, meta.area, { ramos, aceitos: meta.fronteira_aceita })) (x.aceito ? avisar : reprovar)('fronteira', `${rel}:${x.linha} ${x.rotulo} num modelo de «${meta.area}»${x.aceito ? ', aceito em fronteira_aceita' : ''}: «${x.trecho}»`);
      }
    } else if (!transversal) avisar('fronteira', 'não conferida: o modelo não compila');
    for (const { rel, texto } of textosDoCurador(modelo)) {
      // Citação por número: na prosa e no desenho, pelo extrator do hook.
      if (rel === 'design.yaml' || rel === 'prosa.yaml') {
        const cits = citacoesDoTexto(texto, { pasta: pastaCit });
        if (cits === null) avisar('citacoes', 'o hook do Citation Gate não está nesta instalação: as citações não foram conferidas');
        // Decisão do dono (28/09/2026): a regra vale para todo modelo novo; o modelo anterior a ela, que o
        // curador marca com `citacao_por_numero: legado` no modelo.yaml, recebe aviso em vez de falha até ser
        // revisado para V2 ou V3. A peça do run continua conferida citação a citação pelo Citation Gate.
        else {
          const legado = String(meta.citacao_por_numero || '').trim().toLowerCase() === 'legado';
          for (const x of cits) (legado ? avisar : reprovar)('citacoes', `${rel}:${x.linha} ${x.classe} «${redigir(x.bruto)}»${legado ? ' (modelo legado: aviso)' : ''}`);
        }
      }
      texto.split('\n').forEach((l, i) => { if (l.includes(TRAVESSAO)) reprovar('travessao', `${rel}:${i + 1} «${trechoDe(l, l.indexOf(TRAVESSAO), l.indexOf(TRAVESSAO) + 1)}»`); });
      for (const x of sigiloDoTexto(texto)) reprovar('sigilo', `${rel}:${x.linha} ${x.tipo}`);
    }
    // O travessão no squad compilado que não veio do curador é do texto fixo do motor: o trecho em
    // volta de cada travessão do curador identifica os dele.
    if (dirA) {
      const vizinhanca = (l, i) => l.slice(Math.max(0, i - 8), i + 9).replace(/\s+/g, ' ');
      const doCurador = new Set();
      for (const { texto } of textosDoCurador(modelo)) for (const l of texto.split('\n')) for (let i = l.indexOf(TRAVESSAO); i >= 0; i = l.indexOf(TRAVESSAO, i + 1)) doCurador.add(vizinhanca(l, i));
      for (const { rel, texto } of textosDoSquad(dirA)) {
        const linhas = texto.split('\n');
        const doMotor = [];
        linhas.forEach((l, n) => { for (let i = l.indexOf(TRAVESSAO); i >= 0; i = l.indexOf(TRAVESSAO, i + 1)) if (!doCurador.has(vizinhanca(l, i))) { doMotor.push(n); break; } });
        if (doMotor.length) { const l = linhas[doMotor[0]]; reprovar('travessao', `${rel}:${doMotor[0] + 1} travessão no texto fixo do motor${doMotor.length > 1 ? ` (${doMotor.length} linhas)` : ''}: «${trechoDe(l, l.indexOf(TRAVESSAO), l.indexOf(TRAVESSAO) + 1)}»`); }
      }
    }

    // 11. A versão declarada.
    const mat = maturidadeDoModelo(meta);
    for (const p of mat.problemas) reprovar('maturidade', p);
    if (!mat.declarada) avisar('maturidade', `o modelo.yaml não declara maturidade (derivada: ${mat.derivada}); publique com maturidade: V1`);
    return fechar();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** O piso em todos os modelos de pacote do projeto. */
export function pisoDeTodos(cwd, { hoje } = {}) {
  const ctx = contextoDoPiso(cwd);
  const resultados = ctx.todos.filter((m) => m.meta?.origem?.tipo !== 'escritorio').map((m) => pisoDoModelo(m, { cwd, hoje, ctx }));
  return { total: resultados.length, aprovados: resultados.filter((r) => r.aprovado).length, resultados };
}

/** As linhas de texto de um resultado do piso. */
export function linhasDoPiso(r, { detalhado = true } = {}) {
  const linhas = [`  Piso automático de ${r.id}: ${r.aprovado ? 'APROVADO' : 'REPROVADO'} (${r.checagens.filter((x) => x.ok).length}/${r.checagens.length} checagens)`];
  for (const x of r.checagens) {
    linhas.push(`    ${x.ok ? '✓' : '✖'} ${x.nome}${x.ok ? '' : `: ${x.falhas.length} falha(s)`}`);
    if (!detalhado) continue;
    for (const f of x.falhas.slice(0, 25)) linhas.push(`        ${f}`);
    if (x.falhas.length > 25) linhas.push(`        ... e mais ${x.falhas.length - 25}`);
    for (const a of x.avisos.slice(0, 5)) linhas.push(`        ⚠ ${a}`);
  }
  return linhas;
}
