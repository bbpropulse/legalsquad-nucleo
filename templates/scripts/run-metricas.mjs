#!/usr/bin/env node
/**
 * Métricas do run — lidas do LEDGER, nunca de relato.
 *
 * Fase 0 do plano (docs/specs/legalsquad/PLANO-ORQUESTRADOR.md): sem número de
 * partida, toda promessa de produtividade é opinião. Este script lê o que o
 * cartório já grava — `run-state.json` (início, fim, um histórico por step,
 * carimbo de cada checkpoint), `review-state.json` (ciclos e vereditos por gate)
 * e os artefatos em `output/` (marcadores de pendência) — e devolve as medidas
 * que o RELATORIO.md publica na seção "Métricas do run".
 *
 * Duas regras, herdadas do registro de uso de skills:
 * - ausência de medida é `null` e sai como "não medido" — nunca zero inventado;
 * - é consulta, não enforcement: sai sempre com código 0, mesmo sem ledger.
 *
 * Uso:
 *   node scripts/run-metricas.mjs squads/<nome>            # Markdown (para o RELATORIO)
 *   node scripts/run-metricas.mjs squads/<nome> --json     # objeto completo
 *   node scripts/run-metricas.mjs squads/<nome> --agora <ISO>   # "agora" fixo (run em andamento / testes)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mesmo marcador do hook de citações — a pendência que trava a entrega. */
// Marcador de pendência. Duas correções vieram de um run real, e as duas eram
// subnotificação — o pior defeito possível numa métrica de pendência, porque o
// profissional lê "não medido" como "nada pendente" e protocola.
//
// 1. `CONFIRMAR` faltava. É a palavra que um redator alcança primeiro para
//    "isto o advogado tem de confirmar antes de protocolar", e o caso-ouro de um
//    squad em campo já a prescrevia. Mesma família de CONFERIR e A CONFERIR.
// 2. **O marcador com CARGA era invisível.** O regex exigia o colchete fechando
//    logo depois da palavra, então `[CONFERIR: a vara competente]` não casava —
//    e essa forma é estritamente melhor que a nua, porque diz o que conferir.
//    A métrica punia em silêncio a prática melhor. Agora a carga é opcional,
//    aceita depois de dois-pontos, travessão ou hífen.
export const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|CONFIRMAR|A[ _]CONFIRMAR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O)(?:\s*[:—–-][^\]]*)?\]/gi;
/** Tema sem âncora apontado pelo verificador de persuasão — contado à parte (não trava hoje). */
export const TEMA_MARKER = /\[TEMA[ _]A[ _]CONFERIR(?:\s*[:—–-][^\]]*)?\]/gi;

// Mesmos filtros do hook de redação: o que NÃO é artefato de entrega.
const SUPPORTED_EXT = /\.(?:md|txt|rtf)$/i;
const MANIFEST_SUFFIX = /\.(?:citation|redacao)-gate\.json$/i;
const DRAFT_NAME = /(?:^|[-_.])(?:minuta|rascunho|draft|intern[oa])(?:[-_.]|$)/i;
const INTERNAL_NAME = /^(?:revis[ãa]o|aprova[çc][ãa]o|checklist|relat[óo]rio|pesquisa|resumo|diagn[óo]stico|fatos|teses|estrat[ée]gia|intake)(?:[-_.]|$)/i;

function minutos(deIso, ateIso) {
  const de = Date.parse(deIso);
  const ate = Date.parse(ateIso);
  if (!Number.isFinite(de) || !Number.isFinite(ate) || ate < de) return null;
  return Math.round(((ate - de) / 60000) * 10) / 10;
}

function contar(texto, re) {
  return (String(texto).match(re) || []).length;
}

/** Os arquivos que contam como entrega: `.md/.txt/.rtf` na raiz de `output/`, fora de rascunho/interno/manifesto. */
/**
 * Marca com que um arquivo se declara interno, lida no CABEÇALHO.
 *
 * A lista de nomes internos (`INTERNAL_NAME`) é uma corrida perdida: cada squad
 * novo inventa nomes novos, e num run real o `contraditor.md` e o arquivo de
 * pendências entraram na contagem de ENTREGA, o segundo a ponto de disputar com
 * a peça a escolha do empacotador. Nome é convenção; a declaração do autor é
 * fato. Quem escreve "NÃO PROTOCOLAR" na primeira linha disse o que o arquivo é.
 */
const MARCA_INTERNA = /N[ÃA]O\s+PROTOCOLAR|Documento\s+interno\s+do\s+run|uso\s+interno\s+do\s+escrit[óo]rio/i;
const LINHAS_DE_CABECALHO = 12;

/**
 * `texto` é opcional: sem ele a decisão é só pelo nome, como sempre foi. Com
 * ele, a declaração do próprio arquivo tem a última palavra — e ela só EXCLUI,
 * nunca inclui: nada vira entrega por causa do conteúdo.
 */
