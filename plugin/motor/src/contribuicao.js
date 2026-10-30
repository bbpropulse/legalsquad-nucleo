// Contribuição dos squads à plataforma da comunidade (decisão do dono de 26/09/2026).
//
// O squad que o aluno cria ou ajusta e que chega a um run aprovado melhora a plataforma de todos:
// a ESTRUTURA dele (agentes, passos, textos de instrução, skills do escritório) sobe para uma caixa
// de entrada privada no servidor do acervo, onde o dono faz curadoria, testa e só o aprovado vira
// modelo num pacote publicado pelo fluxo normal. Quatro decisões do dono moldam o desenho:
//
// - "O consentimento já é dado por contrato": não há pergunta nem opt-in. O aluno é informado numa
//   linha no onboarding e no README, e o envio é automático e silencioso.
// - "O squad chega só a estrutura": o que sobe é exatamente o modelo do escritório que o
//   `squad-modelo --exportar` levaria para esse squad (`contribuicaoDoSquad`, em
//   modelo-escritorio.js), no formato `.lsmodelos.json`. Autos, output, memória, estado do run,
//   `identificacao.json` e `caso.json` nunca entram, porque o modelo nunca os leva.
// - A varredura de sigilo roda antes, contra a pasta do caso, e BARRA: não há "aceitar achados" no
//   envio automático. O aluno recebe uma linha dizendo que aquele squad não foi enviado.
// - "Sem crédito": o envio não leva nome do aluno nem do escritório. O servidor recebe só um
//   identificador pseudônimo e estável da instalação (para deduplicar e barrar abuso).
//
// Nada disso pode atrapalhar o run: falha de rede não quebra nada, o squad fica pendente e vai no
// próximo momento seguro; o registro do que já foi (`_legalsquad/_memory/contribuicoes.json`) evita
// reenviar o mesmo conteúdo.
//
// Quando sai, em código (04/10/2026; antes o fim do run era uma instrução do runner, que dependia
// de o chefe lembrar): no `squad-state complete` de um run APROVADO (a parada `aprovacao`
// respondida com "Aprovar...", também na reabertura; ver `aprovacaoDoRun` em run-state.js), que
// roda `contribuir --fundo` pelo atalho do projeto sem esperar, e no `update`. Os dois chegam a
// `dispararEmSegundoPlano`. O aviso de squad barrado sai no `complete` seguinte.

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_ACESSO_ABERTO, resolverConfigDeAcervo } from './acervo-config.js';
import { contribuicaoDoSquad, pacoteDeModelos, provaDoRun } from './modelo-escritorio.js';
import { listarModelos } from './squad-modelo.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'legalsquad.js');

/** O mesmo teto do servidor: um modelo real tem dezenas de KB; o inteiro, perto de 200 KB. */
export const LIMITE_DO_ENVIO = 2 * 1024 * 1024;
const TEMPO_DA_REQUISICAO_MS = 10_000;
// Estados em que o squad só volta a ser olhado quando mudar. `pendente` (rede, servidor fora,
// limite do dia) volta sempre.
const FINAIS = new Set(['enviado', 'nada', 'barrado', 'ignorado', 'recusado']);

// ───────────────────────── ligada ou não ─────────────────────────
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para o
// `scripts/squad-state.mjs` e o `templates/scripts/squad-state.mjs`: o `complete` de um run
// aprovado dispara a contribuição em segundo plano e diz os avisos pendentes, e o script do projeto
// não tem `src/` para importar. Usa só `readFileSync`, `writeFileSync`, `renameSync`, `mkdirSync`,
// `statSync`, `dirname` e `join`, que as cópias importam.

// >>> contribuicao-ligada:begin
/** Onde fica o que já foi enviado, por projeto. É memória do projeto, nunca sai da máquina. */
const ARQUIVO_DO_REGISTRO = join('_legalsquad', '_memory', 'contribuicoes.json');
const TRAVA = join('_legalsquad', '_memory', '.contribuicoes.trava');
const DESLIGADO = /^(?:0|n|nao|não|no|false|off|desligad[oa])$/i;

