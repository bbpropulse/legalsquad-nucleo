#!/usr/bin/env node
/**
 * Auditor das premissas do motor, lidas do que o run deixou em disco (sem token, sem rede).
 *
 * O dono aprovou em 01/10/2026 as premissas de produto e de advocacia que todo run tem de provar
 * (revisoes/PREMISSAS-MOTOR-2026-10.md, blocos A a H). Cada uma tem um verificador: código, roteiro
 * (o run recebe mensagens planejadas do profissional) ou avaliador (leitura independente). Este
 * script é o verificador por CÓDIGO: lê os ledgers (`run-state.json`, `review-state.json`), o
 * `pipeline.yaml`, o `squad.yaml`, os agentes, o `_build/`, a pasta `output/{run_id}/`, o pacote,
 * os autos do caso e o `_legalsquad/logs/roteamento.jsonl`, e diz, premissa a premissa:
 *
 *   passa | falha | nao_se_aplica | sem_dado | pendente_roteiro | pendente_avaliador
 *
 * com a evidência em uma linha (arquivo e valor). `sem_dado` é o motor que não grava o que a
 * premissa pede; o relatório diz o que ele precisaria gravar, nunca adivinha. Premissa que só um
 * roteiro ou um avaliador confere sai como pendente, com o que conferir.
 *
 * Só LEITURA: o auditor não grava nada, nem no squad, nem nos autos, nem nos logs. Os dois
 * processos que ele chama (o `check-squad` do motor e o `meta-consenso` do squad-state) também só
 * leem.
 *
 * Uso:
 *   node scripts/auditar-run.mjs squads/<nome> [--run <run_id>] [--json] [--transcricao <arquivo>]
 *
 * `--transcricao`: o texto da conversa do run (texto puro, ou o `.jsonl` da sessão do Claude Code).
 * Com ele, o código confere o que dá para conferir na conversa: o chefe se apresenta e não expõe
 * nome interno de agente, id de step nem nome de script (E1), nenhuma peça redigida na conversa
 * (A5, E6), e as respostas das paradas estão no que o profissional escreveu (D2).
 *
 * Sai 0 sempre que conseguiu auditar (o placar é o resultado, não o código de saída), e 1 só com
 * erro de uso (pasta inexistente, run que não existe).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PENDING_MARKER, DATA_MARKER, medirSquad } from './run-metricas.mjs';
import { inventarioDeImagens, planoDeIntegracao, statusDoSumario, pastaDeAutos } from './sumario-autos.mjs';
import { cobertura, lerIndiceYaml } from './indexar-autos.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));

export const STATUS = Object.freeze(['passa', 'falha', 'nao_se_aplica', 'sem_dado', 'pendente_roteiro', 'pendente_avaliador']);

export const BLOCOS = Object.freeze({
  A: 'Porta de entrada (chefe-roteador)',
  B: 'Arquiteto (criar squad)',
  C: 'Time de agentes',
  D: 'Pipeline (a lei do run)',
  E: 'O chefe do squad',
  F: 'Alteração depois da entrega',
  G: 'Autos e documentos',
  H: 'Gates da advocacia',
});

/** As premissas do documento, com o verificador declarado lá. */
export const PREMISSAS = Object.freeze([
  ['A1', 'Pedido de peça chega a quem atende (modelo, squad da área ou Arquiteto); nunca "não há modelo" e parar', 'roteiro + código'],
  ['A2', 'Área do caso filtra: modelo ou squad de outra área nunca é escolhido', 'código'],
  ['A3', 'Modelo recusado não deixa squad órfão', 'código'],
  ['A4', 'Ambiguidade vira uma pergunta curta com a opção "montar com o Arquiteto"', 'roteiro'],
  ['A5', 'O roteador não redige peça na conversa', 'avaliador'],
  ['B1', 'Discovery pergunta só o que o relato e os documentos não respondem; poucas perguntas', 'código'],
  ['B2', 'Design reaproveita skills e especialistas da área; nenhuma de outra área; lacuna declarada', 'código'],
  ['B3', 'Build íntegro: check-squad sem erro, sem marcador, caso.json e identificacao.json, nenhum modelo fixo', 'código'],
  ['B4', 'O desenho (Arquiteto) ou a equipe (modelo) é aprovado pelo profissional antes de construir ou rodar', 'código'],
  ['C1', 'Cada step executado pelo agente declarado, com as skills resolvidas antes', 'código'],
  ['C2', 'Fase zero em paralelo e read-only; quem revisa nunca é quem redigiu', 'código'],
  ['C3', 'Especialista declarado é despachado pelo nome e existe na máquina', 'código'],
  ['C4', 'Agente não escreve fora do próprio outputFile', 'código'],
  ['D1', 'Steps na ordem declarada; nenhum pulado, nenhum enxertado', 'código'],
  ['D2', 'Toda parada declarada aconteceu e a resposta está gravada literal', 'código'],
  ['D3', 'Tetos de ciclo respeitados; escalada ao profissional quando estoura', 'código'],
  ['D4', 'Retomada depois de queda volta ao step certo sem refazer o que estava pronto', 'roteiro'],
  ['D5', 'Saídas só em output/{run_id}/ com versão; nada sobrescrito', 'código'],
  ['E1', 'O chefe se apresenta uma vez e fala em linguagem de gente (sem agente, step ou script)', 'avaliador'],
  ['E2', 'Pergunta no meio do run: responde sem mexer no pipeline', 'roteiro'],
  ['E3', 'Correção de fato no meio do run: abre revisão no step que consumiu o fato', 'roteiro + código'],
  ['E4', 'Pedido novo no meio do run: não enxerta step; termina ou pergunta se aborta', 'roteiro'],
  ['E5', 'Autonomia: nunca age acima do nível vigente; M4 nunca', 'código + avaliador'],
  ['E6', 'O chefe não redige peça na conversa', 'avaliador'],
  ['F1', 'Pedido de forma reabre em ajustes: só o redator, gates, nova versão, aprovação de novo', 'roteiro + código'],
  ['F2', 'Pedido de mérito reabre em revisão: fix humano, redator e revisor, conferência, meta, aprovação', 'roteiro + código'],
  ['F3', 'O pedido chega ao agente certo depois da reabertura', 'código'],
  ['F4', 'Fato novo, documento novo ou outra peça não reabre', 'roteiro'],
  ['F5', 'O pacote anterior fica guardado e o termo ganha "Revisões depois da entrega"', 'código'],
  ['G1', 'Leitura integral: toda folha com texto, OCR ou imagem; nenhuma faixa sem aviso', 'código'],
  ['G2', 'Toda foto descrita como prova e integrada ao documento.md; a peça cita a folha', 'código + avaliador'],
  ['G3', 'Sumário do caso em dia ou refeito', 'código'],
  ['H1', 'Nenhuma citação de memória: toda citação da final conferida, nenhuma cancelada ou divergente', 'código'],
  ['H2', 'Citação pertinente ao fato e à relação jurídica', 'avaliador'],
  ['H3', 'Redação Gate e Sobrevivência ao Resumo passados ou escalados com ressalva registrada', 'código'],
  ['H4', 'Verificação da Meta com nota e veredito por critério; nota independente ao lado', 'código'],
  ['H5', 'Nada protocolado ou enviado; sem dado pessoal real e sem travessão na entrega', 'código + avaliador'],
  ['H6', 'Pacote gerado (docx, pdf, termo, nota ao revisor com as divergências do relato)', 'código'],
  ['H7', 'Red-team que acha ataque sem resposta muda a peça (fix humano) ou fica como ressalva decidida pelo profissional, ataque a ataque', 'código'],
].map(([id, titulo, verificador]) => Object.freeze({ id, bloco: id[0], titulo, verificador })));

// ─────────────────────────── leitura ───────────────────────────

const lerTexto = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const lerJson = (p) => { const t = lerTexto(p); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };
const existe = (p) => existsSync(p);
const ehDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const mtimeMs = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
const posix = (p) => p.split(sep).join('/');
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normal = (t) => semAcento(t).toLowerCase().replace(/\s+/g, ' ').trim();

/** Todos os arquivos sob `dir` (recursivo), com caminho absoluto; pula `node_modules` e `.git`. */
function arquivosSob(dir, { pular = () => false } = {}) {
  const out = [];
  const andar = (d) => {
    let entradas;
    try { entradas = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const full = join(d, e.name);
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (pular(full, e)) continue;
      if (e.isDirectory()) andar(full);
      else if (e.isFile()) out.push(full);
    }
  };
  andar(dir);
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function lerParty(squadDir) {
  const t = lerTexto(join(squadDir, 'squad-party.csv'));
  if (!t) return [];
  const linhas = t.split(/\r?\n/).filter((l) => l.trim());
  const cab = parseCsvLine(linhas.shift() || '');
  return linhas.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cab[i], v])));
}

