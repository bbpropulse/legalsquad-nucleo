// Skills e best-practices que viajam com o modelo do escritório (pedido do dono, 25/09/2026:
// "deve também ir acompanhado das skills que tenham sido criadas/personalizadas de forma que
// respeite integralmente o que foi feito").
//
// Num projeto há três tipos de skill, e o registro do depósito separa os três por código:
//
// - de pacote intocada: o caminho está em `acervo/_packs/_arquivos/<pacote>.json` do depósito
//   ligado ao projeto e o arquivo tem o mesmo sha256 (é o hard link, ou a cópia fiel). Não viaja: o
//   outro projeto a recebe pelo sync.
// - de pacote editada: o caminho está no registro e o arquivo difere, falta, sobra, ou há um
//   `SKILL.local.md` (a camada do usuário, que o catálogo põe na frente). Viaja como diferença
//   sobre a versão do pacote, com o arquivo inteiro de reserva para quando a diferença não
//   reaplicar sobre a versão nova do curador.
// - criada no projeto: nenhum pacote declara o caminho. Viaja inteira.
//
// "Respeitar integralmente" sem mexer nos outros squads: a skill editada vira uma skill do
// escritório com id próprio (`esc-<id>`), materializada inteira em `skills/` do projeto, e só o
// squad criado do modelo aponta para ela (o desenho é reescrito na criação). A skill do pacote fica
// como o curador a publicou, para todos os outros squads. Nenhum pacote declara `esc-*` (o
// `pack-build` recusa), então o sync e o `update` não a tocam nem a apagam. Uma cópia dentro do
// squad não serviria: o runner, o check-squad e o resolvedor leem `skills/<id>/SKILL.md` da raiz
// do projeto.
//
// A procedência mora em `skills/_escritorio.json` (arquivo com `_`, que o catálogo não lê e nenhum
// pacote declara), por LINHAGEM e não por bytes (revisão v3, A5, 25/09/2026: comparar byte a byte
// criava `esc-x-2`, `-3` a cada criação depois de `contract-skills`, de atualização do curador ou de
// reimportação do mesmo modelo). Cada skill do escritório guarda de onde veio (`de` e o pacote, ou
// `origem: criada` e o id original), o modelo que a trouxe, a impressão da entrada do modelo que a
// gerou e a base do pacote sobre a qual foi montada (a diferença seguinte é tirada contra essa base,
// não contra a versão de hoje do curador: M4).
//
// Quem confere não lê regra trazida por arquivo (revisão v3, A1): a troca de uma skill de pacote
// pela versão do escritório vale para os agentes que escrevem; o revisor e o conferente continuam
// com a do pacote, e skill de conferência de citações, de ética ou de sigilo não se troca.

import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { arquivosDoDeposito, donosDosArquivosDoDeposito, ligacaoDoProjeto, momentoDaLigacao } from './deposito.js';
import { aplicarTrechos, canonico, hashDe, trechosEntre } from './diferenca.js';
import { discoverSkillCatalog, gravarIndiceDeSkills } from './skill-catalog.js';
import { parseSkillMetadata } from './frontmatter.js';

export const ARQUIVO_DAS_SKILLS = 'skills.json';
const REGISTRO = join('skills', '_escritorio.json');
const ANTERIORES = join('skills', '_escritorio', 'anteriores');
const PASTA_BP = join('_legalsquad', 'core', 'best-practices');
const RE_ID = /^[a-z0-9][a-z0-9-]*$/;
const RE_REL = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const LIMITE_POR_ARQUIVO = 2_000_000;
const LIMITE_POR_SKILL = 4_000_000;
// Um modelo real leva de uma a dez skills; 300 criadas num arquivo de fora entravam todas (A5,
// melhorias da revisão v3).
export const LIMITE_DE_SKILLS = 40;
const NATIVAS = new Set(['web_search', 'web_fetch']);
// Arquivos que o `contract-skills` gera a partir do SKILL.md: não são texto do escritório. Na
// comparação eles ficam de fora, e na instalação saem do pacote com o id novo (M2: o contrato
// reescrevia `$x` para `$esc-x` e o squad criado do modelo virava "mudado").
export const ARQUIVOS_DO_CONTRATO = new Set(['agents/openai.yaml', 'references/high-performance-contract.md']);
const doContrato = (tipo, rel) => tipo === 'skill' && ARQUIVOS_DO_CONTRATO.has(rel);
// Skill e best-practice de conferência de citações, de ética e de sigilo: gate, não estilo.
const RE_DE_GATE = /(?:^|-)(?:etica|sigilo|lgpd|citac[a-z]*|verificac[a-z]*|conferencia|conferente)(?:-|$)/;

const sha = (t) => createHash('sha256').update(typeof t === 'string' ? Buffer.from(t, 'utf8') : t).digest('hex');
const lerJson = (c) => { try { return JSON.parse(readFileSync(c, 'utf8')); } catch { return null; } };
const lista = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
const relSeguro = (rel) => typeof rel === 'string' && RE_REL.test(rel) && !rel.split('/').some((p) => p === '..' || p === '.' || p.startsWith('.'));
const semFimDeLinha = (t) => String(t).replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');
const escaparRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Texto de verdade: UTF-8 válido e sem NUL. Arquivo binário numa skill (imagem, planilha) não viaja. */
function comoTexto(buf) {
  if (buf.includes(0)) return null;
  const t = buf.toString('utf8');
  return Buffer.from(t, 'utf8').equals(buf) ? t : null;
}

/** O agente que confere (revisor, conferente, verificador): não recebe regra de fora. */
export const ehVerificador = (a) => /verificador|contraditor|avaliador/.test(String(a?.specialist ?? '')) || /^(?:revisor|conferente)$/.test(String(a?.id ?? ''));

/**
 * Skills e best-practices de gate num desenho: as que só os agentes que conferem usam. Somadas às
 * de conferência de citações, ética e sigilo pelo nome, são as que o modelo do escritório não troca
 * (no salvar, a mudança fica na pasta e não vai; na importação, recusa).
 */
export function skillsDeGate(design) {
  const gate = { skills: new Set(), bps: new Set() };
  const outros = { skills: new Set(), bps: new Set() };
  for (const a of lista(design?.agents)) {
    const alvo = ehVerificador(a) ? gate : outros;
    for (const s of lista(a?.skills)) alvo.skills.add(String(s));
    for (const b of lista(a?.best_practices)) alvo.bps.add(String(b));
  }
  for (const s of outros.skills) gate.skills.delete(s);
  for (const b of outros.bps) gate.bps.delete(b);
  return gate;
}
export const ehDeGate = (tipo, id, gate = null) => RE_DE_GATE.test(String(id || '')) || Boolean((tipo === 'skill' ? gate?.skills : gate?.bps)?.has(String(id)));

/** O `name:` do frontmatter de SKILL.md é o id da pasta (o catálogo reprova quando difere). */
export function comNome(texto, id) {
  const t = String(texto);
  if (!t.startsWith('---')) return t;
  const fim = t.indexOf('\n---', 3);
  if (fim < 0) return t;
  const fm = t.slice(0, fim);
  const novo = /^name:.*$/m.test(fm) ? fm.replace(/^name:.*$/m, `name: ${id}`) : fm;
  return `${novo}${t.slice(fim)}`;
}