/**
 * A contribuição vem ligada para o aluno. Desliga, para o dono e para instalação que não é da
 * comunidade, por qualquer um dos dois: `LEGALSQUAD_CONTRIBUIR=0` no ambiente (vale para a máquina
 * toda) ou `"contribuir": false` em `_legalsquad/config/acervo.json` (vale para a pasta).
 */
function contribuicaoLigada(cwd, { env = process.env } = {}) {
  if (typeof env.LEGALSQUAD_CONTRIBUIR === 'string' && DESLIGADO.test(env.LEGALSQUAD_CONTRIBUIR.trim())) {
    return { ligada: false, motivo: 'LEGALSQUAD_CONTRIBUIR desliga a contribuição nesta máquina' };
  }
  try {
    const bruto = JSON.parse(readFileSync(join(cwd, '_legalsquad', 'config', 'acervo.json'), 'utf8'));
    if (bruto && bruto.contribuir === false) return { ligada: false, motivo: '"contribuir": false em _legalsquad/config/acervo.json' };
  } catch { /* sem config: o padrão, ligada */ }
  return { ligada: true, motivo: null };
}

/**
 * Os squads barrados pela varredura de dado do caso que o aluno ainda não soube, uma vez cada:
 * devolve a lista e marca no registro que foram ditos. A passada em segundo plano não tem a quem
 * dizer; quem diz é o próximo `complete` (ou a próxima passada à vista). Com uma passada em curso
 * (a trava tem menos de dez minutos), não mexe no registro e devolve nada: ela o regrava no fim, e
 * o aviso sai na vez seguinte. Nunca falha.
 */
function avisosDaContribuicao(cwd) {
  try {
    try { if (Date.now() - statSync(join(cwd, TRAVA)).mtimeMs < 10 * 60_000) return []; } catch { /* sem passada em curso */ }
    const destino = join(cwd, ARQUIVO_DO_REGISTRO);
    const reg = JSON.parse(readFileSync(destino, 'utf8'));
    if (!reg || typeof reg.squads !== 'object' || !reg.squads) return [];
    const avisos = [];
    for (const [squad, x] of Object.entries(reg.squads)) {
      if (x?.estado !== 'barrado' || !x.avisar) continue;
      avisos.push({ squad, motivo: x.motivo || 'possível dado de caso' });
      x.avisar = false;
    }
    if (!avisos.length) return [];
    mkdirSync(dirname(destino), { recursive: true });
    const tmp = `${destino}.${process.pid}.avisos.tmp`;
    writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
    renameSync(tmp, destino);
    return avisos;
  } catch {
    return [];
  }
}

/** A linha que o chefe repete ao aluno, uma por squad barrado. */
const linhaDoAviso = (a) => `O squad «${a.squad}» não foi enviado à plataforma da comunidade: ${a.motivo}. Ele continua só nesta pasta.`;
// <<< contribuicao-ligada:end

export { ARQUIVO_DO_REGISTRO, avisosDaContribuicao, contribuicaoLigada, linhaDoAviso };

/**
 * O endereço da caixa de entrada: o mesmo servidor do catálogo, na rota das contribuições. HTTPS,
 * porque a licença vai no cabeçalho; `http` só para a própria máquina (testes, servidor local).
 */
