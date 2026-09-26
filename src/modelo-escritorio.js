// Modelo do escritório: o squad que funcionou num caso vira ponto de partida dos casos parecidos.
//
// Refeito em 25/09/2026 como DIFERENÇA sobre o modelo de origem, depois de a revisão por execução
// da 0.9.42 provar 19 defeitos que vinham quase todos de guardar arquivos compilados inteiros. O
// modelo do escritório é:
//
// - `modelo.yaml`: identidade (rótulo que o advogado lê, peça, área herdada), origem (modelo da
//   área e a versão dele quando o escritório salvou), provas (nota do run que o originou, nunca o
//   caso) e a impressão do conteúdo;
// - `diferenca.json`: o que o escritório mudou, no nível que o compilador consome (desenho campo a
//   campo, prosa marcador a marcador) e, para o que não cabe num marcador, trechos de linha
//   ancorados no texto em volta; arquivos acrescentados e removidos;
// - `design.yaml` e `prosa.yaml` só quando o squad não nasceu de um modelo da área (squad do
//   Arquiteto): aí o modelo vai inteiro, no formato de modelo, como a curadoria faz.
//
// Criar a partir dele compila o modelo da área NA VERSÃO DE HOJE e reaplica a diferença; o que
// não reaplica (o modelo da área mudou aquele ponto) é relatado, nunca aplicado às cegas. A
// varredura de dado do caso roda no salvar, no exportar e no importar, com a mesma régua.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { emitirYaml, parseYamlSubconjunto } from './yaml-subconjunto.js';
import { ErroDeCompilacaoDeSquad, VERSAO_DO_MOTOR, alinharProsa, compilarSquad, despersonalizar, emitirProsa, existenciaNoProjeto, lerProsa, marcadoresDe, personalizar, preencherMarcadores } from './squad-compile.js';
import { checkSquad } from './squad-check.js';
import { ErroDeModelo, PASTA_DE_MODELOS, herdarDoModeloDaArea, listarModelos, testarModelos } from './squad-modelo.js';
import { arquivosDoDeposito, ligacaoDoProjeto, pacotesPorArquivoDoDeposito } from './deposito.js';
import { defaultBestPracticesCatalogPath } from './best-practices-catalog.js';
import { alinharNumeracao, aplicarDiferencaDeDesign, aplicarTrechos, canonico, caminhoLegivel, diferencaDeDesign, hashDe, mesmaProsa, normalizarProsa, trechosEntre } from './diferenca.js';
import { achadosDeCaso, indiceDoCaso, semAcento, textoDeTodosOsCasos, textoDoCaso, vocabularioDe } from './sigilo-caso.js';
import { ARQUIVO_DAS_SKILLS, aplicarMapaNoDesenho, capturarSkills, comNome, conferirSkillsNoProjeto, ehDeGate, ehVerificador, impressaoDasSkills, instalarSkills, mapaDeVolta, paraOModelo, planejarSkills, quemUsa, registrarNaOrigem, semContrato, skillsCitadasNoTexto, skillsDeGate, skillsDoFrontmatter, skillsParaLer, textosDasSkills, trocarId, validarSkills, voltaNoTexto } from './skills-escritorio.js';

export const PREFIXO_DO_ESCRITORIO = 'esc-';
export const ARQUIVO_DA_DIFERENCA = 'diferenca.json';
const FORMATO_DO_PACOTE = 'legalsquad-modelos-do-escritorio';
const VERSAO_DO_PACOTE = 2;
const ARQUIVOS_DO_MODELO = ['modelo.yaml', ARQUIVO_DA_DIFERENCA, 'design.yaml', 'prosa.yaml', ARQUIVO_DAS_SKILLS];
// Limites da importação (D13: um arquivo de 225 MB entrava e gerava um agente de 225 MB). Um
// modelo real tem dezenas de KB de diferença; o inteiro, a prosa curada, perto de 200 KB.
const LIMITE_DO_ARQUIVO = 2_000_000;
const LIMITE_DO_MODELO = 6_000_000;
const LIMITE_DA_IMPORTACAO = 40_000_000;
const RE_ID = /^[a-z0-9][a-z0-9-]*$/;
const RE_CAMINHO_DO_SQUAD = /^(?:squad\.yaml|squad-party\.csv|(?:agents|pipeline|_evals)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/;
const RE_ARQUIVO_NOVO = /^(?:agents|pipeline)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:md|ya?ml|json|csv|txt|html?)$/;

const falha = (m) => { throw new ErroDeModelo(m); };
const hojeIso = (h) => h || new Date().toISOString().slice(0, 10);
const lerJson = (c) => { try { return JSON.parse(readFileSync(c, 'utf8')); } catch { return null; } };
const lista = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
const humanizarPeca = (p) => String(p || '').replace(/[-_]+/g, ' ').trim();
export const ehDoEscritorio = (m) => m?.meta?.origem?.tipo === 'escritorio';
const lerYaml = (texto, rotulo) => parseYamlSubconjunto(texto, rotulo, { falha });
const caminhoSeguro = (rel) => typeof rel === 'string' && RE_CAMINHO_DO_SQUAD.test(rel) && !rel.split('/').some((p) => p === '..' || p === '.');

/** O que é do run ou do caso e nunca entra na diferença: memória, saídas, estado, autos. */
const doRun = (rel) => /^(?:_memory|output|_build|autos)\//.test(rel) || rel === '_evals/scores.md';

/**
 * O code do squad sai da diferença onde o compilador o escreve: caminho `squads/<code>`, `code:`,
 * `squad:` do frontmatter e a linha de fronteira do agente ("Dentro do squad `<code>`"), que é o
 * texto que o compilador escreve. A primeira versão só trocava os dois primeiros, e o squad
 * recriado declarava `squad: pi-cobranca` (D3). A troca de todo `` `<code>` `` corrompia a skill
 * homônima que o escritório citava ("carregar a skill `apelacao`" num squad de code `apelacao`,
 * revisão v2, N5): fora dessas linhas do compilador, o texto do escritório fica como está.
 */
export function despersonalizarNoSquad(texto, code) {
  const esc = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return despersonalizar(texto, code)
    .replace(new RegExp(`^(\\s*squad:\\s*"?)${esc}("?\\s*)$`, 'gm'), '$1{code}$2')
    .replace(new RegExp(`(Dentro do squad )\`${esc}\``, 'g'), '$1`{code}`');
}
const mapaDeTexto = (v, f) => (Array.isArray(v) ? v.map((x) => mapaDeTexto(x, f)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapaDeTexto(x, f)])) : typeof v === 'string' ? f(v) : v);

/** Arquivos regulares do squad (relativos), sem seguir link simbólico; os links voltam à parte. */
function arquivosDoSquad(dir) {
  const arquivos = new Map();
  const links = [];
  const andar = (sub) => {
    let entradas;
    try { entradas = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.name.startsWith('.')) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { links.push(rel); continue; }
      if (e.isDirectory()) andar(rel);
      else if (e.isFile()) arquivos.set(rel, join(dir, rel));
    }
  };
  andar('');
  return { arquivos, links };
}

