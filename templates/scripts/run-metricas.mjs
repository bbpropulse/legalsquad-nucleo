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
 * travessão, hífen, vírgula, ponto e vírgula ou espaço (`[CONFERIR: a vara]`, `[CONFIRMAR COM A AUTORA]`,
 * `[CONFIRMAR, decisão da cliente]`: com vírgula, escapava do manifesto, achado A8 do m4 de 01/10/2026).
 * Caixa alta é o que separa o marcador de um link Markdown (`[Conferir o
 * inteiro teor](url)`) e de um termo técnico entre colchetes (`[hipótese de
 * incidência]`): com a flag `i`, os dois bloqueavam a gravação da final.
 * Colchete seguido de `(` é link, nunca marcador.
 */
const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|CONFIRMAR|A[ _]CONFIRMAR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O|PREENCHER|A[ _]PREENCHER|DILIG[ÊE]NCIA)(?:(?:\s+|\s*[:,;—–-])[^\]]*)?\](?!\()/g;
/**
 * Marcador de DADO (o fato que depende do profissional ou do cliente), separado do
 * de citação na medição dos moldes de 24/09/2026 (G11). O de citação trava a final
 * sempre; o de dado passa se o manifesto o lista em `pendencias_do_profissional[]`,
 * e a parada aprovação o mostra. Testado sobre um marcador já casado por PENDING_MARKER.
 */
const DATA_MARKER = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:,;—–-]|\])/;
/** Tema sem âncora apontado pelo verificador de persuasão: contado à parte (não trava hoje). */
const TEMA_MARKER = /\[TEMA[ _]A[ _]CONFERIR(?:(?:\s+|\s*[:—–-])[^\]]*)?\](?!\()/g;
/** A linha que abre ou fecha a nota ao revisor (a mesma do bloco `nota-ao-revisor`). */
const LINHA_DA_NOTA_AO_REVISOR = /^[ \t]*<!--\s*nota-ao-revisor:(inicio|fim)\s*-->[ \t]*\r?$/;
/**
 * Cada marcador de pendência do texto, na ordem, com `indice` (posição no texto), `naNota` (está
 * dentro da nota ao revisor) e `repeteDaPeca` (na nota, o mesmo marcador que a peça já traz). A nota
 * que recapitula os campos da peça não é outra pendência: medido em 27/09/2026 (L15, locação, motor
 * 0.9.60), a tabela "Campos e diligências" da nota repetia os marcadores do corpo, e o manifesto saiu
 * com 39 entradas para 18 marcadores. O marcador que só a nota tem continua contando.
 */
function ocorrenciasDePendencia(texto) {
  const normal = (m) => String(m).normalize('NFC').replace(/\s+/g, ' ').trim();
  const out = [];
  let naNota = false;
  let pos = 0;
  for (const linha of String(texto ?? '').split('\n')) {
    const nota = linha.match(LINHA_DA_NOTA_AO_REVISOR);
    if (nota) naNota = nota[1] === 'inicio';
    else {
      for (const a of linha.matchAll(new RegExp(PENDING_MARKER.source, 'g'))) {
        out.push({ marcador: a[0], indice: pos + a.index, naNota, mencao: naNota && mencaoAoMarcador(linha, a.index, a[0]) });
      }
    }
    pos += linha.length + 1;
  }
  const naPeca = new Set(out.filter((o) => !o.naNota).map((o) => normal(o.marcador)));
  return out.map((o) => ({ ...o, repeteDaPeca: o.naNota && naPeca.has(normal(o.marcador)) }));
}
/**
 * Na nota ao revisor, o marcador NU (sem carga) que a frase nomeia como coisa é menção, não
 * pendência: "Nenhum item [NÃO VERIFICADO] da pesquisa foi usado", "(marcadores [CONFIRMAR] e
 * [DILIGÊNCIA])", "`[CONFERIR]`". Medido em 27/09/2026 (negativação, motor 0.9.61): a primeira
 * frase fez o manifesto-final recusar por `marcador-de-citacao` (L17) e a segunda virou duas
 * pendências no manifesto, 10 contra as 8 do empacotador (L18). O critério: marcador nu, entre
 * crases ou aspas, ou precedido (depois de outros marcadores nus e de "e", "ou", vírgula ou barra)
 * de palavra que o nomeia (marcador, item, nenhum, sem...). Continua contando o marcador com carga
 * (`[NÃO VERIFICADO: Súmula 999]`) e o nu colado ao que ele marca (`REsp 1.234/SP [NÃO
 * VERIFICADO]`, `Estado civil do fiador [CONFIRMAR]`). Fora da nota, marcador é sempre marcador.
 */
const PALAVRAS_DO_MARCADOR = PENDING_MARKER.source.slice(PENDING_MARKER.source.indexOf('(?:'), PENDING_MARKER.source.indexOf(')(?:(?:') + 1);
const MARCADOR_NU = new RegExp(`^\\[${PALAVRAS_DO_MARCADOR}\\]$`);
const MARCADOR_NU_NO_FIM = new RegExp(`\\[${PALAVRAS_DO_MARCADOR}\\]\\s*$`);
const PALAVRA_QUE_NOMEIA = /^(?:marcador(?:es)?|item|itens|rotulos?|etiquetas?|sinal|sinais|nenhum|nenhuma|sem|todos?|todas?|tipos?)$/;
function mencaoAoMarcador(linha, indice, marcador) {
  if (!MARCADOR_NU.test(marcador)) return false;
  const antes = linha.slice(0, indice);
  const depois = linha.slice(indice + marcador.length);
  if (/[`"'“‘]$/.test(antes) && /^[`"'”’]/.test(depois)) return true;
  let resto = antes;
  for (;;) {
    const sem = resto.replace(/\s+$/, '').replace(/(?:\s(?:e|ou)|[,/])$/, '').replace(MARCADOR_NU_NO_FIM, '');
    if (sem === resto) break;
    resto = sem;
  }
  const palavra = (resto.match(/([\p{L}]+)[\s(]*$/u) || [])[1] || '';
  return PALAVRA_QUE_NOMEIA.test(palavra.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
}
// <<< pendencia:end

// Fases nomeadas do run: cópia VERBATIM de src/fases-do-run.js.
// >>> fases-do-run:begin
/**
 * A lista fechada. `imagens-sumario` é o registro único que o runner abre para os descritores de
 * imagem e o sumário do caso (`--step autos-imagens-sumario`); `imagens` e `sumario` separados vêm
 * dos despachos. `gate:<nome>:<ciclo>` não está aqui: é derivado do `review-state.json`.
 */
const FASES_DO_RUN = Object.freeze([
  'roteamento', 'arquiteto', 'intake', 'imagens', 'sumario', 'imagens-sumario', 'fase-zero',
  'diagnostico', 'pesquisa', 'redacao', 'revisao', 'conferencia', 'cg-final', 'meta', 'aprovacao',
  'pacote', 'reabertura', 'outra',
]);

const semAcentoDaFase = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Regras na ordem: a primeira que casa decide. Valem para o id do step e, sem acerto, para o rótulo. */
const REGRAS_DE_FASE = [
  ['imagens-sumario', /autos-imagens-sumario|imagens?\b.*\bsumario|descricao das imagens/],
  ['fase-zero', /\bfase[- ]zero\b|\(\s*\d+\s+em\s+paralelo\s*\)/],
  ['sumario', /\bsumario (?:do caso|dos autos)\b/],
  ['imagens', /\bimagens?\b|\bdescritor/],
  ['intake', /\bintake\b|\btriagem\b/],
  ['diagnostico', /\bdiagnostico\b|\bfoco\b/],
  ['pesquisa', /\bpesquisa\b/],
  ['conferencia', /\bconferencia\b|\bconferente\b/],
  ['revisao', /\brevisao\b|\brevisor\b/],
  ['redacao', /\bredacao\b|\bminuta\b|\bredator\b/],
  ['aprovacao', /\baprovacao\b/],
  ['pacote', /\bprotocolo\b|\bchecklist\b|\bdistribuicao\b|\bpacote\b|\bempacot/],
];

/**
 * A fase de um step do ledger. O id decide antes do rótulo: no run reaberto, o rótulo da redação é
 * "Redação da minuta (revisão depois da entrega)", e quem é revisão é o step, não a frase. O
 * registro do fan-out da fase zero de ledger antigo usava o id do diagnóstico com o rótulo
 * "(N em paralelo)": o rótulo do paralelo vence o id nesse caso.
 */
function faseDoStep({ stepId, label } = {}) {
  const id = semAcentoDaFase(stepId).replace(/[-_]+/g, ' ');
  const rotulo = semAcentoDaFase(label);
  if (/\(\s*\d+\s+em\s+paralelo\s*\)/.test(rotulo) || /^fase zero\b/.test(id) || /^paralelo\b/.test(id)) return 'fase-zero';
  for (const texto of [id ? `${id} ${semAcentoDaFase(stepId)}` : '', rotulo]) {
    if (!texto) continue;
    const regra = REGRAS_DE_FASE.find(([, re]) => re.test(texto));
    if (regra) return regra[0];
  }
  return 'outra';
}

/**
 * A fase de um despacho, pelo nome que o chefe deu ao `aguardar --despacho`; sem acerto, a do step
 * em que o despacho saiu. O avaliador da meta e o verificador de citações rodam dentro do step de
 * redação ou de conferência, e a conta deles é da meta e do gate, não do step.
 */
function faseDoDespacho(nome, faseDoStepAtual = 'outra') {
  const n = semAcentoDaFase(nome).replace(/[-_]+/g, ' ');
  if (/\bavaliador meta\b|\bmeta\b/.test(n)) return 'meta';
  if (/\bverificador citac|\bcitac|\bcitation\b/.test(n)) return faseDoStepAtual === 'conferencia' ? 'cg-final' : 'gate:citacao';
  if (/\bpersuas/.test(n)) return 'gate:persuasao';
  if (/\bcatalog scout\b|\bscout\b/.test(n)) return 'roteamento';
  if (/\bdescritor\b|\bimagens?\b/.test(n)) return 'imagens';
  if (/\bsumario\b/.test(n)) return 'sumario';
  if (/\brevis/.test(n)) return 'revisao';
  if (/\bconferen/.test(n)) return 'conferencia';
  if (/\bleitor\b|\bnativo\b|\bpre mortem\b|\bcontraditor\b/.test(n) && faseDoStepAtual !== 'pesquisa') return 'fase-zero';
  if (/\bpesquis/.test(n)) return 'pesquisa';
  return faseDoStepAtual || 'outra';
}

/** Fase aceita pelo `squad-state fase` e pelo `--fase`: a lista fechada ou `gate:<nome>[:<ciclo>]`. */
function faseValida(nome) {
  return FASES_DO_RUN.includes(nome) || /^gate:[a-z0-9-]+(?::\d+)?$/.test(String(nome || ''));
}

/**
 * Roteamento e Arquiteto acontecem antes do `init`, e o ledger nasce sem eles. O que o disco sabe:
 * as linhas do `_legalsquad/logs/roteamento.jsonl` (cada decisão do roteador, com hora), a hora do
 * `_build/discovery.yaml` (o Arquiteto começou) e a do último arquivo de definição do squad gravado
 * antes do run (o Build terminou). `entradas` são as horas ISO do log; `discoveryEm` e `definicaoAte`,
 * ISO ou null. Devolve as duas fases com `origem: 'derivada'`, ou lista vazia sem log.
 *
 * O roteamento começa na primeira linha do log da sessão (as linhas sem intervalo maior que
 * `intervaloMin` antes do run); o Arquiteto, na última linha do log anterior ao Discovery. A linha é
 * gravada depois da decisão, então o roteamento medido é o piso, nunca mais que o real.
 */
function fasesAntesDoRun({ inicioDoRun, entradas = [], discoveryEm = null, definicaoAte = null, intervaloMin = 60 } = {}) {
  const inicio = Date.parse(inicioDoRun);
  if (!Number.isFinite(inicio)) return [];
  const horas = entradas.map((e) => Date.parse(e)).filter((t) => Number.isFinite(t) && t <= inicio).sort((a, b) => a - b);
  if (!horas.length) return [];
  let primeira = horas.length - 1;
  while (primeira > 0 && horas[primeira] - horas[primeira - 1] <= intervaloMin * 60000) primeira -= 1;
  if (inicio - horas[horas.length - 1] > intervaloMin * 60000 * 3) return [];
  const sessao = horas.slice(primeira);
  const iso = (t) => new Date(t).toISOString();
  const discovery = Date.parse(discoveryEm);
  const comArquiteto = Number.isFinite(discovery) && discovery >= sessao[0] && discovery <= inicio;
  if (!comArquiteto) return [{ fase: 'roteamento', inicio: iso(sessao[0]), fim: iso(inicio), origem: 'derivada' }];
  const antesDoDiscovery = sessao.filter((t) => t <= discovery);
  const inicioArq = antesDoDiscovery.length ? antesDoDiscovery[antesDoDiscovery.length - 1] : sessao[0];
  const ate = Date.parse(definicaoAte);
  const fimArq = Number.isFinite(ate) && ate >= inicioArq && ate <= inicio ? ate : inicio;
  return [
    { fase: 'roteamento', inicio: iso(sessao[0]), fim: iso(inicioArq), origem: 'derivada' },
    { fase: 'arquiteto', inicio: iso(inicioArq), fim: iso(fimArq), origem: 'derivada' },
  ];
}
// <<< fases-do-run:end
// A fase do despacho e a lista fechada servem a quem importa a métrica (os testes e o auditor).
export { FASES_DO_RUN, faseDoDespacho, faseValida };
export { DATA_MARKER, PENDING_MARKER, TEMA_MARKER, ocorrenciasDePendencia };

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
// `<peça>-final.md` com o nome da peça começando por palavra interna (`revisao-<qualificador>-final.md`) é entrega;
// a palavra sozinha (`revisao-final.md`) não. Espelho em `src/squad-check.js` (NOME_DE_PECA_FINAL).
const PIECE_FINAL = /^[a-z0-9]+(?:-[a-z0-9]+)+-final\.(?:md|txt|rtf)$/i;

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
  if (DRAFT_NAME.test(nome) || (INTERNAL_NAME.test(nome) && !PIECE_FINAL.test(nome))) return false;
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
/**
 * `pipeline` são os ids dos steps declarados no `pipeline.yaml` do squad. Medido em 27/09/2026
 * (negativação, motor 0.9.61, L20): o intake não chegou ao ledger como step (o `step` sem
 * `--working` falhava, L16), e a chave `step-01-intake` lida como escalada fez a métrica dizer
 * "2 paradas, 2 escaladas" com o ledger registrando uma escalada só. A chave que é step do
 * pipeline é parada do pipeline, com ou sem registro no ledger; o pipeline só absolve, nunca
 * condena (ledger antigo, sem ele, segue a regra de antes).
 */
export function tipoDaParada(chave, ids = new Set(), pipeline = new Set()) {
  if (ESCALADA.test(String(chave))) return 'escalada';
  if (pipeline.has(chave)) return 'checkpoint';
  if (ids.size && !ids.has(chave)) return 'escalada';
  return 'checkpoint';
}

/** Ids dos steps do `pipeline/pipeline.yaml` do squad (lista vazia sem o arquivo). */
export function idsDoPipeline(squadDir) {
  let texto;
  try { texto = readFileSync(join(squadDir, 'pipeline', 'pipeline.yaml'), 'utf8'); } catch { return []; }
  return [...texto.matchAll(/^\s*-\s+id:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/gm)].map((m) => m[1]);
}

/** Quantas escaladas o run teve: o histórico aditivo do ledger, ou as chaves de escalada do mapa. */
export function escaladasDoRun(run, paradas = null, pipeline = new Set()) {
  const hist = run && Array.isArray(run.escaladas_historico) ? run.escaladas_historico.filter((e) => e && typeof e.step === 'string') : [];
  const doMapa = (paradas || (run && run.checkpoints && typeof run.checkpoints === 'object' ? Object.keys(run.checkpoints).map((id) => ({ id, tipo: tipoDaParada(id, idsDeStep(run), pipeline) })) : []))
    .filter((p) => p.tipo === 'escalada');
  // A escalada registrada antes do histórico existir (ou fora do prefixo) segue contando pela chave.
  const noHistorico = new Set(hist.map((e) => e.step));
  return hist.length + doMapa.filter((p) => !noHistorico.has(p.id)).length;
}

function esperaHumana(run, pipeline = new Set()) {
  const carimbos = run && run.checkpoints_em && typeof run.checkpoints_em === 'object' ? run.checkpoints_em : null;
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  if (!carimbos || !steps.length) return { min: null, medidos: 0 };
  const ids = idsDeStep(run);
  let total = 0;
  let medidos = 0;
  for (const [step, quando] of Object.entries(carimbos)) {
    // Escalada não tem abertura carimbada no ledger: medir do início do step
    // em que ela caiu contaria o trabalho dos agentes como espera.
    if (tipoDaParada(step, ids, pipeline) !== 'checkpoint') continue;
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

// ---------------------------------------------------------------------------
// Tempo e tokens por fase (Etapa 0 do plano motor leve, outubro de 2026)
// ---------------------------------------------------------------------------
const hora = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** A hora da primeira reabertura: tudo antes dela é o run de base; depois, a revisão da entrega. */
function corteDaReabertura(run) {
  const r = Array.isArray(run?.reaberturas) ? run.reaberturas : [];
  const t = r.length ? hora(r[0].em) : null;
  return t === null ? Infinity : t;
}

/** O step pertence ao run de base (antes da primeira reabertura)? */
function doRunDeBase(s, corte) {
  if (s && s.reabertura) return false;
  const t = hora(s && s.startedAt);
  return t !== null && t < corte;
}

/**
 * Cada ciclo de cada laço de gate, em ordem, com a hora em que fechou (`em` do ciclo, ou o voto
 * mais tardio dele) e o tempo desde o marco anterior do laço (a abertura ou o ciclo anterior): o
 * tempo do ciclo inclui a correção do redator que o precedeu. Ledger anterior à hora nos votos
 * devolve o ciclo com `min: null`.
 */
export function ciclosDeGate(review) {
  if (!review || typeof review !== 'object' || !review.loops) return [];
  const historico = review.historico && typeof review.historico === 'object' ? review.historico : {};
  const out = [];
  for (const gate of new Set([...Object.keys(review.loops), ...Object.keys(historico)])) {
    const lacos = [...(Array.isArray(historico[gate]) ? historico[gate] : []), ...(review.loops[gate] ? [review.loops[gate]] : [])];
    lacos.forEach((laco, iLaco) => {
      let marco = hora(laco && laco.aberto_em);
      for (const c of Array.isArray(laco?.cycles) ? laco.cycles : []) {
        const votos = (Array.isArray(c.verdicts) ? c.verdicts : []).map((v) => hora(v && v.em)).filter((t) => t !== null);
        const fim = hora(c.em) ?? (votos.length ? Math.max(...votos) : null);
        const d = c.decision || {};
        out.push({
          fase: laco.loop === 'citation-gate-final' ? 'cg-final' : `gate:${gate}:${c.cycle}`,
          gate, laco: iLaco + 1, loop: laco.loop || null, ciclo: c.cycle,
          veredito: d.action === 'advance' ? 'APPROVE' : d.action ? 'REJECT' : null,
          acao: d.action || null,
          fim: fim === null ? null : new Date(fim).toISOString(),
          min: fim !== null && marco !== null && fim >= marco ? Math.round(((fim - marco) / 60000) * 10) / 10 : null,
        });
        if (fim !== null) marco = fim;
      }
    });
  }
  return out.sort((a, b) => (hora(a.fim) ?? Infinity) - (hora(b.fim) ?? Infinity));
}

/**
 * O laço de correção: da primeira vez que a minuta entra num gate (a primeira abertura de laço
 * depois que o step de redação começou) ao último APPROVE antes da conferência. Com hora nos votos,
 * o fim é o voto; no ledger antigo, o fim do último step de redação ou revisão anterior à
 * conferência (o runner avança o step logo depois do APPROVE).
 */
export function lacoDeCorrecao(run, review) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const corte = corteDaReabertura(run);
  const base = steps.filter((s) => doRunDeBase(s, corte));
  const fase = (s) => s.fase || faseDoStep(s);
  const redacao = base.find((s) => fase(s) === 'redacao');
  if (!redacao || !review || !review.loops) return null;
  const inicioRedacao = hora(redacao.startedAt);
  const conferencia = base.find((s) => fase(s) === 'conferencia' && hora(s.startedAt) > inicioRedacao);
  const limite = conferencia ? hora(conferencia.startedAt) : corte;
  const historico = review.historico && typeof review.historico === 'object' ? review.historico : {};
  const lacos = [...Object.values(historico).flat(), ...Object.values(review.loops)].filter(Boolean);
  const aberturas = lacos.map((l) => hora(l.aberto_em)).filter((t) => t !== null && t >= inicioRedacao && t < limite);
  if (!aberturas.length) return null;
  const inicio = Math.min(...aberturas);
  const aprovacoes = lacos.flatMap((l) => (Array.isArray(l.cycles) ? l.cycles : [])
    .filter((c) => c && c.decision && c.decision.action === 'advance')
    .map((c) => hora(c.em) ?? Math.max(-Infinity, ...(c.verdicts || []).map((v) => hora(v && v.em)).filter((t) => t !== null))))
    .filter((t) => Number.isFinite(t) && t > inicio && t <= limite);
  let fim = aprovacoes.length ? Math.max(...aprovacoes) : null;
  let origem = 'votos';
  if (fim === null) {
    const ultimos = base.filter((s) => ['redacao', 'revisao'].includes(fase(s)) && hora(s.endedAt) !== null && hora(s.endedAt) <= limite);
    fim = ultimos.length ? Math.max(...ultimos.map((s) => hora(s.endedAt))) : null;
    origem = 'steps';
  }
  if (fim === null || fim < inicio) return null;
  return { inicio: new Date(inicio).toISOString(), fim: new Date(fim).toISOString(), min: Math.round(((fim - inicio) / 60000) * 10) / 10, origem };
}

/**
 * Tempo e tokens por fase do run de base, as reaberturas à parte. O tempo de uma fase é a soma dos
 * steps dela (sem dupla contagem: os steps do ledger não se sobrepõem); roteamento e Arquiteto vêm
 * de `run.fases` (gravadas no `init` ou pelo chefe) ou, no ledger antigo, de `antes` (derivadas do
 * disco). Os despachos (`aguardar --fim`) dão os tokens e o tempo das fases que correm dentro de
 * um step (meta, gates): essas saem com `dentro: true` e não somam no total.
 */
export function fasesDoRun(run, { antes = [] } = {}) {
  if (!run || !run.runId) return null;
  const corte = corteDaReabertura(run);
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const ordem = [];
  const porFase = new Map();
  const somar = (fase, { min = null, tokens = null, dentro = false } = {}) => {
    if (!porFase.has(fase)) { porFase.set(fase, { fase, min: null, tokens: null, registros: 0, ...(dentro ? { dentro: true } : {}) }); ordem.push(fase); }
    const f = porFase.get(fase);
    if (min !== null) f.min = Math.round(((f.min || 0) + min) * 10) / 10;
    if (tokens !== null) f.tokens = (f.tokens || 0) + tokens;
    f.registros += 1;
    if (!dentro) delete f.dentro;
  };
  const marcadas = (Array.isArray(run.fases) ? run.fases : []).filter((f) => f && f.fase);
  const antesDoRun = marcadas.some((f) => ['roteamento', 'arquiteto'].includes(f.fase)) ? [] : antes;
  for (const f of [...antesDoRun, ...marcadas].sort((a, b) => (hora(a.inicio) ?? 0) - (hora(b.inicio) ?? 0))) {
    somar(f.fase, { min: f.inicio && f.fim ? minutos(f.inicio, f.fim) : null, tokens: Number.isFinite(f.tokens) ? f.tokens : null });
  }
  for (const s of steps.filter((x) => doRunDeBase(x, corte))) {
    somar(s.fase || faseDoStep(s), { min: s.startedAt && s.endedAt ? minutos(s.startedAt, s.endedAt) : null });
  }
  const despachos = (Array.isArray(run.despachos) ? run.despachos : []).filter((d) => d && hora(d.inicio) !== null && hora(d.inicio) < corte);
  for (const d of despachos) {
    const fase = d.fase || 'outra';
    const tokens = Number.isFinite(d.tokens) ? d.tokens : null;
    if (porFase.has(fase) && !porFase.get(fase).dentro) {
      // Fase que já tem o tempo dos steps: o despacho só traz os tokens.
      if (tokens !== null) { const f = porFase.get(fase); f.tokens = (f.tokens || 0) + tokens; }
    } else {
      somar(fase, { min: d.inicio && d.fim ? minutos(d.inicio, d.fim) : null, tokens, dentro: true });
    }
  }
  const reaberturas = (Array.isArray(run.reaberturas) ? run.reaberturas : []).map((r, i, todas) => {
    const de = hora(r.em);
    const ate = i + 1 < todas.length ? hora(todas[i + 1].em) : hora(run.endedAt);
    const dela = (Array.isArray(run.despachos) ? run.despachos : []).filter((d) => { const t = hora(d && d.inicio); return t !== null && de !== null && t >= de && (ate === null || t < ate); });
    const tokens = dela.filter((d) => Number.isFinite(d.tokens)).reduce((n, d) => n + d.tokens, 0);
    return { numero: r.numero || i + 1, modo: r.modo || null, min: de !== null && ate !== null && ate >= de ? Math.round(((ate - de) / 60000) * 10) / 10 : null, tokens: dela.some((d) => Number.isFinite(d.tokens)) ? tokens : null };
  });
  const lista = ordem.map((f) => porFase.get(f));
  const fora = lista.filter((f) => !f.dentro);
  const tokensConhecidos = lista.filter((f) => f.tokens !== null);
  const base = steps.filter((x) => doRunDeBase(x, corte) && x.endedAt).map((x) => hora(x.endedAt));
  const inicioRun = hora(run.startedAt);
  const fimBase = Number.isFinite(corte) && base.length ? Math.max(...base) : null;
  return {
    fases: lista,
    totalMin: fora.some((f) => f.min !== null) ? Math.round(fora.reduce((n, f) => n + (f.min || 0), 0) * 10) / 10 : null,
    tokens: tokensConhecidos.length ? tokensConhecidos.reduce((n, f) => n + f.tokens, 0) : null,
    despachos: { total: despachos.length, comTokens: despachos.filter((d) => Number.isFinite(d.tokens)).length },
    duracaoBaseMin: fimBase !== null && inicioRun !== null ? Math.round(((fimBase - inicioRun) / 60000) * 10) / 10 : null,
    reaberturas,
  };
}

/**
 * Roteamento e Arquiteto de um run cujo ledger não os gravou: a mesma leitura do `init` do
 * `squad-state` (log do roteador, `_build/discovery.yaml`, último arquivo de definição do squad).
 */
export function fasesAntesDoRunNoDisco(squadDir, inicioIso) {
  const dir = resolve(squadDir);
  let entradas;
  try {
    entradas = readFileSync(join(dir, '..', '..', '_legalsquad', 'logs', 'roteamento.jsonl'), 'utf8').split('\n')
      .map((l) => { try { return JSON.parse(l).ts; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
  const mtimeIso = (p) => { try { return statSync(p).mtime.toISOString(); } catch { return null; } };
  const definicao = [];
  const varrer = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of readdirSync(p)) varrer(join(p, f)); return; }
    definicao.push(st.mtimeMs);
  };
  for (const parte of ['squad.yaml', 'squad-party.csv', 'agents', 'pipeline']) varrer(join(dir, parte));
  const inicio = Date.parse(inicioIso);
  const ate = definicao.filter((m) => m <= inicio).sort((a, b) => b - a)[0];
  return fasesAntesDoRun({ inicioDoRun: inicioIso, entradas, discoveryEm: mtimeIso(join(dir, '_build', 'discovery.yaml')), definicaoAte: Number.isFinite(ate) ? new Date(ate).toISOString() : null });
}

/**
 * Mede um run a partir dos ledgers (objetos já lidos) e dos artefatos de entrega.
 * Puro: não toca o disco. `agora` fecha a duração de um run ainda em andamento.
 */
export function medirRun({ run = null, review = null, artefatos = [], agora = null, idsDoPipeline: doPipeline = [], antesDoRun = [] } = {}) {
  const pipeline = new Set(Array.isArray(doPipeline) ? doPipeline : []);
  const temRun = !!(run && typeof run === 'object' && run.runId);
  const fim = temRun ? (run.endedAt || (run.status === 'running' && agora ? agora : null)) : null;
  const steps = temRun && Array.isArray(run.steps) ? run.steps : [];
  const primeiroFechado = steps.find((s) => s && s.endedAt);
  const temParadas = temRun && run.checkpoints && typeof run.checkpoints === 'object';
  const ids = temRun ? idsDeStep(run) : new Set();
  const paradas = temParadas ? Object.keys(run.checkpoints).map((id) => ({ id, tipo: tipoDaParada(id, ids, pipeline) })) : null;
  const espera = temRun ? esperaHumana(run, pipeline) : { min: null, medidos: 0 };

  const porArtefato = [];
  let pendencias = 0;
  let temas = 0;
  for (const a of artefatos) {
    if (!a || typeof a.texto !== 'string') continue;
    // O marcador de dado que a nota ao revisor só repete da peça não conta de novo (L15).
    // A menção ao marcador na nota ao revisor não é pendência (L17 e L18).
    const p = ocorrenciasDePendencia(a.texto).filter((o) => !o.mencao && !(o.repeteDaPeca && DATA_MARKER.test(o.marcador))).length;
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
      // Com o id do registro: a fase zero (`fase-zero`) e as imagens e o sumário dos autos
      // (`autos-imagens-sumario`) têm entrada própria desde 01/10/2026 (achados 17 e 18).
      steps: steps.map((s) => ({ n: s.n, ...(s.stepId ? { stepId: s.stepId } : {}), label: s.label, min: s.startedAt && s.endedAt ? minutos(s.startedAt, s.endedAt) : null })),
      // Duas medidas, nunca somadas: parada do pipeline e escalada de gate.
      paradasHumanas: paradas ? paradas.filter((p) => p.tipo === 'checkpoint').length : null,
      // Cada escalada registrada, também a que repetiu a chave (a meta reprovada duas vezes): o
      // histórico do ledger, quando existe; sem ele (ledger antigo), as chaves do mapa.
      escaladas: paradas ? escaladasDoRun(run, paradas, pipeline) : null,
      paradas: paradas || [],
      esperaHumanaMin: espera.min,
      checkpointsMedidos: espera.medidos,
    },
    gates: gatesDoLedger(review),
    porFase: temRun ? fasesDoRun(run, { antes: antesDoRun }) : null,
    ciclosDeGate: ciclosDeGate(review),
    lacoDeCorrecao: temRun ? lacoDeCorrecao(run, review) : null,
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
  const pf = m.porFase;
  if (pf && pf.fases.length) {
    const partes = pf.fases.map((f) => `${f.fase}${f.dentro ? ' (dentro)' : ''} ${f.min === null ? 'não medido' : `${fmt(f.min)} min`}${f.tokens !== null ? `, ${fmt(Math.round(f.tokens / 100) / 10)}k tokens` : ''}`);
    linhas.push(`- Tempo por fase${pf.duracaoBaseMin !== null ? ` (run de base ${fmt(pf.duracaoBaseMin)} min)` : ''}: ${partes.join(' · ')}`);
    linhas.push(`- Tokens: ${pf.tokens === null ? 'não medido (nenhum despacho com --tokens)' : `${fmt(Math.round(pf.tokens / 100) / 10)}k em ${pf.despachos.comTokens} de ${pf.despachos.total} despacho${pf.despachos.total === 1 ? '' : 's'}`}`);
    if (pf.reaberturas.length) linhas.push(`- Reaberturas: ${pf.reaberturas.map((r) => `${r.numero} (${r.modo || 'sem modo'}) ${r.min === null ? 'não medido' : `${fmt(r.min)} min`}`).join(' · ')}`);
  }
  const lc = m.lacoDeCorrecao;
  if (lc) linhas.push(`- Laço de correção (da minuta no primeiro gate ao último APPROVE antes da conferência): ${fmt(lc.min)} min${lc.origem === 'steps' ? ' (fim pelo step: ledger sem hora nos votos)' : ''}`);
  const comHora = (m.ciclosDeGate || []).filter((c) => c.min !== null);
  if (comHora.length) linhas.push(`- Ciclos de gate com hora: ${comHora.map((c) => `${c.fase} ${fmt(c.min)} min (${c.veredito || '?'})`).join(' · ')}`);
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
  // O ledger da raiz é o do último run; o de um run anterior está guardado na pasta dele (o init
  // do run novo o guarda lá). Com `runId` de outro run, a medida sai da cópia, nunca da raiz.
  const daRaiz = lerJson(join(dir, 'run-state.json'));
  const run = runId ?? (daRaiz && typeof daRaiz.runId === 'string' ? daRaiz.runId : null);
  const anterior = run && daRaiz && daRaiz.runId !== run;
  const doLedger = anterior ? lerJson(join(outputDir, String(run), 'run-state.json')) : daRaiz;
  const review = anterior ? lerJson(join(outputDir, String(run), 'review-state.json')) : lerJson(join(dir, 'review-state.json'));
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
    review,
    artefatos,
    agora,
    idsDoPipeline: idsDoPipeline(dir),
    antesDoRun: doLedger && doLedger.startedAt ? fasesAntesDoRunNoDisco(dir, doLedger.startedAt) : [],
  });
  if (motivo) m.pendencias.motivo = motivo;
  return m;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const comValor = new Set(['--agora', '--run']);
  const dir = args.find((a, k) => !a.startsWith('--') && !comValor.has(args[k - 1]));
  if (!dir) {
    process.stderr.write('uso: run-metricas.mjs <squad-dir> [--run <run_id>] [--json] [--agora <ISO>]\n');
    process.exit(1);
  }
  const i = args.indexOf('--agora');
  const agora = i >= 0 ? args[i + 1] : null;
  const r = args.indexOf('--run');
  const runId = r >= 0 && args[r + 1] && !args[r + 1].startsWith('--') ? args[r + 1] : null;
  const m = medirSquad(dir, { agora, runId });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(m, null, 2)}\n` : `${paraMarkdown(m)}\n`);
  process.exit(0);
}
