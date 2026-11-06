// As fases nomeadas do run: o nome que o ledger grava em cada step e em cada despacho, e que o
// `run-metricas` soma em tempo e tokens por fase.
//
// Etapa 0 do plano "motor mais leve" (revisoes/MOTOR-LEVE-2026-10.md, §5): o tempo por gate e por
// ciclo dos seis runs medidos saiu dos diários, não do código, porque o ledger só tinha o rótulo
// livre de cada step. O rótulo muda de run para run ("Redação da minuta", "Redação da minuta
// (revisão depois da entrega)"); a fase é uma lista fechada. O `squad-state step` grava a fase com
// esta classificação, e o `run-metricas` a usa também para ler ledger antigo, sem o campo.
//
// Módulo PURO (só texto e datas recebidas). SINCRONIA: o bloco entre os marcadores é copiado
// VERBATIM pelo `scripts/sync-blocos.mjs` para o `squad-state` e o `run-metricas` (raiz e
// templates). Nenhum import.

// >>> fases-do-run:begin
/**
 * A lista fechada. `imagens-sumario` é o registro único que o runner abre para os descritores de
 * imagem e o sumário do caso (`--step autos-imagens-sumario`); `imagens` e `sumario` separados vêm
 * dos despachos. `gate:<nome>:<ciclo>` não está aqui: é derivado do `review-state.json`.
 */
const FASES_DO_RUN = Object.freeze([
  'roteamento', 'arquiteto', 'intake', 'imagens', 'sumario', 'imagens-sumario', 'fase-zero',
  'diagnostico', 'pesquisa', 'contingencia', 'redacao', 'revisao', 'conferencia', 'cg-final', 'meta', 'aprovacao',
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
  // A calculista (contingência, liquidação) tem fase própria: no m2r da 0.9.83 ela caía em "outra".
  ['contingencia', /\bcontingencia\b|\bcalculista\b|\bliquidacao\b/],
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
  if (/\bcalculista\b|\bcontingenc|\bliquidac/.test(n)) return 'contingencia';
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

export { FASES_DO_RUN, REGRAS_DE_FASE, faseDoStep, faseDoDespacho, faseValida, fasesAntesDoRun };