export function urlDeContribuicoes(catalogUrl) {
  let u;
  try { u = new URL(String(catalogUrl)); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  u.pathname = `${u.pathname.replace(/\/v1\/catalog\/?$/, '').replace(/\/+$/, '')}/v1/contributions`;
  u.search = '';
  return u.toString();
}

// ───────────────────────── quem envia, sem dizer quem é ─────────────────────────

/**
 * Identificador pseudônimo e estável da instalação: nunca o nome, nunca a licença em claro. Com
 * licença nominal, o hash dela (a mesma pessoa em duas máquinas é uma só para o limite diário);
 * com o acesso aberto, que é o mesmo token em toda instalação, o hash de um número sorteado uma vez
 * por máquina e guardado em `~/.legalsquad/instalacao.json`.
 */
export function idDaInstalacao({ license, casa = homedir() } = {}) {
  const h = (t) => createHash('sha256').update(`legalsquad-contribuicao|${t}`).digest('hex').slice(0, 32);
  if (license && license !== TOKEN_ACESSO_ABERTO) return h(`licenca|${license}`);
  const arquivo = join(casa, '.legalsquad', 'instalacao.json');
  let sorteio = null;
  try { sorteio = JSON.parse(readFileSync(arquivo, 'utf8'))?.id || null; } catch { /* primeira vez */ }
  if (typeof sorteio !== 'string' || sorteio.length < 16) {
    sorteio = randomUUID();
    try {
      mkdirSync(dirname(arquivo), { recursive: true });
      writeFileSync(arquivo, `${JSON.stringify({ id: sorteio, criado_em: new Date().toISOString().slice(0, 10) }, null, 2)}\n`, 'utf8');
    } catch { /* sem casa gravável: o id vale só para esta vez */ }
  }
  return h(`instalacao|${sorteio}`);
}

// ───────────────────────── registro local ─────────────────────────

function lerRegistro(cwd) {
  try {
    const r = JSON.parse(readFileSync(join(cwd, ARQUIVO_DO_REGISTRO), 'utf8'));
    if (r && typeof r === 'object' && r.squads && typeof r.squads === 'object') return r;
  } catch { /* primeira vez, ou ilegível: começa de novo (o servidor deduplica) */ }
  return { formato: 1, squads: {} };
}

function gravarRegistro(cwd, reg) {
  const destino = join(cwd, ARQUIVO_DO_REGISTRO);
  mkdirSync(dirname(destino), { recursive: true });
  const tmp = `${destino}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
  renameSync(tmp, destino);
}

/**
 * Uma passada por vez por projeto: o disparo em segundo plano e o do fim do run podem coincidir.
 * Trava com mais de dez minutos é de um processo que morreu, e é retomada.
 */
function travar(cwd) {
  const arquivo = join(cwd, TRAVA);
  mkdirSync(dirname(arquivo), { recursive: true });
  try {
    closeSync(openSync(arquivo, 'wx'));
  } catch {
    try { if (Date.now() - statSync(arquivo).mtimeMs < 10 * 60_000) return null; } catch { return null; }
    try { writeFileSync(arquivo, ''); } catch { return null; }
  }
  return () => { try { rmSync(arquivo, { force: true }); } catch { /* já saiu */ } };
}

// ───────────────────────── o que mudou ─────────────────────────

// O que é do run ou do caso não entra na assinatura: um run novo muda a saída e o estado, não a
// estrutura do squad.
const FORA_DA_ASSINATURA = /^(?:output|_memory|autos|_evals\/results)(?:\/|$)|^(?:state|run-state|review-state|caso|identificacao)\.json$|^_build\/(?:salvo-como|oferta-de-modelo)\.json$/;

/**
 * Assinatura barata da estrutura do squad (caminho, tamanho e data de cada arquivo, e do registro
 * das skills do escritório): igual à da última passada, o squad não é montado nem varrido de novo.
 * É só um atalho; quem decide se o conteúdo mudou é a impressão do modelo.
 */
function assinaturaDoSquad(cwd, dir) {
  const linhas = [];
  const andar = (sub, prof = 0) => {
    let entradas;
    try { entradas = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.name.startsWith('.')) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (FORA_DA_ASSINATURA.test(rel)) continue;
      if (e.isDirectory()) { if (prof < 8) andar(rel, prof + 1); continue; }
      try { const st = statSync(join(dir, rel)); linhas.push(`${rel}|${st.size}|${Math.round(st.mtimeMs)}`); } catch { /* sumiu */ }
    }
  };
  andar('');
  for (const extra of [join('skills', '_escritorio.json'), join('_legalsquad', 'core', 'best-practices', '_catalog.yaml')]) {
    try { const st = statSync(join(cwd, extra)); linhas.push(`${extra}|${st.size}|${Math.round(st.mtimeMs)}`); } catch { /* não há */ }
  }
  return createHash('sha256').update(linhas.sort().join('\n')).digest('hex').slice(0, 24);
}

// ───────────────────────── envio ─────────────────────────

/**
 * Manda um `.lsmodelos.json` à caixa de entrada. Devolve `{ok, status, id, duplicada}` ou
 * `{ok: false, rede: true}`: quem chama decide se tenta de novo depois.
 */
export async function enviarContribuicao({ url, license, instalacao, corpo, tempoMs = TEMPO_DA_REQUISICAO_MS }) {
  let resposta;
  try {
    resposta = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${license}`,
        'Content-Type': 'application/json',
        'X-Legalsquad-Instalacao': instalacao,
      },
      body: corpo,
      signal: AbortSignal.timeout(tempoMs),
    });
  } catch {
    return { ok: false, rede: true, status: null };
  }
  let json = null;
  try { json = await resposta.json(); } catch { /* corpo que não é JSON */ }
  return { ok: resposta.ok, status: resposta.status, id: json?.id || null, duplicada: json?.duplicada === true };
}