/** Troca um id de skill por outro no texto, só onde ele aparece inteiro (`x`, não `x-2`). */
export function trocarId(texto, de, para) {
  if (!de || de === para) return String(texto);
  return String(texto).replace(new RegExp(`(?<![A-Za-z0-9-])${escaparRe(de)}(?![A-Za-z0-9-])`, 'g'), para);
}

function registro(cwd) {
  const r = lerJson(join(cwd, REGISTRO));
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return { skills: obj(r?.skills), best_practices: obj(r?.best_practices), locais: obj(r?.locais) };
}
function gravarRegistro(cwd, reg) {
  mkdirSync(join(cwd, 'skills'), { recursive: true });
  writeFileSync(join(cwd, REGISTRO), `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
}
const tabelaDe = (reg, tipo) => (tipo === 'skill' ? reg.skills : reg.best_practices);
const criadaNoRegistro = (p) => Boolean(p) && (p.origem === 'criada' || !p.de);

/** O que o depósito ligado ao projeto declara, e onde lê cada arquivo (ou null sem depósito). */
function doPacote(cwd) {
  const deposito = ligacaoDoProjeto(cwd)?.deposito;
  const mapa = deposito && existsSync(deposito) ? arquivosDoDeposito(deposito) : null;
  return { deposito, mapa: mapa || new Map() };
}
const caminhoDe = (tipo, id, rel = null) => (tipo === 'skill' ? `skills/${id}/${rel}` : `_legalsquad/core/best-practices/${id}.md`);
const declaradaPeloPacote = (pac, tipo, id) => (tipo === 'skill' ? pac.mapa.has(caminhoDe('skill', id, 'SKILL.md')) : pac.mapa.has(caminhoDe('bp', id)));

/** Arquivos (relativos) de uma skill no disco, sem seguir atalho; `.bak` do sync fica de fora. */
function arquivosNoDisco(dir) {
  const saida = new Map();
  const atalhos = [];
  const andar = (sub) => {
    let entradas;
    try { entradas = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.name.startsWith('.') || /\.bak(?:\.\d+)?$/.test(e.name)) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { atalhos.push(rel); continue; }
      if (e.isDirectory()) andar(rel);
      else if (e.isFile()) saida.set(rel, join(dir, rel));
    }
  };
  andar('');
  return { arquivos: saida, atalhos };
}

/**
 * Os arquivos do pacote para a skill `id` (rel → texto), lidos no depósito; null se o pacote não a
 * tem. `alterados`: arquivo do depósito cujo conteúdo não é o que o pacote registrou (alguém deu
 * permissão de escrita e editou por dentro, revisão v3, M6): a edição vale para todos os projetos
 * da máquina e o modelo não tem como separá-la do pacote.
 */
function versaoDoPacote(cwd, tipo, id, pac = doPacote(cwd)) {
  const arquivos = {};
  const alterados = [];
  let pacote = null;
  const prefixo = tipo === 'skill' ? `skills/${id}/` : null;
  for (const [path, info] of pac.mapa) {
    if (tipo === 'skill' ? !path.startsWith(prefixo) : path !== caminhoDe('bp', id)) continue;
    let buf;
    try { buf = readFileSync(join(pac.deposito, ...path.split('/'))); } catch { continue; }
    pacote = info.pack_id;
    if (info.sha256 && sha(buf) !== info.sha256) {
      // O mesmo caminho publicado por dois pacotes: vale o conteúdo de qualquer um deles.
      pac.donos ||= donosDosArquivosDoDeposito(pac.deposito) || new Map();
      const h = sha(buf);
      if (!(pac.donos.get(path) || []).some((d) => d.sha256 === h)) alterados.push(path);
    }
    const t = comoTexto(buf);
    if (t === null) continue;
    arquivos[tipo === 'skill' ? path.slice(prefixo.length) : `${id}.md`] = t;
  }
  return pacote ? { pacote, arquivos, alterados } : null;
}

/** Ids de skill no frontmatter `skills: [...]` de um agente (o que o runner injeta). */
export function skillsDoFrontmatter(texto) {
  const m = /^skills:\s*\[([^\]]*)\]/m.exec(String(texto).split('\n---')[0] || '');
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** Skills e best-practices que o squad usa: o desenho e o frontmatter dos agentes (que o compilador gera do desenho, mas o advogado pode ter editado). */
export function usadasPeloSquad(dirSquad, design) {
  const skills = new Set();
  const bps = new Set();
  for (const a of lista(design?.agents)) {
    for (const s of lista(a?.skills)) skills.add(String(s));
    for (const b of lista(a?.best_practices)) bps.add(String(b));
  }
  for (const s of lista(design?.squad?.skills)) skills.add(String(s));
  for (const b of lista(design?.squad?.best_practices)) bps.add(String(b));
  let agentes = [];
  try { agentes = readdirSync(join(dirSquad, 'agents')).filter((f) => f.endsWith('.agent.md')); } catch { /* sem agentes */ }
  for (const f of agentes) {
    let t;
    try { t = readFileSync(join(dirSquad, 'agents', f), 'utf8'); } catch { continue; }
    for (const s of skillsDoFrontmatter(t) || []) skills.add(s);
  }
  for (const s of [...skills]) if (NATIVAS.has(s) || !RE_ID.test(s)) skills.delete(s);
  for (const b of [...bps]) if (!RE_ID.test(b)) bps.delete(b);
  return { skills: [...skills].sort(), bps: [...bps].sort() };
}

/**
 * Skills citadas só no texto dos agentes e dos passos ("carregar a skill `tabela-da-casa`") que
 * existem nesta pasta e não são de pacote: o agente as usa e elas têm de ir junto (revisão v3, M5).
 */
export function skillsCitadasNoTexto(cwd, textos, jaUsadas = []) {
  const pac = doPacote(cwd);
  const ja = new Set(jaUsadas);
  const achadas = new Set();
  for (const t of textos) {
    for (const m of String(t).matchAll(/`([a-z0-9][a-z0-9-]{2,80})`/g)) {
      const id = m[1];
      if (ja.has(id) || achadas.has(id) || NATIVAS.has(id)) continue;
      if (!existsSync(join(cwd, 'skills', id, 'SKILL.md')) && !existsSync(join(cwd, 'skills', id, 'SKILL.local.md'))) continue;
      if (declaradaPeloPacote(pac, 'skill', id)) continue;
      achadas.add(id);
    }
  }
  return [...achadas].sort();
}

/** Impressão de uma entrada do modelo: o que o escritório escreveu, sem o id que ela tinha na pasta de origem. */
export function impressaoDaEntrada(e) {
  const resto = { ...(e || {}) };
  delete resto.no_squad;
  delete resto.binarios;
  delete resto.da_pasta;
  return hashDe(canonico(resto));
}

/**
 * Classifica e captura as skills e best-practices do squad que precisam viajar. Devolve as entradas
 * de `skills.json` (sem gravar nada), o que não pôde ir, com o motivo, e os avisos.
 * `extras`: skills citadas no texto (M5), capturadas como as do desenho.
 */
export function capturarSkills(cwd, dirSquad, design, { extras = [] } = {}) {
  const pac = doPacote(cwd);
  const reg = registro(cwd);
  const usadas = usadasPeloSquad(dirSquad, design);
  for (const x of extras) if (!usadas.skills.includes(x)) usadas.skills.push(x);
  const entradas = [];
  const naoViaja = [];
  const avisos = [];
  // Sem depósito ligado não há como saber o que é do pacote: levar tudo levaria o catálogo inteiro
  // da área como "criado aqui". Nada vai, e o chefe diz por quê. As do escritório (registradas)
  // continuam indo, porque a procedência delas está no registro.
  if (!pac.mapa.size) {
    const soDoEscritorio = [...usadas.skills.filter((id) => reg.skills[id]), ...usadas.bps.filter((id) => reg.best_practices[id])];
    if (usadas.skills.length + usadas.bps.length > soDoEscritorio.length) naoViaja.push({ arquivo: 'skills/', motivo: 'esta pasta não está ligada ao depósito da máquina (npx legalsquad acervo ligar): não dá para separar as skills criadas aqui das do pacote, e elas não vão com o modelo' });
    if (!soDoEscritorio.length) return { entradas, naoViaja, avisos };
  }
  const itens = [...usadas.skills.map((id) => ['skill', id]), ...usadas.bps.map((id) => ['bp', id])];
  const ligadaEm = momentoDaLigacao(cwd);
  const defasadas = [];
  for (const [tipo, idNoDisco] of itens) {
    const procedencia = tabelaDe(reg, tipo)[idNoDisco] || null;
    if (!pac.mapa.size && !procedencia) continue;
    const criada = criadaNoRegistro(procedencia);
    const idDoPacote = criada ? null : (procedencia?.de || idNoDisco);
    // O que está no disco (a camada `SKILL.local.md` é a que vale: o catálogo a põe na frente).
    const efetivos = {};
    let binarios = 0;
    let local = false;
    if (tipo === 'skill') {
      const dir = join(cwd, 'skills', idNoDisco);
      if (!existsSync(join(dir, 'SKILL.md')) && !existsSync(join(dir, 'SKILL.local.md'))) continue;
      const { arquivos, atalhos } = arquivosNoDisco(dir);
      for (const a of atalhos) naoViaja.push({ arquivo: `skills/${idNoDisco}/${a}`, motivo: 'atalho (link simbólico): não é seguido' });
      for (const [rel, abs] of arquivos) {
        const t = comoTexto(readFileSync(abs));
        if (t === null) { binarios++; naoViaja.push({ arquivo: `skills/${idNoDisco}/${rel}`, motivo: 'arquivo que não é texto: não viaja com o modelo' }); continue; }
        efetivos[rel] = t;
      }
      if (efetivos['SKILL.local.md'] !== undefined) { efetivos['SKILL.md'] = efetivos['SKILL.local.md']; delete efetivos['SKILL.local.md']; local = true; }
    } else {
      const abs = join(cwd, PASTA_BP, `${idNoDisco}.md`);
      if (!existsSync(abs)) continue;
      const t = comoTexto(readFileSync(abs));
      if (t === null) continue;
      // A chave é a do pacote dos dois lados: com o id do disco (`esc-x.md`) contra o do pacote
      // (`x.md`), a best-practice do escritório virava "tirada e acrescentada" inteira (M3).
      efetivos[`${idDoPacote || idNoDisco}.md`] = t;
    }
    let base = null;
    if (!criada) {
      base = versaoDoPacote(cwd, tipo, idDoPacote, pac);
      for (const p of base?.alterados || []) avisos.push(`${p}: o arquivo do depósito da máquina não é o que o pacote publicou (alguém o editou por dentro, e a edição vale para todos os projetos desta máquina); a mudança não se separa do pacote e não vai com o modelo. Para restaurar, rode \`npx legalsquad acervo sync\`; para personalizar, use SKILL.local.md`);
      // A diferença é tirada contra a base sobre a qual a skill do escritório foi montada (gravada no
      // registro), não contra a versão de hoje do curador: o que o curador mudou depois não é
      // mudança do escritório (M4).
      const guardada = procedencia?.base && typeof procedencia.base === 'object' ? procedencia.base : null;
      const guardadaLocal = local ? reg.locais[idNoDisco]?.base : null;
      if (base && guardada) base = { ...base, arquivos: { ...base.arquivos, ...guardada } };
      else if (base && guardadaLocal && typeof guardadaLocal['SKILL.md'] === 'string') base = { ...base, arquivos: { ...base.arquivos, 'SKILL.md': guardadaLocal['SKILL.md'] } };
    }
    if (!base) {
      // Criada no projeto (ou do escritório sem o pacote de onde veio): vai inteira, com o id que
      // tinha no modelo (a `regras-da-casa-2` que entrou com sufixo volta a ser `regras-da-casa`).
      const total = Object.values(efetivos).reduce((n, t) => n + Buffer.byteLength(t), 0);
      if (total > LIMITE_POR_SKILL) { naoViaja.push({ arquivo: caminhoDe(tipo, idNoDisco, ''), motivo: 'skill grande demais para um modelo' }); continue; }
      const id = criada && procedencia?.nome && RE_ID.test(procedencia.nome) ? procedencia.nome : idNoDisco;
      const arquivos = {};
      for (const [rel, t] of Object.entries(efetivos)) arquivos[tipo === 'bp' ? `${id}.md` : rel] = tipo === 'skill' && rel === 'SKILL.md' ? comNome(t, id) : t;
      entradas.push({ tipo, id, no_squad: idNoDisco, modo: 'inteira', arquivos, ...(binarios ? { binarios } : {}) });
      continue;
    }
    // De pacote: compara com a versão do pacote, com o `name:` já trocado para o id do escritório.
    const id = `esc-${idDoPacote}`;
    const nomeado = (rel, t) => (tipo === 'skill' && rel === 'SKILL.md' ? comNome(t, id) : t);
    const mudados = {};
    const novos = {};
    const removidos = [];
    for (const [rel, t] of Object.entries(efetivos)) {
      if (doContrato(tipo, rel)) continue;
      const b = base.arquivos[rel];
      if (b === undefined) { novos[rel] = nomeado(rel, t); continue; }
      const bn = nomeado(rel, b);
      const tn = nomeado(rel, t);
      if (semFimDeLinha(bn) === semFimDeLinha(tn)) continue;
      mudados[rel] = { base: sha(bn), trechos: trechosEntre(bn, tn), inteiro: tn };
    }
    for (const rel of Object.keys(base.arquivos)) if (efetivos[rel] === undefined && !doContrato(tipo, rel) && !(tipo === 'skill' && rel === 'SKILL.md')) removidos.push(rel);
    if (!Object.keys(mudados).length && !Object.keys(novos).length && !removidos.length) {
      if (procedencia) entradas.push({ tipo, id, no_squad: idNoDisco, de: idDoPacote, pacote: base.pacote, modo: 'diferenca', mudados, novos, removidos });
      continue; // de pacote intocada: vem do sync
    }
    // Arquivo de pacote que ninguém tocou desde a ligação e difere do depósito: a pasta ainda não
    // foi religada depois do sync, e a diferença é do curador (a versão nova), não do escritório. Era
    // levada como "mudança do escritório" que desfazia o texto novo do curador (revisão v3, M4).
    if (!procedencia && !local && ligadaEm !== null) {
      const onde = (rel) => (tipo === 'skill' ? join(cwd, 'skills', idNoDisco, rel) : join(cwd, PASTA_BP, `${idNoDisco}.md`));
      const velho = (abs) => { try { return lstatSync(abs).mtimeMs <= ligadaEm + 1000; } catch { return true; } };
      const tocados = [...Object.keys(mudados), ...Object.keys(novos)];
      const pastaVelha = tipo !== 'skill' || velho(join(cwd, 'skills', idNoDisco));
      if (tocados.every((rel) => velho(onde(rel))) && (tocados.length || pastaVelha)) { defasadas.push(idNoDisco); continue; }
    }
    // `da_pasta`: a skill do pacote editada no lugar (ou pela camada local), que vale para todos os
    // squads desta pasta; a `esc-x` registrada é deste squad (M1).
    entradas.push({ tipo, id, no_squad: idNoDisco, de: idDoPacote, pacote: base.pacote, modo: 'diferenca', mudados, novos, removidos: removidos.sort(), ...(procedencia ? {} : { da_pasta: true }) });
  }
  if (defasadas.length) avisos.push(`esta pasta tem ${defasadas.length} skill(s) do pacote numa versão anterior à do depósito (${defasadas.slice(0, 4).join(', ')}): a pasta não foi religada depois do último sync, e isso não é mudança do escritório; rode \`npx legalsquad acervo ligar\``);
  // A versão do escritório registrada (`esc-x`) é a que o squad usa: a mesma skill do pacote editada
  // no lugar, usada por quem confere, não vira uma segunda `esc-x`.
  const doEscritorio = new Set(entradas.filter((e) => !e.da_pasta).map((e) => `${e.tipo}:${e.id}`));
  return { entradas: entradas.filter((e) => !e.da_pasta || !doEscritorio.has(`${e.tipo}:${e.id}`)), naoViaja, avisos };
}