const semFimDeLinha = (t) => String(t).replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');
const mesmoTexto = (a, b) => semFimDeLinha(a) === semFimDeLinha(b);
const linhaDoDesenho = (l) => /^(?:skills|best_practices): \[/.test(l) || /^- \*\*Depends on\*\*:/.test(l) || /^Skills injetadas pelo runner/.test(l);
const ehArquivo = (c) => { try { return lstatSync(c).isFile(); } catch { return false; } };

function lerEsqueleto(dir) {
  const e = lerJson(join(dir, '_build', 'esqueleto.json'));
  if (!e || !e.arquivos || typeof e.arquivos !== 'object') return null;
  return { arquivos: new Map(Object.entries(e.arquivos)), completo: e.completo === true, motor: e.motor || null, compilado_em: e.compilado_em || null };
}

/**
 * Os arquivos que a criação gerou, por impressão (`_build/gerado.json`). Squad criado de um modelo
 * do escritório e não mexido é "nada a guardar" por aqui: a diferença contra o modelo da área muda
 * sozinha quando o curador publica versão nova, e a oferta voltava em todo run (revisão v2, N7).
 */
const ARQUIVO_GERADO = /^(?:squad\.yaml|squad-party\.csv|agents\/|pipeline\/)/;
function impressoesDoSquad(dir) {
  const saida = {};
  for (const [rel, abs] of arquivosDoSquad(dir).arquivos) if (ARQUIVO_GERADO.test(rel)) saida[rel] = hashDe(readFileSync(abs, 'utf8'));
  return saida;
}
function intocadoDesdeACriacao(dir, cwd = null, skills = []) {
  const gerado = lerJson(join(dir, '_build', 'gerado.json'));
  if (!gerado || typeof gerado !== 'object') return false;
  if (canonico(gerado) !== canonico(impressoesDoSquad(dir))) return false;
  // As skills que o squad usa e que viajariam (as do escritório instaladas na criação) têm de estar
  // como a criação as deixou; skill de pacote editada depois da criação é mudança do escritório.
  const skillsNaCriacao = lerJson(join(dir, '_build', 'gerado-skills.json')) || {};
  return lista(skills).every((e) => cwd && skillsNaCriacao[`${e.tipo}:${e.no_squad || e.id}`] === impressaoDasSkills(cwd, [e]));
}

const porArquivoPersonalizado =(porArquivo, code) => Object.fromEntries(Object.entries(porArquivo).map(([a, m]) => [a, Object.fromEntries(Object.entries(m).map(([id, t]) => [id, personalizar(t, code)]))]));

// ───────────────────────── contexto do projeto ─────────────────────────

/**
 * O que é do produto e não do cliente: o texto dos modelos de pacote (com os casos fictícios deles)
 * e o perfil do escritório (a OAB e o e-mail do próprio escritório não são dado de caso, D19).
 * Os modelos do escritório nunca entram: o dado aceito num deles não pode liberar o mesmo dado em
 * outro (D6g, "lavagem"). Com `comPerfil: false` (a contribuição à comunidade), o perfil fica de
 * fora do conhecido: lá o dado do escritório também barra.
 */
export function contextoDoProjeto(cwd, todos = listarModelos(cwd), { comPerfil = true } = {}) {
  const partes = [];
  for (const m of todos.filter((x) => !ehDoEscritorio(x))) {
    for (const nome of ['design.yaml', 'prosa.yaml', 'modelo.yaml', 'caso-ficticio.md']) {
      try { partes.push(readFileSync(join(m.dir, nome), 'utf8')); } catch { /* o modelo não tem este arquivo */ }
    }
  }
  const textoPacotes = partes.join('\n');
  const perfil = comPerfil ? ['company.md', 'preferences.md'].map((n) => { try { return readFileSync(join(cwd, '_legalsquad', '_memory', n), 'utf8'); } catch { return ''; } }).join('\n') : '';
  return { conhecido: `${textoPacotes}\n${perfil}`, vocabulario: vocabularioDe(textoPacotes) };
}

/**
 * Identificador que não é do caso e está escrito numa skill ou best-practice instalada (o CNPJ de um
 * birô de crédito, o SAC de um órgão, o telefone de um tribunal) é dado público de instituição, não
 * de cliente (revisão v2, N15). A procura só roda para esses achados, pelo texto literal, e para
 * em 300 MB lidos. O que está no caso continua barrado, onde quer que também apareça.
 */
export function semDadoPublico(cwd, achados) {
  const candidatos = achados.filter((a) => !/que aparece no caso|nome/.test(a.motivo));
  if (!candidatos.length) return achados;
  // Só o conteúdo de PACOTE conta como público, lido no depósito pelo registro: a skill criada no
  // projeto (a que vai com o modelo) não pode liberar o próprio dado.
  const deposito = ligacaoDoProjeto(cwd)?.deposito;
  const mapa = deposito && existsSync(deposito) ? arquivosDoDeposito(deposito) : null;
  if (!mapa) return achados;
  const falta = new Set(candidatos.map((a) => a.trecho));
  let lido = 0;
  for (const path of mapa.keys()) {
    if (!falta.size || lido > 300_000_000) break;
    if (!/^(?:skills\/|_legalsquad\/core\/best-practices\/)/.test(path) || !/\.(md|ya?ml|json)$/.test(path)) continue;
    let t;
    try { t = readFileSync(join(deposito, ...path.split('/')), 'utf8'); } catch { continue; }
    lido += t.length;
    for (const x of [...falta]) if (t.includes(x)) falta.delete(x);
  }
  return achados.filter((a) => !candidatos.includes(a) || falta.has(a.trecho));
}

/** Ids que um pacote declara (instalados aqui ou registrados no depósito): o escritório nunca os usa. */
export function idsDePacote(cwd, todos = listarModelos(cwd)) {
  const ids = new Set(todos.filter((m) => !ehDoEscritorio(m)).map((m) => m.id));
  const deposito = ligacaoDoProjeto(cwd)?.deposito;
  const registros = deposito ? pacotesPorArquivoDoDeposito(deposito) : null;
  if (registros) for (const k of registros.keys()) { const m = /^squads\/_modelos\/([^/]+)\//.exec(k); if (m) ids.add(m[1]); }
  return ids;
}

const bestPracticesDoProjeto = (cwd) => dirname(defaultBestPracticesCatalogPath(cwd));

/**
 * Agentes e steps (`agents:<id>`, `pipeline:<id>`) que o desenho atual tem diferentes do que o Build
 * compilou, pelo manifesto `_build/compilacao.json` (skills e tasks por agente; tipo, agente e
 * volta de revisão por step). Sem manifesto, nada se afirma.
 */
function desenhoDesdeOBuild(dir, modeloNormalizado) {
  const man = lerJson(join(dir, '_build', 'compilacao.json'));
  const mudou = new Set();
  if (!man || !Array.isArray(man.agentes) || !Array.isArray(man.steps) || !modeloNormalizado) return mudou;
  const agentesAntes = new Map(man.agentes.map((a) => [a.id, a]));
  for (const a of modeloNormalizado.agentes || []) {
    const b = agentesAntes.get(a.id);
    if (!b || Number(b.skills) !== a.skills.length || Number(b.tasks) !== a.tasks.length) mudou.add(`agents:${a.id}`);
  }
  for (const id of agentesAntes.keys()) if (!(modeloNormalizado.agentes || []).some((a) => a.id === id)) mudou.add(`agents:${id}`);
  const stepsAntes = new Map(man.steps.map((s) => [s.id, s]));
  for (const s of modeloNormalizado.steps || []) {
    const b = stepsAntes.get(s.id);
    if (!b || b.type !== s.type || (b.agent ?? null) !== (s.agent ?? null) || String(b.on_reject ?? '') !== String(s.on_reject ?? '')) mudou.add(`pipeline:${s.id}`);
  }
  for (const id of stepsAntes.keys()) if (!(modeloNormalizado.steps || []).some((s) => s.id === id)) mudou.add(`pipeline:${id}`);
  return mudou;
}

// ───────────────────────── gates que a diferença não afrouxa ─────────────────────────

function valorEm(obj, caminho) {
  let no = obj;
  for (const p of caminho) {
    if (no === undefined || no === null) return undefined;
    if (p && typeof p === 'object') { const [k, v] = Object.entries(p)[0]; no = Array.isArray(no) ? no.find((x) => x && x[k] === v) : undefined; } else no = no[p];
  }
  return no;
}
const CAMPOS_NUMERICOS_DE_GATE = new Set(['citation_verifiers', 'meta_verifiers', 'max_review_cycles', 'max_citation_cycles']);

/**
 * Operações de desenho que desligariam ou afrouxariam um gate: menos verificadores, teto de ciclo
 * menor, `meta_limiar` mexido, tipo de entrega trocado, parada humana, revisão ou conferência
 * tirada. O modelo do escritório não as leva (no salvar, com aviso; na importação, recusa): uma
 * diferença importada com `citation_verifiers: 0` passava e o squad dizia "estrutura íntegra"
 * (revisão v2, N9). Devolve `{ ops, barradas }`, cada barrada com o motivo em linguagem simples.
 */
/**
 * Skills e best-practices que a operação tira de onde estavam no desenho de base: a lista do agente
 * (ou do squad) trocada inteira, ou o agente trocado inteiro. O `skills.json` não é a única porta
 * para mudar o que o conferente lê: a lista dele no desenho também é (revisão v3, A1).
 */
function tiradas(o, c, baseDesign) {
  const campo = c[c.length - 1];
  const itens = (v) => lista(v).map(String);
  if (c.length === 2 && c[0] === 'agents') {
    if (o.op !== 'alterar') return [];
    const antes = valorEm(baseDesign, c) || {};
    const depois = o.valor || {};
    return [...itens(antes.skills).filter((x) => !itens(depois.skills).includes(x)), ...itens(antes.best_practices).filter((x) => !itens(depois.best_practices).includes(x))];
  }
  if (!['skills', 'best_practices'].includes(campo)) return [];
  const depois = o.op === 'remover' ? [] : itens(o.valor);
  return itens(valorEm(baseDesign, c)).filter((x) => !depois.includes(x));
}

export function gatesProtegidos(ops, baseDesign) {
  const aceitas = [];
  const barradas = [];
  for (const o of lista(ops)) {
    const c = o.caminho || [];
    const campo = typeof c[c.length - 1] === 'string' ? c[c.length - 1] : null;
    const antes = valorEm(baseDesign, c);
    let motivo = null;
    if (c[0] === 'squad' && c[1] === 'meta_limiar' && !(o.op === 'acrescentar' && c.length === 2 && antes === undefined)) motivo = 'mexe na régua de aprovação da meta';
    else if (c[0] === 'squad' && c[1] === 'delivery_type' && antes !== undefined) motivo = 'troca o tipo de entrega, que decide os gates';
    else if (campo && CAMPOS_NUMERICOS_DE_GATE.has(campo) && (o.op === 'remover' || (antes !== undefined && !(Number(o.valor) >= Number(antes))) || (o.op !== 'remover' && !(Number(o.valor) >= 1)))) motivo = `diminui ou tira ${campo === 'max_review_cycles' || campo === 'max_citation_cycles' ? 'o teto de ciclos de revisão' : 'o número de verificadores'}`;
    else if (c[0] === 'pipeline' && c.length >= 3 && campo === 'on_reject' && antes !== undefined && o.op !== 'acrescentar') motivo = 'tira a volta da revisão para a redação';
    else if (c[0] === 'pipeline' && c.length >= 3 && campo === 'type' && antes === 'checkpoint') motivo = 'tira uma parada humana';
    else if (c[0] === 'pipeline' && c.length === 2 && o.op === 'remover' && antes && (antes.type === 'checkpoint' || antes.on_reject !== undefined || antes.citation_verifiers !== undefined || antes.meta_verifiers !== undefined)) motivo = 'tira uma parada humana, a revisão ou a conferência';
    else if (c[0] === 'agents' && c.length === 2 && o.op === 'remover' && ehVerificador(antes)) motivo = 'tira o agente de revisão ou de conferência';
    else if (c[0] === 'agents' && c.length === 3 && campo === 'specialist' && ehVerificador({ specialist: antes })) motivo = 'troca o verificador que o agente despacha';
    else if (c[0] === 'agents' && c.length >= 2 && ehVerificador(valorEm(baseDesign, c.slice(0, 2))) && tiradas(o, c, baseDesign).length) motivo = 'tira skill ou best-practice do agente de revisão ou de conferência';
    else if (c[0] === 'squad' && c[1] === 'best_practices' && c.length === 2 && tiradas(o, c, baseDesign).some((x) => ehDeGate('bp', x))) motivo = 'tira a best-practice de ética ou de sigilo';
    else if (c.length <= 1 && ['pipeline', 'agents', 'squad'].includes(c[0] ?? 'raiz')) motivo = 'troca o desenho inteiro de uma vez';
    if (motivo) barradas.push({ caminho: caminhoLegivel(c), motivo }); else aceitas.push(o);
  }
  return { ops: aceitas, barradas };
}

// ───────────────────────── a diferença de um squad ─────────────────────────

const palavras = (l) => new Set((semAcento(l).match(/[a-z0-9]{3,}/g) || []));
const semNumeroDeLista = (l) => l.replace(/^\s*(?:\d+\.|[-*])\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
/** Duas linhas do mesmo parágrafo reescrito pelo motor: metade ou mais das palavras em comum. */
function parecidas(a, b) {
  if (semNumeroDeLista(a) === semNumeroDeLista(b)) return true;
  const pa = palavras(a);
  const pb = palavras(b);
  if (!pa.size || !pb.size) return false;
  let comuns = 0;
  for (const w of pa) if (pb.has(w)) comuns++;
  return comuns / (pa.size + pb.size - comuns) >= 0.5;
}

/**
 * Num arquivo compilado por um motor anterior sem cópia no esqueleto: os trechos com as linhas que
 * só o squad tem (sem parecida no que o motor de hoje gera no mesmo ponto nem em outro ponto do
 * arquivo), inseridas depois do texto de hoje. É o que o escritório escreveu, com a margem de erro
 * de uma linha do motor antigo que o de hoje tirou inteira: por isso vai "a conferir".
 */
function linhasSoDoSquad(hoje, atual) {
  const deHoje = String(hoje).split('\n');
  const presentes = new Set(deHoje.map(semNumeroDeLista));
  const saida = [];
  for (const t of trechosEntre(hoje, atual)) {
    const tiradas = t.remover.filter((l) => l.trim());
    const doMotor = (l) => presentes.has(semNumeroDeLista(l)) || tiradas.some((r) => parecidas(r, l));
    const idx = t.inserir.map((l, i) => (l.trim() && !doMotor(l) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const de = idx[0] > 0 && !t.inserir[idx[0] - 1].trim() ? idx[0] - 1 : idx[0];
    const inserir = t.inserir.slice(de, idx[idx.length - 1] + 1).filter((l) => !l.trim() || !doMotor(l));
    saida.push({ antes: [...t.antes, ...t.remover], remover: [], inserir, depois: t.depois, inicio: t.inicio, fim: t.fim, linha: t.linha, secao: t.secao, a_conferir: true });
  }
  return saida;
}

/**
 * Onde o squad começou: o modelo da área e o texto dele na versão que o criou. A criação grava
 * essa base em `_build/base/` desde 25/09/2026; squad anterior usa o `_build/prosa.yaml`, que é a
 * prosa do modelo como veio, e o desenho do modelo se a versão ainda é a mesma.
 */
function baseDoSquad(dir, code, origem, todos, avisos) {
  const idBase = origem.base?.modelo || (origem.escritorio ? null : origem.modelo) || null;
  if (!idBase) {
    if (origem.modelo) avisos.push(`o squad nasceu do modelo do escritório «${origem.modelo}» num formato antigo: o modelo novo vai inteiro (desenho e textos)`);
    return null;
  }
  const P = todos.find((m) => m.id === idBase && !ehDoEscritorio(m) && m.completo);
  // Sem o modelo da área na pasta, a diferença não tem sobre o que ser tirada. Guardar inteiro
  // levaria a prosa curada do pacote no arquivo exportado e o congelaria (revisão v2, N16): recusa.
  if (!P) return { ausente: idBase };
  const versao = origem.base?.versao ?? origem.versao ?? null;
  const mesmaVersao = String(P.meta?.versao ?? '') === String(versao ?? '');
  const pastaBase = join(dir, '_build', 'base');
  let design;
  let prosa;
  if (existsSync(join(pastaBase, 'design.yaml')) && existsSync(join(pastaBase, 'prosa.yaml'))) {
    design = readFileSync(join(pastaBase, 'design.yaml'), 'utf8');
    prosa = lerProsa(join(pastaBase, 'prosa.yaml')).porArquivo;
  } else {
    // Squad anterior ao registro da base. A prosa com que ele nasceu está em `_build/prosa.yaml`. O
    // desenho de então não está guardado, e o do modelo da área não serve de base inteira: o
    // curador muda o desenho sem trocar a versão (medido em 25/09/2026 nos 23 squads da medição:
    // `meta_limiar`, `meta_limiar_nota` e critérios reescritos na mesma versão), e tudo isso viraria
    // "mudança do escritório". O desenho do próprio squad fica como base; os agentes e steps que
    // mudaram desde o Build (conferidos contra o manifesto da compilação) são comparados com o
    // modelo da área mais adiante (`desenhoDesdeOBuild`).
    if (existsSync(join(dir, '_build', 'prosa.yaml'))) prosa = lerProsa(join(dir, '_build', 'prosa.yaml')).porArquivo;
    else if (mesmaVersao) prosa = porArquivoPersonalizado(lerProsa(join(P.dir, 'prosa.yaml')).porArquivo, code);
    design = readFileSync(join(dir, '_build', 'design.yaml'), 'utf8');
  }
  if (!prosa) return null;
  const reconstruida = !existsSync(join(pastaBase, 'design.yaml'));
  const designDoModelo = reconstruida && mesmaVersao ? personalizar(readFileSync(join(P.dir, 'design.yaml'), 'utf8'), code) : null;
  return { modelo: P, versao, design, prosa, reconstruida, designDoModelo, mesmaVersao };
}

/**
 * Compara o squad com o que ele seria sem as mudanças do escritório e devolve a diferença. Nada é
 * gravado. `vazio` quando o squad está como o modelo da área o criou (D2: numeração, ordem de
 * chave e espaço não contam).
 */
export function diferencaDoSquad(cwd, code, { todos = listarModelos(cwd) } = {}) {
  const squadsDir = join(cwd, 'squads');
  code = String(code || '').trim();
  if (!RE_ID.test(code)) falha(`squad «${code}» inválido: minúsculas, dígitos e hífen`);
  const dir = join(squadsDir, code);
  if (!existsSync(dir)) falha(`squads/${code}/ não existe`);
  if (!existsSync(join(dir, '_build', 'design.yaml'))) {
    falha(`o squad «${code}» veio pronto do pacote da área, sem o desenho (_build/design.yaml) que o Arquiteto ou o modelo grava: ele já é o squad da área e não há o que guardar como modelo do escritório`);
  }
  const origem = lerJson(join(dir, '_build', 'modelo-origem.json')) || {};
  const avisos = [];
  const naoViaja = [];
  const despers = (t) => despersonalizarNoSquad(t, code);
  // O squad que aponta para a versão do escritório (`esc-x`, `regras-da-casa-2`) é lido como se
  // apontasse para a do modelo da área: a troca é refeita na criação, e contá-la como mudança fazia
  // o squad criado do modelo parecer mexido e a recriação "não sair igual" (revisão v3, A5 e M2).
  const volta = mapaDeVolta(cwd);
  const V = (t) => voltaNoTexto(t, volta);
  const designAtual = readFileSync(join(dir, '_build', 'design.yaml'), 'utf8');
  const achouBase = baseDoSquad(dir, code, origem, todos, avisos);
  if (achouBase?.ausente) falha(`o squad nasceu do modelo da área «${achouBase.ausente}», que não está nesta pasta: ligue a área que o traz (npx legalsquad acervo areas) e guarde de novo; sem ele, o modelo do escritório não tem sobre o que guardar a diferença`);
  const base = achouBase;

  const esq = lerEsqueleto(dir);
  const motorDoBuild = lerJson(join(dir, '_build', 'compilacao.json'))?.motor || esq?.motor || null;
  const hojeDoBuild = esq?.compilado_em || origem.criado_em || undefined;
  let ref;
  try { ref = compilarSquad(code, { squadsDir, escrever: false, hoje: hojeDoBuild }); } catch (e) {
    if (e instanceof ErroDeCompilacaoDeSquad) falha(`o desenho do squad «${code}» não compila com este motor: ${e.message}`);
    throw e;
  }
  // O que o compilador gerou no Build (o esqueleto gravado); o que ele não guardou (squad anterior a
  // 25/09/2026, arquivos sem marcador) sai da compilação de hoje, que só é exata com o mesmo motor.
  const compilados = new Map([...ref.arquivos].map(([rel, t]) => [rel, V(t)]));
  if (esq) for (const [rel, t] of esq.arquivos) compilados.set(rel, V(t));
  const exato = (rel) => Boolean(esq?.arquivos.has(rel)) || (Boolean(motorDoBuild) && motorDoBuild === VERSAO_DO_MOTOR);
  const { arquivos: disco, links } = arquivosDoSquad(dir);
  const lido = (rel) => V(readFileSync(disco.get(rel), 'utf8'));

  // Prosa atual, marcador a marcador, alinhada contra o esqueleto.
  const prosaDoSquad = {};
  const faltantes = [];
  for (const [rel, esqT] of compilados) {
    if (doRun(rel) || !marcadoresDe(esqT).length || !disco.has(rel)) continue;
    const r = alinharProsa(esqT, lido(rel));
    if (Object.keys(r.prosa).length) prosaDoSquad[rel] = r.prosa;
    for (const f of r.faltantes) faltantes.push({ arquivo: rel, ...f });
  }

  const prosaDif = {};
  const prosaDifOriginal = {};
  if (base) {
    for (const [rel, ids] of Object.entries(prosaDoSquad)) {
      for (const [id, t] of Object.entries(ids)) {
        const b = base.prosa[rel]?.[id];
        if (b !== undefined && mesmaProsa(b, t)) continue;
        // Marcador que o modelo da área já tinha: só os trechos que o escritório mudou dentro dele.
        // Reaplicados sobre o texto de hoje, levam a melhoria do curador junto; e o texto curado não
        // viaja no modelo do escritório nem no arquivo exportado (é conteúdo do pacote). Marcador
        // novo (agente acrescentado no desenho): o texto inteiro, que é todo do escritório.
        const alinhado = b === undefined ? t : alinharNumeracao(t, b);
        const trechos = b === undefined ? null : trechosEntre(b, alinhado);
        if (trechos && !trechos.length) continue;
        (prosaDif[rel] ||= {})[id] = b === undefined
          ? { texto: despers(t), base: null }
          : { base: hashDe(normalizarProsa(despers(b))), trechos: trechos.map((x) => mapaDeTexto(x, despers)) };
        (prosaDifOriginal[rel] ||= {})[id] = t;
      }
    }
  }
  const prosaEfetiva = (rel) => (base ? { ...(base.prosa[rel] || {}), ...(prosaDifOriginal[rel] || {}) } : (prosaDoSquad[rel] || {}));

  // Texto fixo: o que o squad tem além da prosa, arquivo a arquivo, contra o que ele seria.
  const texto = {};
  const removidos = [];
  const aConferir = [];
  const motorAnterior = [];
  for (const [rel, esqT] of compilados) {
    if (doRun(rel)) continue;
    const esperado = marcadoresDe(esqT).length ? preencherMarcadores(esqT, prosaEfetiva(rel)).texto : esqT;
    if (!disco.has(rel)) {
      if (exato(rel)) removidos.push(rel);
      continue;
    }
    const atual = lido(rel);
    if (mesmoTexto(esperado, atual)) continue;
    // O arquivo é o que o compilador gera hoje do desenho atual do squad: a mudança veio do desenho
    // (skill posta no agente, step novo) e já viaja na diferença de desenho; como trecho, conflitaria.
    const deHoje = ref.arquivos.has(rel) ? V(ref.arquivos.get(rel)) : undefined;
    if (deHoje !== undefined && mesmoTexto(marcadoresDe(deHoje).length ? preencherMarcadores(deHoje, prosaEfetiva(rel)).texto : deHoje, atual)) continue;
    if (!exato(rel)) {
      // Arquivo que o Build de um motor anterior não guardou (squad anterior a 25/09/2026): o texto
      // de então não existe mais. Comparado com o compilado de hoje, a linha que o motor reescreveu
      // tem uma parecida do outro lado; a que só existe no squad é do escritório e vai, marcada "a
      // conferir" para o advogado ler na prévia. Antes ela sumia e o comando respondia "Nada a
      // guardar" (revisão v2, N1). A linha do motor que o escritório reescreveu fica de fora, dito.
      const soDoSquad = linhasSoDoSquad(esperado, atual);
      if (soDoSquad.length) {
        texto[rel] = soDoSquad.map((t) => mapaDeTexto(t, despers));
        aConferir.push({ arquivo: rel, linhas: soDoSquad.flatMap((t) => t.inserir).filter((l) => l.trim()) });
      } else motorAnterior.push(rel);
      continue;
    }
    // Linha que o compilador escreve a partir do desenho (a lista de skills do agente, "skills
    // injetadas", "Depends on") não vai como trecho: a mudança de desenho já viaja na diferença de
    // desenho, e o compilador a reescreve no squad novo (com a skill do escritório, se for o caso).
    const trechos = trechosEntre(esperado, atual).filter((t) => ![...t.remover, ...t.inserir].filter((l) => l.trim()).every(linhaDoDesenho));
    if (trechos.length) texto[rel] = trechos.map((t) => mapaDeTexto(t, despers));
  }
  const novos = {};
  for (const [rel] of disco) {
    if (compilados.has(rel) || doRun(rel)) continue;
    if (rel.startsWith('_evals/')) { naoViaja.push({ arquivo: rel, motivo: 'caso de avaliação escrito neste squad: pode ter dado do caso e fica só aqui' }); continue; }
    if (!/^(?:agents|pipeline)\//.test(rel)) continue; // autos, caso.json, estado do run: são do caso
    if (!RE_ARQUIVO_NOVO.test(rel)) { naoViaja.push({ arquivo: rel, motivo: 'arquivo que não é texto (ou com nome fora do padrão)' }); continue; }
    const t = lido(rel);
    if (Buffer.byteLength(t) > LIMITE_DO_ARQUIVO) { naoViaja.push({ arquivo: rel, motivo: 'arquivo grande demais para um modelo' }); continue; }
    novos[rel] = despers(t);
  }
  for (const rel of links) if (/^(?:agents|pipeline|_evals)\//.test(rel)) naoViaja.push({ arquivo: rel, motivo: 'atalho (link simbólico): não é seguido' });

  const designDoSquad = lerYaml(despers(designAtual), `${code}/_build/design.yaml`);
  // A skill do escritório (`esc-x`) que o squad usa volta a ser `x` para comparar o desenho com o do
  // modelo da área: a troca é refeita na criação, pelo que vai em `skills.json`.
  const designAtualLido = aplicarMapaNoDesenho(designDoSquad, volta);
  // Skill posta ou tirada só no frontmatter do agente (o jeito natural de editar) é mudança de
  // desenho: descartada como "linha do compilador", ela viajava, era instalada e o squad novo não a
  // usava (revisão v3, A4). O frontmatter vence o desenho quando os dois diferem.
  for (const a of lista(designAtualLido?.agents)) {
    const rel = `agents/${a?.id}.agent.md`;
    if (!a?.id || !disco.has(rel)) continue;
    const doFm = skillsDoFrontmatter(lido(rel));
    if (doFm !== null && canonico(doFm) !== canonico(lista(a.skills).map(String))) a.skills = doFm;
  }
  // Skill citada só no texto de agente ou de passo, que existe nesta pasta e não é de pacote (M5).
  const textosDoSquad = [...disco.keys()].filter((rel) => /^(?:agents|pipeline)\/.*\.md$/.test(rel)).map((rel) => readFileSync(disco.get(rel), 'utf8'));
  const designCru = lerYaml(designAtual, `${code}/_build/design.yaml`);
  const jaNoDesenho = [...lista(designCru?.agents).flatMap((a) => lista(a?.skills)), ...lista(designCru?.squad?.skills)].map(String);
  const citadas = skillsCitadasNoTexto(cwd, textosDoSquad, jaNoDesenho);
  const capSkills = capturarSkills(cwd, dir, designCru, { extras: citadas });
  naoViaja.push(...capSkills.naoViaja);
  avisos.push(...capSkills.avisos);
  // Skill ou best-practice de gate (de conferência, de ética, de sigilo, ou só de quem confere) não
  // vai: a mudança fica nesta pasta (revisão v3, A1).
  let designDoGate = designAtualLido;
  if (base) { try { designDoGate = lerYaml(despers(base.design), 'design de origem'); } catch { /* fica o do squad */ } }
  const gateDeSkills = skillsDeGate(designDoGate);
  const entradas = [];
  for (const e of capSkills.entradas) {
    if (e.modo === 'diferenca' && ehDeGate(e.tipo, e.de, gateDeSkills)) {
      avisos.push(`a mudança na ${e.tipo === 'skill' ? 'skill' : 'best-practice'} «${e.de}» fica nesta pasta e não vai com o modelo: ela é de conferência, de ética ou de sigilo (ou só os agentes que conferem a usam), e o modelo do escritório não mexe nos gates`);
      continue;
    }
    entradas.push(e);
  }
  let designDeBase = base ? lerYaml(despers(base.design), 'design de origem') : null;
  let opsDoDesenho = base ? diferencaDeDesign(designDeBase, designAtualLido) : [];
  if (base?.reconstruida) {
    // Squad anterior ao registro da base: agente ou step que mudou desde o Build (o manifesto da
    // compilação guarda o que o Build viu) é comparado com o modelo da área e vai "a conferir"; o
    // resto do desenho não se separa do que o curador mudou na mesma versão (revisão v2, N1).
    const mudou = desenhoDesdeOBuild(dir, ref.modelo);
    if (mudou.size && base.designDoModelo) {
      designDeBase = lerYaml(despers(base.designDoModelo), 'design do modelo da área');
      opsDoDesenho = diferencaDeDesign(designDeBase, designAtualLido).filter((o) => o.caminho.length >= 2 && typeof o.caminho[1] === 'object' && mudou.has(`${o.caminho[0]}:${Object.values(o.caminho[1])[0]}`));
    } else if (mudou.size) {
      avisos.push(`o desenho deste squad mudou depois do Build (${[...mudou].slice(0, 4).join(', ')}), mas o modelo da área «${base.modelo.id}» também mudou de versão desde então: a mudança de desenho do escritório não se separa da do curador e não vai; refaça-a no squad que nascer do modelo`);
    }
  }
  const gates = base ? gatesProtegidos(opsDoDesenho, designDeBase) : { ops: [], barradas: [] };
  const design = gates.ops;
  if (base?.reconstruida && design.length) aConferir.push({ arquivo: 'desenho', linhas: design.map((o) => `${caminhoLegivel(o.caminho)}: ${o.op === 'remover' ? 'tirado' : o.op === 'acrescentar' ? 'acrescentado' : 'mudado'}`) });
  for (const b of gates.barradas) avisos.push(`o modelo não leva a mudança em ${b.caminho}: ${b.motivo}, e o modelo do escritório não afrouxa os gates`);
  if (motorAnterior.length) avisos.push(`${motorAnterior.length} arquivo(s) deste squad foram gerados por uma versão anterior do motor e só têm texto dele reescrito (${motorAnterior.slice(0, 3).join(', ')}${motorAnterior.length > 3 ? '…' : ''}): se o escritório reescreveu uma linha desse texto, a linha não vai; o que ele acrescentou vai`);
  const inteiro = base ? null : {
    design: despers(designAtual),
    prosa: emitirProsa({ origem: 'squad do escritório', arquivos: Object.entries(prosaDoSquad).map(([arquivo, m]) => ({ arquivo, marcadores: Object.fromEntries(Object.entries(m).map(([id, t]) => [id, despers(t)])) })) }),
  };
  const diferenca = { formato: 1, design, prosa: prosaDif, texto, novos, removidos: removidos.sort() };
  const impressao = impressaoDe(diferenca, inteiro, paraOModelo(entradas));
  const daPasta = entradas.filter((e) => e.da_pasta);
  const contagem = {
    desenho: design.length,
    prosa: Object.values(prosaDif).reduce((n, m) => n + Object.keys(m).length, 0),
    trechos: Object.values(texto).reduce((n, l) => n + l.length, 0),
    novos: Object.keys(novos).length,
    removidos: removidos.length,
    // A skill do pacote mudada nesta pasta vale para todo squad daqui: sozinha, ela não faz deste
    // squad um modelo novo (a oferta voltava no fim de todo run, de toda peça, revisão v3, M1).
    skills: entradas.length - daPasta.length,
    skills_da_pasta: daPasta.length,
  };
  const vazio = Boolean(base) && !Object.entries(contagem).some(([k, n]) => k !== 'skills_da_pasta' && n);
  return { code, dir, origem, base, diferenca, inteiro, desenhoLido: designAtualLido, skills: entradas, daPasta: daPasta.map((e) => e.de), impressao, vazio, intocado: intocadoDesdeACriacao(dir, cwd, entradas.filter((e) => !e.da_pasta)), contagem, avisos, naoViaja, aConferir, motorAnterior, faltantes, hojeDoBuild, motorDoBuild, designAtual, textoCompilado: [...compilados].filter(([rel]) => !doRun(rel)).map(([, t]) => t).join('\n') };
}

export const impressaoDe = (diferenca, inteiro, skills = null) => hashDe(canonico({ diferenca, inteiro: inteiro || null, ...(skills && skills.length ? { skills } : {}) }));

/** Textos da diferença, com o rótulo em que o advogado os reconhece, para a varredura e para a prévia. */
export function textosDaDiferenca(diferenca, inteiro = null) {
  const t = {};
  for (const o of diferenca?.design || []) if (o.valor !== undefined) t[`desenho: ${caminhoLegivel(o.caminho)}`] = typeof o.valor === 'string' ? o.valor : JSON.stringify(o.valor, null, 1);
  for (const [rel, ids] of Object.entries(diferenca?.prosa || {})) for (const [id, x] of Object.entries(ids)) t[`${rel} (texto «${id}»)`] = x?.base ? lista(x.trechos).flatMap((y) => lista(y.inserir)).join('\n') : String(x?.texto ?? '');
  for (const [rel, trechos] of Object.entries(diferenca?.texto || {})) {
    // Só o que o escritório escreveu: a âncora (antes, depois, o que sai) é texto do modelo da área
    // ou do compilador, que já passa pela varredura no desenho e na prosa.
    trechos.forEach((x, i) => { if (lista(x.inserir).length) t[`${rel} (trecho ${i + 1})`] = lista(x.inserir).join('\n'); });
  }
  for (const [rel, c] of Object.entries(diferenca?.novos || {})) t[`${rel} (arquivo novo)`] = String(c);
  if (inteiro) { t['design.yaml'] = String(inteiro.design || ''); t['prosa.yaml'] = String(inteiro.prosa || ''); }
  return t;
}

// ───────────────────────── reaplicar ─────────────────────────

/**
 * O que a criação de um squad escreve a partir de um modelo: o desenho e a prosa que o compilador
 * consome, a base (o modelo da área, puro) e a diferença a aplicar depois de compilar. Para modelo
 * de pacote, é o modelo como está; para o do escritório, o modelo da área de HOJE com a diferença.
 */
export function planoDoModelo(cwd, modelo, code, { todos = listarModelos(cwd) } = {}) {
  const avisos = [];
  const conflitos = [];
  const lerDoModelo = (m, nome) => readFileSync(join(m.dir, nome), 'utf8');
  if (!ehDoEscritorio(modelo)) {
    const design = personalizar(lerDoModelo(modelo, 'design.yaml'), code);
    const prosa = personalizar(lerDoModelo(modelo, 'prosa.yaml'), code);
    return { design, prosa, base: { modelo: modelo.id, versao: modelo.meta?.versao ?? null, design, prosa }, diferenca: null, avisos, conflitos };
  }
  if (modelo.antigo) falha(`o modelo do escritório «${modelo.id}» está no formato antigo (0.9.42), que guardava arquivos inteiros: guarde de novo o squad de origem com esta versão`);
  const dif = lerJson(join(modelo.dir, ARQUIVO_DA_DIFERENCA)) || { formato: 1, design: [], prosa: {}, texto: {}, novos: {}, removidos: [] };
  const difPessoal = mapaDeTexto(dif, (t) => personalizar(t, code));
  if (modelo.formato !== 'diferenca') {
    // Modelo inteiro (squad do Arquiteto): o próprio desenho e a própria prosa; a diferença só tem
    // o texto fixo, os arquivos novos e os removidos.
    return { design: personalizar(lerDoModelo(modelo, 'design.yaml'), code), prosa: personalizar(lerDoModelo(modelo, 'prosa.yaml'), code), base: null, diferenca: difPessoal, avisos, conflitos };
  }
  const idP = String(modelo.meta?.origem?.modelo || '');
  const P = todos.find((m) => m.id === idP && !ehDoEscritorio(m) && m.completo);
  if (!P) {
    // Sem cópia de base guardada, de propósito: guardar o modelo da área dentro do do escritório
    // congelaria o texto curado (o defeito que a diferença existe para tirar) e o levaria no arquivo
    // exportado, fora do canal do pacote.
    falha(`o modelo do escritório «${modelo.meta?.nome || modelo.id}» foi feito sobre o modelo da área «${idP}», que não está nesta pasta. Ligue a área que o traz (npx legalsquad acervo areas) e tente de novo`);
  }
  const versaoHoje = P.meta?.versao ?? null;
  const versaoSalva = modelo.meta?.origem?.versao_do_modelo ?? null;
  if (versaoSalva !== null && String(versaoSalva) !== String(versaoHoje)) avisos.push(`o modelo da área «${P.id}» foi atualizado (de ${versaoSalva} para ${versaoHoje}) depois que o escritório guardou este modelo: as mudanças do escritório foram reaplicadas sobre a versão nova`);
  const designP = personalizar(lerDoModelo(P, 'design.yaml'), code);
  const prosaPTexto = personalizar(lerDoModelo(P, 'prosa.yaml'), code);
  let design = designP;
  if (lista(difPessoal.design).length) {
    const baseP = lerYaml(designP, `${P.id}/design.yaml`);
    // O gate é conferido de novo contra o modelo da área de HOJE: a mesma operação que era neutra
    // quando o escritório salvou pode afrouxar um gate que o curador subiu depois.
    const g = gatesProtegidos(difPessoal.design, baseP);
    for (const b of g.barradas) conflitos.push({ arquivo: 'desenho', trecho: b.caminho, motivo: `${b.motivo}; o modelo do escritório não afrouxa os gates` });
    const r = aplicarDiferencaDeDesign(baseP, g.ops);
    for (const c of r.conflitos) conflitos.push({ arquivo: 'desenho', trecho: c.caminho, motivo: c.motivo });
    for (const a of r.avisos) avisos.push(`desenho, ${a.caminho}: ${a.motivo}`);
    design = `# Desenho do modelo da área «${P.id}» com as mudanças do modelo do escritório «${modelo.id}».\n${emitirYaml(r.design)}\n`;
  }
  const prosaP = lerProsaDeTexto(prosaPTexto);
  const efetiva = structuredClone(prosaP);
  for (const [rel, ids] of Object.entries(difPessoal.prosa || {})) {
    for (const [id, x] of Object.entries(ids)) {
      const atual = prosaP[rel]?.[id];
      if (!x?.base) { (efetiva[rel] ||= {})[id] = String(x?.texto ?? ''); continue; }
      // Marcador do modelo da área: os trechos do escritório vão por cima do texto de hoje. Igual ao
      // de quando o escritório salvou, o resultado é o do squad de origem; mudado pelo curador, leva
      // as duas mudanças; o que não coube fica de fora, relatado.
      if (atual === undefined) {
        conflitos.push({ arquivo: rel, trecho: lista(x.trechos).flatMap((t) => lista(t.inserir)).join('\n'), motivo: `o modelo da área não tem mais o texto «${id}»` });
        continue;
      }
      const mudouNaArea = hashDe(normalizarProsa(despersonalizarNoSquad(atual, code))) !== x.base;
      const r = aplicarTrechos(atual, lista(x.trechos));
      (efetiva[rel] ||= {})[id] = r.texto;
      for (const c of r.conflitos) conflitos.push({ arquivo: rel, trecho: lista(c.inserir).join('\n') || lista(c.remover).map((l) => `(tirar) ${l}`).join('\n'), motivo: `o modelo da área mudou o texto «${id}» no ponto que o escritório tinha mudado` });
      if (mudouNaArea && r.aplicados.length) avisos.push(`${rel}, texto «${id}»: o modelo da área também mudou este texto; as mudanças do escritório foram reaplicadas sobre o texto novo`);
    }
  }
  const prosa = emitirProsa({ origem: `modelo do escritório ${modelo.id} sobre ${P.id}`, arquivos: Object.entries(efetiva).map(([arquivo, marcadores]) => ({ arquivo, marcadores })) });
  return { design, prosa, base: { modelo: P.id, versao: versaoHoje, design: designP, prosa: prosaPTexto }, diferenca: difPessoal, avisos, conflitos };
}

function lerProsaDeTexto(texto) {
  const doc = lerYaml(texto, 'prosa.yaml');
  const saida = {};
  for (const item of lista(doc?.arquivos)) {
    if (!item || typeof item !== 'object' || !item.arquivo) continue;
    saida[String(item.arquivo)] = Object.fromEntries(Object.entries(item.marcadores || {}).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]));
  }
  return saida;
}

/**
 * Depois de compilar: os trechos de texto fixo, os arquivos que o escritório acrescentou e os que
 * ele tirou. Cada trecho que não reaplica volta em `conflitos`, com o texto que ficou de fora.
 */
export function aplicarDiferencaNoSquad(dir, diferenca) {
  const conflitos = [];
  const avisos = [];
  let aplicados = 0;
  if (!diferenca) return { conflitos, avisos, aplicados };
  for (const [rel, trechos] of Object.entries(diferenca.texto || {})) {
    if (!caminhoSeguro(rel)) { conflitos.push({ arquivo: rel, trecho: '', motivo: 'caminho fora do squad' }); continue; }
    const alvo = join(dir, rel);
    if (!ehArquivo(alvo)) {
      for (const t of trechos) conflitos.push({ arquivo: rel, trecho: lista(t.inserir).join('\n'), motivo: 'o modelo da área não gera mais este arquivo' });
      continue;
    }
    const r = aplicarTrechos(readFileSync(alvo, 'utf8'), trechos);
    writeFileSync(alvo, r.texto, 'utf8');
    aplicados += r.aplicados.length;
    for (const c of r.conflitos) conflitos.push({ arquivo: rel, trecho: lista(c.inserir).join('\n') || lista(c.remover).map((l) => `(tirar) ${l}`).join('\n'), motivo: c.motivo });
  }
  for (const [rel, conteudo] of Object.entries(diferenca.novos || {})) {
    if (!RE_ARQUIVO_NOVO.test(rel) || !caminhoSeguro(rel)) { conflitos.push({ arquivo: rel, trecho: '', motivo: 'caminho fora do squad' }); continue; }
    const alvo = join(dir, rel);
    if (existsSync(alvo) && !ehArquivo(alvo)) { conflitos.push({ arquivo: rel, trecho: '', motivo: 'no lugar do arquivo há uma pasta' }); continue; }
    if (existsSync(alvo) && !mesmoTexto(readFileSync(alvo, 'utf8'), conteudo)) avisos.push(`${rel}: o modelo da área passou a gerar este arquivo; ficou a versão do escritório`);
    mkdirSync(dirname(alvo), { recursive: true });
    writeFileSync(alvo, String(conteudo), 'utf8');
    aplicados += 1;
  }
  for (const rel of diferenca.removidos || []) {
    if (!caminhoSeguro(rel)) continue;
    let st = null;
    try { st = lstatSync(join(dir, rel)); } catch { /* já não existe */ }
    if (st?.isFile()) rmSync(join(dir, rel), { force: true });
  }
  return { conflitos, avisos, aplicados };
}

// ───────────────────────── provas do run ─────────────────────────

/**
 * A nota da Verificação da Meta e a data do último run aprovado, lidas do que o runner gravou.
 * Só números e data: o tema do run (`runs.md`) e o `run_id` ficam no squad, que é do caso.
 */
export function provaDoRun(dir) {
  let linhas;
  try { linhas = readFileSync(join(dir, '_memory', 'runs.md'), 'utf8').split('\n'); } catch { return null; }
  for (const l of linhas) {
    const c = l.split('|').map((x) => x.trim());
    if (c.length < 6 || !/^\d{4}-\d{2}-\d{2}$/.test(c[1])) continue;
    if (!/aprovad|publicad/i.test(c[c.length - 2] || '')) continue;
    const runId = c[2];
    let nota = null;
    for (const nome of ['verificacao-meta.md', 'RELATORIO.md']) {
      if (!/^[\w.-]+$/.test(runId)) break;
      try {
        const m = /\bNota[:\s]+(\d{1,3})\b/.exec(readFileSync(join(dir, 'output', runId, nome), 'utf8'));
        if (m) { nota = Number(m[1]); break; }
      } catch { /* sem o arquivo */ }
    }
    return { data: c[1], nota };
  }
  return null;
}

// ───────────────────────── modelo.yaml ─────────────────────────

const CABECALHO_DO_MODELO = '# Modelo do ESCRITÓRIO: nasceu de um squad deste escritório. Guarda só o que o escritório mudou\n'
  + '# (diferenca.json) sobre o modelo da área (origem.modelo), que é compilado na versão de hoje a cada\n'
  + '# squad novo; sem modelo de origem, vai inteiro (design.yaml e prosa.yaml). Gatilhos, área e pedidos\n'
  + '# vêm do modelo da área da mesma peça. Nenhum pacote o declara: o sync não o altera nem apaga.\n';

function gravarMeta(dir, meta) {
  writeFileSync(join(dir, 'modelo.yaml'), `${CABECALHO_DO_MODELO}${emitirYaml(meta)}\n`, 'utf8');
}
const lerMetaDe = (dir) => lerYaml(readFileSync(join(dir, 'modelo.yaml'), 'utf8'), `${basename(dir)}/modelo.yaml`) || {};

/** Achados que o advogado já aceitou NESTE modelo, com este conteúdo: não barram de novo. */
function naoAceitos(achados, meta, impressao) {
  const lib = meta?.liberacao;
  if (!lib || String(lib.impressao || '') !== String(impressao)) return achados;
  const aceitos = new Set(lista(lib.aceitos).map(String));
  return achados.filter((a) => !aceitos.has(hashDe(a.chave)));
}

const normalizarRotulo = (t) => semAcento(t).replace(/[^a-z0-9]+/g, ' ').trim();

// ───────────────────────── gatilhos e régua ─────────────────────────

/**
 * Gatilho que o escritório dá (ou que vem num arquivo importado): texto de 3 a 120 caracteres, até
 * 30 deles, e o prefixo com `*` de pelo menos 4 letras. `"a*"` casava quase todo pedido e o modelo
 * importado respondia por contestação, petição inicial e outras peças (revisão v2, N2).
 */
export function validarGatilhos(v, nome = 'gatilhos') {
  const itens = lista(v);
  if (itens.length > 30) return `${nome}: mais de 30 frases`;
  for (const g of itens) {
    if (typeof g !== 'string' || (!g.includes('*') && g.trim().length < 3) || g.trim().length > 120) return `${nome}: cada frase é texto de 3 a 120 caracteres`;
    for (const parte of g.split(' + ')) {
      const n = semAcento(parte).replace(/[^a-z0-9*\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (n.endsWith('*') ? n.slice(0, -1).trim().length < 4 : n.length < 3) return `${nome}: «${g}» é largo demais (o começo de palavra com * precisa de 4 letras ou mais)`;
    }
  }
  return null;
}

/**
 * A régua com os candidatos na disputa, contra a régua sem eles: os pedidos de exemplo que passam a
 * escolher um candidato de outra peça, ou a empatar com ele, e os pedidos do próprio candidato que
 * não o escolhem. É barreira, não aviso, no salvar e na importação (revisão v2, N2).
 */
function desviosDaRegua(todos, candidatos, { tirar = [] } = {}) {
  const copia = (m) => ({ ...m, meta: { ...m.meta } });
  const semEles = todos.filter((m) => !tirar.includes(m.id) && !candidatos.some((c) => c.id === m.id)).map(copia);
  const chave = (f) => `${f.modelo}|${f.pedido}|${f.esperado}`;
  const antes = new Set(testarModelos(semEles).falhas.map(chave));
  const comEles = herdarDoModeloDaArea([...semEles.map(copia), ...candidatos.map((c) => ({ id: c.id, dir: c.dir, completo: true, meta: { ...c.meta } }))]);
  const ids = new Set(candidatos.map((c) => c.id));
  return testarModelos(comEles).falhas.filter((f) => !antes.has(chave(f)) && (ids.has(f.obtido) || ids.has(f.modelo) || f.ranking.some((r) => ids.has(r.split(':')[0]))));
}

/**
 * O que o modelo do escritório tinha e o squad que vai substituí-lo não tem: linha escrita pelo
 * escritório que não está mais no arquivo, arquivo acrescentado que sumiu, mudança de desenho
 * desfeita. Guardar de novo um squad criado com conflitos apagava do modelo o que não coube no
 * modelo da área atualizado, em silêncio (revisão v2, N3). Cada item tem um número, para o chefe
 * perguntar um a um e levar junto os que o advogado quiser (`--levar`).
 */
function perdasSobre(modelo, cap) {
  const perde = [...(modelo.formato === 'diferenca' ? perdasDoTexto(modelo, cap) : []), ...perdasDeSkills(modelo, cap)];
  return perde.map((p, i) => ({ n: i + 1, ...p }));
}

/**
 * As skills que o modelo levava e o squad não leva mais, ou leva sem as linhas do escritório. O
 * caminho comum até aqui é o `update` devolvendo à versão do pacote a skill editada no lugar:
 * guardar de novo apagava as skills do modelo sem pergunta (revisão v3, A2).
 */
function perdasDeSkills(modelo, cap) {
  const antigas = lista(lerJson(join(modelo.dir, ARQUIVO_DAS_SKILLS))?.skills);
  const agora = paraOModelo(cap.skills);
  const perde = [];
  for (const o of antigas) {
    if (!o || typeof o !== 'object' || typeof o.id !== 'string') continue;
    const nome = o.tipo === 'skill' ? 'skill' : 'best-practice';
    const n = agora.find((x) => x.tipo === o.tipo && x.id === o.id);
    if (!n) { perde.push({ tipo: 'skill', arquivo: `${nome} ${o.id}`, id: o.id, entrada: o }); continue; }
    if (o.modo !== 'diferenca' || n.modo !== 'diferenca') continue;
    for (const [rel, x] of Object.entries(o.mudados || {})) {
      const atual = String(n.mudados?.[rel]?.inteiro ?? n.novos?.[rel] ?? '').split('\n').map(semNumeroDeLista);
      const linhas = lista(x?.trechos).flatMap((t) => lista(t.inserir)).filter((l) => l.trim() && !/^name:/.test(l) && !atual.includes(semNumeroDeLista(l)));
      if (linhas.length) perde.push({ tipo: 'skill', arquivo: `${nome} ${o.id}`, id: o.id, rel, linhas, anterior: x });
    }
    for (const [rel, c] of Object.entries(o.novos || {})) if (n.novos?.[rel] === undefined && n.mudados?.[rel] === undefined) perde.push({ tipo: 'skill', arquivo: `${nome} ${o.id}`, id: o.id, rel, conteudo: c });
  }
  return perde;
}

function perdasDoTexto(modelo, cap) {
  const antiga = lerJson(join(modelo.dir, ARQUIVO_DA_DIFERENCA));
  if (!antiga || typeof antiga !== 'object') return [];
  const doSquad = (rel) => { try { return readFileSync(join(cap.dir, rel), 'utf8').split('\n').map(semNumeroDeLista); } catch { return null; } };
  const perde = [];
  const faltam = (rel, linhas) => {
    const atual = doSquad(rel);
    return lista(linhas).filter((l) => l.trim() && !(atual && atual.includes(semNumeroDeLista(personalizar(l, cap.code)))));
  };
  for (const [rel, ids] of Object.entries(antiga.prosa || {})) {
    for (const [id, x] of Object.entries(ids || {})) {
      const linhas = faltam(rel, x?.base ? lista(x.trechos).flatMap((t) => lista(t.inserir)) : String(x?.texto ?? '').split('\n'));
      if (linhas.length) perde.push({ tipo: 'prosa', arquivo: rel, id, linhas });
    }
  }
  for (const [rel, trechos] of Object.entries(antiga.texto || {})) {
    const linhas = faltam(rel, lista(trechos).flatMap((t) => lista(t.inserir)));
    if (linhas.length) perde.push({ tipo: 'texto', arquivo: rel, linhas });
  }
  for (const [rel, conteudo] of Object.entries(antiga.novos || {})) if (!ehArquivo(join(cap.dir, rel))) perde.push({ tipo: 'novo', arquivo: rel, conteudo });
  // O desenho do squad como a diferença o vê: com a skill do escritório de volta à do pacote e o
  // frontmatter dos agentes valendo (A4); lido cru, a skill posta só no frontmatter virava "perda".
  const design = cap.desenhoLido || null;
  for (const o of lista(antiga.design)) {
    if (o.op === 'remover' || !design) continue;
    if (canonico(valorEm(design, o.caminho)) !== canonico(o.valor)) perde.push({ tipo: 'desenho', arquivo: 'desenho', caminho: caminhoLegivel(o.caminho), op: o });
  }
  return perde;
}

/** Leva de volta ao modelo novo os itens escolhidos: no fim do texto do marcador ou do arquivo; a skill inteira, ou as linhas dela no fim do arquivo. */
function levarDeVolta(dif, skillsAgora, perde, cap) {
  const d = structuredClone(dif);
  const skills = structuredClone(lista(skillsAgora));
  const noFim = (linhas) => ({ antes: [], remover: [], inserir: ['', ...linhas], depois: [], inicio: false, fim: true, linha: 0, secao: undefined });
  for (const p of perde) {
    if (p.tipo === 'prosa') {
      const atual = (d.prosa[p.arquivo] ||= {})[p.id];
      if (atual?.base) atual.trechos = [...lista(atual.trechos), noFim(p.linhas)];
      else if (atual) atual.texto = `${atual.texto}\n\n${p.linhas.join('\n')}`;
      else {
        const b = cap.base?.prosa?.[p.arquivo]?.[p.id];
        d.prosa[p.arquivo][p.id] = b === undefined ? { texto: p.linhas.join('\n'), base: null } : { base: hashDe(normalizarProsa(despersonalizarNoSquad(b, cap.code))), trechos: [noFim(p.linhas)] };
      }
    } else if (p.tipo === 'texto') d.texto[p.arquivo] = [...lista(d.texto[p.arquivo]), noFim(p.linhas)];
    else if (p.tipo === 'novo') d.novos[p.arquivo] = p.conteudo;
    else if (p.tipo === 'desenho') d.design = [...d.design, p.op];
    else if (p.tipo === 'skill') {
      if (p.entrada) { if (!skills.some((x) => x.id === p.id && x.tipo === p.entrada.tipo)) skills.push(structuredClone(p.entrada)); continue; }
      const n = skills.find((x) => x.id === p.id);
      if (!n) continue;
      if (p.conteudo !== undefined) { n.novos = { ...(n.novos || {}), [p.rel]: p.conteudo }; continue; }
      const m = n.mudados?.[p.rel];
      if (m) { m.trechos = [...lista(m.trechos), noFim(p.linhas)]; m.inteiro = `${m.inteiro}\n\n${p.linhas.join('\n')}`; } else n.mudados = { ...(n.mudados || {}), [p.rel]: structuredClone(p.anterior) };
    }
  }
  return { dif: d, skills };
}

// ───────────────────────── salvar ─────────────────────────

/**
 * Guarda o squad como modelo do escritório. Com `previa`, só diz o que iria (nada é gravado): é o
 * que o runner usa para oferecer a opção na entrega do run, uma vez, e o que o chefe mostra ao
 * advogado antes do "sim".
 */
export function salvarModeloDoEscritorio(code, { cwd, id, rotulo, peca: pecaDada, gatilhos, pedidos, substituir = null, levar = null, aceitarAchados = false, forcar = false, previa = false, hoje } = {}) {
  const dataDeHoje = hojeIso(hoje);
  const todos = listarModelos(cwd);
  const cap = diferencaDoSquad(cwd, code, { todos });
  const { dir } = cap;
  const salvoComo = lerJson(join(dir, '_build', 'salvo-como.json'));
  const oferta = lerJson(join(dir, '_build', 'oferta-de-modelo.json'));
  const escritorio = todos.filter(ehDoEscritorio);
  const jaSalvo = Boolean(salvoComo?.impressao === cap.impressao && escritorio.some((m) => m.id === salvoComo.id && String(m.meta?.impressao || '') === String(salvoComo.impressao_do_modelo || cap.impressao)));
  const dispensado = oferta?.impressao === cap.impressao;
  let designAtual;
  try { designAtual = lerYaml(cap.designAtual, 'design.yaml') || {}; } catch { designAtual = {}; }
  const ident = lerJson(join(dir, 'identificacao.json'));
  const peca = String(pecaDada || cap.base?.modelo?.meta?.peca || designAtual.squad?.peca || ident?.peca || '').trim() || null;
  const origemEsc = cap.origem?.escritorio ? escritorio.find((m) => m.id === cap.origem.modelo) : null;
  // Squad não mexido desde a criação: nada a guardar, pela impressão dos arquivos gerados (N7); ou
  // igual ao modelo de onde nasceu, pela diferença.
  const igualA = cap.intocado && cap.origem?.modelo ? String(cap.origem.modelo) : cap.vazio ? cap.base.modelo.id : origemEsc && String(origemEsc.meta?.impressao || '') === cap.impressao ? origemEsc.id : null;
  const resumo = { ...cap.contagem, nao_viaja: cap.naoViaja, a_conferir: cap.aConferir, avisos: cap.avisos, modelo_da_area: cap.base ? cap.base.modelo.id : null, skills_da_pasta: cap.daPasta };
  if (igualA && !cap.daPasta.length) return { success: false, nada_a_salvar: true, igual_ao_modelo: igualA, salvavel: false, ja_salvo: jaSalvo, dispensado, resumo };
  // Só skill do pacote mudada nesta pasta: a oferta do fim do run não aparece (M1), e o advogado
  // que pede para guardar ESTE squad leva a skill no modelo.
  const soDaPasta = Boolean(igualA);
  if (!peca) falha('o squad não diz qual é a peça (o desenho não tem squad.peca e não há identificacao.json): repita com --peca <nome técnico da peça>');
  if (!RE_ID.test(peca)) falha(`peça «${peca}» inválida: minúsculas, dígitos e hífen`);

  // Qual modelo: o que este squad já gerou (atualizar), um id dado, um novo da peça, ou recusa.
  const doPacote = idsDePacote(cwd, todos);
  const mesmaPeca = escritorio.filter((m) => String(m.meta?.peca || '') === peca);
  const anterior = salvoComo?.id ? escritorio.find((m) => m.id === salvoComo.id) : null;
  const livre = (b) => { if (!existsSync(join(cwd, PASTA_DE_MODELOS, b))) return b; for (let n = 2; n < 100; n++) if (!existsSync(join(cwd, PASTA_DE_MODELOS, `${b}-${n}`))) return `${b}-${n}`; return falha(`não há id livre para ${b}`); };
  let idFinal;
  let substitui = null;
  if (id) {
    idFinal = String(id).trim();
    if (!RE_ID.test(idFinal)) falha(`id de modelo «${idFinal}» inválido: minúsculas, dígitos e hífen`);
    if (!idFinal.startsWith(PREFIXO_DO_ESCRITORIO)) falha(`o id de um modelo do escritório começa com «${PREFIXO_DO_ESCRITORIO}» (ex.: ${PREFIXO_DO_ESCRITORIO}${peca}), para nunca coincidir com um modelo de pacote`);
    substitui = escritorio.find((m) => m.id === idFinal) || null;
    if (!substitui && existsSync(join(cwd, PASTA_DE_MODELOS, idFinal))) falha(`${PASTA_DE_MODELOS}/${idFinal}/ existe e não é modelo do escritório`);
    if (substitui && substitui !== anterior && !forcar && !previa) falha(`já existe o modelo do escritório «${substitui.meta?.nome || idFinal}»; para substituí-lo por este squad, repita com --forcar`);
  } else if (anterior) {
    idFinal = anterior.id;
    substitui = anterior;
  } else if (rotulo) {
    idFinal = livre(`${PREFIXO_DO_ESCRITORIO}${peca}`);
  } else if (!mesmaPeca.length) {
    idFinal = livre(`${PREFIXO_DO_ESCRITORIO}${peca}`);
  } else if (forcar && origemEsc) {
    // Squad criado de um modelo do escritório: substituir é atualizar aquele modelo.
    idFinal = origemEsc.id;
    substitui = origemEsc;
  } else if (forcar && mesmaPeca.length === 1) {
    idFinal = mesmaPeca[0].id;
    substitui = mesmaPeca[0];
  } else if (!previa) {
    return { success: false, ja_existe_da_peca: mesmaPeca.map((m) => ({ id: m.id, rotulo: m.meta?.nome || m.id, salvo_em: m.meta?.origem?.salvo_em || m.meta?.versao || null })), resumo };
  } else idFinal = `${PREFIXO_DO_ESCRITORIO}${peca}`;
  if (doPacote.has(idFinal)) falha(`«${idFinal}» é o id de um modelo de pacote: escolha outro`);
  const P = cap.base?.modelo || null;

  const nomeDaArea = P?.meta?.nome || designAtual.squad?.name || humanizarPeca(peca);
  const rotuloFinal = String(rotulo || (substitui ? substitui.meta?.nome : '') || `${nomeDaArea} (escritório)`).trim();
  const rotuloRepetido = escritorio.find((m) => m.id !== idFinal && normalizarRotulo(m.meta?.nome || '') === normalizarRotulo(rotuloFinal));
  if (rotuloRepetido && !previa) falha(`já há um modelo do escritório chamado «${rotuloFinal}» (${rotuloRepetido.id}): dê outro nome a este com --rotulo`);
  const listaDeTexto = (v, nome) => {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) falha(`--${nome} precisa ser uma lista de frases (texto), sem vazio`);
    const vistos = new Set();
    return v.map((x) => x.trim()).filter((x) => { const k = semAcento(x).replace(/\s+/g, ' '); if (vistos.has(k)) return false; vistos.add(k); return true; });
  };
  const gatilhosProprios = listaDeTexto(gatilhos, 'gatilhos') ?? lista(substitui?.meta?.gatilhos_proprios).map(String);
  const pedidosProprios = listaDeTexto(pedidos, 'pedidos') ?? lista(substitui?.meta?.pedidos_proprios).map(String);
  const erroDeGatilho = validarGatilhos(gatilhosProprios, '--gatilhos');
  if (erroDeGatilho) falha(erroDeGatilho);
  // Peça que nenhum modelo da área cobre (squad do Arquiteto de peça nova): o único gatilho seria o
  // nome técnico da peça, e o chefe quase nunca o acharia (revisão v2, N10). O chefe propõe frases
  // da peça e pedidos de exemplo, sem dado do caso, e a régua confere que o modelo os atende.
  const semModeloDaPeca = !P && !todos.some((m) => !ehDoEscritorio(m) && String(m.meta?.peca || '') === peca);
  const faltamGatilhos = semModeloDaPeca && (!gatilhosProprios.length || !pedidosProprios.length);
  if (faltamGatilhos && !previa) falha(`nenhum modelo da área cobre a peça «${peca}»: para o chefe achar este modelo nos próximos casos, passe --gatilhos e --pedidos (frases e pedidos da peça, sem dado do caso)`);
  const perde = substitui ? perdasSobre(substitui, cap) : [];

  // Varredura do que vai para o modelo contra a pasta do caso inteira.
  // Troca de trecho só no modelo (o squad do caso fica como está): o chefe generaliza o dado que a
  // varredura achou ("Maria" vira "a cliente") sem estragar o squad que ainda serve ao caso.
  const trocas = validarSubstituicoes(substituir);
  const semEfeito = trocas.filter(([de]) => !JSON.stringify([cap.diferenca, cap.skills]).toLowerCase().includes(JSON.stringify(de).slice(1, -1).toLowerCase()) && !(cap.inteiro && `${cap.inteiro.design}${cap.inteiro.prosa}`.includes(de))).map(([de]) => de);
  const escolhidas = levar === 'todos' ? perde : perde.filter((p) => lista(levar).map(Number).includes(p.n));
  const comLevadas = escolhidas.length ? levarDeVolta(cap.diferenca, cap.skills, escolhidas, cap) : { dif: cap.diferenca, skills: cap.skills };
  // O `--substituir` que casa no id ou no nome de arquivo de uma skill criada a renomeia no modelo
  // (id, pasta, `name:`, e o id onde o desenho e os textos o citam): trocar só o texto deixava o
  // nome da cliente no id, e a instalação o restaurava no `name:` (revisão v3, A3).
  const { skills: renomeadas, renomes } = renomearSkills(comLevadas.skills, trocas);
  const renomear = (t) => renomes.reduce((x, [a, b]) => trocarId(x, a, b), String(t));
  const difRenomeada = renomes.length ? mapaDeTexto(comLevadas.dif, renomear) : comLevadas.dif;
  const dif = trocas.length ? aplicarSubstituicoes(difRenomeada, trocas) : difRenomeada;
  const skills = trocas.length ? substituirNasSkills(renomeadas, trocas) : renomeadas;
  const inteiro = cap.inteiro && trocas.length ? { design: trocar(renomear(cap.inteiro.design), trocas), prosa: trocar(renomear(cap.inteiro.prosa), trocas) } : cap.inteiro;
  const impressaoDoModelo = trocas.length || escolhidas.length ? impressaoDe(dif, inteiro, paraOModelo(skills)) : cap.impressao;
  const ctx = contextoDoProjeto(cwd, todos);
  // O texto fixo do compilador ("a persuasão vem da estrutura") também é vocabulário do produto;
  // menos as palavras do desenho que o escritório mudou (ou do desenho inteiro, no squad do
  // Arquiteto), que podem ter vindo do caso.
  const doDesenho = vocabularioDe([...lista(dif.design).map((o) => JSON.stringify(o.valor ?? '')), inteiro?.design || ''].join('\n'));
  for (const w of vocabularioDe(cap.textoCompilado)) if (!doDesenho.has(w)) ctx.vocabulario.add(w);
  const { texto: textoCaso, naoLidos } = textoDoCaso(dir, { raiz: cwd });
  const caso = indiceDoCaso(textoCaso, { vocabulario: ctx.vocabulario });
  // O id e a peça também viajam (no arquivo exportado, na lista, na pergunta de empate): passam pela
  // varredura como o nome (revisão v2, N8).
  const textos = { ...textosDaDiferenca(dif, inteiro), 'nome do modelo': rotuloFinal, 'id do modelo': idFinal.replace(/-/g, ' '), 'peça': String(peca).replace(/-/g, ' ') };
  if (gatilhosProprios.length) textos['gatilhos do escritório'] = gatilhosProprios.join('\n');
  if (pedidosProprios.length) textos['pedidos de exemplo do escritório'] = pedidosProprios.join('\n');
  if (!P) textos['descrição'] = String(designAtual.squad?.description || '');
  let brutos = achadosDeCaso(textos, { caso, conhecido: ctx.conhecido });
  // A skill é da pasta, não do squad: o nome do cliente de outro caso posto numa skill que este
  // squad usa passava (revisão v3, A3). As skills são cruzadas com todos os casos da pasta.
  const textosSkills = textosDasSkills(skills);
  if (Object.keys(textosSkills).length) {
    const daPasta = textoDeTodosOsCasos(cwd);
    brutos = [...brutos, ...achadosDeCaso(textosSkills, { caso: indiceDoCaso(`${textoCaso}\n${daPasta.texto}`, { vocabulario: ctx.vocabulario }), conhecido: ctx.conhecido })];
  }
  const achados = semDadoPublico(cwd, brutos);
  const nao_lidos = naoLidos;
  if (previa) {
    return { success: true, previa: true, salvavel: !soDaPasta, so_skills_da_pasta: soDaPasta ? cap.daPasta : [], ja_salvo: jaSalvo, dispensado, id: idFinal, atualiza: Boolean(substitui), rotulo: rotuloFinal, peca, resumo, skills: skillsParaLer(skills), sem_contrato: semContrato(cwd, skillsSemContrato(skills)), perde, substituicoes_sem_efeito: semEfeito, precisa_gatilhos: faltamGatilhos, mudancas: mudancasParaLer(dif, inteiro, { desenhoAConferir: cap.aConferir.some((x) => x.arquivo === "desenho") }), achados, nao_lidos, ja_existe_da_peca: !anterior && !id && mesmaPeca.length ? mesmaPeca.map((m) => ({ id: m.id, rotulo: m.meta?.nome || m.id })) : [] };
  }
  if (perde.length && levar === null) return { success: false, perde, id: idFinal, rotulo: rotuloFinal, resumo };
  if (achados.length && !aceitarAchados) return { success: false, achados, nao_lidos, id: idFinal, resumo, substituicoes_sem_efeito: semEfeito };

  // Modelo em pasta de trabalho, conferido por uma recriação numa pasta temporária antes de gravar.
  const raizDosModelos = join(cwd, PASTA_DE_MODELOS);
  mkdirSync(raizDosModelos, { recursive: true });
  const trabalho = join(raizDosModelos, `.salvando-${idFinal}-${process.pid}`);
  rmSync(trabalho, { recursive: true, force: true });
  mkdirSync(trabalho, { recursive: true });
  try {
    const run = provaDoRun(dir);
    const checkOrigem = checkSquad(cap.code, { squadsDir: join(cwd, 'squads'), skillsDir: join(cwd, 'skills'), bestPracticesDir: bestPracticesDoProjeto(cwd) });
    const meta = {
      id: idFinal,
      nome: rotuloFinal,
      ...(P ? {} : { descricao: String(designAtual.squad?.description || '') }),
      area: P ? (P.meta?.area ?? null) : (designAtual.squad?.area ?? null),
      peca,
      polo: P ? (P.meta?.polo ?? null) : null,
      formato: P ? 'diferenca' : 'inteiro',
      versao: dataDeHoje,
      origem: { tipo: 'escritorio', modelo: P ? P.id : null, versao_do_modelo: P ? (cap.base.versao ?? null) : null, motor: VERSAO_DO_MOTOR, salvo_em: dataDeHoje },
      ...(gatilhosProprios.length ? { gatilhos_proprios: gatilhosProprios } : {}),
      ...(pedidosProprios.length ? { pedidos_proprios: pedidosProprios } : {}),
      provas: {
        run: run ? { data: run.data, nota: run.nota } : null,
        check_squad: { erros: checkOrigem.issues.filter((i) => i.severity === 'error').length, avisos: checkOrigem.issues.filter((i) => i.severity === 'warn').length },
        diferenca: cap.contagem,
      },
      impressao: impressaoDoModelo,
      ...(achados.length ? { liberacao: { impressao: impressaoDoModelo, aceitos: achados.map((a) => hashDe(a.chave)), em: dataDeHoje } } : {}),
    };
    writeFileSync(join(trabalho, ARQUIVO_DA_DIFERENCA), `${JSON.stringify(dif, null, 2)}\n`, 'utf8');
    if (skills.length) writeFileSync(join(trabalho, ARQUIVO_DAS_SKILLS), `${JSON.stringify({ formato: 1, skills: paraOModelo(skills) }, null, 2)}\n`, 'utf8');
    if (inteiro) {
      writeFileSync(join(trabalho, 'design.yaml'), inteiro.design, 'utf8');
      writeFileSync(join(trabalho, 'prosa.yaml'), inteiro.prosa, 'utf8');
    }
    gravarMeta(trabalho, meta);

    const candidato = { id: idFinal, dir: trabalho, completo: true, formato: meta.formato, meta: lerMetaDe(trabalho) };
    // A comparação arquivo a arquivo só diz algo quando o squad foi compilado por este motor: com
    // outro, a recriação traz o texto fixo de hoje (é o que se quer), e tudo sairia "diferente".
    const mesmoMotor = Boolean(cap.motorDoBuild) && cap.motorDoBuild === VERSAO_DO_MOTOR;
    const conferencia = conferirRecriacao(cwd, candidato, { todos, code: cap.code, hoje: cap.hojeDoBuild, comparar: mesmoMotor && !trocas.length && !escolhidas.length && !cap.aConferir.length ? dir : null, ignorar: cap.naoViaja.map((x) => x.arquivo) });
    // A régua é barreira: gatilho do escritório que tira de outra peça um pedido de exemplo, ou
    // pedido do próprio modelo que não o escolhe, não se grava (revisão v2, N2).
    const desvios = desviosDaRegua(todos, [candidato], { tirar: substitui ? [substitui.id] : [] });
    if (desvios.length) return { success: false, regua: desvios, id: idFinal, resumo };
    // Modelo que recria squad com erro de estrutura não se grava, nem quando o erro já está no squad
    // de origem (o advogado apagou uma task que o agente ainda chama): a importação recusaria o mesmo
    // modelo em outra pasta, e o próximo caso nasceria quebrado (D8).
    const erros = conferencia.check.filter((i) => i.severity === 'error');
    if (erros.length) {
      const daOrigem = erros.some((i) => checkOrigem.issues.some((o) => o.severity === 'error' && o.code === i.code && o.detail === i.detail));
      falha(`o modelo recriaria um squad com ${erros.length} problema(s) de estrutura${daOrigem ? ', que o squad de origem já tem' : ''}: ${erros.map((i) => i.detail).slice(0, 3).join('; ')}. Conserte o squad (npx legalsquad check-squad ${cap.code}) e guarde de novo; nada foi gravado`);
    }

    const destino = join(raizDosModelos, idFinal);
    if (existsSync(destino)) paraALixeira(cwd, idFinal, dataDeHoje);
    renameSync(trabalho, destino);
    writeFileSync(join(dir, '_build', 'salvo-como.json'), `${JSON.stringify({ id: idFinal, impressao: cap.impressao, impressao_do_modelo: impressaoDoModelo, em: dataDeHoje }, null, 2)}\n`, 'utf8');
    const naPasta = registrarNaOrigem(cwd, skills, { modelo: idFinal });
    return { success: true, id: idFinal, dir: destino, atualizou: Boolean(substitui), rotulo: rotuloFinal, peca, formato: meta.formato, modelo_da_area: P ? P.id : null, resumo, skills: skillsParaLer(skills), skills_na_pasta: naPasta, sem_contrato: semContrato(cwd, skillsSemContrato(skills)), mudancas: mudancasParaLer(dif, inteiro, { desenhoAConferir: cap.aConferir.some((x) => x.arquivo === "desenho") }), achados_aceitos: achados, nao_lidos, run: meta.provas.run, nao_reproduz: conferencia.diferentes, conflitos_na_recriacao: conferencia.conflitos, levados: escolhidas.map((p) => p.n), substituicoes_sem_efeito: semEfeito, regua: [] };
  } finally {
    rmSync(trabalho, { recursive: true, force: true });
  }
}

function validarSubstituicoes(bruto) {
  if (bruto === null || bruto === undefined || bruto === '') return [];
  let obj = bruto;
  if (typeof bruto === 'string') { try { obj = JSON.parse(bruto); } catch { falha('--substituir precisa ser um objeto JSON: {"trecho do caso": "texto genérico"}'); } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) falha('--substituir precisa ser um objeto JSON: {"trecho do caso": "texto genérico"}');
  const trocas = Object.entries(obj);
  if (trocas.some(([de, para]) => typeof para !== 'string' || !String(de).trim())) falha('--substituir: cada trecho vira um texto (os dois lados são texto, e o trecho não é vazio)');
  // Trecho mais longo primeiro: "Maria Aparecida Pacheco" antes de "Maria".
  return trocas.sort((a, b) => b[0].length - a[0].length);
}
const trocar = (t, trocas) => trocas.reduce((s, [de, para]) => s.split(de).join(para), String(t));

/**
 * Aplica as trocas ao que o escritório escreveu (texto dos marcadores, linhas inseridas, arquivos
 * novos, valores do desenho), nunca à âncora (o texto em volta, que é do modelo da área).
 */
function aplicarSubstituicoes(diferenca, trocas) {
  const d = structuredClone(diferenca);
  const t = (s) => trocar(s, trocas);
  d.design = d.design.map((o) => (o.valor === undefined ? o : { ...o, valor: mapaDeTexto(o.valor, t) }));
  for (const ids of Object.values(d.prosa)) {
    for (const x of Object.values(ids)) {
      if (typeof x.texto === 'string') x.texto = t(x.texto);
      if (Array.isArray(x.trechos)) x.trechos = x.trechos.map((y) => ({ ...y, inserir: y.inserir.map(t) }));
    }
  }
  for (const [rel, trechos] of Object.entries(d.texto)) d.texto[rel] = trechos.map((y) => ({ ...y, inserir: y.inserir.map(t) }));
  for (const rel of Object.keys(d.novos)) d.novos[rel] = t(d.novos[rel]);
  return d;
}

/** As skills criadas que o modelo leva, pelo id que têm nesta pasta (as de pacote já têm contrato). */
const skillsSemContrato = (skills) => lista(skills).filter((e) => e.tipo === 'skill' && e.modo === 'inteira').map((e) => e.no_squad || e.id);

/** Id de skill com a troca do `--substituir` aplicada: sem acento, minúsculo, hífen no lugar do espaço. */
function idTrocado(id, trocas) {
  const legivel = String(id).replace(/[-_]+/g, ' ');
  let t = legivel;
  for (const [de, para] of trocas) t = t.replace(new RegExp(String(de).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-_\s]+/g, '[-_\\s]+'), 'gi'), para);
  if (t === legivel) return id;
  return semAcento(t).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || id;
}

/** Renomeia, no modelo, a skill criada cujo id ou nome de arquivo casa com um trecho do `--substituir`. */
function renomearSkills(skills, trocas) {
  if (!trocas.length) return { skills, renomes: [] };
  const renomes = [];
  const relTrocado = (rel) => rel.split('/').map((seg) => { const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(seg); const novo = idTrocado(m[1], trocas); return novo === m[1] ? seg : `${novo}${m[2] || ''}`; }).join('/');
  const saida = lista(skills).map((e0) => {
    const e = structuredClone(e0);
    if (e.modo === 'inteira') {
      const novo = idTrocado(e.id, trocas);
      if (novo !== e.id) { renomes.push([e.id, novo]); e.id = novo; }
      e.arquivos = Object.fromEntries(Object.entries(e.arquivos || {}).map(([rel, t]) => [e.tipo === 'bp' ? `${e.id}.md` : relTrocado(rel), e.tipo === 'skill' && rel === 'SKILL.md' ? comNome(t, e.id) : t]));
    } else e.novos = Object.fromEntries(Object.entries(e.novos || {}).map(([rel, t]) => [e.tipo === 'bp' ? rel : relTrocado(rel), t]));
    return e;
  });
  return { skills: saida, renomes };
}

/** As trocas do `--substituir` valem também para o que o escritório escreveu nas skills. */
function substituirNasSkills(skills, trocas) {
  const t = (x) => trocar(x, trocas);
  return lista(skills).map((e) => {
    const c = structuredClone(e);
    if (c.modo === 'inteira') c.arquivos = Object.fromEntries(Object.entries(c.arquivos || {}).map(([k, v]) => [k, t(v)]));
    for (const x of Object.values(c.mudados || {})) { x.inteiro = t(x.inteiro); x.trechos = lista(x.trechos).map((y) => ({ ...y, inserir: y.inserir.map(t) })); }
    c.novos = Object.fromEntries(Object.entries(c.novos || {}).map(([k, v]) => [k, t(v)]));
    return c;
  });
}

/** A varredura sobre o que `--extrair` (curadoria) acabou de gravar, sem o próprio modelo no conhecido. */
export function achadosNaExtracao(cwd, code, r) {
  const todos = listarModelos(cwd).filter((m) => m.id !== r.id);
  const ctx = contextoDoProjeto(cwd, todos);
  const { texto } = textoDoCaso(join(cwd, 'squads', code), { raiz: cwd });
  const textos = {};
  for (const nome of ['design.yaml', 'prosa.yaml']) { try { textos[nome] = readFileSync(join(r.dir, nome), 'utf8'); } catch { /* sem o arquivo */ } }
  return achadosDeCaso(textos, { caso: indiceDoCaso(texto, { vocabulario: ctx.vocabulario }), conhecido: ctx.conhecido });
}

/** O runner registra que o advogado disse "não" à oferta: não oferece de novo enquanto o squad não mudar. */
export function dispensarOferta(cwd, code, { hoje } = {}) {
  const cap = diferencaDoSquad(cwd, code);
  writeFileSync(join(cap.dir, '_build', 'oferta-de-modelo.json'), `${JSON.stringify({ impressao: cap.impressao, dispensada_em: hojeIso(hoje) }, null, 2)}\n`, 'utf8');
  return { success: true, code: cap.code };
}

/** A diferença em linhas que o advogado lê: o que entrou, o que saiu, onde. */
export function mudancasParaLer(diferenca, inteiro = null, { desenhoAConferir = false } = {}) {
  const L = [];
  // O texto que o advogado lê começa na primeira linha com conteúdo: a linha em branco que abre o
  // trecho deixava a prévia dizer «» (revisão v2, N16).
  const legivel = (linhas) => lista(linhas).join('\n').replace(/^\s*\n/, '').replace(/^\n+/, '').slice(0, 600);
  if (inteiro) {
    let d;
    try { d = lerYaml(String(inteiro.design || ''), 'design.yaml'); } catch { d = null; }
    const agentes = lista(d?.agents).map((a) => `${a?.name || a?.id} (${a?.id})`);
    const passos = lista(d?.pipeline).map((s) => s?.name || s?.id);
    L.push({ onde: 'modelo inteiro', o_que: 'squad sem modelo da área de origem: vão o desenho e todos os textos dos agentes', texto: `Agentes: ${agentes.join(', ') || '?'}. Passos: ${passos.join(' · ') || '?'}.` });
  }
  for (const o of diferenca?.design || []) L.push({ onde: `desenho: ${caminhoLegivel(o.caminho)}`, o_que: `${o.op === 'remover' ? 'tirado' : o.op === 'acrescentar' ? 'acrescentado' : 'mudado'}${desenhoAConferir ? ' (a conferir)' : ''}`, texto: o.valor === undefined ? undefined : (typeof o.valor === 'string' ? o.valor : JSON.stringify(o.valor)).slice(0, 400) });
  for (const [rel, ids] of Object.entries(diferenca?.prosa || {})) {
    for (const [id, x] of Object.entries(ids)) {
      // O que o escritório escreveu dentro do texto, quando se sabe; senão, o texto inteiro.
      const inseridas = lista(x.trechos).flatMap((t) => lista(t.inserir)).filter((l) => l.trim());
      const tiradas = lista(x.trechos).flatMap((t) => lista(t.remover)).filter((l) => l.trim());
      L.push({ onde: `${rel}, texto «${id}»`, o_que: !x.base ? 'acrescentado' : inseridas.length && !tiradas.length ? 'acrescentado ao texto do modelo' : 'mudado', texto: legivel(inseridas.length ? inseridas : [String(x.texto ?? '')]) });
    }
  }
  for (const [rel, trechos] of Object.entries(diferenca?.texto || {})) {
    for (const t of trechos) {
      const tipo = t.inserir.some((l) => l.trim()) && t.remover.some((l) => l.trim()) ? 'trocado' : t.inserir.some((l) => l.trim()) ? 'acrescentado' : 'tirado';
      L.push({ onde: `${rel}, perto da linha ${t.linha || '?'}`, o_que: `${tipo}${t.a_conferir ? ' (a conferir: o squad é de uma versão anterior do motor, confira se é do escritório)' : ''}`, texto: legivel(t.inserir.some((l) => l.trim()) ? t.inserir : t.remover) });
    }
  }
  for (const [rel, c] of Object.entries(diferenca?.novos || {})) L.push({ onde: rel, o_que: 'arquivo novo', texto: legivel(String(c).split('\n')) });
  for (const rel of diferenca?.removidos || []) L.push({ onde: rel, o_que: 'arquivo tirado' });
  return L;
}

// ───────────────────────── conferir recriando ─────────────────────────

/**
 * Recria um squad do modelo numa pasta temporária (o projeto de verdade não é tocado) e devolve o
 * check-squad, os conflitos e, com `comparar`, os arquivos que saem diferentes do squad de origem.
 */
export function conferirRecriacao(cwd, modelo, { todos = listarModelos(cwd), code = 'conferencia', hoje, comparar = null, ignorar = [] } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'legalsquad-modelo-'));
  try {
    const squadsDir = join(tmp, 'squads');
    const r = materializar(cwd, modelo, { squadsDir, code, hoje, todos, instalar: false });
    // A skill do escritório que ainda não está instalada (a conferência não grava no projeto) não
    // conta como ausente; o conteúdo dela é conferido pelo plano.
    const planejadas = new Set([...(r.skills?.instalar || []).map((x) => `${x.tipo}:${x.id}`)]);
    const check = checkSquad(code, { squadsDir, skillsDir: join(cwd, 'skills'), bestPracticesDir: bestPracticesDoProjeto(cwd), raizDoProjeto: cwd }).issues
      .filter((i) => !(i.code === 'skill-declarada-inexistente' && [...planejadas].some((k) => k.startsWith('skill:') && i.detail.includes(`"${k.slice(6)}"`))))
      .filter((i) => !(i.code === 'best-practice-declarada-inexistente' && [...planejadas].some((k) => k.startsWith('bp:') && i.detail.includes(`${k.slice(3)}.md`))));
    const diferentes = [];
    if (comparar) {
      const a = arquivosDoSquad(comparar).arquivos;
      const b = arquivosDoSquad(r.dir).arquivos;
      const ign = new Set(ignorar);
      // A troca da skill do pacote pela do escritório (e o sufixo `-2`) não conta como "não sai igual".
      const volta = mapaDeVolta(cwd);
      // As linhas que o compilador escreve a partir do desenho (a lista de skills do agente, "skills
      // injetadas", a coluna de skills do squad-party.csv) saem da comparação: o squad de origem que
      // mudou a skill só no frontmatter não as tinha, e o recriado as tem certas (A4).
      const semDesenho = (rel, t) => (rel === 'squad-party.csv' ? t.split('\n').map((l) => l.replace(/,(?:"[^"]*"|[^,]*)$/, '')).join('\n') : t.split('\n').filter((l) => !linhaDoDesenho(l)).join('\n'));
      const V = (t, rel) => semDesenho(rel, voltaNoTexto(t, volta, r.skills?.volta));
      for (const rel of new Set([...a.keys(), ...b.keys()])) {
        if (doRun(rel) || ign.has(rel) || /^(?:caso|identificacao|run-state|state|review-state)\.json$/.test(rel) || (rel.startsWith('_evals/') && !b.has(rel))) continue;
        if (!/^(?:squad\.yaml|squad-party\.csv|agents\/|pipeline\/|_evals\/)/.test(rel)) continue;
        if (!a.has(rel) || !b.has(rel) || !mesmoTexto(V(readFileSync(a.get(rel), 'utf8'), rel), V(readFileSync(b.get(rel), 'utf8'), rel))) diferentes.push(rel);
      }
    }
    return { check, conflitos: r.conflitos, avisos: r.avisos, diferentes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * O núcleo da criação: grava `_build/` (desenho, prosa, base, origem), compila e reaplica a
 * diferença. `squadsDir` pode ser temporário (conferência antes de gravar um modelo).
 */
export function materializar(cwd, modelo, { squadsDir = join(cwd, 'squads'), code, hoje, todos = listarModelos(cwd), identificacao = null, caso = null, instalar = true } = {}) {
  const plano = planoDoModelo(cwd, modelo, code, { todos });
  // As skills do escritório que o modelo leva: instaladas em `skills/` do projeto (ou só planejadas,
  // na conferência antes de gravar), e o desenho do squad novo passa a apontar para elas.
  const docSkills = ehDoEscritorio(modelo) ? lerJson(join(modelo.dir, ARQUIVO_DAS_SKILLS)) : null;
  const planoSkills = docSkills ? planejarSkills(cwd, docSkills, { modelo: modelo.id, excluirSquad: code }) : null;
  if (planoSkills?.erros.length) falha(`o modelo leva ${planoSkills.erros.length} skill(s) que não se instalam nesta pasta: ${planoSkills.erros.map((e) => e.motivo).join('; ')}`);
  if (planoSkills && instalar) instalarSkills(cwd, planoSkills, { hoje: hojeIso(hoje) });
  if (planoSkills && [planoSkills.mapa, planoSkills.mapaDoPacote].some((m) => Object.keys(m.skills).length || Object.keys(m.bps).length)) {
    plano.design = `# Desenho do modelo do escritório «${modelo.id}», com as skills do escritório.\n${emitirYaml(aplicarMapaNoDesenho(lerYaml(plano.design, 'design.yaml'), planoSkills.mapa, { mapaDoPacote: planoSkills.mapaDoPacote }))}\n`;
  }
  const dir = join(squadsDir, code);
  const build = join(dir, '_build');
  mkdirSync(join(build, 'base'), { recursive: true });
  writeFileSync(join(build, 'design.yaml'), plano.design, 'utf8');
  writeFileSync(join(build, 'prosa.yaml'), plano.prosa, 'utf8');
  if (plano.base) {
    writeFileSync(join(build, 'base', 'design.yaml'), plano.base.design, 'utf8');
    writeFileSync(join(build, 'base', 'prosa.yaml'), plano.base.prosa, 'utf8');
  } else rmSync(join(build, 'base'), { recursive: true, force: true });
  if (!ehDoEscritorio(modelo) && existsSync(join(modelo.dir, 'discovery.yaml'))) {
    writeFileSync(join(build, 'discovery.yaml'), personalizar(readFileSync(join(modelo.dir, 'discovery.yaml'), 'utf8'), code), 'utf8');
  }
  if (identificacao) writeFileSync(join(dir, 'identificacao.json'), `${JSON.stringify({ ...identificacao, modelo: modelo.id, registrada_em: hojeIso(hoje) }, null, 2)}\n`, 'utf8');
  if (caso) writeFileSync(join(dir, 'caso.json'), `${JSON.stringify({ pasta: String(caso) }, null, 2)}\n`, 'utf8');
  const origem = { modelo: modelo.id, versao: modelo.meta?.versao ?? null, criado_em: hojeIso(hoje) };
  if (ehDoEscritorio(modelo)) { origem.escritorio = true; origem.impressao = modelo.meta?.impressao ?? null; }
  if (plano.base) origem.base = { modelo: plano.base.modelo, versao: plano.base.versao };
  writeFileSync(join(build, 'modelo-origem.json'), `${JSON.stringify(origem, null, 2)}\n`, 'utf8');
  const prosa = lerProsa(join(build, 'prosa.yaml')).porArquivo;
  // Na conferência (nada instalado), a skill do escritório planejada conta como existente: o
  // compilador escreve "Aplicar a redação persuasiva de `esc-x`" só quando a skill está na pasta, e
  // o texto genérico no lugar dele fazia a recriação "não sair igual" na primeira vez que se guarda.
  const existeNaPasta = existenciaNoProjeto(cwd);
  const planejadas = new Set([...(planoSkills?.ids.skills || []), ...(planoSkills?.ids.bps || [])]);
  const r = compilarSquad(code, { squadsDir, hoje, prosa, existe: (id) => planejadas.has(id) || existeNaPasta(id) });
  const pos = aplicarDiferencaNoSquad(dir, plano.diferenca);
  const conflitos = [...plano.conflitos, ...pos.conflitos];
  const avisos = [...plano.avisos, ...pos.avisos, ...(planoSkills?.avisos || [])];
  if (ehDoEscritorio(modelo)) {
    for (const s of r.manifesto.prosa?.sobrando || []) conflitos.push({ arquivo: s.split(':')[0], trecho: s, motivo: 'o texto do escritório é de um ponto que o modelo da área não tem mais' });
    writeFileSync(join(build, 'escritorio.json'), `${JSON.stringify({ modelo: modelo.id, rotulo: modelo.meta?.nome || modelo.id, criado_em: hojeIso(hoje), conflitos, avisos }, null, 2)}\n`, 'utf8');
  }
  writeFileSync(join(build, 'gerado.json'), `${JSON.stringify(impressoesDoSquad(dir), null, 2)}\n`, 'utf8');
  if (planoSkills && instalar) {
    const naCriacao = {};
    for (const id of planoSkills.ids.skills) naCriacao[`skill:${id}`] = impressaoDasSkills(cwd, [{ tipo: 'skill', no_squad: id }]);
    for (const id of planoSkills.ids.bps) naCriacao[`bp:${id}`] = impressaoDasSkills(cwd, [{ tipo: 'bp', no_squad: id }]);
    writeFileSync(join(build, 'gerado-skills.json'), `${JSON.stringify(naCriacao, null, 2)}\n`, 'utf8');
  }
  // Marcadores que restam DEPOIS dos trechos do escritório (D18: a contagem era a da compilação).
  let restantes = 0;
  for (const rel of arquivosDoSquad(dir).arquivos.keys()) if (/\.(md|ya?ml)$/.test(rel) && !doRun(rel)) restantes += marcadoresDe(readFileSync(join(dir, rel), 'utf8')).length;
  return { dir, manifesto: { ...r.manifesto, marcadores: restantes }, conflitos, avisos, aplicados: pos.aplicados, skills: planoSkills };
}

// ───────────────────────── gestão ─────────────────────────

/** A lixeira dos modelos: apagar e substituir são reversíveis (a pasta começa com ponto e nenhum listador a lê). */
function paraALixeira(cwd, id, dataDeHoje) {
  const lixeira = join(cwd, PASTA_DE_MODELOS, '.lixeira');
  mkdirSync(lixeira, { recursive: true });
  let alvo = join(lixeira, `${id}-${dataDeHoje}`);
  for (let n = 2; existsSync(alvo); n++) alvo = join(lixeira, `${id}-${dataDeHoje}-${n}`);
  renameSync(join(cwd, PASTA_DE_MODELOS, id), alvo);
  // Guarda as três versões mais recentes de cada modelo; a lixeira não cresce a cada atualização.
  const doMesmo = readdirSync(lixeira).filter((n) => n.startsWith(`${id}-`) && /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/.test(n.slice(id.length + 1)))
    .map((n) => ({ n, t: lstatSync(join(lixeira, n)).mtimeMs })).sort((x, y) => y.t - x.t);
  for (const velho of doMesmo.slice(3)) rmSync(join(lixeira, velho.n), { recursive: true, force: true });
  return alvo;
}

function modeloDoEscritorio(cwd, id) {
  const m = listarModelos(cwd).find((x) => x.id === String(id));
  if (!m) falha(`não há modelo «${id}» nesta pasta`);
  if (!ehDoEscritorio(m)) falha(`«${id}» é um modelo da área (do pacote), não do escritório: ele não se apaga nem se renomeia por aqui`);
  return m;
}

export function apagarModeloDoEscritorio(cwd, id, { hoje } = {}) {
  const m = modeloDoEscritorio(cwd, id);
  // As skills que o modelo trouxe ficam na pasta (um squad pode usá-las): o advogado ouve quais e
  // quem as usa (melhorias da revisão v3).
  const skills = lista(lerJson(join(m.dir, ARQUIVO_DAS_SKILLS))?.skills).filter((e) => e && typeof e.id === 'string');
  const ficam = skills.map((e) => ({ id: e.id, tipo: e.tipo, usada_por: quemUsa(cwd, e.tipo, e.id).map((u) => u.code) }));
  const lixeira = paraALixeira(cwd, m.id, hojeIso(hoje));
  return { success: true, id: m.id, rotulo: m.meta?.nome || m.id, lixeira: relative(cwd, lixeira).split(sep).join('/'), skills_que_ficam: ficam };
}

export function renomearModeloDoEscritorio(cwd, id, rotulo) {
  const m = modeloDoEscritorio(cwd, id);
  const novo = String(rotulo || '').trim();
  if (!novo) falha('--rotulo precisa do nome novo');
  if (novo.length > 120) falha('o nome do modelo tem mais de 120 caracteres');
  const todos = listarModelos(cwd);
  const repetido = todos.filter(ehDoEscritorio).find((x) => x.id !== m.id && normalizarRotulo(x.meta?.nome || '') === normalizarRotulo(novo));
  if (repetido) falha(`já há um modelo do escritório chamado «${novo}» (${repetido.id})`);
  // O nome passa pela varredura com o caso do squad que gerou o modelo, achado pelo
  // `salvo-como.json` dos squads desta pasta (o modelo não guarda o squad: o code pode ter o nome do
  // cliente). Sem squad de origem aqui (modelo importado), só os identificadores: o advogado é
  // avisado de conferir o nome (revisão v2, N8).
  const ctx = contextoDoProjeto(cwd, todos);
  const origens = squadsQueGeraram(cwd, m.id);
  const texto = origens.map((d) => textoDoCaso(d, { raiz: cwd }).texto).join('\n');
  const caso = origens.length ? indiceDoCaso(texto, { vocabulario: ctx.vocabulario }) : null;
  const achados = achadosDeCaso({ 'nome do modelo': novo }, { caso, conhecido: ctx.conhecido });
  if (achados.length) return { success: false, achados };
  const meta = lerMetaDe(m.dir);
  meta.nome = novo;
  gravarMeta(m.dir, meta);
  return { success: true, id: m.id, rotulo: novo, conferencia_parcial: !origens.length };
}

/** Squads desta pasta cujo `_build/salvo-como.json` aponta o modelo. */
function squadsQueGeraram(cwd, id) {
  const squadsDir = join(cwd, 'squads');
  let entradas;
  try { entradas = readdirSync(squadsDir, { withFileTypes: true }); } catch { return []; }
  return entradas.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.') && lerJson(join(squadsDir, e.name, '_build', 'salvo-como.json'))?.id === id).map((e) => join(squadsDir, e.name));
}

/** Traz de volta da lixeira dos modelos a versão mais recente de um modelo do escritório. */
export function restaurarModeloDoEscritorio(cwd, id, { hoje } = {}) {
  const alvo = String(id || '').trim();
  if (!RE_ID.test(alvo) || !alvo.startsWith(PREFIXO_DO_ESCRITORIO)) falha(`«${alvo}» não é id de modelo do escritório`);
  const lixeira = join(cwd, PASTA_DE_MODELOS, '.lixeira');
  let nomes = [];
  try { nomes = readdirSync(lixeira).filter((n) => n.startsWith(`${alvo}-`) && /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/.test(n.slice(alvo.length + 1))); } catch { /* sem lixeira */ }
  if (!nomes.length) falha(`não há versão de «${alvo}» na lixeira dos modelos`);
  const maisRecente = nomes.map((n) => ({ n, t: lstatSync(join(lixeira, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0].n;
  const destino = join(cwd, PASTA_DE_MODELOS, alvo);
  // O que está no lugar agora vai para a lixeira: restaurar também é reversível.
  if (existsSync(destino)) paraALixeira(cwd, alvo, hojeIso(hoje));
  renameSync(join(lixeira, maisRecente), destino);
  let meta;
  try { meta = lerMetaDe(destino); } catch { meta = {}; }
  return { success: true, id: alvo, rotulo: meta.nome || alvo, de: maisRecente };
}

/** Os modelos do escritório desta pasta, no que o advogado reconhece. */
export function listarDoEscritorio(cwd) {
  const todos = listarModelos(cwd);
  return todos.filter(ehDoEscritorio).map((m) => {
    const o = m.meta?.origem || {};
    const P = o.modelo ? todos.find((x) => x.id === String(o.modelo) && !ehDoEscritorio(x)) : null;
    const run = m.meta?.provas?.run && typeof m.meta.provas.run === 'object' ? m.meta.provas.run : m.meta?.provas?.run_informado && typeof m.meta.provas.run_informado === 'object' ? { ...m.meta.provas.run_informado, informada: true } : null;
    return {
      id: m.id,
      rotulo: m.meta?.nome || m.id,
      peca: m.meta?.peca || null,
      area: m.meta?.area || null,
      formato: m.formato || null,
      modelo_da_area: o.modelo || null,
      versao_do_modelo: o.versao_do_modelo ?? null,
      modelo_da_area_presente: o.modelo ? Boolean(P) : null,
      modelo_da_area_atualizado: Boolean(P && o.versao_do_modelo && String(P.meta?.versao) !== String(o.versao_do_modelo)),
      salvo_em: o.salvo_em || m.meta?.versao || null,
      nota: run?.nota === undefined || run?.nota === null || run?.nota === '' ? null : Number(run.nota),
      data_do_run: run?.data || null,
      nota_informada_por_outra_pasta: run?.informada === true,
      completo: m.completo,
      antigo: Boolean(m.antigo),
    };
  });
}

/**
 * Modelos do escritório nas pastas IRMÃS desta (a pasta de cada área ou sócio, lado a lado), para o
 * onboarding perguntar só quando há o que trazer. Lê só `squads/_modelos/esc-*\/modelo.yaml` das
 * irmãs, sem descer em mais nada e sem seguir atalho: não é busca no disco.
 */
export function procurarNasPastasIrmas(cwd, { limite = 200 } = {}) {
  const raiz = resolve(cwd);
  const mae = dirname(raiz);
  const aqui = new Set(listarModelos(cwd).filter((m) => !ehDoEscritorio(m) && m.completo).map((m) => m.id));
  const achados = [];
  let entradas;
  try { entradas = readdirSync(mae, { withFileTypes: true }); } catch { return { pastas: [] }; }
  for (const e of entradas.slice(0, limite)) {
    if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
    const pasta = join(mae, e.name);
    if (pasta === raiz) continue;
    const dirModelos = join(pasta, PASTA_DE_MODELOS);
    let modelos;
    try { modelos = readdirSync(dirModelos, { withFileTypes: true }); } catch { continue; }
    const doEsc = [];
    for (const m of modelos) {
      if (!m.isDirectory() || !m.name.startsWith(PREFIXO_DO_ESCRITORIO)) continue;
      let meta;
      try { meta = lerYaml(readFileSync(join(dirModelos, m.name, 'modelo.yaml'), 'utf8'), 'modelo.yaml') || {}; } catch { continue; }
      if (meta?.origem?.tipo !== 'escritorio') continue;
      // Cabe aqui quando o modelo da área de onde nasceu está nesta pasta (ou é modelo inteiro): o
      // onboarding pergunta só pelos que cabem (revisão v2, N4).
      const deOrigem = meta.origem?.modelo ? String(meta.origem.modelo) : null;
      doEsc.push({ id: m.name, rotulo: meta.nome || m.name, peca: meta.peca || null, cabe_aqui: !deOrigem || aqui.has(deOrigem), modelo_da_area: deOrigem });
    }
    if (doEsc.length) achados.push({ pasta, nome: e.name, modelos: doEsc });
  }
  return { pastas: achados };
}

// ───────────────────────── exportar ─────────────────────────

/** Arquivos de um modelo, na lista fechada, sem seguir atalho e dentro dos limites. */
function lerArquivosDoModelo(dir) {
  const arquivos = {};
  const recusas = [];
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isSymbolicLink()) { recusas.push(`${e.name} é um atalho (link simbólico)`); continue; }
    if (e.isDirectory()) { recusas.push(e.name === 'sobreposicoes' ? 'formato antigo (0.9.42), que guardava arquivos inteiros: guarde de novo o squad de origem com esta versão' : `pasta ${e.name} fora do formato de modelo`); continue; }
    if (!ARQUIVOS_DO_MODELO.includes(e.name)) { recusas.push(`${e.name} não é arquivo de modelo`); continue; }
    const tam = lstatSync(join(dir, e.name)).size;
    total += tam;
    if (tam > (e.name === ARQUIVO_DAS_SKILLS ? LIMITE_DO_MODELO : LIMITE_DO_ARQUIVO)) { recusas.push(`${e.name} passa do limite de ${LIMITE_DO_ARQUIVO / 1e6} MB`); continue; }
    arquivos[e.name] = readFileSync(join(dir, e.name), 'utf8');
  }
  if (total > LIMITE_DO_MODELO) recusas.push(`o modelo passa do limite de ${LIMITE_DO_MODELO / 1e6} MB`);
  return { arquivos, recusas };
}

/** A varredura sem o caso (que não viaja): identificadores, contra o conhecido, menos o já aceito aqui. */
function varrerModelo(arquivos, conhecido) {
  let dif;
  try { dif = JSON.parse(arquivos[ARQUIVO_DA_DIFERENCA] || 'null'); } catch { dif = null; }
  const inteiro = arquivos['design.yaml'] ? { design: arquivos['design.yaml'], prosa: arquivos['prosa.yaml'] || '' } : null;
  let meta;
  try { meta = lerYaml(arquivos['modelo.yaml'] || '', 'modelo.yaml') || {}; } catch { meta = {}; }
  let docSkills;
  try { docSkills = arquivos[ARQUIVO_DAS_SKILLS] ? JSON.parse(arquivos[ARQUIVO_DAS_SKILLS]) : null; } catch { docSkills = null; }
  const skills = lista(docSkills?.skills);
  const textos = { ...textosDaDiferenca(dif, inteiro), ...textosDasSkills(skills), 'nome do modelo': String(meta.nome || '') };
  if (meta.gatilhos_proprios) textos['gatilhos do escritório'] = lista(meta.gatilhos_proprios).join('\n');
  if (meta.pedidos_proprios) textos['pedidos de exemplo do escritório'] = lista(meta.pedidos_proprios).join('\n');
  if (meta.descricao) textos['descrição'] = String(meta.descricao);
  const impressao = dif ? impressaoDe(dif, inteiro, skills) : null;
  return { achados: naoAceitos(achadosDeCaso(textos, { conhecido }), meta, impressao), impressao, meta, dif };
}

export function exportarModelosDoEscritorio({ cwd, ids = null, arquivo, forcar = false, aceitarAchados = false, hoje } = {}) {
  const dataDeHoje = hojeIso(hoje);
  const todos = listarModelos(cwd);
  const doEsc = todos.filter(ehDoEscritorio);
  const escolhidos = ids && ids.length ? ids.map((id) => doEsc.find((m) => m.id === id) || falha(`não há modelo do escritório «${id}» nesta pasta (há: ${doEsc.map((m) => m.id).join(', ') || 'nenhum'})`)) : doEsc;
  if (!escolhidos.length) falha('esta pasta não tem modelo do escritório para levar (guarde um squad com `squad-modelo --salvar <squad>`)');
  const destino = resolve(cwd, String(arquivo || `modelos-do-escritorio-${dataDeHoje}.lsmodelos.json`));
  if (!destino.endsWith('.lsmodelos.json')) falha('o arquivo dos modelos termina em .lsmodelos.json');
  const relAoSquads = relative(join(resolve(cwd), 'squads'), destino);
  if (!relAoSquads.startsWith('..') && !isAbsolute(relAoSquads)) falha('não grave o arquivo dentro de squads/: ali ele se misturaria aos squads e aos modelos; escolha outra pasta');
  if (!existsSync(dirname(destino))) falha(`a pasta ${dirname(destino)} não existe`);
  // Pelo caminho real (sem atalho): `squads/` ou `_modelos/` de outro projeto também não, porque o
  // arquivo estragaria os modelos de lá (revisão v2, N14).
  const real = realpathSync(dirname(destino)).split(sep);
  if (real.includes('squads') || real.includes('_modelos')) falha('não grave o arquivo dentro de uma pasta squads/ ou _modelos/ (desta ou de outra pasta do escritório): escolha outra pasta');
  if (existsSync(destino) && !forcar) falha(`${destino} já existe; para substituí-lo, repita com --forcar`);
  const { conhecido } = contextoDoProjeto(cwd, todos);
  const modelos = [];
  const recusados = [];
  const achados = [];
  for (const m of escolhidos) {
    const { arquivos, recusas } = lerArquivosDoModelo(m.dir);
    if (recusas.length) { recusados.push({ id: m.id, rotulo: m.meta?.nome || m.id, motivo: recusas.join('; ') }); continue; }
    const v = varrerModelo(arquivos, conhecido);
    v.achados = semDadoPublico(cwd, v.achados);
    for (const a of v.achados) achados.push({ modelo: m.id, ...a });
    modelos.push({ id: m.id, rotulo: m.meta?.nome || m.id, arquivos });
  }
  if (recusados.length) return { success: false, recusados, achados };
  if (achados.length && !aceitarAchados) return { success: false, achados };
  const pacote = pacoteDeModelos(modelos, { hoje: dataDeHoje });
  try { writeFileSync(destino, `${JSON.stringify(pacote, null, 2)}\n`, 'utf8'); } catch (e) { falha(`não consegui gravar ${destino}: ${e.code || e.message}`); }
  return { success: true, arquivo: destino, modelos: modelos.map((m) => m.id), rotulos: modelos.map((m) => m.rotulo), achados_aceitos: achados };
}

// ───────────────────────── contribuição à comunidade ─────────────────────────

/**
 * O que identifica o escritório e quem o usa, tirado do perfil: nome, responsável (com a OAB),
 * contato e redes do `company.md`, e o nome do `preferences`. Só os valores, sem os rótulos nem o
 * texto do modelo do perfil, que é do produto. Campo ainda com `<...>` ou "(não informado)" não conta.
 */
export function textoDoPerfil(cwd) {
  const ler = (n) => { try { return readFileSync(join(cwd, '_legalsquad', '_memory', n), 'utf8'); } catch { return ''; } };
  const valores = [];
  const guardar = (v) => {
    const t = String(v || '').replace(/<[^>]*>/g, ' ').replace(/\*\*/g, '').trim();
    if (t && !/^\(?n[ãa]o informado\)?$/i.test(t)) valores.push(t);
  };
  for (const l of ler('company.md').split('\n')) {
    const m = /^\s*-\s*(?:Nome[^:]*|Respons[áa]vel|Contato|E-?mail|Redes[^:]*|Site|Telefone|Endere[çc]o):\s*(.+)$/i.exec(l);
    if (m) guardar(m[1]);
  }
  const prefs = lerJson(join(cwd, '_legalsquad', '_memory', 'preferences.json'));
  guardar(prefs?.userName);
  for (const l of ler('preferences.md').split('\n')) { const m = /User Name:\**\s*(.+)$/i.exec(l); if (m) guardar(m[1]); }
  return valores.join('\n');
}

/**
 * Índice do perfil para a varredura: o do caso (identificadores, nomes compostos) e, além dele,
 * cada palavra dos valores que não é vocabulário dos modelos de pacote. O nome solto do aluno
 * ("Bruno revisa a peça") não casa o padrão de nome composto do caso e tem de barrar do mesmo jeito.
 */
// O que o nome de qualquer instituição tem e não identifica ninguém ("Escritório", "Advocacia",
// "Defensoria Pública"): sem isto, "## Padrão do escritório" barrava o squad de todo escritório.
const GENERICAS_DO_PERFIL = new Set(['das', 'dos', 'oab', 'dra', 'sra', 'escritorio', 'advocacia', 'advogados', 'advogadas', 'advogado', 'advogada', 'associados', 'associadas', 'sociedade', 'socios', 'consultoria', 'assessoria', 'juridico', 'juridica', 'juridicos', 'defensoria', 'defensor', 'defensora', 'publica', 'publico', 'ministerio', 'promotoria', 'promotor', 'promotora', 'procuradoria', 'procurador', 'procuradora', 'gabinete', 'departamento', 'ltda', 'eireli', 'unipessoal', 'www', 'com', 'adv', 'http', 'https', 'instagram', 'linkedin']);

function indiceDoPerfil(texto, vocabulario) {
  const ind = indiceDoCaso(texto, { vocabulario });
  for (const l of String(texto).split('\n')) {
    const toks = (semAcento(l).match(/[a-z]+/g) || []).filter((t) => t.length >= 3 && !GENERICAS_DO_PERFIL.has(t));
    for (const t of toks) if (!vocabulario.has(t)) ind.palavrasDeNome.add(t);
    for (let i = 0; i + 1 < toks.length; i++) ind.paresDeNome.add(`${toks[i]} ${toks[i + 1]}`);
  }
  for (const t of [...ind.palavrasDeNome]) if (GENERICAS_DO_PERFIL.has(t)) ind.palavrasDeNome.delete(t);
  for (const p of [...ind.paresDeNome]) if (p.split(' ').some((t) => GENERICAS_DO_PERFIL.has(t))) ind.paresDeNome.delete(p);
  for (const t of [...ind.prenomes]) if (GENERICAS_DO_PERFIL.has(t)) ind.prenomes.delete(t);
  ind.vazio = !String(texto).trim();
  return ind;
}

// O único "não lido" que não barra o envio: o squad sem caso nenhum (conteúdo, rotina), em que a
// varredura cruza só o que o run gravou, e é isso que há para cruzar.
const SEM_CASO = /não tem autos, caso\.json nem pasta de documentos/;

/**
 * O modelo que este squad mandaria à plataforma da comunidade: o mesmo que o `--salvar` gravaria e
 * o `--exportar` levaria (a diferença sobre o modelo da área, ou o squad inteiro do Arquiteto, com
 * as skills do escritório), montado em memória, sem gravar nada na pasta. A varredura é a do
 * salvar, contra a pasta do caso e contra os outros casos, com três endurecimentos que o envio sem
 * advogado exige (decisão do dono de 26/09/2026):
 *
 * - o perfil do escritório deixa de ser "conhecido" e passa a barrar: o envio não leva nome do
 *   aluno nem do escritório (nem a OAB, o e-mail ou o telefone deles);
 * - não há "aceitar achados": qualquer achado barra o squad inteiro;
 * - caso que a varredura não leu inteiro (PDF sem texto, imagem, documento que não abre) barra:
 *   sem o texto, o nome do cliente escrito num agente não teria com o que ser cruzado.
 *
 * O rótulo é o padrão (o nome do modelo da área), nunca o que o advogado deu ao modelo guardado,
 * que costuma levar o nome do escritório. Devolve `{estado}`: `nada` (squad como o modelo da área o
 * criou), `ignorado` (squad que não vira modelo, com o motivo), `barrado` (com os achados, sem o
 * trecho) ou `pronto` (com o modelo no formato do arquivo exportado).
 */
export function contribuicaoDoSquad(cwd, code, { todos = listarModelos(cwd), hoje } = {}) {
  const dataDeHoje = hojeIso(hoje);
  let cap;
  try { cap = diferencaDoSquad(cwd, code, { todos }); } catch (e) {
    if (e instanceof ErroDeModelo) return { estado: 'ignorado', motivo: e.message };
    throw e;
  }
  const { dir } = cap;
  const escritorio = todos.filter(ehDoEscritorio);
  const origemEsc = cap.origem?.escritorio ? escritorio.find((m) => m.id === cap.origem.modelo) : null;
  // Como no salvar: intocado desde a criação, igual ao modelo da área, ou igual ao modelo do
  // escritório de onde nasceu. Só skill do pacote mudada na pasta não faz do squad uma estrutura nova.
  const igualA = cap.intocado && cap.origem?.modelo ? String(cap.origem.modelo) : cap.vazio ? cap.base.modelo.id : origemEsc && String(origemEsc.meta?.impressao || '') === cap.impressao ? origemEsc.id : null;
  if (igualA) return { estado: 'nada', impressao: cap.impressao, igual_ao_modelo: igualA };

  let designAtual;
  try { designAtual = lerYaml(cap.designAtual, 'design.yaml') || {}; } catch { designAtual = {}; }
  const ident = lerJson(join(dir, 'identificacao.json'));
  const P = cap.base?.modelo || null;
  const pecaLida = String(P?.meta?.peca || designAtual.squad?.peca || ident?.peca || '').trim();
  const peca = RE_ID.test(pecaLida) ? pecaLida : 'sem-peca';
  const id = `${PREFIXO_DO_ESCRITORIO}${peca}`;
  const rotulo = `${P?.meta?.nome || designAtual.squad?.name || humanizarPeca(peca)} (escritório)`;
  const salvoComo = lerJson(join(dir, '_build', 'salvo-como.json'));
  const guardado = salvoComo?.id ? escritorio.find((m) => m.id === salvoComo.id) : null;
  const gatilhosProprios = lista(guardado?.meta?.gatilhos_proprios).map(String);
  const pedidosProprios = lista(guardado?.meta?.pedidos_proprios).map(String);
  const { diferenca: dif, inteiro, skills } = cap;

  // A varredura do salvar, com o perfil fora do conhecido.
  const ctx = contextoDoProjeto(cwd, todos, { comPerfil: false });
  const doDesenho = vocabularioDe([...lista(dif.design).map((o) => JSON.stringify(o.valor ?? '')), inteiro?.design || ''].join('\n'));
  for (const w of vocabularioDe(cap.textoCompilado)) if (!doDesenho.has(w)) ctx.vocabulario.add(w);
  const { texto: textoCaso, naoLidos } = textoDoCaso(dir, { raiz: cwd });
  const caso = indiceDoCaso(textoCaso, { vocabulario: ctx.vocabulario });
  const textos = { ...textosDaDiferenca(dif, inteiro), 'nome do modelo': rotulo, 'id do modelo': id.replace(/-/g, ' '), 'peça': peca.replace(/-/g, ' ') };
  if (gatilhosProprios.length) textos['gatilhos do escritório'] = gatilhosProprios.join('\n');
  if (pedidosProprios.length) textos['pedidos de exemplo do escritório'] = pedidosProprios.join('\n');
  if (!P) textos['descrição'] = String(designAtual.squad?.description || '');
  const textosSkills = textosDasSkills(skills);
  let brutos = achadosDeCaso(textos, { caso, conhecido: ctx.conhecido });
  if (Object.keys(textosSkills).length) {
    const daPasta = textoDeTodosOsCasos(cwd);
    brutos = [...brutos, ...achadosDeCaso(textosSkills, { caso: indiceDoCaso(`${textoCaso}\n${daPasta.texto}`, { vocabulario: ctx.vocabulario }), conhecido: ctx.conhecido })];
  }
  const achados = semDadoPublico(cwd, brutos);
  const perfil = textoDoPerfil(cwd);
  if (perfil) {
    const doPerfil = achadosDeCaso({ ...textos, ...textosSkills }, { caso: indiceDoPerfil(perfil, ctx.vocabulario), conhecido: ctx.conhecido });
    for (const a of doPerfil) if (/que aparece no caso|nome/.test(a.motivo)) achados.push({ ...a, motivo: `dado do perfil do escritório (${a.motivo.replace(/ que aparece no caso| do caso/, '')})` });
  }
  const naoLidosQueBarram = naoLidos.filter((x) => !SEM_CASO.test(x.motivo));
  const barrar = (itens, extra = {}) => ({ estado: 'barrado', impressao: cap.impressao, achados: itens.map((a) => ({ arquivo: a.arquivo, motivo: a.motivo })), nao_lidos: naoLidosQueBarram, ...extra });
  if (achados.length || naoLidosQueBarram.length) return barrar(achados);

  // Os arquivos do modelo, como o salvar os grava e o exportar os lê.
  const run = provaDoRun(dir);
  const checkOrigem = checkSquad(cap.code, { squadsDir: join(cwd, 'squads'), skillsDir: join(cwd, 'skills'), bestPracticesDir: bestPracticesDoProjeto(cwd) });
  const meta = {
    id,
    nome: rotulo,
    ...(P ? {} : { descricao: String(designAtual.squad?.description || '') }),
    area: P ? (P.meta?.area ?? null) : (designAtual.squad?.area ?? null),
    peca,
    polo: P ? (P.meta?.polo ?? null) : null,
    formato: P ? 'diferenca' : 'inteiro',
    versao: dataDeHoje,
    origem: { tipo: 'escritorio', modelo: P ? P.id : null, versao_do_modelo: P ? (cap.base.versao ?? null) : null, motor: VERSAO_DO_MOTOR, salvo_em: dataDeHoje },
    ...(gatilhosProprios.length ? { gatilhos_proprios: gatilhosProprios } : {}),
    ...(pedidosProprios.length ? { pedidos_proprios: pedidosProprios } : {}),
    provas: {
      run: run ? { data: run.data, nota: run.nota } : null,
      check_squad: { erros: checkOrigem.issues.filter((i) => i.severity === 'error').length, avisos: checkOrigem.issues.filter((i) => i.severity === 'warn').length },
      diferenca: cap.contagem,
    },
    impressao: cap.impressao,
  };
  const arquivos = {
    'modelo.yaml': `${CABECALHO_DO_MODELO}${emitirYaml(meta)}\n`,
    [ARQUIVO_DA_DIFERENCA]: `${JSON.stringify(dif, null, 2)}\n`,
    ...(skills.length ? { [ARQUIVO_DAS_SKILLS]: `${JSON.stringify({ formato: 1, skills: paraOModelo(skills) }, null, 2)}\n` } : {}),
    ...(inteiro ? { 'design.yaml': inteiro.design, 'prosa.yaml': inteiro.prosa } : {}),
  };
  // A varredura do exportar (identificadores contra o conhecido) roda de novo sobre o arquivo
  // pronto, e um caminho desta máquina no texto barra: o arquivo exportado nunca leva caminho.
  const doExportar = varrerModelo(arquivos, ctx.conhecido).achados;
  if (doExportar.length) return barrar(semDadoPublico(cwd, doExportar));
  const tudo = Object.values(arquivos).join('\n');
  const caminhos = [resolve(cwd), dirname(resolve(cwd))].filter((c) => c.length > 1);
  try { caminhos.push(realpathSync(cwd)); } catch { /* sem caminho real */ }
  if (caminhos.some((c) => tudo.includes(c))) return barrar([{ arquivo: 'modelo', motivo: 'caminho de pasta desta máquina' }]);
  const tamanhos = Object.entries(arquivos).map(([n, t]) => [n, Buffer.byteLength(t)]);
  if (tamanhos.some(([n, b]) => b > (n === ARQUIVO_DAS_SKILLS ? LIMITE_DO_MODELO : LIMITE_DO_ARQUIVO)) || tamanhos.reduce((s, [, b]) => s + b, 0) > LIMITE_DO_MODELO) {
    return { estado: 'ignorado', impressao: cap.impressao, motivo: 'o modelo passa do limite de tamanho de um modelo' };
  }
  return { estado: 'pronto', impressao: cap.impressao, formato: meta.formato, peca, modelo: { id, rotulo, arquivos } };
}

/** O envelope do arquivo exportado (`.lsmodelos.json`), o mesmo que o `--exportar` grava. */
export function pacoteDeModelos(modelos, { hoje } = {}) {
  return { formato: FORMATO_DO_PACOTE, versao: VERSAO_DO_PACOTE, motor: VERSAO_DO_MOTOR, exportado_em: hojeIso(hoje), modelos };
}

// ───────────────────────── importar ─────────────────────────

function lerOrigemDaImportacao(origem) {
  let st;
  try { st = lstatSync(origem); } catch { falha(`«${origem}» não existe: aponte o arquivo de modelos (.lsmodelos.json) ou a pasta de outro projeto do escritório`); }
  if (st.isSymbolicLink()) falha(`«${origem}» é um atalho (link simbólico): aponte o arquivo ou a pasta de verdade`);
  if (st.isFile()) {
    if (st.size > LIMITE_DA_IMPORTACAO) falha(`«${basename(origem)}» tem ${Math.round(st.size / 1e6)} MB, acima do limite de ${LIMITE_DA_IMPORTACAO / 1e6} MB de um arquivo de modelos`);
    let pacote;
    try { pacote = JSON.parse(readFileSync(origem, 'utf8')); } catch { falha(`«${basename(origem)}» não é um arquivo de modelos do LegalSquad`); }
    if (pacote?.formato !== FORMATO_DO_PACOTE || !Array.isArray(pacote.modelos)) falha(`«${basename(origem)}» não é um arquivo de modelos do LegalSquad`);
    if (Number(pacote.versao) !== VERSAO_DO_PACOTE) falha(`«${basename(origem)}» foi exportado por uma versão anterior (formato ${pacote.versao}), que levava arquivos inteiros: exporte de novo na pasta de origem com esta versão`);
    return pacote.modelos.map((m) => {
      const id = typeof m?.id === 'string' ? m.id : '';
      const arquivos = m?.arquivos && typeof m.arquivos === 'object' && !Array.isArray(m.arquivos) ? m.arquivos : null;
      if (!arquivos) return { id, arquivos: {}, recusas: ['sem arquivos'] };
      const recusas = [];
      for (const [nome, conteudo] of Object.entries(arquivos)) {
        if (!ARQUIVOS_DO_MODELO.includes(nome)) recusas.push(`${nome} não é arquivo de modelo`);
        else if (typeof conteudo !== 'string') recusas.push(`${nome} não é texto`);
        else if (Buffer.byteLength(conteudo) > LIMITE_DO_ARQUIVO) recusas.push(`${nome} passa do limite de ${LIMITE_DO_ARQUIVO / 1e6} MB`);
      }
      return { id, arquivos: recusas.length ? {} : arquivos, recusas };
    });
  }
  if (!st.isDirectory()) falha(`«${origem}» não é arquivo nem pasta`);
  const deUm = (dir, id) => { const { arquivos, recusas } = lerArquivosDoModelo(dir); return { id, arquivos, recusas }; };
  if (existsSync(join(origem, 'modelo.yaml'))) return [deUm(origem, basename(origem))];
  const dirModelos = join(origem, PASTA_DE_MODELOS);
  let entradas = [];
  try { entradas = readdirSync(dirModelos, { withFileTypes: true }); } catch { /* sem modelos */ }
  const saida = [];
  for (const e of entradas) {
    if (!e.name.startsWith(PREFIXO_DO_ESCRITORIO)) continue;
    if (e.isSymbolicLink()) { saida.push({ id: e.name, arquivos: {}, recusas: ['é um atalho (link simbólico)'] }); continue; }
    if (e.isDirectory()) saida.push(deUm(join(dirModelos, e.name), e.name));
  }
  if (!saida.length) falha(`«${origem}» não tem modelo do escritório (procurei em ${PASTA_DE_MODELOS}/esc-*)`);
  return saida;
}

const ehListaDeTexto = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const chaveProibida = (v) => (Array.isArray(v) ? v.some(chaveProibida) : v && typeof v === 'object' ? Object.keys(v).some((k) => ['__proto__', 'constructor', 'prototype'].includes(k) || chaveProibida(v[k])) : false);
function validarDiferenca(dif) {
  if (!dif || typeof dif !== 'object' || Array.isArray(dif)) return 'diferenca.json ilegível';
  if (Number(dif.formato) !== 1) return 'diferenca.json de formato desconhecido';
  if (!Array.isArray(dif.design || [])) return 'desenho fora do formato';
  for (const o of dif.design || []) {
    if (!o || !['alterar', 'acrescentar', 'remover'].includes(o.op) || !Array.isArray(o.caminho) || !o.caminho.length) return 'operação de desenho fora do formato';
    if (o.caminho.some((p) => !(typeof p === 'string' || (p && typeof p === 'object' && Object.keys(p).length === 1 && typeof Object.values(p)[0] === 'string')))) return 'caminho de desenho fora do formato';
    if (o.caminho.some((p) => typeof p === 'string' && ['__proto__', 'constructor', 'prototype'].includes(p))) return 'caminho de desenho proibido';
    if (o.caminho.some((p) => p && typeof p === 'object' && !['id', 'name'].includes(Object.keys(p)[0]))) return 'caminho de desenho fora do formato';
    if (o.valor !== undefined && chaveProibida(o.valor)) return 'valor de desenho com chave proibida';
  }
  for (const [rel, ids] of Object.entries(dif.prosa || {})) {
    if (!caminhoSeguro(rel) || !ids || typeof ids !== 'object') return `prosa de arquivo fora do squad (${rel})`;
    if (Object.keys(ids).some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))) return 'marcador de prosa com nome fora do formato';
    for (const x of Object.values(ids)) {
      if (!x || typeof x !== 'object') return 'texto de prosa fora do formato';
      if (x.base ? !Array.isArray(x.trechos) || x.trechos.some((t) => !t || !ehListaDeTexto(t.antes) || !ehListaDeTexto(t.remover) || !ehListaDeTexto(t.inserir) || !ehListaDeTexto(t.depois)) : typeof x.texto !== 'string') return 'texto de prosa que não é texto';
    }
  }
  for (const [rel, trechos] of Object.entries(dif.texto || {})) {
    if (!caminhoSeguro(rel) || !Array.isArray(trechos)) return `trecho de arquivo fora do squad (${rel})`;
    for (const t of trechos) if (!t || !ehListaDeTexto(t.antes) || !ehListaDeTexto(t.remover) || !ehListaDeTexto(t.inserir) || !ehListaDeTexto(t.depois)) return 'trecho fora do formato';
  }
  for (const [rel, c] of Object.entries(dif.novos || {})) if (!RE_ARQUIVO_NOVO.test(rel) || !caminhoSeguro(rel) || typeof c !== 'string') return `arquivo novo fora do formato (${rel})`;
  if (!ehListaDeTexto(dif.removidos || []) || (dif.removidos || []).some((r) => !caminhoSeguro(r))) return 'arquivo tirado fora do squad';
  return null;
}

/**
 * Traz modelos do escritório de um arquivo exportado ou da pasta de outro projeto. Tudo ou nada:
 * cada modelo é validado, recriado numa pasta temporária e varrido antes de qualquer gravação, e
 * um recusado impede os outros (o advogado resolve e importa de novo).
 */
export function importarModelosDoEscritorio({ cwd, origem, so = null, forcar = false, comoNovo = false, aceitarAchados = false, previa = false, hoje } = {}) {
  const dataDeHoje = hojeIso(hoje);
  const lidos = lerOrigemDaImportacao(resolve(cwd, String(origem || '')));
  const todos = listarModelos(cwd);
  const doPacote = idsDePacote(cwd, todos);
  const { conhecido } = contextoDoProjeto(cwd, todos);
  const escritorio = todos.filter(ehDoEscritorio);
  const aceitos = [];
  const recusados = [];
  const iguais = [];
  const outraArea = [];
  const naoEscolhidos = [];
  const achadosTodos = [];
  const ids = new Set();
  const escolhidos = so === null || so === undefined ? null : new Set(lista(so).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean));
  const rotulos = new Map(escritorio.map((m) => [normalizarRotulo(m.meta?.nome || m.id), m.id]));
  for (const l of lidos) {
    const recusa = (motivo, extra = {}) => recusados.push({ id: l.id || '(sem id)', motivo, ...extra });
    // O advogado escolheu quais trazer (`--so`): os outros nem são conferidos (revisão v2, N4).
    if (escolhidos && !escolhidos.has(l.id)) { naoEscolhidos.push(l.id); continue; }
    if (l.recusas?.length) { recusa(l.recusas.join('; ')); continue; }
    if (!RE_ID.test(l.id) || !l.id.startsWith(PREFIXO_DO_ESCRITORIO)) { recusa(`id inválido (um modelo do escritório começa com «${PREFIXO_DO_ESCRITORIO}»)`); continue; }
    if (doPacote.has(l.id)) { recusa('o id é de um modelo de pacote'); continue; }
    if (ids.has(l.id)) { recusa('o mesmo id aparece duas vezes'); continue; }
    ids.add(l.id);
    if (!l.arquivos['modelo.yaml'] || !l.arquivos[ARQUIVO_DA_DIFERENCA]) { recusa('faltam modelo.yaml ou diferenca.json'); continue; }
    let meta;
    if (/^\s*-?\s*(?:__proto__|constructor|prototype)\s*:/m.test(`${l.arquivos['modelo.yaml']}\n${l.arquivos['design.yaml'] || ''}\n${l.arquivos['prosa.yaml'] || ''}`)) { recusa('arquivo do modelo com chave proibida'); continue; }
    try { meta = lerYaml(l.arquivos['modelo.yaml'], `${l.id}/modelo.yaml`) || {}; } catch { recusa('modelo.yaml ilegível'); continue; }
    if (meta?.origem?.tipo !== 'escritorio') { recusa('não é modelo do escritório (os da área chegam pelo sync)'); continue; }
    if (meta.id && String(meta.id) !== l.id) { recusa('o id do modelo.yaml não é o da pasta'); continue; }
    let dif;
    try { dif = JSON.parse(l.arquivos[ARQUIVO_DA_DIFERENCA]); } catch { recusa('diferenca.json ilegível'); continue; }
    const erroDif = validarDiferenca(dif);
    if (erroDif) { recusa(erroDif); continue; }
    let docSkills = null;
    if (l.arquivos[ARQUIVO_DAS_SKILLS] !== undefined) {
      try { docSkills = JSON.parse(l.arquivos[ARQUIVO_DAS_SKILLS]); } catch { recusa('skills.json ilegível'); continue; }
      const erroSkills = validarSkills(docSkills);
      if (erroSkills) { recusa(erroSkills); continue; }
    }
    const formato = meta.formato === 'inteiro' ? 'inteiro' : 'diferenca';
    if (formato === 'inteiro' && (!l.arquivos['design.yaml'] || !l.arquivos['prosa.yaml'])) { recusa('modelo inteiro sem design.yaml ou prosa.yaml'); continue; }
    if (formato === 'diferenca' && (l.arquivos['design.yaml'] || l.arquivos['prosa.yaml'])) { recusa('modelo de diferença com design.yaml ou prosa.yaml'); continue; }
    // Modelo de uma área que esta pasta não usa fica de fora, sem derrubar os outros: o tudo ou nada
    // vale para defeito do arquivo, não para compatibilidade. A pasta de cada área ao lado da outra
    // é justamente o cenário do onboarding (revisão v2, N4).
    const P = formato === 'diferenca' ? todos.find((m) => m.id === String(meta.origem?.modelo || '') && !ehDoEscritorio(m) && m.completo) : null;
    if (formato === 'diferenca' && !P) {
      outraArea.push({ id: l.id, rotulo: String(meta.nome || l.id), modelo_da_area: String(meta.origem?.modelo || '?') });
      continue;
    }
    // Gatilho largo e campo de gate afrouxado: recusa (revisão v2, N2 e N9).
    const erroGat = validarGatilhos(meta.gatilhos_proprios, 'gatilhos') || validarGatilhos(meta.pedidos_proprios, 'pedidos');
    if (erroGat) { recusa(erroGat); continue; }
    let designDeBase;
    if (P) {
      designDeBase = lerYaml(readFileSync(join(P.dir, 'design.yaml'), 'utf8'), `${P.id}/design.yaml`);
      const g = gatesProtegidos(dif.design, designDeBase);
      if (g.barradas.length) { recusa(`o modelo ${g.barradas.map((b) => `${b.motivo} (${b.caminho})`).join('; ')}: o modelo do escritório não afrouxa os gates`); continue; }
    } else {
      try { designDeBase = lerYaml(l.arquivos['design.yaml'], `${l.id}/design.yaml`); } catch { recusa('design.yaml ilegível'); continue; }
    }
    // Skill criada com o id de uma de pacote, ou versão do escritório de skill de conferência, de
    // ética ou de sigilo: recusa, como o gate do desenho (revisão v3, A1).
    if (docSkills) {
      const erro = conferirSkillsNoProjeto(cwd, docSkills, skillsDeGate(designDeBase));
      if (erro) { recusa(erro); continue; }
    }
    // O que afasta pedidos e a nota do run não se aceitam de fora como dado confiável: o que afasta
    // vem do modelo da área daqui, e a nota vira "informada pela pasta de onde veio" (N2).
    const limpo = { ...meta };
    for (const k of ['gatilhos', 'nao_use_para', 'pedidos_exemplo', 'pedidos_fora']) delete limpo[k];
    if (limpo.provas && typeof limpo.provas === 'object') {
      const { run, ...resto } = limpo.provas;
      limpo.provas = { ...resto, ...(run && typeof run === 'object' ? { run_informado: { data: run.data ?? null, nota: run.nota ?? null } } : {}) };
    }
    Object.keys(meta).forEach((k) => delete meta[k]);
    Object.assign(meta, limpo);
    l.arquivos = { ...l.arquivos, 'modelo.yaml': `${CABECALHO_DO_MODELO}${emitirYaml(meta)}\n` };
    const existente = escritorio.find((m) => m.id === l.id);
    const v = varrerModelo(l.arquivos, conhecido);
    v.achados = semDadoPublico(cwd, v.achados);
    if (existente && String(existente.meta?.impressao || '') === String(v.impressao || '') && String(meta.impressao || '') === String(v.impressao || '')) { iguais.push({ id: l.id, rotulo: meta.nome || l.id }); continue; }
    // Mesmo id com conteúdo diferente (a outra pasta evoluiu o modelo por conta própria): nunca por
    // cima em silêncio. `--forcar` substitui o daqui (que vai para a lixeira); `--como-novo` guarda os
    // dois, o de fora com outro id e o nome marcado como importado.
    let idDestino = l.id;
    let rotuloDestino = String(meta.nome || l.id);
    if (existente && !forcar) {
      if (!comoNovo) { recusa(`já existe aqui o modelo «${existente.meta?.nome || l.id}» com o mesmo id e conteúdo diferente: para substituir o daqui (ele vai para a lixeira dos modelos), repita com --forcar; para ficar com os dois, repita com --como-novo`); continue; }
      for (let n = 2; ids.has(idDestino) || existsSync(join(cwd, PASTA_DE_MODELOS, idDestino)); n++) idDestino = `${l.id}-${n}`;
      ids.add(idDestino);
    }
    if (rotulos.has(normalizarRotulo(rotuloDestino)) && rotulos.get(normalizarRotulo(rotuloDestino)) !== idDestino) {
      if (!comoNovo) { recusa(`já há aqui um modelo do escritório chamado «${rotuloDestino}»: renomeie o daqui antes (--renomear), ou repita com --como-novo`); continue; }
      rotuloDestino = `${rotuloDestino} (importado em ${dataDeHoje})`;
    }
    rotulos.set(normalizarRotulo(rotuloDestino), idDestino);
    if (idDestino !== l.id || rotuloDestino !== String(meta.nome || l.id)) {
      meta.id = idDestino;
      meta.nome = rotuloDestino;
      l.arquivos = { ...l.arquivos, 'modelo.yaml': `${CABECALHO_DO_MODELO}${emitirYaml(meta)}\n` };
      l.id = idDestino;
    }
    if (v.achados.length) achadosTodos.push(...v.achados.map((a) => ({ modelo: l.id, ...a })));
    // Recria numa pasta temporária, com o modelo da área deste projeto, antes de gravar (D10).
    const tmpModelo = mkdtempSync(join(tmpdir(), 'legalsquad-importa-'));
    try {
      for (const [nome, conteudo] of Object.entries(l.arquivos)) writeFileSync(join(tmpModelo, nome), conteudo, 'utf8');
      const candidato = { id: l.id, dir: tmpModelo, completo: true, formato, meta };
      const conf = conferirRecriacao(cwd, candidato, { todos, code: 'conferencia-importacao', hoje: dataDeHoje });
      const erros = conf.check.filter((i) => i.severity === 'error');
      if (erros.length) { recusa(`não recria um squad íntegro neste projeto: ${erros.slice(0, 2).map((i) => i.detail).join('; ')}`); continue; }
      const desvios = desviosDaRegua(todos, [candidato], { tirar: existente && forcar ? [existente.id] : [] });
      if (desvios.length) { recusa(`tiraria de outras peças pedidos que não são dele (${desvios.slice(0, 3).map((f) => `«${f.pedido}»`).join(', ')}): os gatilhos são largos demais`, { regua: desvios }); continue; }
      aceitos.push({ id: l.id, rotulo: meta.nome || l.id, arquivos: l.arquivos, docSkills, conflitos: conf.conflitos, substitui: Boolean(existente), mudancas: mudancasParaLer(dif, formato === 'inteiro' ? { design: l.arquivos['design.yaml'] } : null), skills: skillsParaLer(docSkills?.skills) });
    } catch (e) {
      // Arquivo de fora pode ser qualquer coisa: o que não recria é recusado com o motivo, nunca derruba a importação.
      if (!(e instanceof Error)) throw e;
      recusa(`não recria um squad neste projeto: ${e.message}`);
    } finally {
      rmSync(tmpModelo, { recursive: true, force: true });
    }
  }
  const base = { importados: [], iguais, outra_area: outraArea, nao_escolhidos: naoEscolhidos, recusados, conflitos: aceitos.filter((a) => a.conflitos.length).map((a) => ({ id: a.id, conflitos: a.conflitos })), regua: [] };
  // Prévia: o que entraria e o que cada modelo muda nos agentes, para o advogado ler antes do "sim"
  // (um arquivo de fora escreve nas instruções dos agentes; ninguém o importa sem ver).
  // As skills entram na prévia com o que o escritório escreveu nelas: elas instruem os agentes do
  // mesmo jeito que o texto, e a prévia de um modelo só de skills dizia "Entraria «...»" e mais
  // nada (revisão v3, A6).
  if (previa) return { success: recusados.length === 0, previa: true, ...base, a_importar: aceitos.map((a) => ({ id: a.id, rotulo: a.rotulo, substitui: a.substitui, mudancas: a.mudancas, skills: a.skills })), achados: achadosTodos, nada_gravado: true };
  if (recusados.length) return { success: false, ...base, achados: achadosTodos, nada_gravado: true };
  if (achadosTodos.length && !aceitarAchados) return { success: false, ...base, achados: achadosTodos, nada_gravado: true };
  const raizDosModelos = join(cwd, PASTA_DE_MODELOS);
  mkdirSync(raizDosModelos, { recursive: true });
  const skillsInstaladas = [];
  const avisosDasSkills = [];
  const trabalho = join(raizDosModelos, `.importando-${process.pid}`);
  rmSync(trabalho, { recursive: true, force: true });
  try {
    for (const a of aceitos) {
      mkdirSync(join(trabalho, a.id), { recursive: true });
      for (const [nome, conteudo] of Object.entries(a.arquivos)) writeFileSync(join(trabalho, a.id, nome), conteudo, 'utf8');
    }
    for (const a of aceitos) {
      if (existsSync(join(raizDosModelos, a.id))) paraALixeira(cwd, a.id, dataDeHoje);
      renameSync(join(trabalho, a.id), join(raizDosModelos, a.id));
    }
    // As skills entram depois dos modelos, uma a uma, cada plano visto contra o que já entrou: dois
    // modelos com a mesma skill do escritório não gravam um por cima do outro.
    for (const a of aceitos) {
      if (!a.docSkills) continue;
      const plano = planejarSkills(cwd, a.docSkills, { modelo: a.id });
      skillsInstaladas.push(...instalarSkills(cwd, plano, { hoje: dataDeHoje }));
      avisosDasSkills.push(...plano.avisos);
    }
  } finally {
    rmSync(trabalho, { recursive: true, force: true });
  }
  const importados = aceitos.map((a) => a.id);
  return { success: true, ...base, importados, skills_instaladas: skillsInstaladas, avisos_das_skills: avisosDasSkills, rotulos: aceitos.map((a) => a.rotulo), achados_aceitos: achadosTodos };
}

// ───────────────────────── CLI ─────────────────────────

const listaJson = (v, nome) => {
  if (v === undefined || v === null || v === false) return null;
  try { const l = JSON.parse(String(v)); if (Array.isArray(l)) return l; } catch { /* abaixo */ }
  return falha(`--${nome} precisa ser uma lista JSON de frases, ex.: '["frase um", "frase dois"]'`);
};
const linhaDoAchado = (a) => `      ${a.modelo ? `${a.modelo}, ` : ''}${a.arquivo}: «${a.trecho}» (${a.motivo})${a.dado && a.dado !== a.trecho ? `; para trocar, use «${a.dado}»` : ''}`;
const primeiraLinha = (t) => String(t || '').split('\n').find((l) => l.trim()) || '';
const mostrarMudancas = (mudancas, n = 20) => { for (const m of lista(mudancas).slice(0, n)) console.log(`      ${m.onde}: ${m.o_que}${m.texto ? ` («${primeiraLinha(m.texto).trim().slice(0, 120)}»)` : ''}`); };
const mostrarSkills = (skills, n = 6) => {
  for (const x of lista(skills)) {
    console.log(`      ${x.o_que}${x.modo === 'inteira' ? ` [${x.id}]` : ''}`);
    for (const l of lista(x.linhas).slice(0, x.modo === 'inteira' ? n : Math.min(n, 4))) console.log(`          «${l}»`);
  }
};
const mostrarNaPasta = (r) => {
  for (const id of r?.skills_na_pasta?.movidas || []) console.log(`  ✓ a edição que o escritório fez no SKILL.md da skill ${id} do pacote passou para skills/${id}/SKILL.local.md: vale igual nesta pasta, e a atualização do pacote não a desfaz`);
  for (const rel of r?.skills_na_pasta?.no_lugar || []) console.log(`  ⚠ ${rel} foi mudado no lugar, dentro de uma skill do pacote: o modelo guardou a mudança, mas a próxima atualização do pacote devolve este arquivo ao do curador nesta pasta`);
  if (r?.sem_contrato?.length) console.log(`  ⚠ ${r.sem_contrato.length} skill(s) criada(s) no escritório sem o contrato de qualidade (${r.sem_contrato.join(', ')}): o run as bloqueia. Rode \`npx legalsquad contract-skills\` nesta pasta antes do próximo run`);
};
const mostrarNaoViaja = (itens) => { for (const x of itens || []) console.log(`  · não vai: ${x.arquivo} (${x.motivo})`); };
const mostrarNaoLidos = (naoLidos) => {
  if (!naoLidos?.length) return;
  console.log(`  ⚠ A conferência de dado do caso não leu ${naoLidos.length} arquivo(s) do caso; confira você também o que vai no modelo:`);
  for (const x of naoLidos.slice(0, 8)) console.log(`      ${x.arquivo}: ${x.motivo}`);
};
const mostrarRegua = (regua) => {
  if (!regua?.length) return;
  console.log(`  ✖ Não guardei: com este modelo, ${regua.length} pedido(s) de exemplo passariam a escolher o modelo errado:`);
  for (const f of regua.slice(0, 8)) console.log(`      «${f.pedido}» (de ${f.modelo}) ficaria com ${f.obtido}`);
  console.log('  Os gatilhos do escritório estão largos demais, ou os pedidos dele não o escolhem: proponha frases mais específicas da peça (--gatilhos, --pedidos) e guarde de novo.');
};
const mostrarPerde = (perde) => {
  if (!perde?.length) return;
  console.log(`  ⚠ O modelo que este squad atualiza tem ${perde.length} mudança(s) do escritório que o squad não tem (não couberam no modelo da área de hoje, ou foram tiradas):`);
  for (const p of perde) {
    const onde = p.tipo === 'skill' ? `${p.arquivo}${p.rel ? `, ${p.rel}` : ''}` : `${p.arquivo}${p.id ? `, texto «${p.id}»` : ''}${p.caminho ? `, ${p.caminho}` : ''}`;
    const oQue = p.linhas ? `«${primeiraLinha(p.linhas.join('\n')).trim().slice(0, 120)}»` : p.tipo === 'novo' ? 'arquivo acrescentado' : p.tipo === 'skill' ? (p.entrada ? 'a skill inteira (o squad não a usa mais, ou ela voltou a ser a do pacote)' : 'arquivo acrescentado à skill') : 'mudança de desenho';
    console.log(`      ${p.n}. ${onde}: ${oQue}`);
  }
  console.log("  Pergunte ao advogado item a item e repita com --levar '[1, 3]' (os que ele quer manter; vão no fim do texto ou do arquivo), --levar todos, ou --levar '[]' para deixar todos de fora.");
};

/**
 * As rotas do modelo do escritório na CLI (`squad-modelo --salvar|--exportar|--importar|--listar|
 * --apagar|--restaurar|--renomear|--procurar`). Devolve null quando o pedido não é delas. Quem lê a
 * saída é o chefe, que a repassa ao advogado em linguagem simples.
 */
export function cliDoEscritorio(positional, cwd, values = {}) {
  const json = values.json === true;
  const saida = (r) => { console.log(JSON.stringify(r, (k, v) => (k === 'dir' ? undefined : v), 2)); return { success: r.success !== false }; };
  if (values.procurar === true) {
    const r = procurarNasPastasIrmas(cwd);
    if (json) return saida({ success: true, ...r });
    if (!r.pastas.length) { console.log('  Nenhuma pasta ao lado desta tem modelo do escritório.'); return { success: true }; }
    for (const p of r.pastas) {
      const cabem = p.modelos.filter((m) => m.cabe_aqui);
      const naoCabem = p.modelos.filter((m) => !m.cabe_aqui);
      console.log(`  ${p.nome}: ${cabem.map((m) => m.rotulo).join(' · ') || 'nenhum que caiba aqui'}${naoCabem.length ? ` (e ${naoCabem.length} de área que esta pasta não usa: ${naoCabem.map((m) => m.rotulo).join(' · ')})` : ''}`);
    }
    return { success: true };
  }
  if (values.listar === true) {
    const r = listarDoEscritorio(cwd);
    if (json) return saida({ success: true, modelos: r });
    if (!r.length) { console.log('  Esta pasta não tem modelo do escritório. Um squad que funcionou vira modelo com `squad-modelo --salvar <squad>`.'); return { success: true }; }
    console.log('  Modelos do escritório:');
    for (const m of r) {
      const nota = m.nota !== null ? `nota ${m.nota} no run de ${m.data_do_run || '?'}${m.nota_informada_por_outra_pasta ? ' (informada pela pasta de onde veio)' : ''}` : 'sem nota de run';
      const origem = m.modelo_da_area ? `sobre o modelo da área ${m.modelo_da_area}${m.modelo_da_area_presente === false ? ' (que não está nesta pasta)' : m.modelo_da_area_atualizado ? ' (atualizado depois)' : ''}` : 'modelo inteiro';
      console.log(`    ${m.rotulo} [${m.id}]: peça ${m.peca || '?'} · ${origem} · guardado em ${m.salvo_em || '?'} · ${nota}${m.antigo ? ' · formato antigo, guarde de novo' : ''}`);
    }
    return { success: true };
  }
  if (values.apagar) {
    const r = apagarModeloDoEscritorio(cwd, String(values.apagar));
    if (json) return saida(r);
    console.log(`  ✓ Modelo «${r.rotulo}» tirado da lista. Para trazer de volta: \`npx legalsquad squad-modelo --restaurar ${r.id}\`.`);
    for (const x of r.skills_que_ficam || []) console.log(`  · a ${x.tipo === 'skill' ? 'skill' : 'best-practice'} ${x.id}, que veio com o modelo, fica nesta pasta${x.usada_por.length ? ` (usada por ${x.usada_por.join(', ')})` : ', sem squad que a use'}`);
    return { success: true };
  }
  if (values.restaurar) {
    const r = restaurarModeloDoEscritorio(cwd, String(values.restaurar));
    if (json) return saida(r);
    console.log(`  ✓ Modelo «${r.rotulo}» de volta à lista.`);
    return { success: true };
  }
  if (values.renomear) {
    const r = renomearModeloDoEscritorio(cwd, String(values.renomear), values.rotulo);
    if (json) return saida(r);
    if (!r.success) { console.log('  ✖ Não renomeei: o nome parece ter dado de caso:'); for (const a of r.achados) console.log(linhaDoAchado(a)); return { success: false }; }
    console.log(`  ✓ Modelo ${r.id} agora se chama «${r.rotulo}».`);
    if (r.conferencia_parcial) console.log('  ⚠ O squad que gerou este modelo não está nesta pasta: conferi só números e contatos no nome. Confirme com o advogado que o nome não tem dado de cliente.');
    return { success: true };
  }
  if (values.exportar !== undefined) {
    const ids = String(values.exportar === true ? '' : values.exportar || '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'todos');
    const r = exportarModelosDoEscritorio({ cwd, ids, arquivo: values.arquivo, forcar: values.forcar === true, aceitarAchados: values['aceitar-achados'] === true });
    if (json) return saida(r);
    if (!r.success) {
      for (const x of r.recusados || []) console.log(`  ✖ ${x.rotulo || x.id}: ${x.motivo}`);
      if (r.achados?.length) { console.log(`  ✖ Não levei os modelos: ${r.achados.length} trecho(s) parecem dado de caso:`); for (const a of r.achados) console.log(linhaDoAchado(a)); console.log('  Mostre os trechos ao advogado; só com o "sim" dele, repita com --aceitar-achados.'); }
      return { success: false };
    }
    console.log(`  ✓ ${r.modelos.length} modelo(s) do escritório no arquivo ${r.arquivo}: ${r.rotulos.join(' · ')}`);
    console.log('  Na outra pasta: `npx legalsquad squad-modelo --importar <esse arquivo>`.');
    return { success: true };
  }
  if (values.importar) {
    const so = values.so ? String(values.so).split(',').map((x) => x.trim()).filter(Boolean) : null;
    const r = importarModelosDoEscritorio({ cwd, origem: String(values.importar), so, forcar: values.forcar === true, comoNovo: values['como-novo'] === true, aceitarAchados: values['aceitar-achados'] === true, previa: values.previa === true });
    if (json) return saida(r);
    if (r.previa) {
      for (const m of r.a_importar) {
        console.log(`  Entraria «${m.rotulo}» [${m.id}]${m.substitui ? ' (no lugar do daqui)' : ''}:`);
        mostrarMudancas(m.mudancas, 12);
        if (m.skills?.length) { console.log(`    e ${m.skills.length} skill(s) que passam a instruir os agentes:`); mostrarSkills(m.skills); }
        if (!m.mudancas?.length && !m.skills?.length) console.log('      (sem mudança sobre o modelo da área)');
      }
    }
    if (r.importados.length) console.log(`  ✓ ${r.importados.length} modelo(s) do escritório trazido(s): ${r.rotulos.join(' · ')}`);
    if (r.skills_instaladas?.length) console.log(`  ✓ skills do escritório instaladas nesta pasta: ${r.skills_instaladas.join(', ')}`);
    for (const a of r.avisos_das_skills || []) console.log(`  ⚠ ${a}`);
    if (r.iguais.length) console.log(`  · já estavam aqui, iguais: ${r.iguais.map((x) => x.rotulo).join(' · ')}`);
    if (r.outra_area.length) console.log(`  · ficam de fora, porque são de área que esta pasta não usa: ${r.outra_area.map((x) => `${x.rotulo} (sobre ${x.modelo_da_area})`).join(' · ')}`);
    for (const x of r.recusados) console.log(`  ✖ ${x.id}: ${x.motivo}`);
    if (r.achados?.length && !r.success) {
      console.log(`  ✖ ${r.achados.length} trecho(s) parecem dado de caso:`);
      for (const a of r.achados) console.log(linhaDoAchado(a));
      console.log('  Mostre os trechos ao advogado; só se ele disser que não são de cliente, repita com --aceitar-achados.');
    }
    if (r.nada_gravado && !r.previa) console.log('  Nada foi gravado (a importação é tudo ou nada: resolva o que foi recusado, ou traga só os outros com --so <id>,<id>).');
    for (const c of r.conflitos) console.log(`  ⚠ ${c.id}: ${c.conflitos.length} mudança(s) do escritório não couberam no modelo da área desta pasta e ficarão de fora ao criar`);
    return { success: r.success };
  }
  if (values.salvar) {
    if (values.dispensar === true) {
      const r = dispensarOferta(cwd, String(values.salvar));
      if (json) return saida(r);
      console.log('  ✓ Anotado: não ofereço de novo enquanto o squad não mudar.');
      return { success: true };
    }
    let levar = null;
    if (values.levar !== undefined && values.levar !== null) levar = String(values.levar).trim() === 'todos' ? 'todos' : listaJson(values.levar, 'levar');
    const r = salvarModeloDoEscritorio(String(values.salvar), {
      cwd,
      id: values.id ? String(values.id) : undefined,
      rotulo: values.rotulo ? String(values.rotulo) : undefined,
      peca: values.peca ? String(values.peca) : undefined,
      gatilhos: listaJson(values.gatilhos, 'gatilhos'),
      pedidos: listaJson(values.pedidos, 'pedidos'),
      substituir: values.substituir || null,
      levar,
      aceitarAchados: values['aceitar-achados'] === true,
      forcar: values.forcar === true,
      previa: values.previa === true,
    });
    if (json) return saida(r);
    if (r.nada_a_salvar) {
      const avisos = r.resumo?.avisos || [];
      console.log(avisos.length
        ? `  Não achei mudança do escritório que dê para guardar em squads/${values.salvar}, no que dá para comparar com o modelo ${r.igual_ao_modelo}.`
        : `  Nada a guardar: squads/${values.salvar} está como o modelo ${r.igual_ao_modelo}, de onde nasceu. Ele já atende os próximos casos.`);
      for (const a of avisos) console.log(`  ⚠ ${a}`);
      return { success: false };
    }
    if (r.ja_existe_da_peca && !r.previa) {
      console.log('  Já há modelo do escritório para esta peça:');
      for (const m of r.ja_existe_da_peca) console.log(`      «${m.rotulo}» [${m.id}], guardado em ${m.salvo_em || '?'}`);
      console.log('  Para substituí-lo por este squad, repita com --forcar; para guardar os dois, dê um nome a este com --rotulo "<nome>".');
      return { success: false };
    }
    const mudancas = r.mudancas || [];
    if (r.previa) {
      console.log(`  Prévia do modelo «${r.rotulo}» [${r.id}]${r.atualiza ? ' (atualiza o que este squad já gerou)' : ''}${r.ja_salvo ? ': já guardado, sem mudança desde então' : ''}${r.dispensado ? ': o advogado já dispensou esta oferta' : ''}`);
      mostrarMudancas(mudancas);
      if (r.skills?.length) { console.log('  Skills que vão com o modelo:'); mostrarSkills(r.skills); }
      if (r.so_skills_da_pasta?.length) console.log(`  ⚠ A única mudança é na(s) skill(s) do pacote ${r.so_skills_da_pasta.join(', ')}, feita nesta pasta: ela vale para todos os squads daqui. Guardar este squad como modelo só se ele é o squad para o qual ela foi feita (o chefe não oferece isso no fim do run)`);
      if (r.sem_contrato?.length) console.log(`  ⚠ Skill(s) criada(s) sem o contrato de qualidade (${r.sem_contrato.join(', ')}): o run as bloqueia; \`npx legalsquad contract-skills\` resolve`);
      mostrarNaoViaja(r.resumo?.nao_viaja);
      for (const a of r.resumo?.avisos || []) console.log(`  ⚠ ${a}`);
      mostrarPerde(r.perde);
      if (r.precisa_gatilhos) console.log('  ⚠ Nenhum modelo da área cobre esta peça: para guardar, passe --gatilhos e --pedidos (frases e pedidos da peça, sem dado do caso).');
      if (r.substituicoes_sem_efeito?.length) console.log(`  ⚠ --substituir sem efeito (o texto não está no modelo): ${r.substituicoes_sem_efeito.map((x) => `«${x}»`).join(', ')}`);
      if (r.achados?.length) { console.log(`  ⚠ ${r.achados.length} trecho(s) parecem dado do caso:`); for (const a of r.achados) console.log(linhaDoAchado(a)); }
      mostrarNaoLidos(r.nao_lidos);
      return { success: true };
    }
    if (!r.success) {
      if (r.regua?.length) { mostrarRegua(r.regua); return { success: false }; }
      if (r.perde?.length) { mostrarPerde(r.perde); return { success: false }; }
      console.log(`  ✖ Não guardei: ${r.achados.length} trecho(s) parecem dado do caso, e o modelo vai servir a outros clientes:`);
      for (const a of r.achados) console.log(linhaDoAchado(a));
      if (r.substituicoes_sem_efeito?.length) console.log(`  ⚠ --substituir sem efeito (o texto não está no modelo): ${r.substituicoes_sem_efeito.map((x) => `«${x}»`).join(', ')}`);
      mostrarNaoLidos(r.nao_lidos);
      console.log("  Mostre os trechos ao advogado e troque-os só no modelo por texto genérico, com --substituir '{\"<o dado exato>\": \"o cliente\"}' (o squad do caso fica como está); só se ele disser que não são do cliente, repita com --aceitar-achados.");
      return { success: false };
    }
    console.log(`Modelo do escritório: «${r.rotulo}» [${r.id}]${r.atualizou ? ' (atualizado)' : ''}`);
    const nSkills = r.skills?.length ? ` e ${r.skills.length} skill(s)` : '';
    console.log(r.modelo_da_area ? `  ✓ guarda só o que o escritório mudou sobre o modelo da área ${r.modelo_da_area}: ${mudancas.length} mudança(s) no desenho e nos textos${nSkills}` : `  ✓ guarda o squad inteiro (ele não nasceu de um modelo da área)${nSkills}`);
    mostrarMudancas(mudancas, 12);
    if (r.skills?.length) { console.log('  ✓ skills que vão com o modelo:'); mostrarSkills(r.skills); }
    mostrarNaPasta(r);
    mostrarNaoViaja(r.resumo?.nao_viaja);
    for (const a of r.resumo?.avisos || []) console.log(`  ⚠ ${a}`);
    if (r.levados?.length) console.log(`  ✓ levados do modelo anterior: ${r.levados.join(', ')}`);
    if (r.nao_reproduz?.length) console.log(`  ⚠ ${r.nao_reproduz.length} arquivo(s) não saem iguais ao recriar (o squad novo terá esses arquivos como o modelo os gera, sem a mudança que não coube na diferença): ${r.nao_reproduz.slice(0, 6).join(', ')}`);
    if (r.achados_aceitos.length) console.log(`  ⚠ ${r.achados_aceitos.length} trecho(s) com cara de dado do caso foram aceitos pelo advogado`);
    mostrarNaoLidos(r.nao_lidos);
    console.log(`  Nota do run que o originou: ${r.run?.nota ?? 'não registrada'}${r.run?.data ? ` (${r.run.data})` : ''}`);
    console.log(`  Próximos casos de ${r.peca}: o chefe começa por este modelo; para criar direto, \`npx legalsquad squad-modelo ${r.id} --code <code>\`.`);
    return { success: true };
  }
  return null;
}