/** O que o servidor respondeu vira estado: o que ele recusou por conteúdo não volta com o mesmo conteúdo. */
function estadoDaResposta(r) {
  if (r.ok) return 'enviado';
  if (r.rede || r.status === 429 || r.status === 401 || r.status === 403 || r.status === 404 || (r.status >= 500)) return 'pendente';
  return 'recusado';
}

// ───────────────────────── a passada ─────────────────────────

const hojeIso = (h) => h || new Date().toISOString().slice(0, 10);
const RE_CODE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Olha cada squad do projeto e manda o que é novo. Só entra squad com run aprovado (a prova de que
 * a estrutura funciona); o que não mudou desde a última passada nem é montado. Devolve o resumo,
 * sem conteúdo nenhum: `enviados`, `barrados_novos` (os que o aluno ainda não soube que ficaram), e
 * as contagens do resto.
 *
 * `silencioso` (a passada em segundo plano) não marca os barrados como avisados: a próxima passada
 * à vista diz a linha ao aluno.
 */
export async function contribuir(cwd, { env = process.env, casa = homedir(), hoje, enviar = enviarContribuicao, silencioso = false, squads = null } = {}) {
  const resumo = { success: true, ligada: true, enviados: [], ja_enviados: [], nada_a_enviar: [], barrados_novos: [], barrados: [], pendentes: [], recusados: [], ignorados: [] };
  const lig = contribuicaoLigada(cwd, { env });
  if (!lig.ligada) return { ...resumo, ligada: false, motivo: lig.motivo };
  if (!existsSync(join(cwd, 'squads'))) return resumo;
  let config;
  try { config = resolverConfigDeAcervo(cwd); } catch (e) { return { ...resumo, success: false, erro: e.message }; }
  const url = urlDeContribuicoes(config.catalogUrl);
  if (!url) return { ...resumo, success: false, erro: 'o endereço do servidor do acervo não é HTTPS: a contribuição não é enviada' };

  const soltar = travar(cwd);
  if (!soltar) return { ...resumo, em_andamento: true };
  try {
    const reg = lerRegistro(cwd);
    const dataDeHoje = hojeIso(hoje);
    const instalacao = idDaInstalacao({ license: config.license, casa });
    let todos = null;
    let semRede = false;
    let codes;
    try { codes = readdirSync(join(cwd, 'squads'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.') && RE_CODE.test(e.name)).map((e) => e.name).sort(); } catch { codes = []; }
    if (squads) codes = codes.filter((c) => squads.includes(c));
    for (const code of codes) {
      const dir = join(cwd, 'squads', code);
      const antes = reg.squads[code] || null;
      if (!provaDoRun(dir)) continue;
      const assinatura = assinaturaDoSquad(cwd, dir);
      if (antes && antes.assinatura === assinatura && FINAIS.has(antes.estado)) {
        if (antes.estado === 'enviado') resumo.ja_enviados.push(code);
        else if (antes.estado === 'barrado') resumo.barrados.push(code);
        else if (antes.estado === 'nada') resumo.nada_a_enviar.push(code);
        continue;
      }
      todos ||= listarModelos(cwd);
      let r;
      try { r = contribuicaoDoSquad(cwd, code, { todos, hoje: dataDeHoje }); } catch (e) {
        // Um squad que não monta não derruba os outros nem o run.
        r = { estado: 'ignorado', motivo: `não foi possível montar o modelo (${e.message.slice(0, 160)})` };
      }
      const base = { assinatura, impressao: r.impressao || null, em: dataDeHoje };
      if (r.estado === 'nada') { reg.squads[code] = { ...base, estado: 'nada' }; resumo.nada_a_enviar.push(code); continue; }
      if (r.estado === 'ignorado') { reg.squads[code] = { ...base, estado: 'ignorado', motivo: r.motivo }; resumo.ignorados.push({ squad: code, motivo: r.motivo }); continue; }
      if (r.estado === 'barrado') {
        const mesmo = antes?.estado === 'barrado' && antes.impressao === r.impressao;
        const motivo = r.nao_lidos?.length && !r.achados?.length
          ? 'a conferência de dado do caso não conseguiu ler todos os documentos do caso'
          : 'possível dado de caso (ou do escritório) na estrutura';
        reg.squads[code] = { ...base, estado: 'barrado', motivo, avisar: mesmo ? Boolean(antes.avisar) : true };
        resumo.barrados.push(code);
        continue;
      }
      // Pronto. O mesmo conteúdo já enviado não vai de novo, mesmo com a assinatura mudada.
      if (antes?.estado === 'enviado' && antes.impressao === r.impressao) {
        reg.squads[code] = { ...antes, assinatura };
        resumo.ja_enviados.push(code);
        continue;
      }
      const corpo = JSON.stringify(pacoteDeModelos([r.modelo], { hoje: dataDeHoje }));
      if (Buffer.byteLength(corpo) > LIMITE_DO_ENVIO) {
        reg.squads[code] = { ...base, estado: 'ignorado', motivo: 'o modelo passa de 2 MB' };
        resumo.ignorados.push({ squad: code, motivo: 'o modelo passa de 2 MB' });
        continue;
      }
      if (semRede) { reg.squads[code] = { ...base, estado: 'pendente' }; resumo.pendentes.push(code); continue; }
      const resp = await enviar({ url, license: config.license, instalacao, corpo });
      const estado = estadoDaResposta(resp);
      reg.squads[code] = { ...base, estado, ...(resp.id ? { id: resp.id } : {}), ...(resp.status ? { http: resp.status } : {}) };
      if (estado === 'enviado') resumo.enviados.push(code);
      else if (estado === 'recusado') resumo.recusados.push(code);
      else {
        resumo.pendentes.push(code);
        // Servidor fora ou sem rede: os outros esperam a próxima passada, sem insistir agora.
        if (resp.rede || resp.status >= 500 || resp.status === 429) semRede = true;
      }
    }
    // O aviso de squad barrado que o aluno ainda não ouviu sai na primeira passada à vista (a de
    // segundo plano não tem a quem dizer), uma vez por conteúdo barrado.
    if (!silencioso) {
      for (const [code, x] of Object.entries(reg.squads)) {
        if (x?.estado !== 'barrado' || !x.avisar) continue;
        resumo.barrados_novos.push({ squad: code, motivo: x.motivo || 'possível dado de caso' });
        x.avisar = false;
      }
    }
    gravarRegistro(cwd, reg);
  } finally {
    soltar();
  }
  return resumo;
}

// ───────────────────────── prévia ─────────────────────────

/**
 * O que subiria de cada squad, sem enviar e sem gravar nada (nem o registro, nem a trava, nem o
 * sorteio da instalação): para o dono e o aluno verem, squad a squad, a lista de arquivos e o
 * tamanho do que iria, ou o que a varredura achou e por que aquele squad não iria. Roda mesmo com a
 * contribuição desligada (diz que está desligada). Os achados levam o motivo e o arquivo, e não
 * saem desta máquina.
 */
export function previaDaContribuicao(cwd, { env = process.env, hoje, squads = null } = {}) {
  const lig = contribuicaoLigada(cwd, { env });
  const saida = { success: true, previa: true, ligada: lig.ligada, ...(lig.ligada ? {} : { motivo: lig.motivo }), squads: [] };
  if (!existsSync(join(cwd, 'squads'))) return saida;
  const reg = lerRegistro(cwd);
  const dataDeHoje = hojeIso(hoje);
  let codes;
  try { codes = readdirSync(join(cwd, 'squads'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.') && RE_CODE.test(e.name)).map((e) => e.name).sort(); } catch { codes = []; }
  if (squads) codes = codes.filter((c) => squads.includes(c));
  let todos = null;
  for (const code of codes) {
    const dir = join(cwd, 'squads', code);
    const run = provaDoRun(dir);
    if (!run) { saida.squads.push({ squad: code, estado: 'sem_run_aprovado', subiria: false, motivo: 'nenhum run aprovado registrado (nem em _memory/runs.md, nem no run-state.json): só a estrutura que já funcionou sobe' }); continue; }
    todos ||= listarModelos(cwd);
    let r;
    try { r = contribuicaoDoSquad(cwd, code, { todos, hoje: dataDeHoje }); } catch (e) { r = { estado: 'ignorado', motivo: `não foi possível montar o modelo (${e.message.slice(0, 160)})` }; }
    const base = { squad: code, run_aprovado: run.data, ...(run.nota !== null && run.nota !== undefined ? { nota: run.nota } : {}) };
    if (r.estado === 'nada') { saida.squads.push({ ...base, estado: 'nada', subiria: false, motivo: `o squad está como o modelo «${r.igual_ao_modelo}» o criou: não há estrutura nova` }); continue; }
    if (r.estado === 'ignorado') { saida.squads.push({ ...base, estado: 'ignorado', subiria: false, motivo: r.motivo }); continue; }
    if (r.estado === 'barrado') {
      saida.squads.push({ ...base, estado: 'barrado', subiria: false, achados: r.achados || [], nao_lidos: r.nao_lidos || [] });
      continue;
    }
    const corpo = JSON.stringify(pacoteDeModelos([r.modelo], { hoje: dataDeHoje }));
    const antes = reg.squads[code];
    const jaEnviado = antes?.estado === 'enviado' && antes.impressao === r.impressao;
    const grande = Buffer.byteLength(corpo) > LIMITE_DO_ENVIO;
    saida.squads.push({
      ...base,
      estado: grande ? 'ignorado' : jaEnviado ? 'ja_enviado' : 'pronto',
      subiria: !grande && !jaEnviado && lig.ligada,
      ...(grande ? { motivo: 'o modelo passa de 2 MB' } : {}),
      modelo: r.modelo.id,
      formato: r.formato,
      arquivos: Object.entries(r.modelo.arquivos).map(([nome, t]) => ({ nome, bytes: Buffer.byteLength(t) })),
      bytes: Buffer.byteLength(corpo),
    });
  }
  return saida;
}

const kb = (b) => `${(b / 1024).toFixed(1).replace('.', ',')} KB`;

function imprimirPrevia(p) {
  console.log(`  Prévia da contribuição: nada é enviado nem gravado.${p.ligada ? '' : ` A contribuição está desligada nesta pasta (${p.motivo}): nada subiria.`}`);
  if (!p.squads.length) { console.log('  Nenhum squad nesta pasta.'); return; }
  for (const s of p.squads) {
    if (s.estado === 'pronto' || s.estado === 'ja_enviado') {
      const lista = s.arquivos.map((a) => `${a.nome} ${kb(a.bytes)}`).join('; ');
      console.log(`  «${s.squad}»: ${s.estado === 'ja_enviado' ? 'já enviado com este conteúdo' : 'subiria'} o modelo ${s.modelo} (${s.formato}), ${kb(s.bytes)}: ${lista}.`);
    } else if (s.estado === 'barrado') {
      console.log(`  «${s.squad}»: não subiria (barrado pela varredura de dado do caso).`);
      for (const a of s.achados) console.log(`      - ${a.arquivo}: ${a.motivo}`);
      for (const n of s.nao_lidos) console.log(`      - não lido: ${n.arquivo} (${n.motivo})`);
    } else {
      console.log(`  «${s.squad}»: não subiria: ${s.motivo}.`);
    }
  }
}

// ───────────────────────── em segundo plano ─────────────────────────

/**
 * Dispara a passada num processo à parte, que sobrevive ao comando que o chamou, e volta na hora:
 * é o que o `update` usa, e o `complete` do run aprovado (pelo `contribuir --fundo`). Nunca na suíte de testes, e nunca com a contribuição desligada.
 */
export function dispararEmSegundoPlano(cwd, { env = process.env, bin = BIN } = {}) {
  if (env.NODE_TEST_CONTEXT || !contribuicaoLigada(cwd, { env }).ligada || !existsSync(join(cwd, 'squads'))) return false;
  try {
    const filho = spawn(process.execPath, [bin, 'contribuir', '--silencioso'], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...env, LEGALSQUAD_RAIZ: cwd },
      windowsHide: true,
    });
    filho.on('error', () => {});
    filho.unref();
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── CLI ─────────────────────────

/**
 * `legalsquad contribuir [--json] [--fundo] [--silencioso] [--previa]`. À vista, diz uma linha por
 * squad que não foi enviado por conter possível dado de caso, e nada mais: o envio é silencioso por
 * decisão do dono. `--fundo` só dispara a passada em segundo plano e sai. `--previa` mostra, por
 * squad, o que subiria (arquivos e tamanho) e os achados da varredura, sem enviar e sem gravar.
 */
export async function contribuirCli(cwd, values = {}) {
  if (values.previa === true) {
    let p;
    try { p = previaDaContribuicao(cwd); } catch (e) { p = { success: false, previa: true, erro: e.message, squads: [] }; }
    if (values.json === true) console.log(JSON.stringify(p, null, 2));
    else if (p.erro) console.log(`  Prévia da contribuição não montada: ${p.erro}`);
    else imprimirPrevia(p);
    return { success: true };
  }
  if (values.fundo === true) {
    const disparado = dispararEmSegundoPlano(cwd);
    if (values.json === true) console.log(JSON.stringify({ success: true, disparado }));
    return { success: true };
  }
  let r;
  try {
    r = await contribuir(cwd, { silencioso: values.silencioso === true });
  } catch (e) {
    // A contribuição nunca derruba quem a chamou.
    r = { success: false, erro: e.message };
  }
  if (values.silencioso === true) return { success: true };
  if (values.json === true) {
    console.log(JSON.stringify(r, null, 2));
    return { success: true };
  }
  if (r.ligada === false) { console.log(`  Contribuição à comunidade desligada (${r.motivo}).`); return { success: true }; }
  for (const b of r.barrados_novos || []) console.log(`  ${linhaDoAviso(b)}`);
  if (r.erro) console.log(`  Contribuição não enviada agora: ${r.erro}`);
  return { success: true };
}