/** A entrada como ela vai para `skills.json`: sem o id da pasta de origem nem a marca de "da pasta". */
export function paraOModelo(entradas) {
  return lista(entradas).map((x) => { const e = { ...x }; delete e.no_squad; delete e.da_pasta; return e; });
}

/** Textos das skills que vão, para a varredura de sigilo: a criada inteira, a editada só no que mudou, e o id e os nomes de arquivo (A3). */
export function textosDasSkills(entradas) {
  const t = {};
  const legivel = (s) => String(s).replace(/[-_/.]+/g, ' ');
  for (const e of lista(entradas)) {
    const rotulo = e.tipo === 'skill' ? `skill ${e.id}` : `best-practice ${e.id}`;
    t[`${rotulo}: nome`] = legivel(e.id);
    const rels = e.modo === 'inteira' ? Object.keys(e.arquivos || {}) : [...Object.keys(e.mudados || {}), ...Object.keys(e.novos || {}), ...lista(e.removidos)];
    if (rels.length) t[`${rotulo}: nomes de arquivo`] = rels.map(legivel).join('\n');
    if (e.modo === 'inteira') for (const [rel, x] of Object.entries(e.arquivos || {})) t[`${rotulo}: ${rel}`] = x;
    else {
      for (const [rel, x] of Object.entries(e.mudados || {})) t[`${rotulo}: ${rel}`] = lista(x.trechos).flatMap((y) => lista(y.inserir)).join('\n');
      for (const [rel, x] of Object.entries(e.novos || {})) t[`${rotulo}: ${rel} (novo)`] = x;
    }
  }
  return t;
}

