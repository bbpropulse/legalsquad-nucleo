#!/usr/bin/env node
/**
 * Métricas do run — lidas do LEDGER, nunca de relato.
 *
 * Fase 0 do plano (docs/specs/legalsquad/PLANO-ORQUESTRADOR.md): sem número de
 * partida, toda promessa de produtividade é opinião. Este script lê o que o
 * cartório já grava — `run-state.json` (início, fim, um histórico por step,
 * carimbo de cada checkpoint), `review-state.json` (ciclos e vereditos por gate)
 * e a peça do run em `output/` (marcadores de pendência) — e devolve as medidas
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
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
//    aceita depois de dois-pontos, travessão, hífen ou espaço (`[CONFIRMAR COM A AUTORA]`,
//    `[TEMA A CONFERIR X]`: o ensaio de 19/09/2026 relatou 1 pendência onde havia 6).
// >>> pendencia:begin
/**
 * Regras da gramática: a palavra-chave em CAIXA ALTA (é assim que o runner, as
 * skills e o ensaio a escrevem), com carga opcional depois de dois-pontos,
 * travessão, hífen ou espaço (`[CONFERIR: a vara]`, `[CONFIRMAR COM A AUTORA]`).
 * Caixa alta é o que separa o marcador de um link Markdown (`[Conferir o
 * inteiro teor](url)`) e de um termo técnico entre colchetes (`[hipótese de
 * incidência]`): com a flag `i`, os dois bloqueavam a gravação da final.
 * Colchete seguido de `(` é link, nunca marcador.
 */