export function ehArtefatoDeEntrega(nome, texto = null) {
  if (!SUPPORTED_EXT.test(nome) || MANIFEST_SUFFIX.test(nome)) return false;
  if (nome.startsWith('_') || nome.startsWith('.')) return false;
  if (DRAFT_NAME.test(nome) || INTERNAL_NAME.test(nome)) return false;
  if (typeof texto === 'string' && MARCA_INTERNA.test(texto.split('\n', LINHAS_DE_CABECALHO).join('\n'))) return false;
  return true;
}

function gatesDoLedger(review) {
  if (!review || typeof review !== 'object') return null;
  // Ledger novo: `loops` por gate. Ledger antigo: um único laço na raiz (= revisao).
  const loops = review.loops && typeof review.loops === 'object'
    ? review.loops
    : Array.isArray(review.cycles) ? { revisao: review } : null;
  if (!loops) return null;
  const out = {};
  for (const [gate, laco] of Object.entries(loops)) {
    const cycles = Array.isArray(laco?.cycles) ? laco.cycles : [];
    const rejeicoes = cycles.filter((c) => {
      const d = c && c.decision;
      if (!d || typeof d !== 'object') return false;
      return String(d.verdict || '').toUpperCase() === 'REJECT' || ['revise', 'escalate'].includes(d.action);
    }).length;
    out[gate] = {
      ciclos: cycles.length,
      rejeicoes,
      teto: Number.isInteger(laco?.maxCycles) ? laco.maxCycles : null,
      status: typeof laco?.status === 'string' ? laco.status : null,
    };
  }
  return out;
}

function esperaHumana(run) {
  const carimbos = run && run.checkpoints_em && typeof run.checkpoints_em === 'object' ? run.checkpoints_em : null;
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  if (!carimbos || !steps.length) return { min: null, medidos: 0 };
  let total = 0;
  let medidos = 0;
  for (const [step, quando] of Object.entries(carimbos)) {
    // Casa pelo ID do step (carimbado desde 0.5.9); só então cai no rótulo,
    // heurística que existe para ledger antigo e que só acerta quando o
    // rótulo por acaso começa pelo id.
    const s = steps.find((x) => x.stepId === step)
      || steps.find((x) => typeof x.label === 'string' && (x.label === step || x.label.startsWith(step) || step.startsWith(x.label)));
    const m = s ? minutos(s.startedAt, quando) : null;
    if (m === null) continue;
    total += m;
    medidos += 1;
  }
  return { min: medidos ? Math.round(total * 10) / 10 : null, medidos };
}

/**
 * Mede um run a partir dos ledgers (objetos já lidos) e dos artefatos de entrega.
 * Puro: não toca o disco. `agora` fecha a duração de um run ainda em andamento.
 */
export function medirRun({ run = null, review = null, artefatos = [], agora = null } = {}) {
  const temRun = !!(run && typeof run === 'object' && run.runId);
  const fim = temRun ? (run.endedAt || (run.status === 'running' && agora ? agora : null)) : null;
  const steps = temRun && Array.isArray(run.steps) ? run.steps : [];
  const primeiroFechado = steps.find((s) => s && s.endedAt);
  const paradas = temRun && run.checkpoints && typeof run.checkpoints === 'object' ? Object.keys(run.checkpoints).length : null;
  const espera = temRun ? esperaHumana(run) : { min: null, medidos: 0 };

  const porArtefato = [];
  let pendencias = 0;
  let temas = 0;
  for (const a of artefatos) {
    if (!a || typeof a.texto !== 'string') continue;
    const p = contar(a.texto, PENDING_MARKER);
    const t = contar(a.texto, TEMA_MARKER);
    pendencias += p;
    temas += t;
    porArtefato.push({ nome: a.nome, pendencias: p, temasAConferir: t });
  }

  return {
    medido: temRun,
    run: {
      runId: temRun ? run.runId : null,
      status: temRun ? run.status || null : null,
      emAndamento: temRun ? run.status === 'running' : null,
      inicio: temRun ? run.startedAt || null : null,
      fim,
      duracaoMin: temRun && run.startedAt && fim ? minutos(run.startedAt, fim) : null,
      primeiroArtefatoMin: temRun && run.startedAt && primeiroFechado ? minutos(run.startedAt, primeiroFechado.endedAt) : null,
      steps: steps.map((s) => ({ n: s.n, label: s.label, min: s.startedAt && s.endedAt ? minutos(s.startedAt, s.endedAt) : null })),
      paradasHumanas: paradas,
      esperaHumanaMin: espera.min,
      checkpointsMedidos: espera.medidos,
    },
    gates: gatesDoLedger(review),
    pendencias: {
      total: artefatos.length ? pendencias : null,
      temasAConferir: artefatos.length ? temas : null,
      artefatos: porArtefato,
    },
  };
}

const fmt = (n) => (n === null || n === undefined ? 'não medido' : String(n).replace('.', ','));