const semFrontmatter = (t) => { const s = String(t); if (!s.startsWith('---')) return s; const fim = s.indexOf('\n---', 3); return fim < 0 ? s : s.slice(fim + 4); };
const curta = (l) => { const s = String(l).trim(); return s.length > 200 ? `${s.slice(0, 197)}…` : s; };

/** As linhas que o advogado lê de uma entrada: o que o escritório escreveu (A6). */
export function linhasDaEntrada(e, limite = 25) {
  const L = [];
  if (e.modo === 'inteira') {
    const rels = Object.keys(e.arquivos || {}).sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
    for (const rel of rels) {
      if (rel !== 'SKILL.md' && e.tipo === 'skill') L.push(`(arquivo ${rel})`);
      for (const l of semFrontmatter(e.arquivos[rel]).split('\n')) if (l.trim()) L.push(curta(l));
    }
  } else {
    for (const [rel, x] of Object.entries(e.mudados || {})) {
      for (const t of lista(x.trechos)) {
        const ins = lista(t.inserir).filter((l) => l.trim() && !/^name:/.test(l));
        const rem = lista(t.remover).filter((l) => l.trim() && !/^name:/.test(l));
        if (ins.length) for (const l of ins) L.push(curta(rel === 'SKILL.md' ? l : `${rel}: ${l}`));
        else for (const l of rem) L.push(curta(`(tirado) ${rel === 'SKILL.md' ? '' : `${rel}: `}${l}`));
      }
    }
    for (const [rel, x] of Object.entries(e.novos || {})) L.push(curta(`(arquivo novo ${rel}) ${String(x).split('\n').find((l) => l.trim() && !/^---/.test(l)) || ''}`));
    for (const rel of lista(e.removidos)) L.push(`(arquivo tirado ${rel})`);
  }
  return L.length > limite ? [...L.slice(0, limite), `(e mais ${L.length - limite} linha(s))`] : L;
}