const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|CONFIRMAR|A[ _]CONFIRMAR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O|PREENCHER|A[ _]PREENCHER|DILIG[ÊE]NCIA)(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
/**
 * Marcador de DADO (o fato que depende do profissional ou do cliente), separado do
 * de citação na medição dos moldes de 24/09/2026 (G11). O de citação trava a final
 * sempre; o de dado passa se o manifesto o lista em `pendencias_do_profissional[]`,
 * e a parada aprovação o mostra. Testado sobre um marcador já casado por PENDING_MARKER.
 */
const DATA_MARKER = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:—–-]|\])/;
/** Tema sem âncora apontado pelo verificador de persuasão: contado à parte (não trava hoje). */
const TEMA_MARKER = /\[TEMA[ _]A[ _]CONFERIR(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
// <<< pendencia:end
export { DATA_MARKER, PENDING_MARKER, TEMA_MARKER };

// Mesmos filtros do hook de redação: o que NÃO é artefato de entrega.
const SUPPORTED_EXT = /\.(?:md|txt|rtf)$/i;
const MANIFEST_SUFFIX = /\.(?:citation|redacao)-gate\.json$/i;
const DRAFT_NAME = /(?:^|[-_.])(?:minuta|rascunho|draft|intern[oa])(?:[-_.]|$)/i;
// `foco` (o artefato do checkpoint de diagnóstico), `gate`, `termo`, `conferencia`…
// entraram depois de um run real em que o pacote saiu com `foco-do-caso.md` no
// lugar da peça. Espelho em `src/squad-check.js` (NOME_INTERNO).
// `avaliacao`, `verificacao`, `meta`, `contraditor`, `apoio` e `persuasao` entraram
// na medição de 24/09/2026: o `avaliacao-meta.md` da Verificação da Meta saiu no
// pacote da apelação no lugar da peça, e o `apoio-*.md` contava pendência de entrega.
const INTERNAL_NAME = /^(?:revis[ãa]o|aprova[çc][ãa]o|checklist|relat[óo]rio|pesquisa|resumo|diagn[óo]stico|fatos|teses|estrat[ée]gia|intake|foco|gate|termo|confer[êe]ncia|linha|mem[óo]ria|notas|plano|mapa|an[áa]lise|contradi[çc][õo]es|pre-?mortem|temas|anexos|proximos-passos|manifesto|avalia[çc][ãa]o|verifica[çc][ãa]o|meta|contraditor|apoio|persuas[ãa]o)(?:[-_.]|$)/i;

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

function resumoDoLaco(laco) {
  const cycles = Array.isArray(laco?.cycles) ? laco.cycles : [];
  const rejeicoes = cycles.filter((c) => {
    const d = c && c.decision;
    if (!d || typeof d !== 'object') return false;
    return String(d.verdict || '').toUpperCase() === 'REJECT' || ['revise', 'escalate'].includes(d.action);
  }).length;
  return {
    loop: typeof laco?.loop === 'string' ? laco.loop : null,
    target: typeof laco?.target === 'string' ? laco.target : null,
    ciclos: cycles.length,
    rejeicoes,
    teto: Number.isInteger(laco?.maxCycles) ? laco.maxCycles : null,
    status: typeof laco?.status === 'string' ? laco.status : null,
  };
}

/**
 * Por gate: o total do run (todos os laços) e cada laço em ordem. Um gate abre
 * mais de um laço quando roda em mais de um step (o Citation Gate roda na
 * redação e de novo na conferência final); o `gate-open` arquiva o anterior em
 * `historico[gate]`, e é daqui que o termo e as métricas leem as rodadas que o
 * run de 15/09/2026 escondia.
 */
function gatesDoLedger(review) {
  if (!review || typeof review !== 'object') return null;
  // Ledger novo: `loops` por gate. Ledger antigo: um único laço na raiz (= revisao).
  const loops = review.loops && typeof review.loops === 'object'
    ? review.loops
    : Array.isArray(review.cycles) ? { revisao: review } : null;
  if (!loops) return null;
  const historico = review.historico && typeof review.historico === 'object' ? review.historico : {};
  const out = {};
  const gates = new Set([...Object.keys(loops), ...Object.keys(historico)]);
  for (const gate of gates) {
    const anteriores = Array.isArray(historico[gate]) ? historico[gate] : [];
    const rodadas = [...anteriores, ...(loops[gate] ? [loops[gate]] : [])].map(resumoDoLaco);
    const atual = rodadas.length ? rodadas[rodadas.length - 1] : null;
    out[gate] = {
      ciclos: rodadas.reduce((n, r) => n + r.ciclos, 0),
      rejeicoes: rodadas.reduce((n, r) => n + r.rejeicoes, 0),
      lacos: rodadas.length,
      teto: atual ? atual.teto : null,
      status: atual ? atual.status : null,
      rodadas,
    };
  }
  return out;
}

/**
 * Checkpoint ou escalada: as duas param o run e esperam o profissional, mas só o
 * checkpoint é parada do pipeline. Medido em 24/09/2026: um run criminal da medição
 * registrou `escalada-redacao-gate` e `escalada-meta` pelo mesmo `checkpoint
 * --step`, e o termo disse "Paradas humanas: 4" num squad que para três vezes.
 * A escalada é outra medida: diz que um gate não convergiu, não que o fluxo
 * pediu uma decisão.
 *
 * A chave com `escala` no nome é escalada (é como o runner manda registrar). Com
 * o ledger carimbando `stepId` (desde 0.5.9), a chave que não é id de step
 * nenhum também é: foi o que o runner registrou fora das paradas do pipeline
 * (`verificacao-meta` em dois outros runs da mesma medição). Ledger
 * antigo, sem `stepId`, não tem com que comparar: fica checkpoint.
 */
const ESCALADA = /(?:^|[-_.])escala/i;
export function idsDeStep(run) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  return new Set(steps.map((s) => (s && typeof s.stepId === 'string' ? s.stepId : null)).filter(Boolean));
}
export function tipoDaParada(chave, ids = new Set()) {
  if (ESCALADA.test(String(chave))) return 'escalada';
  if (ids.size && !ids.has(chave)) return 'escalada';
  return 'checkpoint';
}

function esperaHumana(run) {
  const carimbos = run && run.checkpoints_em && typeof run.checkpoints_em === 'object' ? run.checkpoints_em : null;
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  if (!carimbos || !steps.length) return { min: null, medidos: 0 };
  const ids = idsDeStep(run);
  let total = 0;
  let medidos = 0;
  for (const [step, quando] of Object.entries(carimbos)) {
    // Escalada não tem abertura carimbada no ledger: medir do início do step
    // em que ela caiu contaria o trabalho dos agentes como espera.
    if (tipoDaParada(step, ids) !== 'checkpoint') continue;
    // Casa pelo ID do step (carimbado desde 0.5.9); só então cai no rótulo,
    // heurística que existe para ledger antigo e que só acerta quando o
    // rótulo por acaso começa pelo id.
    const doStep = steps.filter((x) => x.stepId === step);
    const candidatos = doStep.length
      ? doStep
      : steps.filter((x) => typeof x.label === 'string' && (x.label === step || x.label.startsWith(step) || step.startsWith(x.label)));
    // O ÚLTIMO registro do step aberto antes da resposta, nunca o primeiro.
    // Medido em 24/09/2026: o runner marca o fan-out da fase zero com o id do
    // checkpoint de diagnóstico, e o primeiro registro é o dos agentes em
    // paralelo. A contestação mediu 49,5 min de espera contra menos de 3 reais.
    const t = Date.parse(quando);
    const s = [...candidatos].reverse().find((x) => Number.isFinite(t) && Date.parse(x.startedAt) <= t) || null;
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
  const temParadas = temRun && run.checkpoints && typeof run.checkpoints === 'object';
  const ids = temRun ? idsDeStep(run) : new Set();
  const paradas = temParadas ? Object.keys(run.checkpoints).map((id) => ({ id, tipo: tipoDaParada(id, ids) })) : null;
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
      // Duas medidas, nunca somadas: parada do pipeline e escalada de gate.
      paradasHumanas: paradas ? paradas.filter((p) => p.tipo === 'checkpoint').length : null,
      escaladas: paradas ? paradas.filter((p) => p.tipo === 'escalada').length : null,
      paradas: paradas || [],
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
  linhas.push(`- Paradas humanas: ${fmt(r.paradasHumanas)} · Escaladas ao profissional: ${fmt(r.escaladas)} · Espera pelo humano: ${espera}`);
  if (m.gates && Object.keys(m.gates).length) {
    const partes = Object.entries(m.gates).map(([g, v]) => `${g} ${v.ciclos} (${v.rejeicoes} REJECT${v.teto ? `, teto ${v.teto}` : ''}${v.lacos > 1 ? `, ${v.lacos} laços` : ''})`);
    linhas.push(`- Ciclos por gate: ${partes.join(' · ')}`);
  } else {
    linhas.push('- Ciclos por gate: não medido (sem `review-state.json`)');
  }
  const p = m.pendencias;
  if (p.total === null) {
    linhas.push(p.motivo === 'ambiguo'
      ? '- Pendências na entrega: não medido (mais de uma peça candidata no run; o empacotador pede `--artefato`)'
      : '- Pendências na entrega: não medido (nenhum artefato de entrega em `output/`)');
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

// ---------------------------------------------------------------------------
// A peça do run: UMA escolha, para a métrica e para o pacote
// ---------------------------------------------------------------------------
// O escolhedor morava no `empacotar.mjs`, e esta métrica tinha a sua varredura
// própria, que somava as pendências de TODO `.md` de entrega do run. Medido em
// 24/09/2026: o TERMO do pacote da reclamação trabalhista disse "Pendências na
// entrega: 7" (as do `contraditor-pre-mortem.md` da fase zero) com a peça final
// em zero, e o da negativação contou o `apoio-lei-e-sumula.md`. É um número que
// o profissional lê. Agora a métrica mede a peça que o empacotador escolhe, com a
// mesma função: ela mora aqui porque o `empacotar.mjs` já importa este arquivo.

/** Erro que justifica exit 1 no empacotador; `codigo` diz à métrica por que não mediu. */
export class ErroReal extends Error {
  constructor(mensagem, codigo = 'ausente') {
    super(mensagem);
    this.codigo = codigo;
  }
}

/** O manifesto do Citation Gate ao lado da peça (`peca.md.citation-gate.json` ou `peca.citation-gate.json`). */
const MANIFESTO_CITACAO = '.citation-gate.json';

/**
 * Onde o run DE VERDADE deixou os artefatos, da pasta mais específica para a
 * mais geral.
 *
 * O runner grava por `squad-path` em `output/{run_id}/v{N}/arquivo.md` — o
 * escopo por run e o versionamento existem desde a Fase 0. O empacotador,
 * porém, só varria a RAIZ de `output/`, e a chamada do runner
 * (`empacotar.mjs squads/{name} --run {run_id}`, sem `--artefato`) portanto
 * nunca achava nada: a Fase 4 (pacote pronto para protocolar) falhava em todo
 * run real, e a única razão de ninguém ter visto é que nenhum run real tinha
 * acontecido. Pior que falhar: com um `.md` esquecido na raiz de `output/` por
 * um fluxo antigo, ela empacotaria a peça ERRADA em silêncio.
 *
 * A versão mais alta vence, e a raiz fica por último, para instalação anterior
 * ao escopo por run continuar funcionando.
 */
function pastasDeArtefato(outputDir, runId) {
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

/**
 * O artefato que o step de conferência declara no `pipeline.yaml`: o step que
 * ancora o Citation Gate final (`citation_verifiers`) e grava `output/<peça>-final.md`.
 * Leitura de linha, sem YAML completo: só `- id:`, `citation_verifiers:` e os
 * itens `- output/...md` de `artifacts:` do mesmo step.
 */
export function artefatosDaConferencia(squadDir) {
  let texto;
  try { texto = readFileSync(join(squadDir, 'pipeline', 'pipeline.yaml'), 'utf8'); } catch { return []; }
  const nomes = [];
  let step = null;
  const fechar = () => { if (step && step.conferencia) nomes.push(...step.artefatos); };
  for (const linha of texto.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*-\s+id:\s*/.test(linha)) { fechar(); step = { conferencia: false, artefatos: [] }; continue; }
    if (/^\S/.test(linha)) { fechar(); step = null; continue; }
    if (!step) continue;
    if (/^\s+citation_verifiers:\s*\d/.test(linha)) step.conferencia = true;
    const art = linha.match(/^\s+-\s+["']?(?:squads\/[^/]+\/)?output\/(?:[^"'\s]*\/)?([^/"'\s]+\.md)["']?\s*$/i);
    if (art) step.artefatos.push(art[1]);
  }
  fechar();
  return [...new Set(nomes)];
}

/** A peça que um manifesto do Citation Gate atesta: `peca.md.citation-gate.json` ou `peca.citation-gate.json`. */
function artefatoDoManifesto(dir, nomeManifesto) {
  const base = nomeManifesto.slice(0, -MANIFESTO_CITACAO.length);
  const candidatos = [base, `${base}.md`];
  const dados = lerJson(join(dir, nomeManifesto));
  if (dados && typeof dados.artifact === 'string' && dados.artifact.trim()) candidatos.push(basename(dados.artifact.trim()));
  return candidatos.find((c) => /\.md$/i.test(c) && existsSync(join(dir, c))) || null;
}

/** Entre várias entregas da mesma pasta, a `-final` vence; empate de verdade é ambiguidade. */
function umaSo(entregas, pasta) {
  if (entregas.length === 1) return join(pasta, entregas[0]);
  const finais = entregas.filter((n) => /(?:^|[-_.])final(?:[-_.]|$)/i.test(n));
  if (finais.length === 1) return join(pasta, finais[0]);
  throw new ErroReal(`artefato ambíguo: há ${entregas.length} entregas em ${pasta}: ${entregas.join(', ')}. Indique uma com --artefato <arquivo.md>`, 'ambiguo');
}

/**
 * A peça do pacote, sem `--artefato`, por ordem de prova:
 *   1. a que tem manifesto do Citation Gate ao lado (a final conferida);
 *   2. a que o step de conferência declara no `pipeline.yaml`;
 *   3. só então a entrega da versão mais alta, com a `-final` na frente.
 * Medido na medição de 24/09/2026: a aprovação roda o empacotador DEPOIS da
 * Verificação da Meta, e o `v11/avaliacao-meta.md` do run da apelação, a entrega
 * da versão mais alta, saiu no pacote como `avaliacao-meta.docx` no lugar da
 * `v10/apelacao-final.md`. A mais nova não é a peça; a conferida é.
 */
export function escolherArtefato({ squadDir, outputDir, pedido, runId = null }) {
  const pastas = pastasDeArtefato(outputDir, runId);
  if (pedido) {
    const candidatos = [
      ...pastas.map((d) => join(d, pedido)),
      join(squadDir, pedido),
      isAbsolute(pedido) ? pedido : resolve(pedido),
    ];
    const achado = candidatos.find((c) => { try { return statSync(c).isFile(); } catch { return false; } });
    if (!achado) throw new ErroReal(`artefato não encontrado: ${pedido} (procurado em ${candidatos.join(', ')})`);
    return achado;
  }
  if (!existsSync(outputDir)) throw new ErroReal(`sem pasta output/ em ${squadDir}: nada a empacotar`);
  // UM predicado só, para a escolha da pasta e para a listagem dentro dela.
  // Com dois, o empacotador elegia a pasta pelo nome e depois a esvaziava pelo
  // conteúdo, respondendo "nenhum artefato de entrega" numa pasta que ele mesmo
  // acabara de eleger por ter um. A marca no cabeçalho ("NÃO PROTOCOLAR")
  // exclui: num run real, o arquivo de pendências internas disputou com a peça,
  // e só não foi embrulhado no lugar dela porque havia DOIS candidatos e o
  // empacotador recusou por ambiguidade. Com um só, teria entregado o errado.
  const ehEntregaNaPasta = (dir, nome) => {
    if (!/\.md$/i.test(nome) || !ehArtefatoDeEntrega(nome)) return false;
    try { return ehArtefatoDeEntrega(nome, readFileSync(join(dir, nome), 'utf8')); } catch { return true; }
  };
  const arquivosDe = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : []);

  // As três provas valem primeiro dentro do run (da versão mais alta para a mais
  // baixa) e só depois na raiz de `output/`: uma entrega antiga esquecida na raiz,
  // mesmo atestada por um manifesto de outro fluxo, não vence a peça do run.
  const declaradas = artefatosDaConferencia(squadDir);
  const escopos = pastas.length > 1 ? [pastas.filter((d) => d !== outputDir), [outputDir]] : [pastas];
  for (const escopo of escopos) {
    // 1. A peça atestada pelo manifesto do Citation Gate.
    for (const d of escopo) {
      const atestadas = [...new Set(arquivosDe(d).filter((n) => n.endsWith(MANIFESTO_CITACAO)).map((n) => artefatoDoManifesto(d, n)).filter(Boolean))]
        .filter((n) => ehEntregaNaPasta(d, n))
        .sort();
      if (atestadas.length) return umaSo(atestadas, d);
    }
    // 2. A peça que o step de conferência declara, onde o runner a gravou.
    for (const d of escopo) {
      const presentes = arquivosDe(d);
      const achadas = declaradas.filter((n) => presentes.includes(n) && ehEntregaNaPasta(d, n)).sort();
      if (achadas.length) return umaSo(achadas, d);
    }
    // 3. A entrega da versão mais alta (instalação sem conferência declarada).
    const comEntrega = escopo.find((d) => arquivosDe(d).some((n) => ehEntregaNaPasta(d, n)));
    if (comEntrega) return umaSo(arquivosDe(comEntrega).filter((n) => ehEntregaNaPasta(comEntrega, n)).sort(), comEntrega);
  }
  // Nenhuma entrega em lugar nenhum. Os `.md` que ESTÃO lá e foram recusados por
  // nome: `ehArtefatoDeEntrega` filtra rascunho (`minuta`, `rascunho`, `draft`) e
  // interno (`revisao`, `intake`, `foco`, `diagnostico`…). Sem nomeá-los, a
  // mensagem dizia "nenhum artefato de entrega (.md)" com o arquivo à vista na
  // pasta, e quem gravou a peça como `minuta.md` (o nome que os prompts usam para
  // ela em PROSA) era mandado procurar o que não estava faltando.
  const recusados = pastas.filter(existsSync).flatMap((d) => readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !ehArtefatoDeEntrega(e.name))
    .map((e) => relative(outputDir, join(d, e.name)) || e.name));
  throw new ErroReal(recusados.length
    ? `nenhum artefato de ENTREGA em ${pastas.join(', ')}: os .md encontrados têm nome de rascunho ou de peça interna (${[...new Set(recusados)].sort().join(', ')}) e o empacotador os ignora de propósito. Renomeie a peça final (ex.: "contestacao.md") ou indique com --artefato <arquivo.md>`
    : `nenhum artefato de entrega (.md) em ${pastas.join(', ')}; indique com --artefato <arquivo.md>`);
}

/**
 * Lê os ledgers de `squads/<nome>/` e mede, com as pendências da PEÇA do run e
 * de nenhum outro arquivo. `artefato` é o caminho que o empacotador já escolheu
 * (o termo mede o que o pacote embrulha, inclusive com `--artefato`); sem ele, a
 * escolha é a mesma `escolherArtefato`. Sem peça, ou com duas candidatas, a
 * pendência sai "não medido" com o motivo: somar arquivos de apoio seria pior.
 */
export function medirSquad(squadDir, { agora = null, runId = null, artefato = null } = {}) {
  const dir = resolve(squadDir);
  const outputDir = join(dir, 'output');
  // `runId` explícito, ou o do ledger — quem mede um run tem de olhar onde o
  // runner grava, e o runner grava sob `output/{run_id}/vN/`.
  const doLedger = lerJson(join(dir, 'run-state.json'));
  const run = runId ?? (doLedger && typeof doLedger.runId === 'string' ? doLedger.runId : null);
  let alvo = artefato;
  let motivo = null;
  if (!alvo) {
    try {
      alvo = escolherArtefato({ squadDir: dir, outputDir, pedido: null, runId: run });
    } catch (e) {
      if (!(e instanceof ErroReal)) throw e;
      motivo = e.codigo;
    }
  }
  const artefatos = [];
  if (alvo) {
    try { artefatos.push({ nome: basename(alvo), texto: readFileSync(alvo, 'utf8') }); } catch { motivo = 'ilegivel'; /* arquivo ilegível não vira medição inventada */ }
  }
  const m = medirRun({
    run: doLedger,
    review: lerJson(join(dir, 'review-state.json')),
    artefatos,
    agora,
  });
  if (motivo) m.pendencias.motivo = motivo;
  return m;
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