/** A seção que o RELATORIO.md publica. Nunca inventa: o que não foi medido sai como "não medido". */
export function paraMarkdown(m) {
  const linhas = ['## Métricas do run'];
  if (!m.medido) {
    linhas.push('- Sem `run-state.json`: run não medido (o cartório só grava quando o runner passa `--run`).');
    return linhas.join('\n');
  }
  const r = m.run;
  const dur = r.duracaoMin === null ? 'não medido' : `${fmt(r.duracaoMin)} min${r.emAndamento ? ' (em andamento)' : ''}`;
  linhas.push(`- Duração: ${dur} · Até o primeiro artefato: ${r.primeiroArtefatoMin === null ? 'não medido' : `${fmt(r.primeiroArtefatoMin)} min`}`);
  const espera = r.esperaHumanaMin === null ? 'não medido' : `${fmt(r.esperaHumanaMin)} min (${r.checkpointsMedidos} checkpoint${r.checkpointsMedidos === 1 ? '' : 's'} medido${r.checkpointsMedidos === 1 ? '' : 's'})`;
  linhas.push(`- Paradas humanas: ${fmt(r.paradasHumanas)} · Espera pelo humano: ${espera}`);
  if (m.gates && Object.keys(m.gates).length) {
    const partes = Object.entries(m.gates).map(([g, v]) => `${g} ${v.ciclos} (${v.rejeicoes} REJECT${v.teto ? `, teto ${v.teto}` : ''})`);
    linhas.push(`- Ciclos por gate: ${partes.join(' · ')}`);
  } else {
    linhas.push('- Ciclos por gate: não medido (sem `review-state.json`)');
  }
  const p = m.pendencias;
  if (p.total === null) {
    linhas.push('- Pendências na entrega: não medido (nenhum artefato de entrega em `output/`)');
  } else {
    const detalhe = p.artefatos.filter((a) => a.pendencias).map((a) => `${a.nome}: ${a.pendencias}`).join(', ');
    linhas.push(`- Pendências na entrega: ${p.total} em ${p.artefatos.length} artefato${p.artefatos.length === 1 ? '' : 's'}${detalhe ? ` (${detalhe})` : ''} · Temas a conferir: ${p.temasAConferir}`);
  }
  return linhas.join('\n');
}

function lerJson(caminho) {
  if (!existsSync(caminho)) return null;
  try { return JSON.parse(readFileSync(caminho, 'utf8')); } catch { return null; }
}

/** Lê os ledgers e os artefatos de `squads/<nome>/` e mede. */
/**
 * Pastas onde um artefato do run pode estar, da mais recente para a mais antiga:
 * as versões do run (`output/{run}/vN`), a raiz do run e a raiz de `output/`.
 *
 * Mesma varredura que `empacotar` faz para ESCOLHER a peça. Aqui ela faltava, e
 * a consequência era pior do que parece: `medirSquad` lia só a raiz de
 * `output/`, onde um run versionado não grava nada, e o TERMO DE CONFERÊNCIA
 * saía dizendo "Pendências na entrega: não medido (nenhum artefato de entrega em
 * `output/`)" sobre uma peça com dez `[CONFIRMAR]` dentro. Um termo que
 * subnotifica pendência é pior do que um termo sem a linha: o profissional lê
 * "não medido" como "nada pendente" e protocola.
 */
function pastasDeMedicao(outputDir, runId) {
  const pastas = [];
  const runDir = runId ? join(outputDir, String(runId)) : null;
  if (runDir && existsSync(runDir)) {
    const versoes = readdirSync(runDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((x, y) => Number(y.slice(1)) - Number(x.slice(1)));
    for (const v of versoes) pastas.push(join(runDir, v));
    pastas.push(runDir);
  }
  pastas.push(outputDir);
  return pastas;
}

export function medirSquad(squadDir, { agora = null, runId = null } = {}) {
  const dir = resolve(squadDir);
  const outputDir = join(dir, 'output');
  // `runId` explícito, ou o do ledger — quem mede um run tem de olhar onde o
  // runner grava, e o runner grava sob `output/{run_id}/vN/`.
  const doLedger = lerJson(join(dir, 'run-state.json'));
  const run = runId ?? (doLedger && typeof doLedger.runId === 'string' ? doLedger.runId : null);
  const vistos = new Set();
  const artefatos = [];
  for (const pasta of pastasDeMedicao(outputDir, run)) {
    if (!existsSync(pasta)) continue;
    for (const e of readdirSync(pasta, { withFileTypes: true })) {
      if (!e.isFile() || !ehArtefatoDeEntrega(e.name) || vistos.has(e.name)) continue;
      try {
        const texto = readFileSync(join(pasta, e.name), 'utf8');
        if (!ehArtefatoDeEntrega(e.name, texto)) continue;   // o arquivo se declara interno
        artefatos.push({ nome: e.name, texto });
        vistos.add(e.name);
      } catch { /* arquivo ilegível não vira medição inventada */ }
    }
  }
  return medirRun({
    run: lerJson(join(dir, 'run-state.json')),
    review: lerJson(join(dir, 'review-state.json')),
    artefatos,
    agora,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stderr.write('uso: run-metricas.mjs <squad-dir> [--json] [--agora <ISO>]\n');
    process.exit(1);
  }
  const i = args.indexOf('--agora');
  const agora = i >= 0 ? args[i + 1] : null;
  const m = medirSquad(dir, { agora });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(m, null, 2)}\n` : `${paraMarkdown(m)}\n`);
  process.exit(0);
}