/** O que o advogado lê na prévia sobre cada skill: de onde vem e a regra do escritório, em linguagem simples (A6). */
export function skillsParaLer(entradas) {
  return lista(entradas).map((e) => {
    const nome = e.tipo === 'skill' ? 'skill' : 'best-practice';
    const linhas = linhasDaEntrada(e);
    if (e.modo === 'inteira') {
      const n = Object.keys(e.arquivos || {}).length;
      return { id: e.id, tipo: e.tipo, modo: 'inteira', como: 'criada', o_que: `${nome} criada no escritório${n > 1 ? ` (${n} arquivos)` : ''}: vai inteira`, linhas };
    }
    const n = Object.keys(e.mudados || {}).length + Object.keys(e.novos || {}).length + lista(e.removidos).length;
    // A regra é a primeira linha com conteúdo, não o título da seção que o escritório abriu.
    const regra = (linhas.find((l) => !l.startsWith('(') && !/^#+\s/.test(l)) || linhas.find((l) => !l.startsWith('(')) || '').replace(/^[-*]\s+/, '') || null;
    const oQue = !n
      ? `a ${nome} «${e.de}» do pacote, na versão do escritório (${e.id}), sem mudança nova`
      : `a ${nome} «${e.de}» do pacote, com ${regra ? `a regra do escritório «${regra}»` : 'mudança do escritório'}${linhas.length > 1 ? ` (e mais ${linhas.length - 1} linha(s))` : ''}; no squad novo ela entra como ${e.id}, e a do pacote fica como está para os outros squads${e.da_pasta ? '. Esta mudança foi feita na skill do pacote e vale hoje para todos os squads desta pasta' : ''}`;
    return { id: e.id, de: e.de, tipo: e.tipo, modo: 'diferenca', como: 'diferenca', o_que: oQue, linhas, ...(e.da_pasta ? { da_pasta: true } : {}) };
  });
}

// ───────────────────────── validar o que veio de fora ─────────────────────────

export function validarSkills(doc) {
  if (!doc || typeof doc !== 'object' || Number(doc.formato) !== 1 || !Array.isArray(doc.skills)) return 'skills.json fora do formato';
  if (doc.skills.length > LIMITE_DE_SKILLS) return `o modelo traz ${doc.skills.length} skills, acima do limite de ${LIMITE_DE_SKILLS} por modelo`;
  const ids = new Set();
  for (const e of doc.skills) {
    if (!e || !['skill', 'bp'].includes(e.tipo) || typeof e.id !== 'string' || !RE_ID.test(e.id)) return 'skill com tipo ou id fora do formato';
    if (ids.has(`${e.tipo}:${e.id}`)) return `a skill ${e.id} aparece duas vezes`;
    ids.add(`${e.tipo}:${e.id}`);
    // `no_squad` é só o nome que a skill tinha na pasta de origem; apontado para outra skill, ele
    // trocava no squad novo a skill de conferência por texto de fora (revisão v3, A1).
    if (e.no_squad !== undefined && !(typeof e.no_squad === 'string' && (e.no_squad === e.id || (e.modo === 'diferenca' && e.no_squad === e.de)))) return `skill ${e.id}: o nome na pasta de origem (no_squad) não é o da própria skill`;
    const textos = [];
    if (e.modo === 'inteira') {
      if (e.de !== undefined) return `skill ${e.id}: a skill criada no escritório não substitui skill de pacote (tem «de»)`;
      if (!e.arquivos || typeof e.arquivos !== 'object' || !Object.keys(e.arquivos).length) return `skill ${e.id} sem arquivos`;
      if (e.tipo === 'skill' && typeof e.arquivos['SKILL.md'] !== 'string') return `skill ${e.id} sem SKILL.md`;
      if (e.tipo === 'bp' && Object.keys(e.arquivos).some((r) => r !== `${e.id}.md`)) return `best-practice ${e.id} fora do formato`;
      for (const [rel, t] of Object.entries(e.arquivos)) { if (!relSeguro(rel) || typeof t !== 'string') return `skill ${e.id}: arquivo fora do formato (${rel})`; textos.push(t); }
    } else if (e.modo === 'diferenca') {
      if (typeof e.de !== 'string' || !RE_ID.test(e.de) || !new RegExp(`^esc-${escaparRe(e.de)}(?:-\\d+)?$`).test(e.id)) return `skill ${e.id}: a versão do escritório de uma skill de pacote tem o id «esc-<id da skill do pacote>»`;
      const relDaBp = (rel) => e.tipo !== 'bp' || rel === `${e.de}.md`;
      for (const [rel, x] of Object.entries(e.mudados || {})) {
        if (!relSeguro(rel) || !relDaBp(rel) || !x || typeof x.inteiro !== 'string' || !Array.isArray(x.trechos)) return `skill ${e.id}: mudança fora do formato (${rel})`;
        for (const t of x.trechos) if (!t || !['antes', 'remover', 'inserir', 'depois'].every((k) => Array.isArray(t[k]) && t[k].every((l) => typeof l === 'string'))) return `skill ${e.id}: trecho fora do formato`;
        textos.push(x.inteiro);
      }
      for (const [rel, t] of Object.entries(e.novos || {})) { if (!relSeguro(rel) || !relDaBp(rel) || typeof t !== 'string') return `skill ${e.id}: arquivo novo fora do formato (${rel})`; textos.push(t); }
      if (!lista(e.removidos).every((r) => relSeguro(r) && r !== 'SKILL.md')) return `skill ${e.id}: arquivo tirado fora do formato`;
    } else return `skill ${e.id}: modo desconhecido`;
    if (textos.some((t) => Buffer.byteLength(t) > LIMITE_POR_ARQUIVO)) return `skill ${e.id}: arquivo acima de ${LIMITE_POR_ARQUIVO / 1e6} MB`;
    if (textos.reduce((n, t) => n + Buffer.byteLength(t), 0) > LIMITE_POR_SKILL) return `skill ${e.id}: acima de ${LIMITE_POR_SKILL / 1e6} MB`;
  }
  return null;
}

/**
 * O que só se confere dentro de um projeto: skill criada com o id de uma skill de pacote (entrava
 * como `x-2` e tomava o lugar da do pacote no desenho, A1) e a versão do escritório de uma skill
 * ou best-practice de gate. `gate` vem do desenho do modelo da área (`skillsDeGate`).
 */
export function conferirSkillsNoProjeto(cwd, doc, gate = null) {
  const pac = doPacote(cwd);
  for (const e of lista(doc?.skills)) {
    const nome = e.tipo === 'skill' ? 'skill' : 'best-practice';
    if (e.modo === 'inteira' && declaradaPeloPacote(pac, e.tipo, e.id)) return `a ${nome} criada «${e.id}» tem o id de uma ${nome} de pacote: no squad novo ela tomaria o lugar da do pacote`;
    if (e.modo === 'diferenca' && ehDeGate(e.tipo, e.de, gate)) return `o modelo muda a ${nome} «${e.de}», que é de conferência, de ética ou de sigilo (ou só os agentes que conferem a usam): o modelo do escritório não mexe nos gates`;
  }
  return null;
}

// ───────────────────────── instalar no projeto ─────────────────────────

/** Conteúdo que a entrada gera neste projeto (rel → texto), ou o erro. `base`: os arquivos do pacote usados. */
function montar(cwd, e, idFinal, pac) {
  const avisos = [];
  // Os arquivos do contrato citam o id da skill (`$x` no openai.yaml): saem com o id que ela tem aqui.
  const doContratoComId = (rel, t, de) => (doContrato(e.tipo, rel) ? trocarId(t, de, idFinal) : t);
  if (e.modo === 'inteira') {
    const arquivos = {};
    for (const [rel, t] of Object.entries(e.arquivos)) arquivos[e.tipo === 'bp' ? `${idFinal}.md` : rel] = e.tipo === 'skill' && rel === 'SKILL.md' ? comNome(t, idFinal) : doContratoComId(rel, t, e.id);
    return { arquivos, avisos };
  }
  const base = versaoDoPacote(cwd, e.tipo, e.de, pac);
  if (!base) return { erro: `a ${e.tipo === 'skill' ? 'skill' : 'best-practice'} ${e.de} do pacote não está nesta pasta: ligue a área que a traz (npx legalsquad acervo areas)` };
  const nomeado = (rel, t) => (e.tipo === 'skill' && rel === 'SKILL.md' ? comNome(t, idFinal) : doContratoComId(rel, t, e.de));
  const arquivos = {};
  for (const [rel, t] of Object.entries(base.arquivos)) if (!lista(e.removidos).includes(rel)) arquivos[e.tipo === 'bp' ? `${idFinal}.md` : rel] = nomeado(rel, t);
  for (const [rel, x] of Object.entries(e.mudados || {})) {
    const chave = e.tipo === 'bp' ? `${idFinal}.md` : rel;
    const atual = arquivos[chave];
    // A diferença reaplicada sobre a versão de hoje do pacote leva a melhoria do curador; o que não
    // reaplica fica com o arquivo do escritório inteiro, dito.
    // Os trechos foram tirados com o `name:` do id de origem; aqui o id pode ser outro (esc-x-2).
    const nome = (l) => (e.tipo === 'skill' && rel === 'SKILL.md' && /^name:/.test(l) ? `name: ${idFinal}` : l);
    const r = atual === undefined ? { conflitos: [1] } : aplicarTrechos(atual, x.trechos.map((t) => ({ ...t, antes: t.antes.map(nome), remover: t.remover.map(nome), inserir: t.inserir.map(nome), depois: t.depois.map(nome) })));
    if (r.conflitos.length) {
      arquivos[chave] = nomeado(rel, x.inteiro);
      if (atual === undefined || sha(atual) !== x.base) avisos.push(`${e.tipo === 'skill' ? 'skill' : 'best-practice'} ${e.de}: o pacote mudou ${rel} no ponto que o escritório tinha mudado; ficou o arquivo do escritório inteiro`);
    } else arquivos[chave] = nomeado(rel, r.texto);
  }
  for (const [rel, t] of Object.entries(e.novos || {})) arquivos[e.tipo === 'bp' ? `${idFinal}.md` : rel] = nomeado(rel, t);
  return { arquivos, avisos, pacote: base.pacote, base: base.arquivos };
}

/** O que está no disco para o id (rel → texto; arquivo que não é texto fica de fora), ou null quando não existe. */
function noDisco(cwd, tipo, id) {
  if (tipo === 'bp') {
    const abs = join(cwd, PASTA_BP, `${id}.md`);
    try { return lstatSync(abs).isFile() ? { [`${id}.md`]: readFileSync(abs, 'utf8') } : {}; } catch { return null; }
  }
  const dir = join(cwd, 'skills', id);
  if (!existsSync(dir)) return null;
  const out = {};
  for (const [rel, abs] of arquivosNoDisco(dir).arquivos) { const t = comoTexto(readFileSync(abs)); if (t !== null) out[rel] = t; }
  if (out['SKILL.local.md'] !== undefined) { out['SKILL.md'] = out['SKILL.local.md']; delete out['SKILL.local.md']; }
  return out;
}
/** Mesmo conteúdo, fora os arquivos que o contrato gera e o espaço no fim das linhas (A5). */
function mesmos(tipo, a, b) {
  const chaves = (o) => Object.keys(o).filter((k) => !doContrato(tipo, k)).sort();
  const ka = chaves(a);
  const kb = chaves(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && semFimDeLinha(a[k]) === semFimDeLinha(b[k]));
}

/**
 * Quem usa a skill nesta pasta: os squads cujo desenho ou frontmatter a declaram, com o modelo de
 * onde cada um nasceu. É o que decide se a versão nova do modelo pode atualizar a skill (só os
 * squads daquele modelo a usam) ou se a daqui fica (outro squad depende dela).
 */
export function quemUsa(cwd, tipo, id) {
  const squadsDir = join(cwd, 'squads');
  let entradas;
  try { entradas = readdirSync(squadsDir, { withFileTypes: true }); } catch { return []; }
  const re = new RegExp(`(?<![A-Za-z0-9-])${escaparRe(id)}(?![A-Za-z0-9-])`);
  const saida = [];
  for (const e of entradas) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const dir = join(squadsDir, e.name);
    let usa = false;
    try { usa = re.test(readFileSync(join(dir, '_build', 'design.yaml'), 'utf8')); } catch { /* sem desenho */ }
    if (!usa && tipo === 'skill') {
      try { usa = readdirSync(join(dir, 'agents')).some((f) => f.endsWith('.agent.md') && (skillsDoFrontmatter(readFileSync(join(dir, 'agents', f), 'utf8')) || []).includes(id)); } catch { /* sem agentes */ }
    }
    if (!usa && tipo === 'bp') { try { usa = re.test(readFileSync(join(dir, 'squad.yaml'), 'utf8')); } catch { /* sem squad.yaml */ } }
    if (usa) saida.push({ code: e.name, modelo: lerJson(join(dir, '_build', 'modelo-origem.json'))?.modelo || null });
  }
  return saida;
}

/**
 * O plano de instalação das skills de um modelo neste projeto, sem gravar nada. Para cada entrada,
 * o id que ela terá aqui, pela linhagem (A5):
 * - id livre: entra com o id do modelo;
 * - a skill daqui tem o mesmo conteúdo: é ela (sem aviso);
 * - a daqui é da mesma linhagem (a mesma skill do pacote, ou a mesma criada, vinda deste modelo) e
 *   o modelo não mudou desde que ela entrou: é ela, com o que a pasta fez nela (o contrato, uma
 *   edição local);
 * - mesma linhagem e o modelo mudou: a daqui é atualizada (a anterior fica guardada) quando só os
 *   squads deste modelo a usam; com outro squad usando, a daqui fica e o aviso diz por quê;
 * - outra origem com o mesmo id: a do modelo entra com o próximo id livre (`x-2`), dito.
 * `mapa`: ids do modelo → ids aqui (vale para todo agente); `mapaDoPacote`: skill do pacote → a do
 * escritório (vale só para os agentes que escrevem; quem confere fica com a do pacote, A1).
 */
export function planejarSkills(cwd, doc, { modelo = null, excluirSquad = null } = {}) {
  const pac = doPacote(cwd);
  const reg = registro(cwd);
  const plano = { instalar: [], mapa: { skills: {}, bps: {} }, mapaDoPacote: { skills: {}, bps: {} }, volta: { skills: {}, bps: {} }, avisos: [], erros: [], ids: { skills: [], bps: [] } };
  const reservados = new Set();
  for (const e of lista(doc?.skills)) {
    const nome = e.tipo === 'skill' ? 'skill' : 'best-practice';
    const tab = tabelaDe(reg, e.tipo);
    const entrada = impressaoDaEntrada(e);
    let escolha = null;
    for (let n = 1; n < 100; n++) {
      const cand = n === 1 ? e.id : `${e.id}-${n}`;
      if (reservados.has(`${e.tipo}:${cand}`)) continue;
      const m = montar(cwd, e, cand, pac);
      if (m.erro) { plano.erros.push({ id: e.id, motivo: m.erro }); escolha = 'erro'; break; }
      const existe = noDisco(cwd, e.tipo, cand);
      if (declaradaPeloPacote(pac, e.tipo, cand)) continue;
      if (existe === null) { escolha = { cand, m, acao: 'novo' }; break; }
      if (mesmos(e.tipo, existe, m.arquivos)) { escolha = { cand, m, acao: 'igual' }; break; }
      const r = tab[cand];
      const mesmaLinhagem = r && (e.modo === 'diferenca' ? r.de === e.de : criadaNoRegistro(r) && (r.nome || cand) === e.id);
      if (!mesmaLinhagem || (r.modelo && modelo && r.modelo !== modelo)) continue;
      if (r.entrada && r.entrada === entrada) { escolha = { cand, m, acao: 'daqui' }; break; }
      const outros = quemUsa(cwd, e.tipo, cand).filter((u) => u.code !== excluirSquad && (!modelo || u.modelo !== modelo));
      if (!outros.length) { escolha = { cand, m, acao: 'atualizar' }; break; }
      escolha = { cand, m, acao: 'daqui' };
      plano.avisos.push(`a ${nome} ${cand} desta pasta difere da que o modelo traz agora, e outro(s) squad(s) a usam (${outros.slice(0, 4).map((u) => u.code).join(', ')}): ela ficou como está, e o squad novo usa a daqui`);
      break;
    }
    if (escolha === 'erro') continue;
    if (!escolha) { plano.erros.push({ id: e.id, motivo: `não há id livre para a ${nome}` }); continue; }
    const { cand, m, acao } = escolha;
    reservados.add(`${e.tipo}:${cand}`);
    if (acao === 'novo' && cand !== e.id) plano.avisos.push(`já há nesta pasta uma ${nome} ${e.id}, de outra origem, diferente da do modelo: a do modelo entra como ${cand}, e o squad novo usa a do modelo (a daqui fica como está para os outros squads)`);
    if (acao === 'atualizar') plano.avisos.push(`a ${nome} ${cand} desta pasta foi atualizada com a versão que o modelo traz agora; a anterior fica guardada em skills/_escritorio/anteriores/`);
    plano.avisos.push(...(acao === 'novo' || acao === 'atualizar' ? m.avisos : []));
    const mapa = e.tipo === 'skill' ? plano.mapa.skills : plano.mapa.bps;
    mapa[e.id] = cand;
    if (e.modo === 'diferenca') (e.tipo === 'skill' ? plano.mapaDoPacote.skills : plano.mapaDoPacote.bps)[e.de] = cand;
    if (cand !== (e.modo === 'diferenca' ? e.de : e.id)) (e.tipo === 'skill' ? plano.volta.skills : plano.volta.bps)[cand] = e.modo === 'diferenca' ? e.de : e.id;
    (e.tipo === 'skill' ? plano.ids.skills : plano.ids.bps).push(cand);
    const registroNovo = { de: e.de || null, pacote: m.pacote || e.pacote || null, nome: e.id, modelo, entrada, base: e.modo === 'diferenca' ? m.base : null };
    if (acao === 'novo' || acao === 'atualizar') plano.instalar.push({ tipo: e.tipo, id: cand, arquivos: m.arquivos, atualizar: acao === 'atualizar', ...registroNovo });
    else if (!tab[cand]?.entrada) plano.instalar.push({ tipo: e.tipo, id: cand, soRegistro: true, ...registroNovo });
  }
  return plano;
}

const entradaDoRegistro = (s) => ({
  ...(s.de ? { de: s.de, pacote: s.pacote, origem: 'pacote' } : { origem: 'criada' }),
  ...(s.nome && s.nome !== s.id ? { nome: s.nome } : {}),
  ...(s.modelo ? { modelo: s.modelo } : {}),
  ...(s.entrada ? { entrada: s.entrada } : {}),
  ...(s.base ? { base: s.base } : {}),
});

function guardarAnterior(cwd, s, hoje) {
  const destinoBase = join(cwd, ANTERIORES, `${s.tipo === 'bp' ? 'bp-' : ''}${s.id}-${hoje}`);
  let destino = destinoBase;
  for (let n = 2; existsSync(destino); n++) destino = `${destinoBase}-${n}`;
  mkdirSync(join(destino, '..'), { recursive: true });
  if (s.tipo === 'skill') renameSync(join(cwd, 'skills', s.id), destino);
  else { mkdirSync(destino, { recursive: true }); renameSync(join(cwd, PASTA_BP, `${s.id}.md`), join(destino, `${s.id}.md`)); }
}

/**
 * Grava o plano: cada skill numa pasta de trabalho e renomeada no fim (nada fica pela metade), a
 * anterior guardada quando é atualização, o registro com a linhagem e o índice das skills refeito
 * (M7: depois da importação o `check-skills` acusava `stale-index`).
 */
export function instalarSkills(cwd, plano, { hoje = new Date().toISOString().slice(0, 10) } = {}) {
  if (!plano.instalar.length) return [];
  const reg = registro(cwd);
  const feitas = [];
  for (const s of plano.instalar) {
    if (!s.soRegistro) {
      if (s.tipo === 'skill') {
        const tmp = join(cwd, 'skills', `.instalando-${s.id}-${process.pid}`);
        rmSync(tmp, { recursive: true, force: true });
        for (const [rel, t] of Object.entries(s.arquivos)) { mkdirSync(join(tmp, rel, '..'), { recursive: true }); writeFileSync(join(tmp, rel), t, 'utf8'); }
        if (s.atualizar && existsSync(join(cwd, 'skills', s.id))) guardarAnterior(cwd, s, hoje);
        renameSync(tmp, join(cwd, 'skills', s.id));
      } else {
        mkdirSync(join(cwd, PASTA_BP), { recursive: true });
        if (s.atualizar && existsSync(join(cwd, PASTA_BP, `${s.id}.md`))) guardarAnterior(cwd, s, hoje);
        writeFileSync(join(cwd, PASTA_BP, `${s.id}.md`), Object.values(s.arquivos)[0], 'utf8');
      }
      feitas.push(s.id);
    }
    tabelaDe(reg, s.tipo)[s.id] = entradaDoRegistro(s);
  }
  gravarRegistro(cwd, reg);
  if (feitas.some((id) => plano.instalar.find((s) => s.id === id)?.tipo === 'skill')) reindexar(cwd);
  return feitas;
}

function reindexar(cwd) {
  const dir = join(cwd, 'skills');
  try { gravarIndiceDeSkills(dir, discoverSkillCatalog(dir)); } catch { /* índice é conforto: a busca revarre sem ele */ }
}

/**
 * Na pasta de origem, depois de guardar: a procedência das skills que foram no modelo, para que o
 * squad criado dele aqui mesmo reconheça a skill como a mesma (sem `-2`, A5); e a edição feita no
 * lugar num SKILL.md de pacote passa para a camada `SKILL.local.md`, que o `update` e o `acervo
 * ligar` não tocam (A2: a edição ia para `.bak` na atualização seguinte e o squad do caso voltava a
 * rodar com a do pacote). A base de então fica guardada para a próxima diferença (M4).
 */
export function registrarNaOrigem(cwd, entradas, { modelo }) {
  const pac = doPacote(cwd);
  const reg = registro(cwd);
  const movidas = [];
  const noLugar = [];
  for (const e of lista(entradas)) {
    const tab = tabelaDe(reg, e.tipo);
    const idNoDisco = e.no_squad || e.id;
    const entrada = impressaoDaEntrada({ ...paraOModelo([e])[0] });
    if (e.modo === 'inteira') {
      const r = tab[idNoDisco];
      if (!r || (criadaNoRegistro(r) && (!r.modelo || r.modelo === modelo))) tab[idNoDisco] = { ...(r || {}), origem: 'criada', ...(e.id !== idNoDisco ? { nome: e.id } : {}), modelo, entrada };
      continue;
    }
    if (tab[idNoDisco]) { if (!tab[idNoDisco].modelo || tab[idNoDisco].modelo === modelo) tab[idNoDisco] = { ...tab[idNoDisco], modelo, entrada }; continue; }
    if (e.tipo !== 'skill') { noLugar.push(caminhoDe('bp', e.de)); continue; }
    const dir = join(cwd, 'skills', idNoDisco);
    const base = versaoDoPacote(cwd, 'skill', e.de, pac);
    const local = join(dir, 'SKILL.local.md');
    const pacote = join(dir, 'SKILL.md');
    if (base && e.mudados?.['SKILL.md'] && !existsSync(local)) {
      const origem = join(pac.deposito, 'skills', e.de, 'SKILL.md');
      try {
        writeFileSync(local, readFileSync(pacote, 'utf8'), 'utf8');
        rmSync(pacote, { force: true });
        try { linkSync(origem, pacote); } catch { copyFileSync(origem, pacote); }
        movidas.push(e.de);
      } catch { noLugar.push(`skills/${e.de}/SKILL.md`); }
    }
    if (base && existsSync(local) && !reg.locais[e.de]) reg.locais[e.de] = { pacote: base.pacote, base: { 'SKILL.md': base.arquivos['SKILL.md'] } };
    for (const rel of [...Object.keys(e.mudados || {}).filter((r) => r !== 'SKILL.md')]) noLugar.push(`skills/${e.de}/${rel}`);
  }
  gravarRegistro(cwd, reg);
  if (movidas.length) reindexar(cwd);
  return { movidas, no_lugar: noLugar };
}

/**
 * Troca, no desenho, os ids das skills e best-practices pelo que elas têm neste projeto. `mapa`
 * vale para todo agente (os ids do próprio modelo); `mapaDoPacote` (skill do pacote → versão do
 * escritório) só para os agentes que escrevem: o revisor e o conferente ficam com a do pacote, e
 * skill de gate não se troca em lugar nenhum (A1).
 */
export function aplicarMapaNoDesenho(design, mapa, { mapaDoPacote = null } = {}) {
  const doPac = mapaDoPacote || { skills: {}, bps: {} };
  const troca = (v, m, p, tipo) => lista(v).map((x) => {
    const k = String(x);
    if (m?.[k] !== undefined) return m[k];
    if (p && p[k] !== undefined && !ehDeGate(tipo, k)) return p[k];
    return x;
  });
  const d = structuredClone(design);
  for (const a of lista(d?.agents)) {
    const p = ehVerificador(a) ? null : doPac;
    if (a && Array.isArray(a.skills)) a.skills = troca(a.skills, mapa.skills, p?.skills, 'skill');
    if (a && Array.isArray(a.best_practices)) a.best_practices = troca(a.best_practices, mapa.bps, p?.bps, 'bp');
  }
  if (d?.squad && Array.isArray(d.squad.skills)) d.squad.skills = troca(d.squad.skills, mapa.skills, doPac.skills, 'skill');
  if (d?.squad && Array.isArray(d.squad.best_practices)) d.squad.best_practices = troca(d.squad.best_practices, mapa.bps, doPac.bps, 'bp');
  return d;
}

/** O inverso, para comparar o squad com o modelo da área: `esc-x` volta a ser `x`, e `regras-da-casa-2` volta a `regras-da-casa`. */
export function mapaDeVolta(cwd) {
  const reg = registro(cwd);
  const volta = (tab) => Object.fromEntries(Object.entries(tab).map(([id, v]) => [id, v?.de || v?.nome || null]).filter(([id, para]) => para && para !== id));
  return { skills: volta(reg.skills), bps: volta(reg.best_practices) };
}

/** O mesmo inverso no texto: o squad que aponta para a versão do escritório lê como o do modelo da área. */
export function voltaNoTexto(texto, ...mapas) {
  const pares = new Map();
  for (const m of mapas) for (const [a, b] of [...Object.entries(m?.skills || {}), ...Object.entries(m?.bps || {})]) if (a && b && a !== b) pares.set(a, b);
  if (!pares.size) return String(texto);
  const re = new RegExp(`(?<![A-Za-z0-9-])(${[...pares.keys()].sort((x, y) => y.length - x.length).map(escaparRe).join('|')})(?![A-Za-z0-9-])`, 'g');
  return String(texto).replace(re, (x) => pares.get(x));
}

/**
 * O texto do SKILL.md sem o que o `contract-skills` escreve (o frontmatter, que ele normaliza, e o
 * bloco do contrato): a pasta que contrata a skill criada não a transforma em "mudança do
 * escritório" (revisão v3, A5 e M2).
 */
const semOContrato = (rel, t) => (rel === 'SKILL.md' ? semFimDeLinha(semFrontmatter(t).replace(/<!-- LEGALSQUAD:HP-CONTRACT:START -->[\s\S]*?<!-- LEGALSQUAD:HP-CONTRACT:END -->/g, '')) : semFimDeLinha(t));

/** Impressão dos arquivos das skills do escritório e criadas que o squad usa (a oferta do runner). */
export function impressaoDasSkills(cwd, entradas) {
  const partes = [];
  for (const e of lista(entradas)) {
    const disco = noDisco(cwd, e.tipo, e.no_squad || e.id) || {};
    partes.push(`${e.tipo}:${e.no_squad || e.id}:${Object.keys(disco).filter((k) => !doContrato(e.tipo, k)).sort().map((k) => `${k}=${sha(semOContrato(k, disco[k]))}`).join(',')}`);
  }
  return sha(partes.sort().join('\n')).slice(0, 16);
}

/**
 * Skills que o modelo leva e o resolvedor do run bloquearia por falta de contrato (M8): a criada
 * no escritório nasce sem o bloco que o `contract-skills` escreve, e o run parava em
 * `quality-legacy-blocked` depois de a criação dizer "estrutura íntegra".
 */
export function semContrato(cwd, ids) {
  const saida = [];
  for (const id of lista(ids)) {
    const dir = join(cwd, 'skills', id);
    const arq = existsSync(join(dir, 'SKILL.local.md')) ? join(dir, 'SKILL.local.md') : join(dir, 'SKILL.md');
    let t;
    try { t = readFileSync(arq, 'utf8'); } catch { continue; }
    const meta = parseSkillMetadata(t, { fallbackName: id });
    if (!meta || String(meta.qualityStatus).toLowerCase() === 'legacy' || !t.includes('LEGALSQUAD:HP-CONTRACT:START')) saida.push(id);
  }
  return saida;
}