const desaspar = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '');
const escalarTopo = (yaml, chave) => {
  const m = String(yaml || '').match(new RegExp(`^${chave}:\\s*(.+?)\\s*$`, 'm'));
  return m ? desaspar(m[1].replace(/\s+#.*$/, '')) : null;
};

/** Lista inline (`[a, b]`) ou em bloco (`- a`) sob uma chave de topo do YAML/frontmatter. */
function listaDeTopo(texto, chave) {
  const inline = String(texto || '').match(new RegExp(`^${chave}:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (inline) return inline[1].split(',').map(desaspar).filter(Boolean);
  const bloco = String(texto || '').match(new RegExp(`^${chave}:\\s*\\n((?:[ \\t]+-[ \\t]+.+\\n?)+)`, 'm'));
  return bloco ? bloco[1].split('\n').map((l) => l.match(/^\s*-\s+(.+?)\s*$/)?.[1]).filter(Boolean).map(desaspar) : [];
}

function frontmatter(texto) {
  const m = String(texto || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

/**
 * O `pipeline.yaml` que o compilador grava (subconjunto de YAML): uma entrada por step, com os
 * campos que o auditor usa. Leitura de linha, como o `run-metricas` faz.
 */
/**
 * O comentário no fim da linha do YAML (`citation_verifiers: 3   # gate final`) não é valor: lido
 * junto, o número virava texto e o auditor não achava o step de conferência (m1, 01/10/2026: F1 e
 * F2 diziam "sem final nova" com a v22 no disco). O `#` dentro de aspas fica.
 */
function semComentario(linha) {
  const aspa = Math.max(linha.lastIndexOf('"'), linha.lastIndexOf("'"));
  return linha.slice(0, aspa + 1) + linha.slice(aspa + 1).replace(/(^|\s+)#.*$/, '');
}

export function lerPipeline(texto) {
  const steps = [];
  let st = null;
  let sub = null;
  for (const bruta of String(texto || '').replace(/\r\n?/g, '\n').split('\n')) {
    const linha = semComentario(bruta);
    if (!linha.trim()) continue;
    if (/^\S/.test(linha)) { st = null; sub = null; if (/^steps:/.test(linha)) sub = 'steps'; continue; }
    const novo = linha.match(/^\s*-\s+id:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/);
    if (novo && (sub === 'steps' || st)) { st = { id: novo[1], depends_on: [], artefatos: [] }; steps.push(st); continue; }
    if (!st) continue;
    const kv = linha.match(/^\s{4}([a-z_]+):\s*(.*?)\s*$/);
    if (kv) {
      const [, k, v] = kv;
      if (k === 'depends_on') { st.depends_on = v ? [desaspar(v)] : []; st._lista = v ? null : 'depends_on'; continue; }
      st._lista = k === 'output' ? 'output' : null;
      if (v !== '') st[k] = /^\d+$/.test(v) ? Number(v) : desaspar(v);
      continue;
    }
    const item = linha.match(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/);
    if (item && st._lista === 'depends_on') { st.depends_on.push(item[1]); continue; }
    if (item && st._lista === 'output' && /output\//.test(item[1])) st.artefatos.push(item[1]);
  }
  for (const s of steps) delete s._lista;
  return steps;
}

const nomeDoArtefato = (caminho) => basename(String(caminho || ''));

// ─────────────────────────── áreas (cópia mínima de src/area.js) ───────────────────────────

const SINONIMOS = {
  criminal: ['criminal', 'penal'], penal: ['criminal', 'penal'], trabalho: ['trabalho', 'trabalhista'], trabalhista: ['trabalho', 'trabalhista'],
  civil: ['civil', 'civel'], civel: ['civil', 'civel'], consumidor: ['consumidor', 'consumerista', 'consumo'], consumo: ['consumidor', 'consumerista', 'consumo'],
  empresarial: ['empresarial', 'comercial', 'societario'], tributario: ['tributario', 'fiscal'], fiscal: ['tributario', 'fiscal'],
  previdenciario: ['previdenciario', 'previdencia'], administrativo: ['administrativo', 'publico'], imobiliario: ['imobiliario', 'imoveis'],
};
const VAZIAS = new Set(['direito', 'direitos', 'do', 'da', 'de', 'dos', 'das', 'e', 'ou', 'processual', 'processo', 'processos']);
const slugDeArea = (t) => semAcento(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const raizDe = (t) => (t.length > 3 ? t.replace(/s$/, '') : t);
const tokensDeArea = (t) => slugDeArea(t).split('-').filter((x) => x && !VAZIAS.has(x));
const alvosDe = (t) => (SINONIMOS[t] || SINONIMOS[raizDe(t)] || [t]).map(raizDe);
/** A área de um item casa com uma das áreas da lista? Pelos tokens e sinônimos, como o roteador. */
export function areaCasa(area, areas) {
  if (!area) return false;
  const doItem = new Set(tokensDeArea(area).flatMap(alvosDe));
  return (areas || []).some((a) => slugDeArea(a) === slugDeArea(area) || tokensDeArea(a).flatMap(alvosDe).some((t) => doItem.has(t)));
}
const ehTransversal = (area) => /transversal/.test(slugDeArea(area));

// ─────────────────────────── perguntas da Discovery (cópia de src/discovery-perguntas.js) ───────────────────────────

// >>> discovery-perguntas:begin
/** Teto de perguntas da Discovery (a regra "NEVER ask more than 8 questions total" do prompt). */
const TETO_DE_PERGUNTAS_DA_DISCOVERY = 8;

/**
 * Lê o bloco `perguntas_feitas` do discovery.yaml:
 *
 *   perguntas_feitas:
 *     total: 2
 *     perguntas:
 *       - "polo de atuação"
 *       - "red-team"
 *     respondidas_pelo_relato:
 *       - "prazo: o relato diz 09/10"
 *
 * Devolve `null` sem o bloco, ou `{ total, perguntas, respondidas_pelo_relato, erros }`; `erros`
 * vazio quando o bloco está no formato.
 */
function lerPerguntasFeitas(texto) {
  const linhas = String(texto || '').replace(/\r\n?/g, '\n').split('\n');
  const i = linhas.findIndex((l) => /^perguntas_feitas:\s*(?:#.*)?$/.test(l));
  if (i < 0) {
    const inline = linhas.find((l) => /^perguntas_feitas:\s*\S/.test(l));
    return inline ? { total: null, perguntas: [], respondidas_pelo_relato: [], erros: ['perguntas_feitas tem de ser um bloco com total e perguntas, não um valor solto'] } : null;
  }
  const out = { total: null, perguntas: [], respondidas_pelo_relato: [], erros: [] };
  let lista = null;
  for (const l of linhas.slice(i + 1)) {
    if (/^\S/.test(l)) break;
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const kv = l.match(/^\s{2}([a-z_]+):\s*(.*?)\s*$/);
    if (kv) {
      lista = null;
      if (kv[1] === 'total') out.total = /^\d+$/.test(kv[2]) ? Number(kv[2]) : NaN;
      else if (kv[1] === 'perguntas' || kv[1] === 'respondidas_pelo_relato') {
        lista = kv[1];
        if (kv[2] === '[]') lista = null;
        else if (kv[2]) out.erros.push(`${kv[1]} tem de ser lista em bloco`);
      }
      continue;
    }
    const item = l.match(/^\s{4}-\s+(.+?)\s*$/);
    if (item && lista) out[lista].push(item[1].replace(/^["']|["']$/g, ''));
  }
  if (!Number.isInteger(out.total)) out.erros.push('perguntas_feitas.total ausente ou não é número inteiro');
  else if (out.total !== out.perguntas.length) out.erros.push(`perguntas_feitas.total é ${out.total} e a lista perguntas tem ${out.perguntas.length}`);
  return out;
}
// <<< discovery-perguntas:end
export { lerPerguntasFeitas };

// ─────────────────────────── o contexto do run ───────────────────────────

class ErroDeUso extends Error {}

/** Lê tudo o que o run deixou. Puro em relação ao disco: só leitura. */
export function carregarRun(squadArg, { run = null } = {}) {
  const squadDir = resolve(squadArg);
  if (!ehDir(squadDir)) throw new ErroDeUso(`pasta do squad não existe: ${squadArg}`);
  const raiz = resolve(squadDir, '..', '..');
  const code = basename(squadDir);
  const ledgerRaiz = lerJson(join(squadDir, 'run-state.json'));
  const runId = run || ledgerRaiz?.runId || null;
  if (!runId) throw new ErroDeUso(`sem run neste squad (nenhum run-state.json em ${squadArg}); passe --run <run_id>`);
  const runDir = join(squadDir, 'output', runId);
  if (!ehDir(runDir)) throw new ErroDeUso(`o run ${runId} não tem pasta em ${posix(relative(raiz, runDir))}`);
  // O ledger da raiz é o do último run; o de um run anterior está arquivado na pasta dele.
  const doRun = (nome) => {
    const daRaiz = lerJson(join(squadDir, nome));
    const arquivado = lerJson(join(runDir, nome));
    if (nome === 'run-state.json') return daRaiz?.runId === runId ? { dado: daRaiz, arquivo: join(squadDir, nome) } : { dado: arquivado, arquivo: join(runDir, nome) };
    return ledgerRaiz?.runId === runId && daRaiz ? { dado: daRaiz, arquivo: join(squadDir, nome) } : { dado: arquivado, arquivo: join(runDir, nome) };
  };
  const rs = doRun('run-state.json');
  const rv = doRun('review-state.json');
  const squadYaml = lerTexto(join(squadDir, 'squad.yaml')) || '';
  const pipelineTexto = lerTexto(join(squadDir, 'pipeline', 'pipeline.yaml')) || '';
  const pipeline = lerPipeline(pipelineTexto);
  const party = lerParty(squadDir);
  const agentes = {};
  const agentsDir = join(squadDir, 'agents');
  if (ehDir(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((n) => n.endsWith('.agent.md') || n.endsWith('.md'))) {
      const texto = lerTexto(join(agentsDir, f)) || '';
      const fm = frontmatter(texto);
      const id = f.replace(/\.agent\.md$|\.md$/, '');
      agentes[id] = { arquivo: join(agentsDir, f), model: escalarTopo(fm, 'model'), execution: escalarTopo(fm, 'execution'), skills: listaDeTopo(fm, 'skills') };
    }
  }
  const stepsDoArquivo = {};
  for (const s of pipeline) {
    if (s.file) stepsDoArquivo[s.id] = lerTexto(join(squadDir, 'pipeline', s.file)) || '';
  }
  const areasDoProjeto = lerJson(join(raiz, '_legalsquad', 'config', 'acervo.json'))?.areas || [];
  const roteamento = (lerTexto(join(raiz, '_legalsquad', 'logs', 'roteamento.jsonl')) || '')
    .split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const autosDir = pastaDeAutos(squadDir);
  return {
    raiz, squadDir, code, runId, runDir,
    run: rs.dado, runArquivo: rs.arquivo,
    review: rv.dado, reviewArquivo: rv.arquivo,
    squadYaml, pipeline, pipelineTexto, party, agentes, stepsDoArquivo, areasDoProjeto, roteamento,
    autosDir: ehDir(autosDir) ? autosDir : null,
    rel: (p) => posix(relative(raiz, p)),
  };
}

// O retorno do contraditor lido por código: canônico em `src/red-team.js` (bloco `red-team`).
// >>> red-team:begin
/** O que não fazer custa, por natureza do ataque, dito ao profissional na parada aprovação. */
const CUSTO_DE_NAO_CORRIGIR = Object.freeze({
  fato: 'a conclusão que depende desse fato fica exposta: quem está do outro lado aponta a prova que falta ou a que contradiz, e o ponto pode cair ou perder valor',
  direito: 'a tese fica sem resposta à leitura contrária: se ela prevalecer, o ponto cai, e com ele o valor, o pedido ou a recomendação que dependem dele',
  forma: 'o pressuposto (competência, prazo, legitimidade, preço ou garantia) pode derrubar, adiar ou encarecer o resultado inteiro sem chegar ao mérito',
  outra: 'o ataque fica sem resposta na entrega, e quem decide do outro lado o usa contra ela',
});

/** As opções da parada depois do red-team, na ordem: corrigir primeiro quando há ataque sem resposta. */
const OPCOES_DEPOIS_DO_RED_TEAM = Object.freeze({
  corrigir: ['Corrigir antes de aprovar (recomendado)', 'Aprovar e seguir', 'Ajustar (diga o quê)', 'Parar aqui'],
  aprovar: ['Aprovar e seguir', 'Ajustar (diga o quê)', 'Parar aqui'],
});

const semAcentoDoRedTeam = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const celulasDoRedTeam = (linha) => linha.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** A natureza do ataque pela célula ("FATO", "FORMA (preço e retenção)"). */
function naturezaDoAtaque(celula) {
  const n = semAcentoDoRedTeam(celula);
  if (/\bfato\b/.test(n)) return 'fato';
  if (/\bdireito\b/.test(n)) return 'direito';
  if (/\bforma\b/.test(n)) return 'forma';
  return 'outra';
}

/**
 * O estado do ataque: `descoberto`, `insuficiente` (antecipado com resposta insuficiente, parcial ou
 * fraca), `antecipado` ou `a-responder` (pré-mortem). Lê a célula do estado e, para a suficiência da
 * resposta, também a do lugar na peça ("ANTECIPADO | II.b | resposta insuficiente: ...").
 */
function estadoDoAtaque(estado, onde = '') {
  const e = semAcentoDoRedTeam(estado);
  const o = semAcentoDoRedTeam(onde);
  if (/\bdescoberto\b/.test(e)) return 'descoberto';
  if (/\ba responder\b/.test(e)) return 'a-responder';
  if (/\bantecipad/.test(e)) return /insuficient|parcial|fraca|incomplet/.test(`${e} ${o}`) ? 'insuficiente' : 'antecipado';
  return null;
}

/**
 * Os ataques da tabela do contraditor, na ordem: `{ n, natureza, estado, ataque, onde, fix }`. As
 * colunas vêm do cabeçalho (Natureza, Ataque, Estado, Onde, Fix); sem cabeçalho reconhecível, a
 * célula com DESCOBERTO ou ANTECIPADO é o estado e a primeira é a natureza.
 */
function ataquesDoContraditor(texto) {
  const linhas = String(texto ?? '').split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l));
  const ataques = [];
  let col = null;
  for (const linha of linhas) {
    const c = celulasDoRedTeam(linha);
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) continue;
    const n = c.map(semAcentoDoRedTeam);
    if (n.some((x) => /^natureza\b/.test(x)) && n.some((x) => /^estado\b/.test(x))) {
      col = {
        natureza: n.findIndex((x) => /^natureza\b/.test(x)),
        ataque: n.findIndex((x) => /^ataque\b/.test(x)),
        estado: n.findIndex((x) => /^estado\b/.test(x)),
        onde: n.findIndex((x) => /^onde\b|o que falta/.test(x)),
        fix: n.findIndex((x) => /^fix\b/.test(x)),
      };
      continue;
    }
    const iEstado = col ? col.estado : n.findIndex((x) => /\b(?:descoberto|antecipad|a responder)\b/.test(x));
    if (iEstado < 0 || c[iEstado] === undefined) continue;
    const onde = col && col.onde >= 0 ? c[col.onde] || '' : c[iEstado + 1] || '';
    const estado = estadoDoAtaque(c[iEstado], onde);
    if (!estado) continue;
    const pega = (k, padrao) => (col && col[k] >= 0 ? c[col[k]] || '' : padrao);
    ataques.push({
      n: ataques.length + 1,
      natureza: naturezaDoAtaque(pega('natureza', c[0])),
      estado,
      ataque: pega('ataque', c[1] || '').replace(/^["“]|["”]$/g, '').trim(),
      onde: onde.trim(),
      fix: pega('fix', '').trim(),
    });
  }
  return ataques;
}

/** Ataque que a peça não responde: descoberto, ou antecipado com resposta insuficiente. */
const ataqueSemResposta = (a) => a && (a.estado === 'descoberto' || a.estado === 'insuficiente');

const cortarDoRedTeam = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

/**
 * A oferta da parada aprovação depois do red-team: cada ataque com o custo de não corrigir, a
 * recomendação (`corrigir` quando há ataque sem resposta) e as opções, nesta ordem.
 */
function ofertaDoRedTeam(ataques) {
  const lista = Array.isArray(ataques) ? ataques : [];
  const semResposta = lista.filter(ataqueSemResposta);
  const recomendacao = semResposta.length ? 'corrigir' : 'aprovar';
  return {
    recomendacao,
    opcoes: [...OPCOES_DEPOIS_DO_RED_TEAM[recomendacao]],
    sem_resposta: semResposta.length,
    ataques: lista.map((a) => ({
      n: a.n,
      natureza: a.natureza,
      estado: a.estado,
      ataque: cortarDoRedTeam(a.ataque, 400),
      ...(a.onde ? { o_que_falta: cortarDoRedTeam(a.onde, 400) } : {}),
      ...(ataqueSemResposta(a) ? { custo_de_nao_corrigir: CUSTO_DE_NAO_CORRIGIR[a.natureza] || CUSTO_DE_NAO_CORRIGIR.outra } : {}),
    })),
  };
}

/** O fix de origem humana que o ataque sem resposta vira, para a redação: gravidade alta. */
function fixDoAtaque(a) {
  const natureza = String(a.natureza || 'outra').toUpperCase();
  const estado = a.estado === 'insuficiente' ? 'antecipado com resposta insuficiente' : 'descoberto';
  const falta = a.fix || a.onde;
  return `alta: red-team, ataque de ${natureza} ${estado}: ${cortarDoRedTeam(a.ataque, 500)}${falta ? ` O que a peça precisa responder: ${cortarDoRedTeam(falta, 500)}` : ''}`;
}
// <<< red-team:end

// ─────────────────────────── utilidades das premissas ───────────────────────────

const chk = (status, evidencia) => ({ status, evidencia });
const ORDEM = ['falha', 'sem_dado', 'passa', 'nao_se_aplica'];
function consolidar(checks) {
  const st = checks.map((c) => c.status);
  for (const s of ORDEM) if (st.includes(s)) return s;
  return 'nao_se_aplica';
}

const tsMs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const inicioDoRun = (ctx) => tsMs(ctx.run?.startedAt);
const fimDoRun = (ctx) => tsMs(ctx.run?.endedAt) ?? Date.now();

/** As versões `vN` de um diretório-grupo, em ordem numérica. */
function versoesDe(dir) {
  if (!ehDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => Number(e.name.slice(1))).sort((a, b) => a - b);
}

/** Onde está a versão mais alta de um artefato no run: `{caminho, versao}` ou null. */
function artefatoNoRun(ctx, nome, grupo = '') {
  const base = join(ctx.runDir, grupo);
  for (const v of versoesDe(base).reverse()) {
    const p = join(base, `v${v}`, nome);
    if (existe(p)) return { caminho: p, versao: v };
  }
  return existe(join(base, nome)) ? { caminho: join(base, nome), versao: null } : null;
}

/** O grupo (subpasta de `output/`) e o nome de um artefato declarado: `output/diagnostico/x.md` → ['diagnostico', 'x.md']. */
function grupoENome(art) {
  const rel = String(art).replace(/^(?:squads\/[^/]+\/)?output\//, '');
  const partes = rel.split('/');
  const nome = partes.pop();
  return [partes.join('/'), nome];
}

/** A final mais alta gravada dentro de uma janela (a de cada reabertura), ou null. */
function finalNaJanela(ctx, ini, fim) {
  const conf = ctx.pipeline.find((s) => Number(s.citation_verifiers) > 0) || null;
  const nomes = conf ? conf.artefatos.map((a) => grupoENome(a)) : [];
  for (const [grupo, nome] of nomes) {
    const base = join(ctx.runDir, grupo);
    for (const v of versoesDe(base).reverse()) {
      const p = join(base, `v${v}`, nome);
      const m = mtimeMs(p);
      if (m !== null && m > ini && m < fim) return { caminho: p, versao: v, nome, step: conf.id };
    }
  }
  return null;
}

function pecaFinal(ctx) {
  const conf = ctx.pipeline.find((s) => Number(s.citation_verifiers) > 0) || null;
  const nomes = conf ? conf.artefatos.map((a) => grupoENome(a)) : [];
  for (const [grupo, nome] of nomes) {
    const achado = artefatoNoRun(ctx, nome, grupo);
    if (achado) return { ...achado, nome, step: conf.id };
  }
  // Sem step de conferência declarado: a `-final.md` de versão mais alta.
  for (const v of versoesDe(ctx.runDir).reverse()) {
    const f = readdirSync(join(ctx.runDir, `v${v}`)).find((n) => /-final\.md$/.test(n));
    if (f) return { caminho: join(ctx.runDir, `v${v}`, f), versao: v, nome: f, step: null };
  }
  return null;
}

const sha256 = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } };

const ehCheckpoint = (s) => s.type === 'checkpoint';
const stepDeRedacao = (ctx) => {
  const revisor = ctx.pipeline.find((s) => s.on_reject);
  return revisor ? ctx.pipeline.find((s) => s.id === revisor.on_reject) || null : null;
};

/** Os ids de agente que o texto do run trata como internos (com hífen: os de uma palavra são português corrente). */
const NATIVOS_DO_MOTOR = ['verificador-citacoes', 'verificador-persuasao', 'avaliador-squad', 'contraditor', 'catalog-scout'];

function nativosDoStep(texto) {
  const nomes = new Set();
  for (const m of String(texto || '').matchAll(/subagentes?\s+nativos?\s+((?:`[\w-]+`(?:\s*,\s*|\s+e\s+)?)+)/g)) {
    for (const n of m[1].matchAll(/`([\w-]+)`/g)) nomes.add(n[1]);
  }
  return [...nomes];
}

function diretoriosDeAgentes(ctx) {
  const extras = String(process.env.LEGALSQUAD_AGENTES_DIR || '').split(':').filter(Boolean);
  return [join(ctx.raiz, '.claude', 'agents'), join(ctx.raiz, '.codex', 'agents'), join(homedir(), '.claude', 'agents'), ...extras];
}

/** Lacos de um gate no review-state: os do histórico e o corrente, na ordem. */
function lacosDoGate(review, gate) {
  if (!review) return [];
  const hist = Array.isArray(review.historico?.[gate]) ? review.historico[gate] : [];
  const atual = review.loops?.[gate] ? [review.loops[gate]] : (gate === 'revisao' && Array.isArray(review.cycles) ? [review] : []);
  return [...hist, ...atual];
}
const todosOsLacos = (review) => {
  if (!review) return [];
  const gates = new Set([...Object.keys(review.loops || {}), ...Object.keys(review.historico || {})]);
  return [...gates].flatMap((g) => lacosDoGate(review, g).map((l) => ({ gate: g, laco: l })));
};

// ─────────────────────────── transcrição ───────────────────────────

/**
 * A conversa do run em turnos `{papel: 'assistente'|'profissional', texto}`. Aceita o `.jsonl` da
 * sessão do Claude Code (mensagens `assistant` e `user` com texto) ou texto puro, em que linhas
 * que abrem com "Usuário:", "Profissional:", "User:" ou "Human:" começam um turno do profissional
 * e "Assistente:", "Claude:" ou "Chefe:" um turno do assistente (sem marca, tudo é assistente).
 */
export function lerTranscricao(texto) {
  const turnos = [];
  const linhas = String(texto || '').split(/\r?\n/);
  const jsonl = linhas.filter((l) => l.trim()).every((l) => l.trim().startsWith('{'));
  if (jsonl && linhas.some((l) => l.trim())) {
    for (const l of linhas) {
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      const papel = o.type === 'assistant' || o.message?.role === 'assistant' ? 'assistente' : (o.type === 'user' || o.message?.role === 'user' ? 'profissional' : null);
      if (!papel) continue;
      const c = o.message?.content;
      const partes = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text) : [];
      const t = partes.join('\n').trim();
      if (t) turnos.push({ papel, texto: t });
    }
    return turnos;
  }
  let atual = { papel: 'assistente', texto: '' };
  for (const l of linhas) {
    const prof = l.match(/^\s*(?:Usu[aá]rio|Profissional|User|Human)\s*:\s?(.*)$/i);
    const asst = l.match(/^\s*(?:Assistente|Claude|Chefe|Assistant)\s*:\s?(.*)$/i);
    if (prof || asst) {
      if (atual.texto.trim()) turnos.push({ ...atual, texto: atual.texto.trim() });
      atual = { papel: prof ? 'profissional' : 'assistente', texto: (prof || asst)[1] };
    } else atual.texto += `\n${l}`;
  }
  if (atual.texto.trim()) turnos.push({ ...atual, texto: atual.texto.trim() });
  return turnos;
}

const CABECALHOS_DE_PECA = [/excelent[ií]ssim[oa]/i, /\bDOS FATOS\b/, /\bDO DIREITO\b/, /\bDOS PEDIDOS\b/, /pede deferimento/i, /termos em que/i, /nestes termos/i, /\bD[AO]S? (?:TUTELA|PRELIMINAR(?:ES)?|M[EÉ]RITO)\b/];
/** Peça redigida na conversa: turno longo do assistente com dois ou mais cabeçalhos de peça. */
export function pecasNaConversa(turnos, { minimo = 2500 } = {}) {
  return turnos.map((t, i) => ({ ...t, i })).filter((t) => t.papel === 'assistente' && t.texto.length >= minimo)
    .map((t) => ({ i: t.i, tamanho: t.texto.length, cabecalhos: CABECALHOS_DE_PECA.filter((re) => re.test(t.texto)).length }))
    .filter((t) => t.cabecalhos >= 2);
}

const RE_APRESENTACAO = /\bAqui (?:é|e) (?:o|a) [A-ZÀ-Ú][\wÀ-ú]+/;
const NUMERO_POR_EXTENSO = '(?:dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte(?: e (?:um|dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove))?|trinta)';
const RE_TAMANHO_DO_CAMINHO = new RegExp(`\\b(?:\\d+|${NUMERO_POR_EXTENSO}) (?:passos|etapas)\\b`, 'i');
/**
 * O ponto da conversa em que o chefe do squad se apresenta (o começo do run), ou -1. A transcrição
 * junta roteador, Arquiteto e chefe (todos "Chefe:"), e o Arquiteto também diz "Aqui é o
 * Arquiteto": vale a apresentação que diz o tamanho do caminho, ou a primeira que não é do Arquiteto.
 */
function inicioDoChefe(turnos) {
  const candidatos = turnos.map((t, i) => ({ t, i })).filter(({ t }) => t.papel === 'assistente' && RE_APRESENTACAO.test(t.texto));
  const doRun = candidatos.find(({ t }) => RE_TAMANHO_DO_CAMINHO.test(t.texto)) || candidatos.find(({ t }) => !/\bAqui (?:é|e) o Arquiteto\b/i.test(t.texto)) || candidatos[0];
  return doRun ? doRun.i : -1;
}

function vazamentosDeNomeInterno(turnos, ctx) {
  const ids = [...new Set([...ctx.party.map((p) => p.id), ...Object.keys(ctx.agentes), ...NATIVOS_DO_MOTOR, ...Object.values(ctx.stepsDoArquivo).flatMap(nativosDoStep)].filter((id) => id && id.includes('-')))];
  const reIds = ids.length ? new RegExp(`(?<![\\w/.-])(${ids.map((i) => i.replace(/[-]/g, '\\-')).join('|')})(?![\\w-])`, 'g') : null;
  const achados = [];
  for (const t of turnos) {
    if (t.papel !== 'assistente') continue;
    // O que está em bloco de código não é fala: é ferramenta mostrada (e já é defeito à parte).
    const texto = t.texto.replace(/```[\s\S]*?```/g, ' ');
    for (const m of texto.matchAll(/\bstep-\d{2}[\w-]*/g)) achados.push(`id de step "${m[0]}"`);
    for (const m of texto.matchAll(/\b[\w-]+\.(?:mjs|py)\b|\bsquad-(?:state|path)\b|\bnpx legalsquad\b/g)) achados.push(`script "${m[0]}"`);
    if (reIds) for (const m of texto.matchAll(reIds)) achados.push(`agente "${m[1]}"`);
  }
  return achados;
}

// ─────────────────────────── o motor (check-squad, meta-consenso) ───────────────────────────

function binDoMotor(ctx) {
  const candidatos = [process.env.LEGALSQUAD_BIN, lerJson(join(ctx.raiz, '_legalsquad', 'motor', 'motor.json'))?.bin, lerJson(join(homedir(), '.legalsquad', 'motor.json'))?.bin];
  return candidatos.find((c) => c && existe(c)) || null;
}

function rodarCheckSquad(ctx) {
  const bin = binDoMotor(ctx);
  if (!bin) return null;
  // cwd fora do projeto: o check-squad só lê, e assim nada que a CLI faça cai na pasta auditada.
  const r = spawnSync(process.execPath, [bin, 'check-squad', ctx.code, '--squads-dir', join(ctx.raiz, 'squads')], { cwd: tmpdir(), encoding: 'utf8', timeout: 120000 });
  const saida = `${r.stdout || ''}${r.stderr || ''}`;
  const erros = [...saida.matchAll(/✖ \[([\w-]+)\]/g)].map((m) => m[1]);
  return { ok: r.status === 0 && !erros.length, erros, bin };
}

function scriptSquadState(ctx) {
  return [join(AQUI, 'squad-state.mjs'), join(ctx.raiz, 'scripts', 'squad-state.mjs')].find(existe) || null;
}

// ─────────────────────────── as premissas ───────────────────────────

const ROTAS_QUE_ATENDEM = /squad|modelo|arquiteto|create|reabrir|reabertura|runner|pipeline/i;
const ROTAS_QUE_PARAM = /^(?:nenhum|sem-modelo|parar|recusa|nao-atende|sem-rota)$/i;

/** As linhas do roteamento que pertencem a este run: do começo do dia anterior até o fim do run. */
function roteamentoDoRun(ctx) {
  const ini = inicioDoRun(ctx);
  const fim = fimDoRun(ctx);
  if (ini === null) return ctx.roteamento;
  return ctx.roteamento.filter((e) => {
    const t = tsMs(e.ts);
    return t !== null && t >= ini - 24 * 3600 * 1000 && t <= fim;
  });
}

/**
 * Squad pronto de pacote ainda sem `area:` (os antigos, como o recurso-criminal no m1 de
 * 01/10/2026): o roteamento não filtra nem registra por área, e a área entra na curadoria do
 * pacote. A1 e A2 não se aplicam (decisão do dono, 02/10/2026); o check-squad avisa.
 */
function prontoSemArea(ctx) {
  return !escalarTopo(ctx.squadYaml, 'area') && ehSquadPronto(ctx)
    ? { checks: [chk('nao_se_aplica', `squad pronto de pacote sem "area:" (squads/${ctx.code}/squad.yaml copiado do depósito): a área entra na curadoria do pacote`)] }
    : null;
}

function premissaA1(ctx) {
  const pronto = prontoSemArea(ctx);
  if (pronto) return pronto;
  const linhas = roteamentoDoRun(ctx);
  const checks = [];
  if (!linhas.length) checks.push(chk('sem_dado', `_legalsquad/logs/roteamento.jsonl: nenhuma linha nas 24 h antes do run ${ctx.runId}`));
  else {
    const ultima = linhas[linhas.length - 1];
    const parou = linhas.find((e) => ROTAS_QUE_PARAM.test(String(e.rota || '')));
    if (parou) checks.push(chk('falha', `roteamento.jsonl ${parou.ts}: rota "${parou.rota}" (o pedido parou sem quem atenda)`));
    else if (ROTAS_QUE_ATENDEM.test(String(ultima.rota || ''))) checks.push(chk('passa', `roteamento.jsonl: ${linhas.length} decisão(ões); a última, ${ultima.ts}, rota "${ultima.rota}"`));
    else checks.push(chk('falha', `roteamento.jsonl ${ultima.ts}: rota "${ultima.rota}" não é squad, modelo nem Arquiteto`));
    const ligaAoSquad = linhas.some((e) => e.squad === ctx.code);
    checks.push(ligaAoSquad
      ? chk('passa', `roteamento.jsonl liga a decisão ao squad ${ctx.code}`)
      : chk('sem_dado', `roteamento.jsonl não diz qual squad a decisão escolheu (sem campo "squad"): a ligação com ${ctx.code} é só pelo horário`));
  }
  return { checks, tambem: 'pendente_roteiro: pedido em linguagem natural, sem nome da peça, chega a quem atende' };
}

function premissaA2(ctx) {
  const pronto = prontoSemArea(ctx);
  if (pronto) return pronto;
  const area = escalarTopo(ctx.squadYaml, 'area');
  const checks = [];
  if (!ctx.areasDoProjeto.length) checks.push(chk('sem_dado', '_legalsquad/config/acervo.json sem "areas": não há área do projeto para comparar'));
  else if (!area) checks.push(chk('sem_dado', `squads/${ctx.code}/squad.yaml sem "area:"`));
  else checks.push(areaCasa(area, ctx.areasDoProjeto) || ehTransversal(area)
    ? chk('passa', `squad.yaml area "${area}" casa com as áreas do projeto (${ctx.areasDoProjeto.join(', ')})`)
    : chk('falha', `squad.yaml area "${area}" fora das áreas do projeto (${ctx.areasDoProjeto.join(', ')})`));
  const origem = lerJson(join(ctx.squadDir, '_build', 'modelo-origem.json'));
  if (origem && area) {
    const areaDoModelo = escalarTopo(lerTexto(join(ctx.raiz, 'squads', '_modelos', String(origem.modelo || ''), 'modelo.yaml')) || '', 'area');
    if (areaDoModelo) checks.push(areaCasa(areaDoModelo, [area]) || ehTransversal(areaDoModelo) ? chk('passa', `modelo ${origem.modelo} da área "${areaDoModelo}"`) : chk('falha', `modelo ${origem.modelo} da área "${areaDoModelo}", o caso é "${area}"`));
  }
  const escolhas = roteamentoDoRun(ctx).filter((e) => e.area && e.squad);
  for (const e of escolhas) {
    if (ctx.areasDoProjeto.length && !areaCasa(e.area, ctx.areasDoProjeto) && !ehTransversal(e.area)) checks.push(chk('falha', `roteamento.jsonl ${e.ts}: squad ${e.squad} da área "${e.area}", fora do projeto`));
  }
  return { checks };
}

/** Squads deste projeto nascidos de modelo, sem run e sem nada em output/: os órfãos de um --criar recusado. */
function premissaA3(ctx) {
  const squads = join(ctx.raiz, 'squads');
  const ini = inicioDoRun(ctx);
  const fim = fimDoRun(ctx);
  const descartados = new Set(ctx.roteamento.filter((e) => /descart/.test(String(e.rota || ''))).map((e) => e.squad));
  const orfaos = [];
  const criadosNaJanela = [];
  for (const nome of ehDir(squads) ? readdirSync(squads) : []) {
    if (nome.startsWith('_') || nome === ctx.code) continue;
    const dir = join(squads, nome);
    const origem = join(dir, '_build', 'modelo-origem.json');
    if (!existe(origem)) continue;
    const criado = mtimeMs(origem);
    if (ini !== null && (criado < ini - 24 * 3600 * 1000 || criado > fim)) continue;
    criadosNaJanela.push(nome);
    const rodou = existe(join(dir, 'run-state.json')) || existe(join(dir, 'state.json'))
      || (ehDir(join(dir, 'output')) && readdirSync(join(dir, 'output')).some((n) => !n.startsWith('.')));
    if (!rodou && !descartados.has(nome)) orfaos.push(`squads/${nome}/ (criado ${iso(criado)}, modelo ${lerJson(origem)?.modelo || '?'}, sem run)`);
  }
  if (orfaos.length) return { checks: [chk('falha', `squad de modelo sem run e não descartado: ${orfaos.join('; ')}`)] };
  if (!criadosNaJanela.length) return { checks: [chk('passa', 'nenhum outro squad de modelo criado na janela do run (nenhum órfão possível)')] };
  return { checks: [chk('passa', `squads de modelo da janela todos rodaram ou foram descartados: ${criadosNaJanela.join(', ')}`)] };
}

function premissaB1(ctx) {
  const disc = lerTexto(join(ctx.squadDir, '_build', 'discovery.yaml'));
  if (!disc) return { checks: [chk('nao_se_aplica', `squads/${ctx.code}/_build/discovery.yaml ausente: o squad não veio do Arquiteto`)] };
  const r = lerPerguntasFeitas(disc);
  if (!r) return { checks: [chk('sem_dado', '_build/discovery.yaml sem o bloco perguntas_feitas (Discovery anterior ao registro)')], falta_gravar: 'discovery.yaml com perguntas_feitas (total, perguntas e respondidas_pelo_relato)' };
  if (r.erros.length) return { checks: [chk('falha', `_build/discovery.yaml perguntas_feitas fora do formato: ${r.erros.join('; ')}`)] };
  const checks = [r.total <= TETO_DE_PERGUNTAS_DA_DISCOVERY
    ? chk('passa', `discovery.yaml: ${r.total} pergunta(s) (teto ${TETO_DE_PERGUNTAS_DA_DISCOVERY})${r.perguntas.length ? `: ${r.perguntas.slice(0, 4).join('; ')}` : ''}`)
    : chk('falha', `discovery.yaml: ${r.total} perguntas, acima do teto de ${TETO_DE_PERGUNTAS_DA_DISCOVERY}`)];
  const doCaso = /^caso:\s*$/m.test(disc) || existe(join(ctx.squadDir, 'caso.json'));
  if (doCaso) checks.push(r.respondidas_pelo_relato.length ? chk('passa', `${r.respondidas_pelo_relato.length} ponto(s) não perguntados porque o relato ou os documentos respondiam`) : chk('falha', 'Discovery de pasta de caso sem nenhum ponto em respondidas_pelo_relato: perguntou o que os documentos respondiam, ou não registrou'));
  return { checks, tambem: 'pendente_avaliador: cada pergunta feita não estava respondida no relato' };
}

function skillsDoSquad(ctx) {
  const ids = new Set(listaDeTopo(ctx.squadYaml, 'skills'));
  for (const a of Object.values(ctx.agentes)) for (const s of a.skills) ids.add(s);
  for (const p of ctx.party) for (const s of String(p.skills || '').split(',').map((x) => x.trim()).filter(Boolean)) ids.add(s);
  return [...ids].filter((s) => !/^web_(?:search|fetch)$/.test(s)).sort();
}

/**
 * A ligação do projeto ao depósito (`acervo/_packs/_ligado.json`): o que veio pronto de pacote
 * (`copiados`) e, por skill, os pacotes que a trazem (os registros do depósito). Uma skill pode vir
 * em mais de um pacote (a calculadora de valor presente vem no de contabilidade e no transversal,
 * m4, 01/10/2026): o `source_area` dela diz só um dono. Sem ligação, nada.
 */
function ligacaoDoProjeto(ctx) {
  if (ctx._ligacao !== undefined) return ctx._ligacao;
  const ligado = lerJson(join(ctx.raiz, 'acervo', '_packs', '_ligado.json'));
  if (!ligado) { ctx._ligacao = null; return null; }
  const pacotesDaSkill = new Map();
  const pasta = typeof ligado.deposito === 'string' ? join(ligado.deposito, 'acervo', '_packs', '_arquivos') : null;
  let nomes;
  try { nomes = pasta ? readdirSync(pasta).filter((n) => n.endsWith('.json')) : []; } catch { nomes = []; }
  for (const nome of nomes) {
    const reg = lerJson(join(pasta, nome));
    for (const a of reg?.arquivos || []) {
      const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(String(a?.path || ''));
      if (m && reg.pack_id) pacotesDaSkill.set(m[1], [...(pacotesDaSkill.get(m[1]) || []), String(reg.pack_id)]);
    }
  }
  ctx._ligacao = { copiados: Object.keys(ligado.copiados || {}), areas: Array.isArray(ligado.areas) ? ligado.areas : [], pacotesDaSkill };
  return ctx._ligacao;
}

/** O pacote ligado ao projeto que traz a skill (transversal, ou de área do projeto), ou null. */
function pacoteLigadoDaSkill(ctx, id) {
  const lig = ligacaoDoProjeto(ctx);
  if (!lig) return null;
  const areas = [...new Set([...ctx.areasDoProjeto, ...lig.areas])];
  return (lig.pacotesDaSkill.get(id) || []).find((p) => ehTransversal(p) || areaCasa(p.replace(/^(?:area|acervo)\./, ''), areas)) || null;
}

/** Squad pronto de pacote: os arquivos dele vieram copiados do depósito, não do Arquiteto nem de modelo. */
function ehSquadPronto(ctx) {
  const lig = ligacaoDoProjeto(ctx);
  return !!lig && lig.copiados.includes(`squads/${ctx.code}/squad.yaml`)
    && !existe(join(ctx.squadDir, '_build', 'discovery.yaml')) && !existe(join(ctx.squadDir, '_build', 'modelo-origem.json'));
}

function premissaB2(ctx) {
  const ids = skillsDoSquad(ctx);
  const checks = [];
  if (!ids.length) return { checks: [chk('sem_dado', 'o squad não declara skills (squad.yaml, agentes, party)')] };
  const faltam = [];
  const fora = [];
  const semArea = [];
  const porArea = {};
  const porPacote = [];
  for (const id of ids) {
    const sk = lerTexto(join(ctx.raiz, 'skills', id, 'SKILL.md'));
    if (sk === null) { faltam.push(id); continue; }
    const area = sk.match(/^\s*source_area:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1] || null;
    if (!area) { semArea.push(id); continue; }
    porArea[area] = (porArea[area] || 0) + 1;
    if (ctx.areasDoProjeto.length && !ehTransversal(area) && !areaCasa(area, ctx.areasDoProjeto)) {
      const pacote = pacoteLigadoDaSkill(ctx, id);
      if (pacote) porPacote.push(`${id} (${area}, também no pacote ${pacote})`);
      else fora.push(`${id} (${area})`);
    }
  }
  checks.push(faltam.length ? chk('falha', `skills declaradas ausentes de skills/: ${faltam.join(', ')}`) : chk('passa', `${ids.length} skills declaradas, todas em skills/ (${Object.entries(porArea).map(([a, n]) => `${a} ${n}`).join(', ')}${semArea.length ? `, sem área ${semArea.length}` : ''})`));
  if (ctx.areasDoProjeto.length) checks.push(fora.length ? chk('falha', `skills de área não ligada ao projeto: ${fora.join(', ')}`) : chk('passa', `nenhuma skill de área fora de ${ctx.areasDoProjeto.join(', ')}${porPacote.length ? `; de outra área, mas trazida por pacote ligado: ${porPacote.join(', ')}` : ''}`));
  const design = lerTexto(join(ctx.squadDir, '_build', 'design.yaml'));
  if (design) {
    // O design.prompt manda omitir `gaps_declarados` vazio: ausente é "nenhuma lacuna", nunca falha.
    const gaps = /^gaps_declarados:/m.test(design);
    checks.push(chk('passa', gaps ? '_build/design.yaml declara gaps_declarados' : '_build/design.yaml sem gaps_declarados: nenhuma lacuna declarada (o design omite a chave vazia)'));
  }
  return { checks };
}

function premissaB3(ctx) {
  const checks = [];
  const veioDoArquiteto = existe(join(ctx.squadDir, '_build', 'discovery.yaml')) || existe(join(ctx.squadDir, '_build', 'design.yaml'));
  const cs = rodarCheckSquad(ctx);
  checks.push(!cs ? chk('sem_dado', 'motor não encontrado (LEGALSQUAD_BIN, _legalsquad/motor/motor.json): check-squad não rodou')
    : cs.ok ? chk('passa', `check-squad ${ctx.code}: estrutura íntegra (${posix(cs.bin)})`) : chk('falha', `check-squad ${ctx.code}: ${cs.erros.length} erro(s): ${cs.erros.join(', ') || 'saída sem a linha de estrutura íntegra'}`));
  const comMarcador = arquivosSob(ctx.squadDir, { pular: (p) => p.startsWith(join(ctx.squadDir, 'output')) || p.startsWith(join(ctx.squadDir, '_build')) })
    .filter((p) => /\.(?:md|ya?ml|csv)$/.test(p) && /<!--\s*LEGALSQUAD:PREENCHER\b/.test(lerTexto(p) || ''));
  checks.push(comMarcador.length ? chk('falha', `marcador LEGALSQUAD:PREENCHER sem prosa em ${comMarcador.slice(0, 4).map(ctx.rel).join(', ')}${comMarcador.length > 4 ? ` e mais ${comMarcador.length - 4}` : ''}`) : chk('passa', 'nenhum marcador LEGALSQUAD:PREENCHER sem prosa nos arquivos do squad'));
  const disc = lerTexto(join(ctx.squadDir, '_build', 'discovery.yaml')) || '';
  const doCaso = existe(join(ctx.squadDir, 'caso.json')) || /casos_path:\s*\S/.test(disc);
  if (doCaso) {
    checks.push(existe(join(ctx.squadDir, 'caso.json')) ? chk('passa', `squads/${ctx.code}/caso.json gravado`) : chk('falha', `squad de pasta de caso sem squads/${ctx.code}/caso.json`));
    // O identificacao.json é do Build (Arquiteto ou modelo); o squad pronto que veio do pacote não
    // passa por ele (recurso-criminal no m1, 01/10/2026).
    if (existe(join(ctx.squadDir, 'identificacao.json'))) checks.push(chk('passa', `squads/${ctx.code}/identificacao.json gravado`));
    else if (ehSquadPronto(ctx)) checks.push(chk('nao_se_aplica', `squad pronto de pacote (squads/${ctx.code}/squad.yaml copiado do depósito): identificacao.json é do Build, que ele não teve`));
    else checks.push(chk('falha', `squad de pasta de caso sem squads/${ctx.code}/identificacao.json${veioDoArquiteto ? ' (criado pelo Arquiteto)' : ''}`));
  } else checks.push(chk('nao_se_aplica', 'squad sem pasta de caso: caso.json e identificacao.json não se exigem'));
  const fixos = Object.entries(ctx.agentes).filter(([, a]) => a.model && !/^inherit$/i.test(a.model)).map(([id, a]) => `${id} (model: ${a.model})`);
  checks.push(fixos.length ? chk('falha', `agente com modelo fixo: ${fixos.join(', ')}`) : chk('passa', `${Object.keys(ctx.agentes).length} agente(s) sem modelo fixo (inherit ou ausente)`));
  return { checks };
}

/**
 * B4 no squad criado de modelo (0.9.91): o roteador mostra a ficha da equipe (quem trabalha, o
 * caminho, as conferências) e pergunta, e a resposta fica em `_build/aprovacao-equipe.json`
 * (`squad-modelo --equipe <code> --decisao aprovar|ajustar --resposta`). Run de squad de modelo
 * sem a aprovação gravada antes do início é falha: o chefe seguiu sem pedir o ok (relato do dono,
 * 05/10/2026). Squad reusado que já rodou antes do registro existir fica sem dado.
 */
function premissaB4DoModelo(ctx, origem) {
  const falta = 'aprovação da equipe gravada por código antes do run (squad-modelo --equipe <code> --decisao aprovar --resposta, em _build/aprovacao-equipe.json)';
  const reg = lerJson(join(ctx.squadDir, '_build', 'aprovacao-equipe.json'));
  const ini = inicioDoRun(ctx);
  const runsAntes = ehDir(join(ctx.squadDir, 'output'))
    ? readdirSync(join(ctx.squadDir, 'output')).filter((n) => !n.startsWith('.') && !n.startsWith('_') && n !== ctx.runId && n < String(ctx.runId) && ehDir(join(ctx.squadDir, 'output', n)))
    : [];
  if (!reg) {
    if (runsAntes.length) return { checks: [chk('sem_dado', `squad do modelo ${origem.modelo || '?'} reusado (rodou antes, em ${runsAntes[runsAntes.length - 1]}) sem _build/aprovacao-equipe.json: criado antes do registro da equipe`)], falta_gravar: falta };
    return { checks: [chk('falha', `squad do modelo ${origem.modelo || '?'} sem a aprovação da equipe gravada (_build/aprovacao-equipe.json ausente): a ficha não foi mostrada ou a resposta não foi registrada`)] };
  }
  const decisoes = Array.isArray(reg.decisoes) ? reg.decisoes : [];
  const antes = decisoes.filter((d) => ini === null || (tsMs(d.em) ?? Infinity) <= ini + 1000);
  const ultima = antes[antes.length - 1];
  const ajustes = antes.filter((d) => d.decisao === 'ajustar').length;
  if (!ultima) return { checks: [chk('falha', `_build/aprovacao-equipe.json sem decisão antes do início do run (${ctx.run?.startedAt || '?'})`)] };
  if (ultima.decisao !== 'aprovar') return { checks: [chk('falha', `_build/aprovacao-equipe.json: a última resposta antes do run pede ajuste ("${String(ultima.resposta || '').slice(0, 60)}", ${ultima.em}) e a equipe não foi aprovada de novo`)] };
  if (!String(ultima.resposta || '').trim() || tsMs(ultima.em) === null) return { checks: [chk('falha', '_build/aprovacao-equipe.json: aprovação sem resposta ou sem hora')] };
  const checks = [chk('passa', `_build/aprovacao-equipe.json: equipe do modelo ${origem.modelo || '?'} aprovada ("${String(ultima.resposta).slice(0, 60)}") em ${ultima.em}${ajustes ? `, depois de ${ajustes} ajuste(s)` : ''}, antes do run`)];
  // A equipe que rodou é a aprovada: só no primeiro run depois da aprovação (o reuso pode ter
  // recebido a versão nova do modelo pelo --atualizar, que não pede o ok de novo).
  if (reg.equipe_sha256 && !runsAntes.length) {
    const yaml = ctx.squadYaml || '';
    const rels = ['squad.yaml', join('pipeline', 'pipeline.yaml'), ...[...yaml.matchAll(/^\s+file:\s*["']?([^"'\n#]+?)["']?\s*$/gm)].map((m) => m[1].trim())];
    const h = createHash('sha256');
    for (const rel of rels.sort()) h.update(`${rel}\n${lerTexto(join(ctx.squadDir, rel)) ?? ''}\n`);
    const agora = h.digest('hex');
    checks.push(agora === reg.equipe_sha256 ? chk('passa', 'a equipe que rodou é a aprovada (squad.yaml, pipeline.yaml e agentes iguais aos da aprovação)') : chk('falha', `a equipe mudou depois da aprovação de ${ultima.em} (squad.yaml, pipeline.yaml ou agentes; sha256 aprovado ${String(reg.equipe_sha256).slice(0, 12)}…, atual ${agora.slice(0, 12)}…)`));
  }
  return { checks };
}

function premissaB4(ctx) {
  const origem = lerJson(join(ctx.squadDir, '_build', 'modelo-origem.json'));
  if (origem) return premissaB4DoModelo(ctx, origem);
  const design = lerTexto(join(ctx.squadDir, '_build', 'design.yaml'));
  if (!design) return { checks: [chk('nao_se_aplica', `squads/${ctx.code}/_build/design.yaml ausente: o squad não foi desenhado pelo Arquiteto nesta pasta`)] };
  const falta = 'aprovação do desenho gravada por código antes do Build (squad-state aprovar-design, em _build/aprovacao-design.json)';
  const reg = lerJson(join(ctx.squadDir, '_build', 'aprovacao-design.json'));
  if (!reg) {
    const linha = design.match(/^#\s*Aprovado na Phase G[^\n]*/m)?.[0];
    return { checks: [chk('sem_dado', linha ? `_build/design.yaml traz "${linha.slice(2, 70)}", escrito pelo modelo; a resposta do profissional não está gravada por código` : '_build/aprovacao-design.json ausente: a aprovação do desenho não foi gravada')], falta_gravar: falta };
  }
  const em = tsMs(reg.em);
  if (!String(reg.resposta || '').trim() || em === null) return { checks: [chk('falha', '_build/aprovacao-design.json sem resposta ou sem hora')] };
  const checks = [chk('passa', `_build/aprovacao-design.json: "${String(reg.resposta).slice(0, 60)}" em ${reg.em}`)];
  // Construído antes da aprovação: o compilador grava _build/compilacao.json no Step 0 do Build.
  const compilado = mtimeMs(join(ctx.squadDir, '_build', 'compilacao.json')) ?? mtimeMs(join(ctx.squadDir, '_build', 'esqueleto.json'));
  if (compilado !== null) checks.push(compilado + 1000 >= em ? chk('passa', `Build compilado em ${iso(compilado)}, depois da aprovação`) : chk('falha', `Build compilado em ${iso(compilado)}, antes da aprovação de ${reg.em}`));
  const shaAgora = sha256(join(ctx.squadDir, '_build', 'design.yaml'));
  const mDesign = mtimeMs(join(ctx.squadDir, '_build', 'design.yaml'));
  if (reg.design_sha256 && shaAgora !== reg.design_sha256 && compilado !== null && mDesign <= compilado + 1000) checks.push(chk('falha', `o design.yaml mudou depois da aprovação e antes do Build (sha256 aprovado ${String(reg.design_sha256).slice(0, 12)}…, compilado ${String(shaAgora).slice(0, 12)}…)`));
  return { checks };
}

function premissaC1(ctx) {
  const checks = [];
  const ids = new Set(ctx.party.map((p) => p.id));
  const agentesSemArquivo = [];
  const semArtefato = [];
  for (const s of ctx.pipeline.filter((x) => x.type === 'agent')) {
    if (!s.agent || !ids.has(s.agent) || !ctx.agentes[s.agent]) agentesSemArquivo.push(`${s.id} (${s.agent || 'sem agent'})`);
    const arts = s.artefatos.map(grupoENome);
    if (arts.length && !arts.some(([g, n]) => artefatoNoRun(ctx, n, g))) semArtefato.push(`${s.id}: ${arts.map(([g, n]) => (g ? `${g}/${n}` : n)).join(', ')}`);
  }
  checks.push(agentesSemArquivo.length ? chk('falha', `step sem agente no party ou sem .agent.md: ${agentesSemArquivo.join('; ')}`) : chk('passa', 'todo step de agente aponta um agente do party com arquivo'));
  checks.push(semArtefato.length ? chk('falha', `step de agente sem o artefato no run: ${semArtefato.join('; ')}`) : chk('passa', `todo step de agente deixou o artefato declarado em output/${ctx.runId}/`));
  const falta = 'manifesto do resolve-skills no run (squad-state skills-resolvidas) e, por step, o agente e as skills (squad-state step --working, gravados no run-state)';
  const entradas = Array.isArray(ctx.run?.steps) ? ctx.run.steps : [];
  const comAgente = entradas.filter((e) => Array.isArray(e.agentes) && e.agentes.length);
  const manifesto = ctx.run?.skills_resolvidas || null;
  if (!manifesto && !comAgente.length) {
    checks.push(chk('sem_dado', 'o run-state não grava o manifesto do resolve-skills nem o agente de cada step (run anterior ao registro)'));
    return { checks, falta_gravar: falta };
  }
  if (!manifesto) checks.push(chk('falha', 'steps com agente registrado, mas sem o manifesto do resolve-skills no run-state (skills-resolvidas não rodou)'));
  else {
    const primeiro = comAgente.map((e) => tsMs(e.startedAt)).filter((t) => t !== null).sort((a, b) => a - b)[0];
    // A retomada resolve de novo: vale a hora da PRIMEIRA resolução (`anteriores[0]`).
    const primeira = Array.isArray(manifesto.anteriores) && manifesto.anteriores.length ? manifesto.anteriores[0] : manifesto;
    const em = tsMs(primeira.em);
    const sobrescrita = !Array.isArray(manifesto.anteriores) && Number(manifesto.rodada) > 1;
    if (!manifesto.success) checks.push(chk('falha', `resolve-skills sem sucesso: recusadas ${(manifesto.recusadas || []).map((r) => `${r.id} (${r.motivo})`).join(', ') || '?'}`));
    else if (primeiro !== undefined && em !== null && em > primeiro && sobrescrita) checks.push(chk('sem_dado', `skills resolvidas de novo (rodada ${manifesto.rodada}) em ${manifesto.em}; a hora da primeira resolução não foi guardada (motor anterior ao histórico)`));
    else if (primeiro !== undefined && em !== null && em > primeiro) checks.push(chk('falha', `skills resolvidas em ${primeira.em}, depois do primeiro step de agente (${iso(primeiro)})`));
    else checks.push(chk('passa', `skills resolvidas em ${primeira.em}${primeira === manifesto ? '' : ` (e de novo em ${manifesto.em}, rodada ${manifesto.rodada})`}: ${(manifesto.permitidas || []).length} permitida(s), ${(manifesto.recusadas || []).length} recusada(s)`));
  }
  // Cada step de agente: alguma entrada do ledger com o id dele (ou o do step de convergência do grupo) e o agente declarado.
  const idx = indiceDe(ctx);
  const errados = [];
  const semRegistro = [];
  for (const s of ctx.pipeline.filter((x) => x.type === 'agent')) {
    const conv = s.parallel_group ? ctx.pipeline.find((x) => x.depends_on.includes(s.id) && !x.parallel_group) : null;
    const doStep = entradas.filter((e) => e.stepId === s.id || (Array.isArray(e.agentes) && e.agentes.length > 0 && ((conv && e.stepId === conv.id && idx.has(e.stepId)) || (s.parallel_group && e.stepId !== 'autos-imagens-sumario' && grupoDoRegistro(ctx, e.stepId) === s.parallel_group))));
    if (!doStep.length) { semRegistro.push(s.id); continue; }
    const certos = doStep.filter((e) => Array.isArray(e.agentes) && e.agentes.includes(s.agent));
    if (!certos.length) {
      const outros = [...new Set(doStep.flatMap((e) => e.agentes || []))];
      errados.push(`${s.id} declara ${s.agent}, o ledger registra ${outros.length ? outros.join(', ') : 'nenhum agente'}`);
    }
  }
  if (errados.length) checks.push(chk('falha', `step executado por agente diferente do declarado: ${errados.join('; ')}`));
  else checks.push(chk('passa', 'todo step de agente registrado no ledger com o agente que o pipeline declara'));
  const fora = comAgente.flatMap((e) => Object.entries(e.skills || {}).filter(([, v]) => (v.fora_do_manifesto || []).length || v.sem_manifesto).map(([ag, v]) => `${e.stepId}/${ag}: ${v.sem_manifesto ? 'sem manifesto' : v.fora_do_manifesto.join(', ')}`));
  checks.push(fora.length ? chk('falha', `step rodou com skill fora do manifesto do resolvedor: ${fora.slice(0, 4).join('; ')}`) : chk('passa', `${comAgente.length} step(s) com as skills do agente todas aprovadas pelo resolvedor`));
  return { checks, ...(semRegistro.length ? { nota: `sem entrada no ledger (ver D1): ${semRegistro.join(', ')}` } : {}) };
}

function premissaC2(ctx) {
  const checks = [];
  const grupos = {};
  for (const s of ctx.pipeline) if (s.parallel_group) (grupos[s.parallel_group] ||= []).push(s);
  if (!Object.keys(grupos).length) checks.push(chk('nao_se_aplica', 'pipeline sem parallel_group (sem fase zero)'));
  for (const [g, steps] of Object.entries(grupos)) {
    const inline = steps.filter((s) => s.execution !== 'subagent').map((s) => s.id);
    checks.push(inline.length ? chk('falha', `grupo ${g}: steps fora de subagente (${inline.join(', ')})`) : chk('passa', `grupo ${g}: ${steps.length} steps em subagente`));
    const leiturasJuntas = (ctx.run?.steps || []).some((e) => /paralel/i.test(String(e.label || '')) || (e.stepId !== 'autos-imagens-sumario' && grupoDoRegistro(ctx, e.stepId) === g));
    const versoes = new Set(steps.flatMap((s) => s.artefatos.map(grupoENome)).map(([gr, n]) => artefatoNoRun(ctx, n, gr)?.versao).filter((v) => v !== undefined));
    checks.push(leiturasJuntas || versoes.size === 1
      ? chk('passa', `grupo ${g} despachado junto (${leiturasJuntas ? 'ledger com o passo "em paralelo"' : 'artefatos na mesma versão'})`)
      : chk('falha', `grupo ${g}: nenhum registro de despacho em paralelo no ledger e artefatos em versões ${[...versoes].join(', ') || '?'}`));
  }
  const revisor = ctx.pipeline.find((s) => s.on_reject);
  if (!revisor) checks.push(chk('nao_se_aplica', 'pipeline sem step de revisão (on_reject)'));
  else {
    const redacao = ctx.pipeline.find((s) => s.id === revisor.on_reject);
    if (redacao && redacao.agent === revisor.agent) checks.push(chk('falha', `${revisor.id} revisa com o mesmo agente que redige (${revisor.agent})`));
    else if (revisor.execution !== 'subagent') checks.push(chk('falha', `${revisor.id} não roda em subagente (contexto não isolado)`));
    else checks.push(chk('passa', `revisão ${revisor.id} (${revisor.agent}, subagente) isolada da redação ${redacao?.id} (${redacao?.agent})`));
    const vozes = lacosDoGate(ctx.review, 'revisao').flatMap((l) => (l.cycles || []).flatMap((c) => (c.verdicts || []).map((v) => v.reviewer)));
    if (redacao && vozes.includes(redacao.agent)) checks.push(chk('falha', `review-state: o redator ${redacao.agent} votou no laço de revisão`));
  }
  return { checks };
}

function premissaC3(ctx) {
  const checks = [];
  const dirs = diretoriosDeAgentes(ctx);
  const declarados = new Map();
  for (const s of ctx.pipeline) for (const n of nativosDoStep(ctx.stepsDoArquivo[s.id])) declarados.set(n, [...(declarados.get(n) || []), s]);
  if (!declarados.size) return { checks: [chk('nao_se_aplica', 'nenhum step declara subagente nativo')] };
  const ausentes = [...declarados.keys()].filter((n) => !dirs.some((d) => existe(join(d, `${n}.md`))));
  checks.push(ausentes.length ? chk('falha', `especialista declarado e não instalado: ${ausentes.join(', ')}`) : chk('passa', `${declarados.size} especialista(s) declarados, todos instalados (${[...declarados.keys()].join(', ')})`));
  const naoDespachados = [];
  for (const [n, steps] of declarados) {
    for (const s of steps) {
      const arts = s.artefatos.map(grupoENome).map(([g, nome]) => artefatoNoRun(ctx, nome, g)).filter(Boolean);
      const naLinha = arts.some((a) => new RegExp(`Nativos despachados:[^\\n]*\\b${n.replace(/-/g, '\\-')}\\b`).test(lerTexto(a.caminho) || ''));
      const noTmp = ehDir(join(ctx.runDir, '_tmp')) && readdirSync(join(ctx.runDir, '_tmp')).some((f) => f.includes(`nativo-${n}`));
      if (!naLinha && !noTmp) naoDespachados.push(`${n} (${s.id})`);
    }
  }
  checks.push(naoDespachados.length ? chk('falha', `nativo declarado sem registro de despacho (linha "Nativos despachados" nem _tmp/): ${naoDespachados.join(', ')}`) : chk('passa', 'todo nativo declarado tem a linha "Nativos despachados" no artefato ou a saída em _tmp/'));
  return { checks };
}

/** O que o run pode gravar fora de output/{run_id}/ sem ser escrita de agente fora do lugar. */
function escritaPermitida(ctx, rel) {
  const sq = `squads/${ctx.code}/`;
  const autos = ctx.autosDir ? `${posix(relative(ctx.raiz, ctx.autosDir))}/` : null;
  return rel.startsWith(`${sq}output/`)
    || [`${sq}state.json`, `${sq}run-state.json`, `${sq}review-state.json`, `${sq}caso.json`, `${sq}_memory/runs.md`, `${sq}_memory/memories.md`, `${sq}_evals/scores.md`].includes(rel)
    || rel.startsWith('skills/_evals/uso/')
    || rel.startsWith('acervo/_fontes/') || rel.startsWith('acervo/_receitas/') || rel === 'acervo/_index.yaml'
    // O step de pesquisa grava no acervo do escritório o que veio de fora (squad-compile, papel pesquisa).
    || /^acervo\/(?:jurisprudencia|legislacao|sumulas|doutrina|teses)\//.test(rel)
    || rel.startsWith('_legalsquad/.venv/') || rel.startsWith('_legalsquad/logs/') || rel.startsWith('_legalsquad/_memory/') || rel.startsWith('_legalsquad/_browser_profile/')
    || (autos && rel.startsWith(autos) && /(?:^|\/)(?:_index\.yaml|_texto\/|_md\/|_sumario\/)/.test(rel.slice(autos.length)));
}

// O `pendencias.json` é a entrada do `manifesto-final` (`--pendencias`), com o `onde` desta versão:
// vive ao lado da final que ele descreve, como o manifesto (achado C4 do run de 01/10/2026).
// O `relatorio-conferencia*.md` é o que o conferente grava na pasta da final (com ou sem
// promoção): é da conferência, como o manifesto (achado C4 do m1, 01/10/2026). O termo de
// conferência do conferente (`termo-de-conferencia.md`, `termo-conferencia-conferente.md`), que os
// modelos mandam montar ao lado da final, também (m6 de 02/10 e m8 de 05/10/2026).
const SIDECARS = /\.(?:citation|redacao)-gate\.json$|^verifica-contrato-final\.json$|^pendencias\.json$|^relatorio-conferencia[\w-]*\.md$|^termo-(?:de-)?conferencia[\w-]*\.md$|\.anexos\.json$/;

function premissaC4(ctx) {
  const ini = inicioDoRun(ctx);
  const fim = fimDoRun(ctx);
  if (ini === null) return { checks: [chk('sem_dado', `${ctx.rel(ctx.runArquivo)} sem startedAt: não há janela para conferir as escritas`)] };
  // `acervo/_packs/` é o conteúdo assinado ligado do depósito (somente leitura, dezenas de milhares de arquivos).
  const naJanela = arquivosSob(ctx.raiz, { pular: (p, e) => e.isDirectory() && p === join(ctx.raiz, 'acervo', '_packs') })
    .filter((p) => { const m = mtimeMs(p); return m >= ini - 1000 && m <= fim + 60 * 1000; })
    .map(ctx.rel);
  const fora = naJanela.filter((r) => !escritaPermitida(ctx, r));
  const checks = [fora.length
    ? chk('falha', `escrita fora do lugar durante o run: ${fora.slice(0, 5).join(', ')}${fora.length > 5 ? ` e mais ${fora.length - 5}` : ''}`)
    : chk('passa', `${naJanela.length} arquivo(s) gravados na janela do run, todos no output do run, nos ledgers, nos autos (índice, texto, conversão, sumário) ou no cache`)];
  // O registro que o pesquisador grava no acervo serve a todos os casos: não leva o code do squad.
  const comCaso = naJanela.filter((r) => /^acervo\/(?:jurisprudencia|legislacao|sumulas|doutrina|teses)\//.test(r) && (lerTexto(join(ctx.raiz, r)) || '').includes(ctx.code));
  if (comCaso.length) checks.push(chk('falha', `registro do acervo com o code do squad (o acervo é do escritório): ${comCaso.slice(0, 3).join(', ')}`));
  const declarados = new Set(ctx.pipeline.flatMap((s) => s.artefatos.map(nomeDoArtefato)));
  const intrusos = [];
  // `_tmp/` (inclusive `_tmp/tardias/`, a gravação que chegou depois do abort) não é produto do run.
  const grupos = [ctx.runDir, ...readdirSync(ctx.runDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^v\d+$/.test(e.name) && e.name !== '_tmp').map((e) => join(ctx.runDir, e.name))];
  for (const g of grupos) {
    for (const v of versoesDe(g)) {
      for (const f of readdirSync(join(g, `v${v}`))) {
        if (!declarados.has(f) && !SIDECARS.test(f)) intrusos.push(ctx.rel(join(g, `v${v}`, f)));
      }
    }
  }
  checks.push(intrusos.length ? chk('falha', `arquivo em pasta de versão que nenhum step declara: ${intrusos.slice(0, 5).join(', ')}`) : chk('passa', 'toda pasta de versão do run só tem artefatos declarados no pipeline'));
  return { checks, limite: 'a atribuição por agente é pelo nome do artefato; o motor não grava qual agente escreveu cada arquivo' };
}

/** Índice de cada step no pipeline. */
const indiceDe = (ctx) => new Map(ctx.pipeline.map((s, i) => [s.id, i]));

/** Laços que devolveram ao redator (REJECT, ou escalada que o profissional mandou corrigir), com a janela em que ficaram abertos. */
function lacosQueDevolveram(ctx) {
  return todosOsLacos(ctx.review)
    .filter(({ laco }) => (laco.cycles || []).some((c) => String(c.decision?.verdict || '').toUpperCase() === 'REJECT' || c.decision?.action === 'revise' || (c.verdicts || []).some((v) => String(v.verdict || '').toUpperCase() === 'REJECT')) || /corrig/i.test(String(laco.resolucao?.decisao || '')))
    .map(({ gate, laco }) => ({ gate, target: laco.target, ini: tsMs(laco.aberto_em), fim: tsMs(laco.arquivadoEm) ?? Infinity }));
}

/**
 * Volta para trás legítima (achados D1 e D4 do run de 01/10/2026): a redação refeita por um laço
 * que reprovou, ou a pesquisa em modo complemento pedida por um gate (autoridade fora da
 * pesquisa), com o laço aberto enquanto o step rodava. Refazer step concluído sem isso é falha.
 */
function voltaLegitima(ctx, e, lacos) {
  const ini = tsMs(e.startedAt);
  if (ini === null) return false;
  const fim = tsMs(e.endedAt) ?? ini;
  const passo = ctx.pipeline.find((s) => s.id === e.stepId);
  return lacos.some((l) => l.ini !== null && l.ini <= fim && l.fim >= ini
    && (e.stepId === l.target || (passo?.type === 'agent' && (ctx.pipeline.find((s) => s.id === l.target)?.depends_on || []).includes(e.stepId))));
}

/**
 * Registros do ledger que não são step do pipeline, mas são do run (achados 17 e 18 do run de
 * 01/10/2026): o despacho da fase zero em paralelo (`fase-zero`, o primeiro grupo do pipeline;
 * `paralelo-{grupo}` para outro) e as imagens e o sumário dos autos antes dela
 * (`autos-imagens-sumario`). O grupo do registro, ou null.
 */
function grupoDoRegistro(ctx, stepId) {
  const id = String(stepId || '');
  if (id === 'fase-zero' || id === 'autos-imagens-sumario') return ctx.pipeline.find((s) => s.parallel_group)?.parallel_group || null;
  const g = /^paralelo-(.+)$/.exec(id)?.[1];
  return g && ctx.pipeline.some((s) => s.parallel_group === g) ? g : null;
}
/** Posição do registro no pipeline: a do step, ou a do primeiro step do grupo do registro. */
function indiceDoRegistro(ctx, stepId, idx = indiceDe(ctx)) {
  if (idx.has(stepId)) return idx.get(stepId);
  const g = grupoDoRegistro(ctx, stepId);
  const i = g ? ctx.pipeline.findIndex((s) => s.parallel_group === g) : -1;
  return i >= 0 ? i : undefined;
}

function premissaD1(ctx) {
  const entradas = Array.isArray(ctx.run?.steps) ? ctx.run.steps : [];
  if (!entradas.length) return { checks: [chk('sem_dado', `${ctx.rel(ctx.runArquivo)} sem steps[]`)] };
  if (entradas.some((e) => !e.stepId)) return { checks: [chk('sem_dado', `${ctx.rel(ctx.runArquivo)}: entrada de step sem stepId (ledger anterior a 0.5.9)`)] };
  const idx = indiceDe(ctx);
  const checks = [];
  const enxertados = entradas.filter((e) => indiceDoRegistro(ctx, e.stepId, idx) === undefined).map((e) => `${e.stepId} ("${e.label}")`);
  checks.push(enxertados.length ? chk('falha', `step fora do pipeline no ledger: ${enxertados.join(', ')}`) : chk('passa', `${entradas.length} entradas do ledger, todas com id do pipeline ou registro do run (fase zero, imagens e sumário)`));
  // Segmentos: cada reabertura recomeça do step de redação.
  const cortes = (ctx.run?.reaberturas || []).map((r) => tsMs(r.em)).filter((t) => t !== null);
  const voltas = [];
  const legitimas = [];
  const lacos = lacosQueDevolveram(ctx);
  let anterior = -1;
  let segmento = 0;
  for (const e of entradas.filter((x) => indiceDoRegistro(ctx, x.stepId, idx) !== undefined)) {
    const t = tsMs(e.startedAt);
    while (segmento < cortes.length && t !== null && t >= cortes[segmento]) { segmento += 1; anterior = -1; }
    const i = indiceDoRegistro(ctx, e.stepId, idx);
    let recomeco = false;
    if (i < anterior) {
      const legitima = voltaLegitima(ctx, e, lacos);
      (legitima ? legitimas : voltas).push(`${e.stepId} depois de ${ctx.pipeline[anterior].id}`);
      // A volta legítima recomeça o caminho dali: a revisão e a conferência que vêm depois da redação
      // refeita estão na ordem (run m8, 05/10/2026: a meta devolveu à redação e o D1 acusava a revisão).
      recomeco = legitima;
    }
    // As imagens e o sumário dos autos rodam antes dos leitores, e podem rodar antes do intake
    // (m1, 01/10/2026): o registro conta a posição do grupo como teto, não como passo dado.
    if (e.stepId !== 'autos-imagens-sumario') anterior = recomeco ? i : Math.max(anterior, i);
  }
  checks.push(voltas.length ? chk('falha', `ordem quebrada: ${voltas.join('; ')}`) : chk('passa', `steps do ledger na ordem do pipeline${legitimas.length ? ` (${legitimas.length} volta(s) por laço que reprovou ou complemento pedido por gate: ${legitimas.join('; ')})` : ''}`));
  const vistos = new Set(entradas.map((e) => e.stepId));
  const emParalelo = new Set(entradas.filter((e) => /paralel/i.test(String(e.label || ''))).map((e) => e.stepId));
  const gruposVistos = new Set(entradas.filter((e) => e.stepId !== 'autos-imagens-sumario').map((e) => grupoDoRegistro(ctx, e.stepId)).filter(Boolean));
  const pulados = ctx.pipeline.filter((s) => {
    if (vistos.has(s.id)) return false;
    if (!s.parallel_group) return true;
    if (gruposVistos.has(s.parallel_group)) return false;
    // Ledger anterior a 01/10/2026: o despacho do grupo levava o id do step de convergência.
    const convergencia = ctx.pipeline.find((x) => x.depends_on.includes(s.id));
    return !(convergencia && emParalelo.has(convergencia.id));
  }).map((s) => s.id);
  const concluido = ctx.run?.status === 'completed';
  checks.push(pulados.length ? chk(concluido ? 'falha' : 'sem_dado', `step do pipeline sem registro no ledger${concluido ? '' : ' (run não concluído)'}: ${pulados.join(', ')}`) : chk('passa', `os ${ctx.pipeline.length} steps do pipeline aparecem no ledger`));
  return { checks };
}

function premissaD2(ctx, transcricao) {
  const checkpoints = ctx.pipeline.filter(ehCheckpoint);
  if (!checkpoints.length) return { checks: [chk('nao_se_aplica', 'pipeline sem checkpoint')] };
  const resp = ctx.run?.checkpoints || {};
  const em = ctx.run?.checkpoints_em || {};
  const checks = [];
  const idx = indiceDe(ctx);
  const atual = indiceDoRegistro(ctx, (ctx.run?.steps || []).at(-1)?.stepId, idx) ?? (ctx.run?.status === 'completed' ? ctx.pipeline.length : -1);
  for (const s of checkpoints) {
    if (ctx.run?.status !== 'completed' && idx.get(s.id) > atual) { checks.push(chk('nao_se_aplica', `${s.id}: o run ainda não chegou a esta parada`)); continue; }
    const r = resp[s.id];
    if (typeof r !== 'string' || !r.trim()) { checks.push(chk('falha', `${s.id}: parada declarada sem resposta em ${ctx.rel(ctx.runArquivo)} (checkpoints)`)); continue; }
    if (!em[s.id]) { checks.push(chk('falha', `${s.id}: resposta sem carimbo de hora (checkpoints_em)`)); continue; }
    const art = s.artefatos.map(grupoENome).map(([g, n]) => artefatoNoRun(ctx, n, g)).find(Boolean);
    const faltaArt = s.artefatos.length && !art;
    checks.push(faltaArt ? chk('falha', `${s.id}: respondida em ${em[s.id]}, mas sem o artefato ${s.artefatos.join(', ')}`) : chk('passa', `${s.id}: "${r.slice(0, 50)}${r.length > 50 ? '…' : ''}" em ${em[s.id]}`));
  }
  let tambem = 'pendente_roteiro: a resposta gravada é a literal do profissional';
  if (transcricao) {
    const falas = transcricao.filter((t) => t.papel === 'profissional').map((t) => normal(t.texto)).join('\n');
    // Com `checkpoints_historico[]`, cada ocorrência (a do run e a de cada reabertura); sem ele, a última.
    const hist = Array.isArray(ctx.run?.checkpoints_historico) ? ctx.run.checkpoints_historico : null;
    for (const s of checkpoints) {
      const respostas = hist ? hist.filter((h) => h.step === s.id).map((h) => ({ r: h.resposta, rot: h.reabertura ? ` (reabertura ${h.reabertura})` : '' })) : [{ r: resp[s.id], rot: '' }];
      for (const { r, rot } of respostas) {
        if (typeof r !== 'string' || !r.trim()) continue;
        // O chefe grava a resposta com rótulos ("escopo: ...", "linha de ataque: ..."): vale o trecho
        // inteiro ou o que vem depois do rótulo.
        const trechos = r.split('|').flatMap((x) => [x, x.includes(':') ? x.slice(x.indexOf(':') + 1) : '']).map((x) => normal(x)).filter((x) => x.length >= 8);
        const achado = trechos.some((x) => falas.includes(x.slice(0, 40)));
        checks.push(achado ? chk('passa', `${s.id}${rot}: a resposta gravada está na fala do profissional (transcrição)`) : chk('falha', `${s.id}${rot}: a resposta gravada não aparece na fala do profissional (transcrição): "${r.slice(0, 60)}"`));
      }
    }
    tambem = null;
  }
  return { checks, tambem };
}

function premissaD3(ctx) {
  const lacos = todosOsLacos(ctx.review);
  if (!lacos.length) return { checks: [chk(ctx.review ? 'nao_se_aplica' : 'sem_dado', ctx.review ? 'review-state sem laço' : 'run sem review-state.json')] };
  const checks = [];
  const escaladasNoRun = [...(ctx.run?.escaladas_historico || []).map((e) => e.step), ...Object.keys(ctx.run?.checkpoints || {}).filter((k) => /(?:^|[-_.])escala/i.test(k))];
  for (const { gate, laco } of lacos) {
    const cycles = Array.isArray(laco.cycles) ? laco.cycles : [];
    const max = Number.isInteger(laco.maxCycles) ? laco.maxCycles : null;
    const nome = `${gate}/${laco.loop || '?'}${laco.aberto_em ? ` (${laco.aberto_em})` : ''}`;
    const problemas = [];
    if (max !== null && cycles.length > max) problemas.push(`${cycles.length} ciclos com teto ${max}`);
    for (const c of cycles) {
      const d = c.decision || {};
      const teto = Number.isInteger(d.maxCycles) ? d.maxCycles : max;
      const rejeitou = String(d.verdict || '').toUpperCase() === 'REJECT';
      if (teto !== null && c.cycle >= teto && rejeitou && d.action !== 'escalate') problemas.push(`ciclo ${c.cycle} no teto ${teto} reprovado com action "${d.action}" em vez de escalate`);
      if (d.action === 'escalate') {
        if (!laco.resolucao && ctx.run?.status === 'completed' && laco.status === 'escalated') problemas.push(`escalou no ciclo ${c.cycle} (${d.reason}) e o run fechou sem a decisão do profissional (gate-decisao)`);
        else if (laco.resolucao && !escaladasNoRun.length) problemas.push(`escalou no ciclo ${c.cycle} e a resposta do profissional não está em ${ctx.rel(ctx.runArquivo)} (escaladas_historico)`);
      }
    }
    checks.push(problemas.length ? chk('falha', `${nome}: ${problemas.join('; ')}`) : chk('passa', `${nome}: ${cycles.length}/${max ?? '?'} ciclo(s), ${laco.status}${laco.resolucao ? `, decisão do profissional "${laco.resolucao.decisao}"` : ''}`));
  }
  return { checks };
}

function premissaD4(ctx) {
  // O `init --run` logo depois do `reabrir` é a reabertura, não queda de sessão (squad-state).
  const retomadas = (Array.isArray(ctx.run?.retomadas) ? ctx.run.retomadas : []).filter((r) => r && r.motivo !== 'reabertura');
  if (!retomadas.length) return { checks: [], pendente: 'roteiro', conferir: 'interromper a sessão no meio do run e retomar: o run-status devolve o run_id e o step, o init --run continua a mesma pasta, e nada pronto é refeito', nota: `${ctx.rel(ctx.runArquivo)} sem retomadas[] (nenhuma retomada neste run, ou motor anterior ao registro)` };
  const idx = indiceDe(ctx);
  const checks = [];
  for (const r of retomadas) {
    const t = tsMs(r.em);
    const i = indiceDoRegistro(ctx, r.stepId, idx);
    // A reabertura recomeça da redação por desenho: o que vem depois dela não é refazer da retomada.
    const reab = Math.min(...(ctx.run?.reaberturas || []).map((x) => tsMs(x.em)).filter((x) => x !== null && x > t), Infinity);
    const depois = (ctx.run?.steps || []).filter((e) => tsMs(e.startedAt) !== null && tsMs(e.startedAt) >= t && tsMs(e.startedAt) < reab && indiceDoRegistro(ctx, e.stepId, idx) !== undefined);
    const lacos = lacosQueDevolveram(ctx);
    const refeitos = i === undefined ? [] : depois.filter((e) => indiceDoRegistro(ctx, e.stepId, idx) < i && !voltaLegitima(ctx, e, lacos)).map((e) => e.stepId);
    checks.push(i === undefined ? chk('sem_dado', `retomada de ${r.em} sem stepId`) : refeitos.length ? chk('falha', `retomada de ${r.em} em ${r.stepId} refez ${refeitos.join(', ')}`) : chk('passa', `retomada de ${r.em} continuou de ${r.stepId} sem refazer step anterior`));
  }
  return { checks, tambem: 'pendente_roteiro: retomada provocada pelo roteiro' };
}

function premissaD5(ctx) {
  const outDir = join(ctx.squadDir, 'output');
  const checks = [];
  const soltos = ehDir(outDir) ? readdirSync(outDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name) : [];
  checks.push(soltos.length ? chk('falha', `arquivo solto em squads/${ctx.code}/output/ fora de pasta de run: ${soltos.join(', ')}`) : chk('passa', `squads/${ctx.code}/output/ só tem pastas de run e o pacote`));
  const agenteSemVersao = [];
  for (const s of ctx.pipeline.filter((x) => x.type === 'agent')) {
    for (const [g, n] of s.artefatos.map(grupoENome)) if (existe(join(ctx.runDir, g, n)) && !versoesDe(join(ctx.runDir, g)).some((v) => existe(join(ctx.runDir, g, `v${v}`, n)))) agenteSemVersao.push(`${s.id}: ${g ? `${g}/` : ''}${n}`);
  }
  checks.push(agenteSemVersao.length ? chk('falha', `artefato de step de agente fora de pasta de versão: ${agenteSemVersao.join(', ')}`) : chk('passa', 'artefatos dos steps de agente em pastas vN'));
  // Sobrescrita: um arquivo de vK gravado depois que já existia uma versão mais nova no mesmo grupo.
  const sobrescritos = [];
  const grupos = [ctx.runDir, ...readdirSync(ctx.runDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^v\d+$/.test(e.name)).map((e) => join(ctx.runDir, e.name))];
  for (const g of grupos) {
    const vs = versoesDe(g);
    const tempos = new Map(vs.map((v) => [v, readdirSync(join(g, `v${v}`)).filter((f) => !SIDECARS.test(f)).map((f) => ({ f, m: mtimeMs(join(g, `v${v}`, f)) }))]));
    for (let k = 0; k < vs.length; k++) {
      const depois = vs.slice(k + 1).flatMap((v) => tempos.get(v).map((x) => x.m)).filter(Number.isFinite);
      if (!depois.length) continue;
      const primeiroDepois = Math.min(...depois);
      for (const { f, m } of tempos.get(vs[k])) if (m > primeiroDepois + 2000) sobrescritos.push(`${ctx.rel(join(g, `v${vs[k]}`, f))} (gravado ${iso(m)}, depois de v${vs.find((v) => tempos.get(v).some((x) => x.m === primeiroDepois))})`);
    }
  }
  checks.push(sobrescritos.length ? chk('falha', `versão anterior regravada depois de existir uma mais nova: ${sobrescritos.slice(0, 3).join('; ')}`) : chk('passa', 'nenhuma versão regravada depois de existir uma mais nova'));
  return { checks };
}

function premissaE1(ctx, transcricao) {
  if (!transcricao) return { checks: [], pendente: 'avaliador', conferir: 'o chefe se apresenta uma vez, diz o tamanho do caminho e não expõe nome interno de agente, id de step nem script (passe --transcricao para o código conferir)' };
  const i = inicioDoChefe(transcricao);
  const checks = [];
  const apresentacoes = transcricao.slice(Math.max(i, 0)).filter((t) => t.papel === 'assistente' && RE_APRESENTACAO.test(t.texto)).length;
  const retomadas = (ctx.run?.retomadas || []).filter((r) => r && r.motivo !== 'reabertura').length + (ctx.run?.reaberturas || []).length;
  checks.push(i < 0 ? chk('falha', 'transcrição: o chefe não se apresenta ("Aqui é o ...")') : apresentacoes > 1 + retomadas ? chk('falha', `transcrição: ${apresentacoes} apresentações para ${retomadas} retomada(s) e reabertura(s)`) : chk('passa', `transcrição: o chefe se apresenta (turno ${i + 1})`));
  if (i >= 0) {
    const abertura = transcricao[i].texto;
    checks.push(RE_TAMANHO_DO_CAMINHO.test(abertura) ? chk('passa', 'transcrição: a apresentação diz o tamanho do caminho') : chk('falha', 'transcrição: a apresentação não diz quantos passos o run tem'));
  }
  const vaz = vazamentosDeNomeInterno(i >= 0 ? transcricao.slice(i) : transcricao, ctx);
  checks.push(vaz.length ? chk('falha', `transcrição: nome interno na fala do chefe: ${[...new Set(vaz)].slice(0, 5).join(', ')}${vaz.length > 5 ? ` (${vaz.length} ocorrências)` : ''}`) : chk('passa', 'transcrição: nenhum id de agente com hífen, id de step ou nome de script na fala do chefe'));
  return { checks, tambem: 'pendente_avaliador: linguagem de gente' };
}

function premissaPecaNaConversa(transcricao, trecho, quem) {
  if (!transcricao) return null;
  const achadas = pecasNaConversa(trecho);
  return {
    checks: [achadas.length
      ? chk('falha', `transcrição: ${achadas.length} turno(s) do ${quem} com cara de peça (${achadas.map((a) => `turno ${a.i + 1}, ${a.tamanho} caracteres, ${a.cabecalhos} cabeçalhos`).join('; ')})`)
      : chk('passa', `transcrição: nenhum turno do ${quem} com cara de peça (2 ou mais cabeçalhos em mais de 2.500 caracteres)`)],
    tambem: 'pendente_avaliador: leitura humana da conversa',
  };
}

/**
 * Pergunta no meio do run: registrada em `fora_do_fluxo[]`, nada de laço aberto nem step novo
 * logo depois dela (até o próximo registro fora do fluxo, no máximo 3 minutos), que é o que
 * mexer no pipeline deixaria no ledger.
 */
function premissaE2(ctx) {
  const fora = (Array.isArray(ctx.run?.fora_do_fluxo) ? ctx.run.fora_do_fluxo : []).filter((f) => !f.anulado);
  const perguntas = fora.filter((f) => f.tipo === 'pergunta' && tsMs(f.em) !== null);
  if (!perguntas.length) return { checks: [], pendente: 'roteiro', conferir: 'pergunta no meio do run é respondida sem gate-open nem step novo' };
  const lacos = todosOsLacos(ctx.review).map(({ gate, laco }) => ({ gate, em: tsMs(laco.aberto_em) })).filter((l) => l.em !== null);
  const idx = indiceDe(ctx);
  const checks = perguntas.map((p) => {
    const t = tsMs(p.em);
    const seguinte = fora.map((f) => tsMs(f.em)).filter((x) => x !== null && x > t);
    const ate = Math.min(t + 3 * 60000, ...seguinte);
    const abriu = lacos.filter((l) => l.em > t && l.em < ate).map((l) => `laço ${l.gate}`);
    // Step novo é o enxertado ou o que refaz um já feito; o seguinte do pipeline é o run andando.
    const antes = (ctx.run?.steps || []).filter((e) => tsMs(e.startedAt) !== null && tsMs(e.startedAt) <= t).map((e) => indiceDoRegistro(ctx, e.stepId, idx)).filter((x) => x !== undefined);
    const ondeEstava = antes.length ? Math.max(...antes) : -1;
    const passou = (ctx.run?.steps || []).filter((e) => tsMs(e.startedAt) > t && tsMs(e.startedAt) < ate)
      .filter((e) => { const i = indiceDoRegistro(ctx, e.stepId, idx); return i === undefined || i < ondeEstava; }).map((e) => `step ${e.stepId}`);
    const rot = `pergunta de ${p.em} ("${String(p.resumo || '').slice(0, 40)}")`;
    return abriu.length || passou.length ? chk('falha', `${rot}: logo depois, ${[...abriu, ...passou].join(', ')}`) : chk('passa', `${rot}: respondida sem laço aberto nem step novo logo depois`);
  });
  return { checks, tambem: 'pendente_roteiro: a resposta não muda o pipeline' };
}

function premissaE3(ctx) {
  const fora = (Array.isArray(ctx.run?.fora_do_fluxo) ? ctx.run.fora_do_fluxo : []).filter((f) => !f.anulado);
  const correcoes = fora.filter((f) => f.tipo === 'correcao');
  if (!correcoes.length) return { checks: [], pendente: 'roteiro', conferir: 'mandar uma correção de fato no meio do run e ver o gate-open no ledger, no step que consumiu o fato', nota: fora.length ? `${fora.length} registro(s) fora do fluxo, nenhum de correção` : `${ctx.rel(ctx.runArquivo)} sem fora_do_fluxo[] (nenhum pedido fora do fluxo registrado)` };
  const lacos = lacosDoGate(ctx.review, 'revisao');
  const concluido = ctx.run?.status === 'completed';
  const checks = correcoes.map((c) => {
    // Correção antes da redação: fix pendente, entregue pelo `step` da redação, sem laço (achados 24 e 25 do run de 01/10/2026).
    if (c.fix) {
      const rot = `correção de ${c.em} ("${String(c.resumo || '').slice(0, 40)}")`;
      if (c.entregue_em) return chk('passa', `${rot}: antes da redação, fix entregue a ${c.entregue_a || 'redação'} em ${c.entregue_em}, sem gastar ciclo da revisão`);
      return chk(concluido ? 'falha' : 'sem_dado', `${rot}: fix pendente ${concluido ? 'nunca entregue à redação' : 'ainda não entregue (a redação não começou)'}`);
    }
    const t = tsMs(c.em);
    const aberto = lacos.find((l) => tsMs(l.aberto_em) !== null && tsMs(l.aberto_em) >= t - 1000);
    return aberto ? chk('passa', `correção de ${c.em} ("${String(c.resumo || '').slice(0, 40)}"): laço de revisão aberto em ${aberto.aberto_em} para ${aberto.target}`) : chk('falha', `correção de ${c.em} ("${String(c.resumo || '').slice(0, 40)}") sem laço de revisão aberto depois dela`);
  });
  return { checks, tambem: 'pendente_roteiro: o fix vai ao step que consumiu o fato' };
}

function premissaE4(ctx) {
  const fora = (Array.isArray(ctx.run?.fora_do_fluxo) ? ctx.run.fora_do_fluxo : []).filter((f) => !f.anulado);
  const novos = fora.filter((f) => f.tipo === 'pedido-novo');
  if (!novos.length) return { checks: [], pendente: 'roteiro', conferir: 'mandar um pedido novo no meio do run ("faz a notificação também"): nenhum step enxertado, e o chefe termina ou pergunta se aborta' };
  const idx = indiceDe(ctx);
  const enxertos = (ctx.run?.steps || []).filter((e) => indiceDoRegistro(ctx, e.stepId, idx) === undefined);
  const checks = [enxertos.length ? chk('falha', `pedido novo registrado e step fora do pipeline no ledger: ${enxertos.map((e) => e.stepId).join(', ')}`) : chk('passa', `${novos.length} pedido(s) novo(s) registrado(s) e nenhum step enxertado`)];
  // O pedido deixado para depois é oferecido na entrega (`pedidos-novos --oferecidos`, achado 26 do run de 01/10/2026).
  const comRegistro = novos.filter((f) => 'pendente' in f || f.oferecido_em);
  if (comRegistro.length) {
    const nao = comRegistro.filter((f) => !f.oferecido_em);
    const concluido = ctx.run?.status === 'completed';
    checks.push(nao.length
      ? chk(concluido ? 'falha' : 'sem_dado', `pedido novo ${concluido ? 'não oferecido na entrega' : 'pendente (o run ainda não entregou)'}: ${nao.map((f) => `"${String(f.resumo || '').slice(0, 40)}"`).join(', ')}`)
      : chk('passa', `pedido(s) novo(s) oferecido(s) na entrega: ${comRegistro.map((f) => `"${String(f.resumo || '').slice(0, 40)}" (${f.oferecido_em}, resposta "${String(f.resposta_oferta || '').slice(0, 40)}")`).join(', ')}`));
  }
  return { checks, tambem: 'pendente_roteiro: o chefe termina ou pergunta se aborta e devolve ao roteamento' };
}

const NIVEIS = ['M0', 'M1', 'M2', 'M3', 'M4'];
function premissaE5(ctx) {
  const checks = [];
  const nivel = ctx.squadYaml.match(/^chefe:\s*\n(?:\s+.+\n)*?\s+autonomia_max:\s*["']?(M\d)["']?/m)?.[1] || null;
  checks.push(nivel && !NIVEIS.includes(nivel) ? chk('falha', `squad.yaml chefe.autonomia_max "${nivel}" inválido`) : chk('passa', `autonomia vigente ${nivel || 'M2 (padrão)'}`));
  const m4 = protocoloOuEnvio(ctx);
  checks.push(m4);
  return { checks, tambem: 'pendente_avaliador: nenhuma ação acima do nível vigente na conversa' };
}

/** Sinal de ato M4 (protocolar, enviar, assinar, publicar) nos registros do run. */
function protocoloOuEnvio(ctx) {
  const textos = [...Object.values(ctx.run?.checkpoints || {}), ...(ctx.run?.fora_do_fluxo || []).map((f) => f.resumo || '')].map(normal);
  const ato = textos.find((t) => /\b(?:protocolei|protocolad[oa] (?:no|em)|peticionad[oa] (?:no|em)|e-?mail enviado|enviei (?:ao|a|para) (?:cliente|juizo|tribunal)|assinei)\b/.test(t));
  const recibo = arquivosSob(ctx.runDir).map((p) => basename(p)).find((n) => /(?:recibo|comprovante)-de-(?:protocolo|envio)|protocolo-realizado/i.test(n));
  if (ato || recibo) return chk('falha', `sinal de ato M4 no run: ${ato ? `"${ato.slice(0, 60)}"` : recibo}`);
  return chk('passa', 'nenhum registro de protocolo, envio ou assinatura nos checkpoints nem recibo no output do run');
}

function premissasF(ctx) {
  const reab = Array.isArray(ctx.run?.reaberturas) ? ctx.run.reaberturas : [];
  if (!reab.length) {
    const na = { checks: [chk('nao_se_aplica', `${ctx.rel(ctx.runArquivo)} sem reaberturas[]: o run não foi reaberto`)] };
    return {
      F1: { ...na, tambem: 'pendente_roteiro: pedido de forma depois da entrega' },
      F2: { ...na, tambem: 'pendente_roteiro: pedido de mérito depois da entrega' },
      F3: na,
      F4: { checks: [], pendente: 'roteiro', conferir: 'pedido com documento novo depois da entrega: o reabrir recusa (fato novo é run novo)' },
      F5: na,
    };
  }
  const idx = indiceDe(ctx);
  const redacao = stepDeRedacao(ctx);
  const revisor = ctx.pipeline.find((s) => s.on_reject);
  const conferencia = ctx.pipeline.find((s) => Number(s.citation_verifiers) > 0);
  const aprovacao = [...ctx.pipeline].reverse().find(ehCheckpoint);
  const fim = tsMs(ctx.run?.endedAt);
  const out = { F1: { checks: [] }, F2: { checks: [] }, F3: { checks: [] }, F5: { checks: [] } };
  reab.forEach((r, k) => {
    const t = tsMs(r.em);
    const proxima = reab[k + 1] ? tsMs(reab[k + 1].em) : Infinity;
    const passos = (ctx.run?.steps || []).filter((e) => { const s = tsMs(e.startedAt); return s !== null && s >= t && s < proxima; }).map((e) => e.stepId);
    const rot = `reabertura ${r.numero || k + 1} (${r.modo}, ${r.em})`;
    const concluiu = fim !== null && fim > t;
    // Cada reabertura com a própria janela (até a próxima): a resposta, a final e a meta dela.
    const hist = Array.isArray(ctx.run?.checkpoints_historico) ? ctx.run.checkpoints_historico : null;
    const aprovouDeNovo = aprovacao && (hist
      ? hist.some((h) => h.step === aprovacao.id && tsMs(h.em) > t && tsMs(h.em) < proxima)
      : tsMs(ctx.run?.checkpoints_em?.[aprovacao.id]) > t);
    const v0 = Number(String(r.versao_anterior || '').replace(/^v/, '')) || 0;
    const final = finalNaJanela(ctx, t, proxima);
    const novaFinal = final && final.versao > v0 && existe(`${final.caminho}.citation-gate.json`);
    const lacosRev = lacosDoGate(ctx.review, 'revisao').filter((l) => tsMs(l.aberto_em) !== null && tsMs(l.aberto_em) >= t - 1000 && tsMs(l.aberto_em) < proxima);
    const alvo = r.modo === 'ajustes' ? out.F1 : out.F2;
    const outro = r.modo === 'ajustes' ? out.F2 : out.F1;
    outro.checks.push(chk('nao_se_aplica', `${rot}: modo ${r.modo}`));
    if (!concluiu) { alvo.checks.push(chk('sem_dado', `${rot}: o run reaberto ainda não fechou`)); out.F3.checks.push(chk('sem_dado', `${rot}: em andamento`)); return; }
    const faltas = [];
    if (redacao && !passos.includes(redacao.id)) faltas.push(`sem o step de redação ${redacao.id}`);
    if (conferencia && !passos.includes(conferencia.id)) faltas.push(`sem a conferência ${conferencia.id}`);
    if (!novaFinal) faltas.push(`sem final nova com manifesto acima de ${r.versao_anterior || 'v0'}`);
    if (!aprovouDeNovo) faltas.push(`sem nova resposta na parada ${aprovacao?.id}`);
    if (r.modo === 'revisao') {
      const humano = lacosRev.some((l) => (l.cycles || []).some((c) => (c.verdicts || []).some((v) => v.reviewer === 'profissional' && v.verdict === 'REJECT' && (v.fixes || []).some((f) => normal(f).includes(normal(r.pedido).slice(0, 30))))));
      if (!humano) faltas.push('sem o fix de origem humana (reviewer profissional com o pedido) num laço de revisão aberto depois da reabertura');
      if (revisor && !passos.includes(revisor.id)) faltas.push(`sem o revisor ${revisor.id}`);
      const meta = arquivosSob(join(ctx.runDir, '_meta')).some((p) => mtimeMs(p) > t && mtimeMs(p) < proxima);
      if (!meta) faltas.push('sem Verificação da Meta depois da reabertura (_meta/)');
    }
    alvo.checks.push(faltas.length ? chk('falha', `${rot}: ${faltas.join('; ')}`) : chk('passa', `${rot}: ${passos.join(' > ')}; final v${final.versao} com manifesto; aprovação de novo`));
    const anteriores = passos.filter((id) => redacao && idx.get(id) < idx.get(redacao.id));
    const errados = [];
    if (r.modo === 'ajustes' && revisor && passos.includes(revisor.id) && !lacosRev.length) errados.push(`o revisor ${revisor.id} rodou num ajuste de forma sem laço de revisão aberto`);
    if (anteriores.length && !/\b(?:fato|documento|prova|cita|sumula|tema|precedente|jurisprud)/.test(normal(r.pedido))) errados.push(`rodaram steps anteriores à redação (${anteriores.join(', ')}) para um pedido que não é de fato nem de citação`);
    if (redacao && !passos.includes(redacao.id)) errados.push('o redator não rodou');
    out.F3.checks.push(errados.length ? chk('falha', `${rot}: ${errados.join('; ')}`) : chk('passa', `${rot}: rodaram ${passos.join(', ')}`));
    const guardado = join(ctx.squadDir, 'output', 'pacote', ctx.runId, 'anteriores', `r${r.numero || k + 1}`);
    const termo = lerTexto(join(ctx.squadDir, 'output', 'pacote', ctx.runId, 'TERMO-DE-CONFERENCIA.md')) || '';
    out.F5.checks.push(ehDir(guardado) && readdirSync(guardado).length ? chk('passa', `${rot}: pacote anterior em ${ctx.rel(guardado)}`) : chk('falha', `${rot}: sem o pacote anterior em ${ctx.rel(guardado)}`));
    out.F5.checks.push(/Revis(?:õ|o)es depois da entrega/.test(termo) ? chk('passa', `${rot}: TERMO-DE-CONFERENCIA.md com "Revisões depois da entrega"`) : chk('falha', `${rot}: TERMO-DE-CONFERENCIA.md sem "Revisões depois da entrega"`));
  });
  // F4: cada reabertura só vale com os autos como estavam no começo do run. A comparação é com a
  // hora de cada reabertura: documento que chegou depois da última (o pedido seguinte, recusado
  // como fato novo) não acusa a reabertura que veio antes dele (m1 e m4, 01/10/2026).
  const ini = inicioDoRun(ctx);
  const indice = ctx.autosDir ? lerTexto(join(ctx.autosDir, '_index.yaml')) : null;
  const mtimes = indice && ini !== null ? [...indice.matchAll(/^\s+mtime:\s*"?([^"\n]+)"?/gm)].map((m) => tsMs(m[1])).filter((m) => m !== null && m > ini) : [];
  const F4 = { checks: [], tambem: 'pendente_roteiro: pedido com documento novo é recusado' };
  reab.forEach((r, k) => {
    const t = tsMs(r.em);
    const rot = `reabertura ${r.numero || k + 1} (${r.em})`;
    const antes = t === null ? [] : mtimes.filter((m) => m <= t);
    F4.checks.push(antes.length ? chk('falha', `${rot}: ${antes.length} documento(s) dos autos mais novo(s) que o começo do run e anterior(es) à reabertura`) : chk('passa', `${rot}: autos inalterados desde o começo do run`));
  });
  const depois = mtimes.filter((m) => reab.every((r) => tsMs(r.em) !== null && m > tsMs(r.em)));
  if (depois.length) F4.checks.push(chk('passa', `${depois.length} documento(s) dos autos chegaram depois da última reabertura: run novo, se houver, não esta reabertura`));
  return { F1: { ...out.F1, tambem: 'pendente_roteiro' }, F2: { ...out.F2, tambem: 'pendente_roteiro' }, F3: out.F3, F4, F5: out.F5 };
}

function lerIndice(ctx) {
  if (!ctx.autosDir) return null;
  try { return lerIndiceYaml(lerTexto(join(ctx.autosDir, '_index.yaml')) || ''); } catch { return null; }
}

const leAutos = (ctx) => !/^le_autos:\s*false/m.test(ctx.squadYaml);

function premissaG1(ctx) {
  if (!ctx.autosDir) return { checks: [chk(leAutos(ctx) && existe(join(ctx.squadDir, 'caso.json')) ? 'falha' : 'nao_se_aplica', `squad sem pasta de autos (${posix(relative(ctx.raiz, pastaDeAutos(ctx.squadDir)))})`)] };
  const indice = lerIndice(ctx);
  if (!indice) return { checks: [chk('falha', `${ctx.rel(ctx.autosDir)}/_index.yaml ausente ou ilegível: autos não indexados`)] };
  const cob = cobertura(indice);
  const checks = [];
  if (!cob.semTexto) checks.push(chk('passa', `${ctx.rel(ctx.autosDir)}/_index.yaml: ${cob.comTexto} de ${cob.paginas} página(s) com texto`));
  else {
    const intake = lerTexto(join(ctx.runDir, 'intake.md')) || '';
    const avisou = /sem texto|lidas? por imagem|n[ãa]o lidas?/i.test(intake);
    checks.push(avisou ? chk('passa', `${cob.semTexto} página(s) sem texto (${cob.faixas.join('; ')}), com aviso no intake.md`) : chk('falha', `${cob.semTexto} página(s) sem texto (${cob.faixas.join('; ')}) e o intake.md não avisa`));
  }
  const pdfSemConversao = (indice.documentos || []).filter((d) => d.texto && d.texto !== 'nao-pdf' && !d.markdown).map((d) => d.arquivo);
  checks.push(pdfSemConversao.length ? chk('falha', `PDF sem conversão em Markdown (documento.md): ${pdfSemConversao.join(', ')}`) : chk('passa', 'todo PDF do índice convertido em documento.md'));
  return { checks };
}

function premissaG2(ctx) {
  if (!ctx.autosDir) return { checks: [chk('nao_se_aplica', 'squad sem pasta de autos')] };
  const inv = inventarioDeImagens(ctx.autosDir);
  const plano = planoDeIntegracao(ctx.autosDir);
  const checks = [];
  if (!inv.total) checks.push(chk('nao_se_aplica', 'os autos não têm imagem a descrever'));
  else {
    checks.push(inv.total - inv.descritas ? chk('falha', `${inv.total - inv.descritas} de ${inv.total} imagem(ns) sem descrição`) : chk('passa', `${inv.total} imagem(ns), todas descritas`));
    checks.push(plano.nao_integradas || plano.recusadas.length ? chk('falha', `descrições fora do documento.md: ${plano.nao_integradas} não integradas, ${plano.recusadas.length} recusadas`) : chk('passa', 'todas as descrições integradas ao documento.md (ou ao _imagens-avulsas.md)'));
    if (inv.passada_de_figuras.length) checks.push(chk('falha', `conversão sem a passada de figuras: ${inv.passada_de_figuras.join(', ')}`));
  }
  const final = pecaFinal(ctx);
  if (final) {
    const texto = lerTexto(final.caminho) || '';
    const citaDescricao = /descri[çc][ãa]o por modelo de vis[ãa]o|_sumario\/imagens\//i.test(texto);
    checks.push(citaDescricao ? chk('falha', `${ctx.rel(final.caminho)} cita a descrição da imagem, não a folha`) : chk('passa', 'a peça final não cita a descrição da imagem'));
  }
  return { checks, tambem: 'pendente_avaliador: a descrição é prova e a peça usa a foto pela folha' };
}

function premissaG3(ctx) {
  if (!ctx.autosDir) return { checks: [chk('nao_se_aplica', 'squad sem pasta de autos')] };
  const st = statusDoSumario(ctx.autosDir);
  return { checks: [st.em_dia && !st.imagens_pendentes && !st.imagens_novas ? chk('passa', `${ctx.rel(ctx.autosDir)}/_sumario: ${st.motivo.split(';')[0]} (${st.folhas_citadas} folha(s) citadas)`) : chk('falha', `${ctx.rel(ctx.autosDir)}/_sumario: ${st.motivo}`)] };
}

const MARCADOR_DE_CITACAO = (m) => !DATA_MARKER.test(m) && !/^\[TEMA/.test(m);

function premissaH1(ctx) {
  const final = pecaFinal(ctx);
  if (!final) return { checks: [chk(ctx.pipeline.some((s) => Number(s.citation_verifiers) > 0) ? 'falha' : 'nao_se_aplica', 'nenhuma peça final no run')] };
  const checks = [];
  const man = lerJson(`${final.caminho}.citation-gate.json`);
  if (!man) return { checks: [chk('falha', `${ctx.rel(final.caminho)} sem o manifesto .citation-gate.json`)] };
  const sha = sha256(final.caminho);
  checks.push(man.artifact_sha256 === sha ? chk('passa', `manifesto confere com a final (sha256 ${sha.slice(0, 12)}…)`) : chk('falha', `manifesto com sha256 ${String(man.artifact_sha256).slice(0, 12)}…, a final tem ${String(sha).slice(0, 12)}…`));
  const cits = Array.isArray(man.citations) ? man.citations : [];
  const ruins = cits.filter((c) => !['verificada', 'verificada_no_acervo'].includes(c.status));
  const semEvid = cits.filter((c) => !c.evidence || !(c.evidence.sha256_texto || c.evidence.sha256_bytes || c.evidence.trecho));
  const conta = cits.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] || 0) + 1 }), {});
  checks.push(ruins.length ? chk('falha', `citações não conferidas no manifesto: ${ruins.map((c) => `${c.title} (${c.status})`).join(', ')}`) : chk('passa', `${cits.length} citação(ões) no manifesto: ${Object.entries(conta).map(([s, n]) => `${n} ${s}`).join(', ')}${semEvid.length ? `; ${semEvid.length} sem evidência` : ''}`));
  const contestadas = Object.values(ctx.review?.citacoes?.contestadas || {});
  const doTexto = new Set(cits.map((c) => normal(c.title)));
  const contraFinal = contestadas.filter((c) => doTexto.has(normal(c.title || '')) || c.status === 'cancelada');
  checks.push(contraFinal.length ? chk('falha', `cartório com citação da final contestada ou cancelada: ${contraFinal.map((c) => `${c.title} (${c.status})`).join(', ')}`) : chk('passa', `cartório sem contestada nem cancelada (${Object.keys(ctx.review?.citacoes?.verificadas || {}).length} verificadas)`));
  const texto = lerTexto(final.caminho) || '';
  const marcadores = (texto.match(new RegExp(PENDING_MARKER.source, 'g')) || []).filter(MARCADOR_DE_CITACAO);
  checks.push(marcadores.length ? chk('falha', `marcador de citação na final: ${[...new Set(marcadores)].slice(0, 3).join(', ')}`) : chk('passa', 'nenhum marcador de citação pendente na final'));
  return { checks };
}

const PERSUASAO_POR_RITMO = { rapido: false, equilibrado: true, completo: true };

function premissaH3(ctx) {
  const checks = [];
  const reader = escalarTopo(ctx.squadYaml, 'reader') || 'juiz';
  const fechou = (l) => ['approved', 'closed', 'aceito-com-ressalvas'].includes(l.status);
  const ressalvaOk = (l) => l.status !== 'aceito-com-ressalvas' || (l.resolucao && Array.isArray(l.resolucao.pendentes));
  // Redação Gate: laço próprio, ou voz `redacao-gate` no laço de revisão.
  const redacao = lacosDoGate(ctx.review, 'redacao');
  const vozNaRevisao = lacosDoGate(ctx.review, 'revisao').some((l) => (l.cycles || []).some((c) => (c.verdicts || []).some((v) => v.reviewer === 'redacao-gate')));
  if (redacao.length) {
    const ultimo = redacao.at(-1);
    checks.push(fechou(ultimo) && ressalvaOk(ultimo) ? chk('passa', `Redação Gate: laço ${ultimo.status}${ultimo.resolucao ? ` (decisão "${ultimo.resolucao.decisao}" do ${ultimo.resolucao.por}, ${ultimo.resolucao.pendentes.length} ressalva(s))` : ''}`) : chk('falha', `Redação Gate: laço ${ultimo.status} sem conclusão registrada`));
  } else if (vozNaRevisao) checks.push(chk('passa', 'Redação Gate votou no laço de revisão'));
  else if (ctx.pipeline.some((s) => s.type === 'agent' && s.on_reject === undefined && ctx.pipeline.some((r) => r.on_reject === s.id))) checks.push(chk('sem_dado', 'nenhum registro do Redação Gate no review-state (run anterior ao registro do APPROVE de primeira, ou o gate não rodou)'));
  else checks.push(chk('nao_se_aplica', 'squad sem step de redação revisado: o Redação Gate não roda'));
  // Gate de Sobrevivência ao Resumo.
  const ritmo = ctx.run?.ritmo || null;
  const ajuste = ctx.run?.ritmo_ajustes?.persuasao;
  const ligado = !['contraparte', 'publico'].includes(reader) && (ajuste !== undefined ? ajuste === true || ajuste === 'sim' : (ritmo ? PERSUASAO_POR_RITMO[ritmo] !== false : true));
  if (!ligado) checks.push(chk('nao_se_aplica', `Sobrevivência ao Resumo desligada (reader ${reader}, ritmo ${ritmo || '?'})`));
  else {
    const pers = lacosDoGate(ctx.review, 'persuasao');
    const ultimo = pers.at(-1);
    const carimbo = ctx.review?.persuasao_carimbo;
    if (ultimo) checks.push(fechou(ultimo) && ressalvaOk(ultimo) ? chk('passa', `Sobrevivência ao Resumo: laço ${ultimo.status}${carimbo ? `, carimbo em ${carimbo.registrado_em}` : ''}`) : chk('falha', `Sobrevivência ao Resumo: laço ${ultimo.status} sem conclusão`));
    else if (carimbo) checks.push(chk('passa', `Sobrevivência ao Resumo aprovada (carimbo ${carimbo.registrado_em})`));
    else checks.push(chk('falha', `Sobrevivência ao Resumo ligada (ritmo ${ritmo || '?'}) e sem laço nem carimbo no review-state`));
  }
  return { checks, falta_gravar: checks.some((c) => c.status === 'sem_dado') ? 'o Redação Gate aprovado na primeira passada (ok: true) registrado no ledger (gate-verdict --reviewer redacao-gate --verdict APPROVE)' : undefined };
}

function premissaH4(ctx) {
  const criterios = (ctx.squadYaml.match(/^success_criteria:\s*\n((?:\s+-\s+.+\n?)+)/m)?.[1] || '').split('\n').filter((l) => /^\s+-\s+/.test(l));
  if (!criterios.length) return { checks: [chk('nao_se_aplica', 'squad.yaml sem success_criteria: a Verificação da Meta não roda')] };
  const metaDir = join(ctx.runDir, '_meta');
  // Com o meta-despacho (0.9.8x), a rodada que vale é o último registro `meta-despacho-<rodada>.json`:
  // as saídas dele (com o desempate) e as vozes que o ritmo pagou (`exigidos`), não o teto do squad
  // (achado do run m8, 05/10/2026: `avaliacao-m-3-1.json` não casava com o padrão antigo).
  const registros = ehDir(metaDir) ? readdirSync(metaDir).filter((f) => /^meta-despacho-.+\.json$/.test(f)).map((f) => lerJson(join(metaDir, f))).filter((r) => r && Array.isArray(r.saidas)) : [];
  const ultimo = registros.sort((a, b) => (tsMs(a.criado_em) ?? 0) - (tsMs(b.criado_em) ?? 0)).at(-1);
  let avals;
  let exigidos = Number(escalarTopo(ctx.squadYaml, 'meta_verifiers')) || 1;
  let deRegistro = false;
  if (ultimo) {
    const arqs = ultimo.saidas.map((x) => x.arquivo).filter(Boolean).map((a) => [join(ctx.raiz, a), join(metaDir, basename(a))].find((p) => existe(p)) ).filter(Boolean);
    const desempate = ultimo.desempate && existe(join(metaDir, `avaliacao-${ultimo.rodada}-desempate.json`)) ? [join(metaDir, `avaliacao-${ultimo.rodada}-desempate.json`)] : [];
    avals = [...arqs, ...desempate].map((p) => basename(p));
    if (Number(ultimo.exigidos) > 0) exigidos = Number(ultimo.exigidos);
    deRegistro = true;
  } else {
    // Run reaberto: a meta da última reabertura (`avaliacao-r{N}-{k}`) é a da final que ficou.
    const todas = ehDir(metaDir) ? readdirSync(metaDir).map((f) => ({ f, m: f.match(/^avaliacao-(?:r(\d+)-)?\d+\.(?:json|md)$/) })).filter((x) => x.m) : [];
    const rodada = Math.max(0, ...todas.map((x) => Number(x.m[1] || 0)));
    avals = todas.filter((x) => Number(x.m[1] || 0) === rodada).map((x) => x.f).sort();
  }
  const checks = [];
  if (!avals.length) return { checks: [chk(ctx.run?.status === 'completed' ? 'falha' : 'sem_dado', `nenhuma avaliação em ${ctx.rel(metaDir)}/`)] };
  checks.push(avals.length >= exigidos ? chk('passa', `${avals.length} avaliação(ões) da meta (${deRegistro ? `rodada ${ultimo.rodada}, ${exigidos} voz(es) pelo ritmo` : `meta_verifiers ${exigidos}`})`) : chk('falha', `${avals.length} avaliação(ões) da meta, o squad exige ${exigidos}`));
  const final = pecaFinal(ctx);
  const script = scriptSquadState(ctx);
  if (!script) checks.push(chk('sem_dado', 'squad-state.mjs não encontrado: o consenso não foi recalculado'));
  else {
    const args = [script, 'meta-consenso', ctx.squadDir, '--sem-gravar', ...avals.flatMap((a) => ['--avaliacao', join(metaDir, a)]), ...(final && existe(`${final.caminho}.citation-gate.json`) ? ['--manifesto', `${final.caminho}.citation-gate.json`] : [])];
    const r = spawnSync(process.execPath, args, { cwd: ctx.raiz, encoding: 'utf8', timeout: 120000 });
    let c = null;
    try { c = JSON.parse(r.stdout); } catch { /* saída não é JSON */ }
    if (!c) checks.push(chk('sem_dado', `meta-consenso não devolveu JSON: ${(r.stderr || '').split('\n')[0]}`));
    else if (c.acao === 'concluir' || c.acao === 'apresentar-falhas') {
      const porCriterio = (c.criterios || []).every((x) => x.veredito);
      checks.push(porCriterio && Number.isFinite(c.nota) ? chk(c.verdict === 'APROVADO' ? 'passa' : 'falha', `meta recalculada por código: nota ${c.nota}, ${c.atendidos}/${c.total} ATENDE, ${c.verdict} (${c.limiar_fonte})`) : chk('falha', 'meta sem veredito por critério ou sem nota'));
      const gravado = lerJson(join(metaDir, deRegistro ? `meta-consenso-${ultimo.rodada}.json` : 'consenso.json'));
      if (gravado && (gravado.nota !== c.nota || gravado.verdict !== c.verdict)) checks.push(chk('falha', `_meta/consenso.json diz nota ${gravado.nota} ${gravado.verdict}, o recálculo dá ${c.nota} ${c.verdict}`));
    } else checks.push(chk('falha', `meta-consenso: ${c.acao} (${c.detalhe || c.motivo || 'avaliação fora do formato'})`));
  }
  const ind = notaIndependente(ctx, metaDir, final);
  checks.push(ind.check);
  return { checks, falta_gravar: ind.check.status === 'sem_dado' ? 'nota independente pelo gabarito ao lado da meta (_meta/nota-independente.json com nota, avaliador, data e arquivo avaliado)' : undefined };
}

/**
 * `_meta/nota-independente.json`, gravado à mão depois da avaliação pelo gabarito:
 * `{ "nota": 0-100, "avaliador": "...", "data": "AAAA-MM-DD", "arquivo": "<a peça avaliada>" }`.
 * O arquivo é relativo à raiz do projeto, à pasta do squad, à do run ou absoluto; tem de ser a
 * final do run (mesmo conteúdo), senão a nota é de outra versão.
 */
function notaIndependente(ctx, metaDir, final) {
  const caminho = join(metaDir, 'nota-independente.json');
  if (!existe(caminho)) return { check: chk('sem_dado', `nenhuma nota independente pelo gabarito em ${ctx.rel(metaDir)}/ (nota-independente.json)`) };
  const n = lerJson(caminho);
  if (!n) return { check: chk('falha', `${ctx.rel(caminho)} não é JSON legível`) };
  const erros = [];
  const nota = Number(n.nota);
  if (n.nota === undefined || n.nota === null || n.nota === '' || !Number.isFinite(nota) || nota < 0 || nota > 100) erros.push('nota de 0 a 100');
  if (!String(n.avaliador || '').trim()) erros.push('avaliador');
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(n.data || '')) || tsMs(String(n.data).slice(0, 10)) === null) erros.push('data AAAA-MM-DD');
  if (!String(n.arquivo || '').trim()) erros.push('arquivo avaliado');
  if (erros.length) return { check: chk('falha', `${ctx.rel(caminho)} sem ${erros.join(', ')}`) };
  const alvo = [n.arquivo, join(ctx.raiz, n.arquivo), join(ctx.squadDir, n.arquivo), join(ctx.runDir, n.arquivo)].find((p) => existe(p) && !ehDir(p));
  if (final) {
    if (alvo && sha256(alvo) !== sha256(final.caminho)) return { check: chk('falha', `nota independente ${nota} de ${n.arquivo}, que não é a final do run (${ctx.rel(final.caminho)})`) };
    if (!alvo && basename(String(n.arquivo)) !== final.nome) return { check: chk('falha', `nota independente ${nota} de ${n.arquivo}, arquivo que não existe e não é a final ${final.nome}`) };
  }
  const meta = lerJson(join(metaDir, 'consenso.json'));
  const lado = meta && Number.isFinite(Number(meta.nota)) ? `; a meta deu ${meta.nota} (diferença ${Math.abs(Number(meta.nota) - nota)})` : '';
  return { check: chk('passa', `nota independente ${nota} por ${n.avaliador} em ${String(n.data).slice(0, 10)} sobre ${alvo ? ctx.rel(alvo) : n.arquivo}${lado}`) };
}

// CPF e CNPJ com dígito verificador válido: os mascarados e os de exemplo grosseiro não contam.
function cpfValido(d) {
  if (/^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
function cnpjValido(d) {
  if (/^(\d)\1{13}$/.test(d)) return false;
  const dv = (n) => { const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = pesos.reduce((a, p, i) => a + p * Number(d[i]), 0); const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
export function documentosPessoais(texto) {
  const achados = [];
  for (const m of String(texto).matchAll(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g)) if (cpfValido(m[0].replace(/\D/g, ''))) achados.push(`CPF ${m[0]}`);
  for (const m of String(texto).matchAll(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g)) if (cnpjValido(m[0].replace(/\D/g, ''))) achados.push(`CNPJ ${m[0]}`);
  return achados;
}

/** Travessão na prosa (fora de blockquote, que é transcrição). */
export function travessoesNaProsa(texto) {
  return String(texto).split('\n').map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*>/.test(l) && l.includes('\u2014')).map(({ i }) => i + 1);
}

function premissaH5(ctx) {
  const final = pecaFinal(ctx);
  if (!final) return { checks: [chk('nao_se_aplica', 'nenhuma peça final no run')] };
  const checks = [protocoloOuEnvio(ctx)];
  const pacote = join(ctx.squadDir, 'output', 'pacote', ctx.runId);
  const entregues = [final.caminho, join(pacote, 'NOTA-AO-REVISOR.md')].filter(existe);
  const travessoes = entregues.flatMap((p) => travessoesNaProsa(lerTexto(p)).map((n) => `${basename(p)}:${n}`));
  checks.push(travessoes.length ? chk('falha', `travessão na prosa entregue: ${travessoes.slice(0, 5).join(', ')}${travessoes.length > 5 ? ` e mais ${travessoes.length - 5}` : ''}`) : chk('passa', `sem travessão na prosa de ${entregues.map((p) => basename(p)).join(' e ')}`));
  const docs = entregues.flatMap((p) => documentosPessoais(lerTexto(p)).map((d) => `${basename(p)}: ${d}`));
  checks.push(docs.length ? chk('falha', `documento pessoal com dígito válido na entrega: ${docs.slice(0, 3).join(', ')}`) : chk('passa', 'nenhum CPF ou CNPJ com dígito válido na entrega'));
  return { checks, tambem: 'pendente_avaliador: dado pessoal real além de CPF e CNPJ (nome, endereço) e ato externo na conversa' };
}

function premissaH6(ctx) {
  const final = pecaFinal(ctx);
  if (!final) return { checks: [chk('nao_se_aplica', 'nenhuma peça final no run')] };
  const pacote = join(ctx.squadDir, 'output', 'pacote', ctx.runId);
  if (!ehDir(pacote)) return { checks: [chk(ctx.run?.status === 'completed' ? 'falha' : 'sem_dado', `${ctx.rel(pacote)}/ não existe`)] };
  const arquivos = readdirSync(pacote);
  const man = lerJson(join(pacote, 'MANIFESTO.json'));
  const base = final.nome.replace(/\.md$/, '');
  const checks = [];
  checks.push(arquivos.includes(`${base}.docx`) ? chk('passa', `${base}.docx no pacote`) : chk('falha', `sem ${base}.docx no pacote`));
  if (arquivos.includes(`${base}.pdf`)) checks.push(chk('passa', `${base}.pdf no pacote`));
  else checks.push(man?.pdf?.gerado === false ? chk('passa', `pdf não gerado, com motivo no MANIFESTO.json: ${man.pdf.motivo}`) : chk('falha', `sem ${base}.pdf e sem motivo no MANIFESTO.json`));
  for (const f of ['TERMO-DE-CONFERENCIA.md', 'ANEXOS.md', 'PROXIMOS-PASSOS.md']) checks.push(arquivos.includes(f) ? chk('passa', `${f} no pacote`) : chk('falha', `sem ${f} no pacote`));
  checks.push(man?.artefato?.sha256 === sha256(final.caminho) ? chk('passa', 'MANIFESTO.json do pacote aponta a final do run (sha256 confere)') : chk('falha', `MANIFESTO.json do pacote aponta ${man?.artefato?.origem || 'nada'}, não a final ${ctx.rel(final.caminho)}`));
  const nota = lerTexto(join(pacote, 'NOTA-AO-REVISOR.md'));
  if (nota === null) checks.push(chk('falha', 'sem NOTA-AO-REVISOR.md no pacote'));
  else if (leAutos(ctx)) checks.push(/Diverg[eê]ncias com o relato/.test(nota) ? chk('passa', 'NOTA-AO-REVISOR.md com "Divergências com o relato"') : chk('falha', 'NOTA-AO-REVISOR.md sem a seção "Divergências com o relato"'));
  return { checks };
}

// ─────────────────────────── montagem ───────────────────────────

/**
 * H7, red-team que muda a peça (m2g da 0.9.83: dois ataques descobertos e um mal respondido, a
 * parada ofereceu "Aprovar e seguir" primeiro e nada mudou). Com a tabela do contraditor no run, o
 * ledger tem de registrar o que ele achou (`red_team`), a oferta tem de recomendar corrigir quando
 * há ataque sem resposta, e cada um desses ataques tem destino: fix de origem humana no laço de
 * revisão, depois da decisão, ou ressalva aceita pelo profissional.
 */
function premissaH7(ctx) {
  const tabela = join(ctx.runDir, 'contraditor.md');
  const rt = ctx.run?.red_team || null;
  if (!rt && !existe(tabela)) return { checks: [chk('nao_se_aplica', 'o red-team não rodou neste run (sem contraditor.md nem red_team no ledger)')] };
  const concluido = ctx.run?.status === 'completed';
  if (!rt) {
    const achados = ataquesDoContraditor(lerTexto(tabela) || '');
    const oferta = ofertaDoRedTeam(achados);
    const sem = achados.filter(ataqueSemResposta);
    return {
      checks: [chk(sem.length ? 'falha' : 'sem_dado', `${ctx.rel(tabela)} com ${achados.length} ataque(s)${sem.length ? `, ${sem.length} sem resposta na peça (a oferta recomendaria ${oferta.recomendacao})` : ''}, e o ledger não registra o que o red-team achou nem o que foi feito com cada ataque`)],
      falta_gravar: 'o retorno do contraditor e a decisão do profissional no ledger (squad-state red-team --retorno e --decisao)',
      ...(sem.length ? { nota: `fix que o primeiro ataque sem resposta teria virado: ${fixDoAtaque(sem[0]).slice(0, 200)}` } : {}),
    };
  }
  const checks = [];
  const sem = (rt.ataques || []).filter(ataqueSemResposta);
  checks.push(sem.length && rt.recomendacao !== 'corrigir'
    ? chk('falha', `${sem.length} ataque(s) sem resposta e a oferta não recomendou corrigir (${rt.recomendacao || 'sem recomendação'})`)
    : chk('passa', `red-team de ${rt.em}: ${(rt.ataques || []).length} ataque(s), ${sem.length} sem resposta; recomendação ${rt.recomendacao}`));
  if (!rt.decisao) {
    checks.push(chk(concluido ? 'falha' : 'sem_dado', `sem decisão do profissional registrada sobre o red-team${concluido ? ' num run concluído' : ''}`));
    return { checks };
  }
  const semDestino = sem.filter((a) => !['fix', 'ressalva'].includes(a.destino));
  if (semDestino.length) checks.push(chk('falha', `ataque(s) sem resposta sem destino (fix ou ressalva): ${semDestino.map((a) => `${a.n} (${a.natureza})`).join(', ')}`));
  if (rt.decisao.decisao === 'corrigir' && sem.length) {
    const t = tsMs(rt.decisao.em);
    const humano = lacosDoGate(ctx.review, 'revisao').some((l) => (l.cycles || []).some((c) => c.origem === 'humana' && (c.verdicts || []).some((v) => v.reviewer === 'profissional' && (v.fixes || []).some((f) => /red-team/.test(String(f))) && (t === null || tsMs(v.em) === null || tsMs(v.em) >= t - 1000))));
    checks.push(humano
      ? chk('passa', `decisão "corrigir" (${rt.decisao.em}): ${sem.length} ataque(s) viraram fix de origem humana no laço de revisão`)
      : chk('falha', `decisão "corrigir" (${rt.decisao.em}) sem ciclo de origem humana com os fixes do red-team no laço de revisão`));
  } else if (sem.length) {
    checks.push(chk('passa', `decisão "${rt.decisao.decisao}" (${rt.decisao.em}): ${sem.length} ataque(s) sem resposta aceitos como ressalva pelo profissional ("${String(rt.decisao.resposta || '').slice(0, 40)}")`));
  } else checks.push(chk('passa', `decisão "${rt.decisao.decisao}": a peça antecipava os ataques`));
  return { checks };
}

function montar(premissa, r) {
  const res = r || { checks: [] };
  const checks = res.checks || [];
  let status;
  if (!checks.length && res.pendente) status = `pendente_${res.pendente}`;
  else status = consolidar(checks);
  return {
    id: premissa.id, bloco: premissa.bloco, titulo: premissa.titulo, verificador: premissa.verificador, status,
    evidencia: checks.find((c) => c.status === status)?.evidencia || res.nota || res.conferir || null,
    checks,
    ...(res.conferir ? { conferir: res.conferir } : {}),
    ...(res.nota && checks.length ? { nota: res.nota } : {}),
    ...(res.tambem ? { tambem: res.tambem } : {}),
    ...(res.limite ? { limite: res.limite } : {}),
    ...(res.falta_gravar && (status === 'sem_dado' || checks.some((c) => c.status === 'sem_dado') || res.pendente) ? { falta_gravar: res.falta_gravar } : {}),
  };
}

/** Audita um run. Devolve o objeto completo (premissas, placar, métricas). Só lê. */
export function auditar(squadArg, { run = null, transcricao = null } = {}) {
  const ctx = carregarRun(squadArg, { run });
  const turnos = transcricao !== null ? lerTranscricao(transcricao) : null;
  const iChefe = turnos ? inicioDoChefe(turnos) : -1;
  const doRoteador = turnos ? (iChefe >= 0 ? turnos.slice(0, iChefe) : turnos) : null;
  const doChefe = turnos ? (iChefe >= 0 ? turnos.slice(iChefe) : []) : null;
  const F = premissasF(ctx);
  const por = {
    A1: () => premissaA1(ctx), A2: () => premissaA2(ctx), A3: () => premissaA3(ctx),
    A4: () => ({ checks: [], pendente: 'roteiro', conferir: 'pedido ambíguo recebe uma pergunta curta, com a opção «nenhum destes: montar com o Arquiteto»' }),
    A5: () => premissaPecaNaConversa(turnos, doRoteador, 'roteador') || { checks: [], pendente: 'avaliador', conferir: 'o roteador não redige peça na conversa (passe --transcricao para a heurística de tamanho e cabeçalho)' },
    B1: () => premissaB1(ctx), B2: () => premissaB2(ctx), B3: () => premissaB3(ctx), B4: () => premissaB4(ctx),
    C1: () => premissaC1(ctx), C2: () => premissaC2(ctx), C3: () => premissaC3(ctx), C4: () => premissaC4(ctx),
    D1: () => premissaD1(ctx), D2: () => premissaD2(ctx, turnos), D3: () => premissaD3(ctx), D4: () => premissaD4(ctx), D5: () => premissaD5(ctx),
    E1: () => premissaE1(ctx, turnos),
    E2: () => premissaE2(ctx),
    E3: () => premissaE3(ctx), E4: () => premissaE4(ctx), E5: () => premissaE5(ctx),
    E6: () => premissaPecaNaConversa(turnos, doChefe, 'chefe') || { checks: [], pendente: 'avaliador', conferir: 'o chefe não redige peça na conversa (passe --transcricao para a heurística de tamanho e cabeçalho)' },
    F1: () => F.F1, F2: () => F.F2, F3: () => F.F3, F4: () => F.F4, F5: () => F.F5,
    G1: () => premissaG1(ctx), G2: () => premissaG2(ctx), G3: () => premissaG3(ctx),
    H1: () => premissaH1(ctx),
    H2: () => ({ checks: [], pendente: 'avaliador', conferir: 'cada citação da final é pertinente ao fato e à relação jurídica do caso (leitura com o gabarito)' }),
    H3: () => premissaH3(ctx), H4: () => premissaH4(ctx), H5: () => premissaH5(ctx), H6: () => premissaH6(ctx), H7: () => premissaH7(ctx),
  };
  const premissas = PREMISSAS.map((p) => {
    let r;
    try { r = por[p.id](); } catch (e) { r = { checks: [chk('sem_dado', `erro ao conferir: ${e.message}`)] }; }
    return montar(p, r);
  });
  const placar = {};
  for (const b of Object.keys(BLOCOS)) {
    placar[b] = Object.fromEntries(STATUS.map((s) => [s, 0]));
    for (const p of premissas.filter((x) => x.bloco === b)) placar[b][p.status] += 1;
  }
  const total = Object.fromEntries(STATUS.map((s) => [s, premissas.filter((p) => p.status === s).length]));
  let metricas;
  try { metricas = medirSquad(ctx.squadDir, { runId: ctx.runId }); } catch { metricas = null; }
  const faltaGravar = premissas.filter((p) => p.falta_gravar).map((p) => ({ id: p.id, gravar: p.falta_gravar }));
  return {
    squad: ctx.code, run_id: ctx.runId, status_do_run: ctx.run?.status || null, auditado_em: new Date().toISOString(),
    transcricao: turnos ? { turnos: turnos.length, chefe_a_partir_do_turno: iChefe >= 0 ? iChefe + 1 : null } : null,
    placar, total, premissas, falta_gravar: faltaGravar,
    metricas: metricas && metricas.medido ? {
      duracao_min: metricas.run.duracaoMin, paradas: metricas.run.paradasHumanas, escaladas: metricas.run.escaladas, espera_humana_min: metricas.run.esperaHumanaMin,
      ciclos_por_gate: Object.fromEntries(Object.entries(metricas.gates || {}).map(([g, v]) => [g, { ciclos: v.ciclos, rejeicoes: v.rejeicoes, lacos: v.lacos }])),
      pendencias_na_entrega: metricas.pendencias.total,
    } : null,
  };
}

const ROTULO = { passa: 'passa', falha: 'FALHA', nao_se_aplica: 'n/a', sem_dado: 'sem dado', pendente_roteiro: 'roteiro', pendente_avaliador: 'avaliador' };

export function paraTexto(a) {
  const L = [`Auditoria das premissas · ${a.squad} · run ${a.run_id} (${a.status_do_run || 'sem status'})`, ''];
  L.push('Placar por bloco (passa / falha / sem dado / roteiro / avaliador / n/a):');
  for (const [b, nome] of Object.entries(BLOCOS)) {
    const p = a.placar[b];
    L.push(`  ${b} ${nome}: ${p.passa} / ${p.falha} / ${p.sem_dado} / ${p.pendente_roteiro} / ${p.pendente_avaliador} / ${p.nao_se_aplica}`);
  }
  const t = a.total;
  L.push(`  Total: ${t.passa} passa, ${t.falha} falha, ${t.sem_dado} sem dado, ${t.pendente_roteiro} roteiro, ${t.pendente_avaliador} avaliador, ${t.nao_se_aplica} n/a`, '');
  for (const p of a.premissas) {
    L.push(`${p.id} [${ROTULO[p.status]}] ${p.titulo}`);
    const mostrar = p.status === 'passa' ? p.checks.filter((x) => x.status === 'passa').slice(0, p.bloco === 'F' ? 4 : 1) : p.checks.filter((x) => x.status !== 'passa').slice(0, 6);
    for (const c of mostrar) L.push(`    ${c.status === 'passa' ? '·' : '✗'} ${c.evidencia}`);
    if (!p.checks.length && (p.conferir || p.nota)) L.push(`    ? ${p.conferir || p.nota}`);
    if (p.tambem) L.push(`    + ${p.tambem}`);
  }
  if (a.falta_gravar.length) {
    L.push('', 'O que o motor precisaria gravar para tirar premissas de "sem dado":');
    for (const f of a.falta_gravar) L.push(`  ${f.id}: ${f.gravar}`);
  }
  if (a.metricas) {
    const m = a.metricas;
    L.push('', `Métricas: ${m.duracao_min ?? 'não medido'} min, ${m.paradas ?? '?'} paradas, ${m.escaladas ?? '?'} escaladas, espera humana ${m.espera_humana_min ?? 'não medida'} min, pendências na entrega ${m.pendencias_na_entrega ?? 'não medido'}`);
    L.push(`  Ciclos: ${Object.entries(m.ciclos_por_gate).map(([g, v]) => `${g} ${v.ciclos} (${v.rejeicoes} REJECT${v.lacos > 1 ? `, ${v.lacos} laços` : ''})`).join(' · ')}`);
  }
  return L.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valor = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
  const pos = args.filter((a, i) => !a.startsWith('--') && !['--run', '--transcricao'].includes(args[i - 1]));
  const dir = pos[0];
  if (!dir) {
    process.stderr.write('uso: auditar-run.mjs squads/<nome> [--run <run_id>] [--json] [--transcricao <arquivo>]\n');
    process.exit(1);
  }
  const arqTranscricao = valor('--transcricao');
  if (args.includes('--transcricao') && !arqTranscricao) { process.stderr.write('auditar-run: --transcricao pede o arquivo da conversa\n'); process.exit(1); }
  const transcricao = arqTranscricao ? lerTexto(resolve(arqTranscricao)) : null;
  if (arqTranscricao && transcricao === null) { process.stderr.write(`auditar-run: transcrição não encontrada: ${arqTranscricao}\n`); process.exit(1); }
  try {
    const a = auditar(dir, { run: valor('--run'), transcricao });
    process.stdout.write(args.includes('--json') ? `${JSON.stringify(a, null, 2)}\n` : `${paraTexto(a)}\n`);
    process.exit(0);
  } catch (e) {
    if (e instanceof ErroDeUso) { process.stderr.write(`auditar-run: ${e.message}\n`); process.exit(1); }
    throw e;
  }
}
