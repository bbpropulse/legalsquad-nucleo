#!/usr/bin/env node
/**
 * Métricas da CRIAÇÃO de squad — lidas dos carimbos que o Arquiteto já grava,
 * nunca de relato.
 *
 * Irmão do `run-metricas.mjs`, que mede a EXECUÇÃO pelo ledger. A criação não
 * tem ledger: o único número que existia era prosa no `build.prompt.md`
 * ("medido em quatro builds reais, 16 a 18 minutos"), sem série, sem baseline,
 * sem como conferir uma mudança. Mas o fluxo grava arquivos em ordem fixa —
 * `_build/discovery.yaml` → `_build/design.yaml` → `squad.yaml` + `squad-party.csv`
 * (onda 1) → `pipeline/pipeline.yaml` (onda 2) → cada `.agent.md`, task e step
 * (onda 3) — e cada arquivo carrega dois carimbos: quando NASCEU (`birthtime`) e
 * quando foi gravado pela última vez (`mtime`). Ler esses carimbos mede o
 * processo sem mudar uma linha de prompt.
 *
 * O problema que todo carimbo tem: o Step C regrava. Corrige `squad.yaml` e
 * `pipeline.yaml` com frequência (`agents-fora-do-squad-yaml`, `on-reject-invalido`,
 * `input-sem-produtor`…) e, no C.2, agentes e arquivos de `pipeline/data/`. Uma
 * regravação deixa o arquivo mais NOVO que tudo o que o fluxo gravou depois dele,
 * e a cadeia canônica quebra — medido em 08/09/2026: dois `pipeline/data/*.md`
 * regravados no C.2 fizeram uma criação real sair "fora de ordem". E o `birthtime`
 * não salva: a Write/Edit do Claude Code RECRIA o arquivo (birthtime = mtime = hora
 * da regravação; medido no mesmo build), só o `fs.writeFile` do Node preserva o
 * inode. Então a regra é de ORDEM, não de inode: a cada quebra da cadeia sai o
 * arquivo mais novo do grupo que ficou novo demais, até a cadeia fechar (no
 * máximo um quarto dos arquivos). O que saiu é o que foi regravado — pelo Step C
 * no fim, ou por uma limpeza em lote no meio (medido em 08/09/2026: cinco
 * `pipeline/data/*.md` e o `pipeline.yaml` carimbados no mesmo segundo, antes da
 * onda 3). A geração se mede pelo que ficou, e a regravação se mede à parte, até
 * a última gravação, que é o fim de fato do Build. Um squad copiado ou vindo de
 * checkout não passa por aí: é uniforme (com ou sem edições por cima), ou está
 * embaralhado além do que uma correção explica. O `birthtime` entra só como sinal
 * extra, onde o escritor preserva o inode.
 *
 * O que os carimbos NÃO separam, e o Markdown diz: tempo de máquina de tempo de
 * espera humana (Discovery e Design têm checkpoints), a Discovery em si
 * (`discovery.yaml` é o FIM dela, não o começo), e um agente ou step regravado no
 * C.2 de um gerado por último (a onda 3 não tem ordem interna). Regravação que
 * NÃO quebra a ordem também é invisível — o `pipeline.yaml` regravado antes da
 * onda 3 começar só estica a onda 2 e encurta a 3, sem aviso. São medidas de
 * parede, e a onda 3 inclui a regravação dos próprios arquivos, se houver. Para
 * separar tudo isso de verdade, o Build precisaria gravar um ledger de marcos;
 * é a próxima medida, não esta.
 *
 * Duas regras, herdadas do `run-metricas`:
 * - ausência de medida é `null` e sai como "não medido" — nunca zero inventado.
 *   O caso perigoso é o squad cujos carimbos NÃO descrevem uma criação: copiado
 *   (carimbos uniformes), vindo de checkout ou restaurado (embaralhado além do
 *   que uma correção explica), ou com a onda 3 espalhada por horas (não é um ato
 *   contínuo). Medido no fixture do próprio repositório antes deste guard:
 *   "Build: 2,6 min, onda 3: 1658 min" — o zero inventado com outra cara. Nesses
 *   casos o script devolve `confiavel: false` com o motivo, apresenta NENHUMA
 *   duração e só inventaria os arquivos. Uma fase isolada com mais de 6 h entre
 *   os carimbos (Design retomado dias depois, por exemplo) não derruba o resto:
 *   sai `null` com um aviso nomeando-a, e as outras seguem medidas;
 * - é consulta, não enforcement: sai sempre com código 0, mesmo sem squad.
 *
 * Uso:
 *   node scripts/build-metricas.mjs squads/<nome>          # Markdown
 *   node scripts/build-metricas.mjs squads/<nome> --json   # objeto completo
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Janela dentro da qual carimbos contam como "o mesmo instante" (cópia; ou nascer e ser gravado). */
const JANELA_UNIFORME_MS = 2000;
/**
 * Janela do "lote" da onda 3: metade do ritmo serial medido pelo time (~1
 * arquivo/min). Com 60 s a fronteira coincidiria com o próprio ritmo, e o
 * round-trip `utimes → mtimeMs → ISO` devolve 59 999 ms para um gap de um
 * minuto — o serial passaria por lote. Com 30 s, um arquivo por minuto nunca
 * cai no lote do anterior, e workers em fan-out (que terminam a segundos um do
 * outro) caem todos no mesmo.
 */
const JANELA_LOTE_MS = 30000;
/** Abaixo disto a onda 3 é curta demais para inferir modo. */
const MIN_ARQUIVOS_PARA_MODO = 3;
/** Uma fase espalhada por mais que isto não é um ato contínuo de criação. */
const ESPALHAMENTO_MAX_MS = 6 * 60 * 60 * 1000;
/**
 * Gravação até isto depois do último nascimento é o Step C corrigindo (o loop
 * tem teto de rodadas, a ~1 min por arquivo reescrito); mais tarde que isso é
 * outro ato — `/legalsquad edit`, ou o usuário ajustando um arquivo — e não
 * entra no Build, só no aviso.
 */
const JANELA_REESCRITA_MS = 60 * 60 * 1000;
/**
 * Metade do ritmo serial medido (~1 arquivo/min). Abaixo disto a onda 3 não foi
 * gerada um arquivo por vez — é a vazão, o sinal mais direto de fan-out.
 */
const MIN_POR_ARQUIVO_PARALELO = 0.5;
/**
 * Fração das chegadas da onda 3 a menos de JANELA_LOTE_MS da anterior. Em série
 * a maioria chega a ~1 min da anterior (tasks curtas chegam antes, mas são a
 * minoria); em fan-out, com tasks no mesmo worker, as conclusões se espalham por
 * minutos e o "maior lote" fica pequeno — mas a maioria das chegadas continua a
 * segundos da anterior. Os dois sinais têm de concordar para nomear o modo.
 */
const FRACAO_CURTAS_PARALELO = 0.5;

function ms(iso) {
  const v = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : null;
}

function iso(msValor) {
  return msValor === null || msValor === undefined ? null : new Date(msValor).toISOString();
}

/**
 * Um carimbo tem `criado` (birthtime) e `modificado` (mtime), ISO ou null.
 * Aceita a forma antiga — um ISO só, que vale pelos dois — e a forma nova.
 */
function carimbo(v) {
  if (typeof v === 'string') return { criado: v, modificado: v };
  if (v && typeof v === 'object') {
    const criado = typeof v.criado === 'string' ? v.criado : (typeof v.modificado === 'string' ? v.modificado : null);
    const modificado = typeof v.modificado === 'string' ? v.modificado : criado;
    return { criado, modificado };
  }
  return { criado: null, modificado: null };
}

function maisRecente(...isos) {
  const validos = isos.filter((i) => ms(i) !== null);
  if (!validos.length) return null;
  return validos.reduce((a, b) => (ms(b) > ms(a) ? b : a));
}

function maisAntigo(...isos) {
  const validos = isos.filter((i) => ms(i) !== null);
  if (!validos.length) return null;
  return validos.reduce((a, b) => (ms(b) < ms(a) ? b : a));
}

/** Um arquivo reescrito: gravado bem depois de ter nascido (fora da janela de "mesmo instante"). */
function reescrito(c) {
  const a = ms(c.criado);
  const b = ms(c.modificado);
  return a !== null && b !== null && b - a > JANELA_UNIFORME_MS;
}

/**
 * Maior número de arquivos nascidos dentro de uma mesma janela curta. Em série
 * sai 1 (um arquivo por minuto); em fan-out sem tasks sai perto do total. Fica
 * no relatório como sinal, mas não decide o modo sozinho: com tasks no mesmo
 * worker, as conclusões do fan-out se espalham e o lote encolhe.
 */
function maiorLoteNaJanela(instantes) {
  const t = instantes.map(ms).filter((v) => v !== null).sort((a, b) => a - b);
  let maior = 0;
  for (let i = 0; i < t.length; i += 1) {
    let j = i;
    while (j < t.length && t[j] - t[i] < JANELA_LOTE_MS) j += 1;
    maior = Math.max(maior, j - i);
  }
  return maior;
}

/** Fração das chegadas (a partir da segunda) a menos de JANELA_LOTE_MS da anterior. */
function fracaoDeChegadasCurtas(instantes) {
  const t = instantes.map(ms).filter((v) => v !== null).sort((a, b) => a - b);
  if (t.length < 2) return null;
  let curtas = 0;
  for (let i = 1; i < t.length; i += 1) if (t[i] - t[i - 1] < JANELA_LOTE_MS) curtas += 1;
  return { curtas, de: t.length - 1, fracao: curtas / (t.length - 1) };
}

/**
 * Modo inferido pelos dois sinais, que têm de concordar: vazão (min/arquivo
 * abaixo de metade do ritmo serial) e chegadas em rajada (a maioria a menos de
 * 30 s da anterior). Um só dos dois — um par coincidente numa onda serial, ou
 * uma onda rápida mas espaçada — fica "indeterminado", que é a resposta honesta.
 */
function modoInferido(arquivos, minPorArquivo, fracaoCurtas) {
  if (arquivos < MIN_ARQUIVOS_PARA_MODO || minPorArquivo === null || fracaoCurtas === null) return 'indeterminado';
  const rapido = minPorArquivo < MIN_POR_ARQUIVO_PARALELO;
  const emRajada = fracaoCurtas >= FRACAO_CURTAS_PARALELO;
  if (rapido && emRajada) return 'paralelo (provável)';
  if (!rapido && !emRajada) return 'serial (provável)';
  return 'indeterminado';
}

const MOTIVO_UNIFORME = 'carimbos uniformes: squad copiado, clonado ou restaurado — os tempos são da cópia, não da criação';
const MOTIVO_UNIFORME_EDITADO = 'carimbos uniformes fora as edições por cima: squad copiado, clonado ou restaurado e editado depois — os tempos são da cópia, não da criação';
const MOTIVO_FORA_DE_ORDEM = 'carimbos fora de ordem além do que uma correção do Step C explica: o squad foi copiado, restaurado ou montado à mão, e os carimbos não descrevem a criação';
const MOTIVO_ESPALHADA = 'onda 3 espalhada por mais de 6 horas: não é um ato contínuo de criação';

function instantes(itens) {
  return itens.map((i) => ms(i.criado)).filter((v) => v !== null);
}

function uniformes(itens) {
  const t = instantes(itens);
  return t.length >= 2 && Math.max(...t) - Math.min(...t) <= JANELA_UNIFORME_MS;
}

/**
 * A cadeia canônica: `discovery` → `design` → primeiro e último de
 * `pipeline/data/` → o mais recente de `squad.yaml`/party (mesma onda, qualquer
 * ordem entre si) → `pipeline.yaml` → o primeiro arquivo da onda 3. A onda 3 não
 * é ordenada internamente (fan-out termina em qualquer ordem), mas nenhum arquivo
 * dela pode ser mais velho que o `pipeline.yaml` que a determinou.
 *
 * Devolve o grupo do elo NOVO DEMAIS na primeira quebra (o elo anterior à
 * quebra), ou null se a cadeia fecha. Numa criação, quem quebra a cadeia é o
 * arquivo regravado — mais novo do que o que o fluxo gravou depois dele.
 */
function primeiraViolacao(itens) {
  const de = (grupo) => instantes(itens.filter((i) => i.grupo === grupo));
  const minDe = (g) => { const v = de(g); return v.length ? Math.min(...v) : null; };
  const maxDe = (g) => { const v = de(g); return v.length ? Math.max(...v) : null; };
  const cadeia = [
    ['discovery', maxDe('discovery')], ['design', maxDe('design')], ['dados', minDe('dados')], ['dados', maxDe('dados')],
    ['onda1', maxDe('onda1')], ['onda2', maxDe('onda2')], ['onda3', minDe('onda3')],
  ].filter(([, v]) => v !== null);
  for (let i = 1; i < cadeia.length; i += 1) if (cadeia[i][1] < cadeia[i - 1][1]) return cadeia[i - 1][0];
  return null;
}

/**
 * Separa o que descreve a criação do que foi regravado depois — ou diz por que
 * nada descreve. A cada quebra da cadeia, sai o arquivo mais novo do grupo que
 * ficou novo demais (é o regravado: no fim, pelo Step C; no meio, por um
 * `sed -i` ou uma limpeza em lote, que carimba tudo no mesmo segundo), até a
 * cadeia fechar — no máximo um quarto dos arquivos, nunca menos de dois. Uma
 * correção regrava poucos; um checkout embaralha muitos, ou é uniforme, com ou
 * sem edições por cima.
 */
function separar(itens) {
  if (uniformes(itens)) return { restantes: itens, descascados: [], motivo: MOTIVO_UNIFORME };
  const teto = Math.max(2, Math.ceil(itens.length / 4));
  let restantes = [...itens];
  const descascados = [];
  for (let k = 0; k <= teto; k += 1) {
    const grupo = primeiraViolacao(restantes);
    if (grupo === null) {
      if (k > 0 && uniformes(restantes)) return { restantes, descascados, motivo: MOTIVO_UNIFORME_EDITADO };
      return { restantes, descascados, motivo: null };
    }
    if (k === teto) break;
    const doGrupo = restantes.filter((i) => i.grupo === grupo);
    const maisNovo = doGrupo.reduce((a, b) => (ms(b.criado) > ms(a.criado) ? b : a));
    descascados.push(maisNovo);
    restantes = restantes.filter((i) => i !== maisNovo);
  }
  return { restantes: itens, descascados: [], motivo: MOTIVO_FORA_DE_ORDEM };
}

/**
 * Mede a criação a partir dos carimbos (já lidos) e da lista da onda 3.
 * Puro: não toca o disco.
 *
 * `marcos`: { discovery, design, squadYaml, squadParty, pipelineYaml } e, para
 *   `pipeline/data/`, ou `dados: [{ nome, criado, modificado }]` ou o par
 *   `dadosInicio`/`dadosFim`; cada carimbo é `{ criado, modificado }` (ISO) — ou
 *   um ISO só, que vale pelos dois.
 * `onda3`: [{ nome, tipo: 'agente'|'task'|'step', criado, modificado }] — ou `mtime` só, idem.
 */
export function medirCriacao({ marcos = {}, onda3 = [] } = {}) {
  const origem = marcos || {};
  const deEntrada = (a) => carimbo(a && typeof a === 'object' && (a.criado !== undefined || a.modificado !== undefined)
    ? { criado: a.criado ?? a.mtime, modificado: a.modificado ?? a.mtime }
    : (a && typeof a === 'object' ? a.mtime : a));
  const itens = [];
  const entra = (nome, grupo, car, extra = {}) => { if (ms(car.criado) !== null) itens.push({ nome, grupo, ...extra, ...car }); };
  entra('_build/discovery.yaml', 'discovery', carimbo(origem.discovery));
  entra('_build/design.yaml', 'design', carimbo(origem.design));
  if (Array.isArray(origem.dados)) {
    for (const d of origem.dados) if (d && typeof d === 'object') entra(d.nome || 'pipeline/data', 'dados', deEntrada(d));
  } else {
    const ini = carimbo(origem.dadosInicio);
    const fim = carimbo(origem.dadosFim);
    entra('pipeline/data (primeiro)', 'dados', ini);
    if (ms(fim.criado) !== null && ms(fim.criado) !== ms(ini.criado)) entra('pipeline/data (último)', 'dados', fim);
  }
  entra('squad.yaml', 'onda1', carimbo(origem.squadYaml));
  entra('squad-party.csv', 'onda1', carimbo(origem.squadParty));
  entra('pipeline/pipeline.yaml', 'onda2', carimbo(origem.pipelineYaml));
  for (const a of onda3 || []) {
    if (a && typeof a === 'object') entra(a.nome, 'onda3', deEntrada(a), { tipo: a.tipo || null });
  }
  const tem = (grupo, nome = null) => itens.some((i) => i.grupo === grupo && (nome === null || i.nome === nome));
  const medido = tem('onda1', 'squad.yaml') || tem('design') || tem('onda3');

  const { restantes, descascados, motivo: motivoSeparacao } = medido ? separar(itens) : { restantes: itens, descascados: [], motivo: null };
  const dos = (grupo) => restantes.filter((i) => i.grupo === grupo);
  const ordenados = dos('onda3').sort((a, b) => ms(a.criado) - ms(b.criado));
  const espalhada = ordenados.length >= 2 && ms(ordenados[ordenados.length - 1].criado) - ms(ordenados[0].criado) > ESPALHAMENTO_MAX_MS;
  const motivo = medido ? (motivoSeparacao || (espalhada ? MOTIVO_ESPALHADA : null)) : null;
  const confiavel = medido && motivo === null;

  const discovery = dos('discovery')[0]?.criado ?? null;
  const design = dos('design')[0]?.criado ?? null;
  const dadosCriados = dos('dados').map((i) => i.criado);
  const dadosInicio = maisAntigo(...dadosCriados);
  const dadosFim = maisRecente(...dadosCriados);
  const fimOnda1 = maisRecente(...dos('onda1').map((i) => i.criado));
  const pipelineYaml = dos('onda2')[0]?.criado ?? null;
  const onda3Inicio = ordenados.length ? ordenados[0].criado : null;
  const onda3Fim = ordenados.length ? ordenados[ordenados.length - 1].criado : null;
  const inicioBuild = dadosInicio || design || null;

  // Regravados: os descascados (a ordem denuncia) e, onde o escritor preserva o
  // inode, os gravados bem depois de nascer. A última gravação até uma hora depois
  // do último arquivo gerado é o fim de fato do Build; mais tarde é edição
  // posterior, e só vira aviso.
  const ultimoNascimento = maisRecente(...restantes.map((i) => i.criado));
  const dentroDoBuild = (isoV) => ms(isoV) !== null && ms(ultimoNascimento) !== null && ms(isoV) - ms(ultimoNascimento) <= JANELA_REESCRITA_MS;
  const ficou = new Set(restantes);
  const reescritos = [
    ...descascados.map((i) => ({ nome: i.nome, grupo: i.grupo, criado: i.criado, modificado: i.modificado, sinal: 'ordem', minDepoisDeCriado: null, dentroDoBuild: dentroDoBuild(i.modificado) })),
    ...itens.filter((i) => ficou.has(i) && reescrito(i)).map((i) => ({
      nome: i.nome,
      grupo: i.grupo,
      criado: i.criado,
      modificado: i.modificado,
      sinal: 'gravacao',
      minDepoisDeCriado: Math.round(((ms(i.modificado) - ms(i.criado)) / 60000) * 10) / 10,
      dentroDoBuild: dentroDoBuild(i.modificado),
    })),
  ];
  const gravacoesNoBuild = reescritos.filter((r) => r.dentroDoBuild && ms(r.modificado) > ms(ultimoNascimento)).map((r) => r.modificado);
  const fimBuild = gravacoesNoBuild.length ? maisRecente(...gravacoesNoBuild) : ultimoNascimento;

  // Sem confiabilidade, nenhuma duração é apresentada: só o inventário. Uma fase
  // com mais de 6 h entre os carimbos sai null com aviso — não foi um ato contínuo.
  const avisos = [];
  if (confiavel) {
    const editadosDepois = reescritos.filter((r) => !r.dentroDoBuild);
    if (editadosDepois.length) avisos.push(`edição posterior ao Build (mais de 60 min depois do último arquivo gerado): ${editadosDepois.map((r) => r.nome).join(', ')} — fora da medição`);
    const grupos = new Set(descascados.map((i) => i.grupo));
    if (grupos.has('onda2')) avisos.push('pipeline.yaml regravado no Step C: Onda 2 não medida e Onda 3 contada desde o fim da Onda 1');
    if (grupos.has('dados')) avisos.push(`pipeline/data/ regravado no Step C (${descascados.filter((i) => i.grupo === 'dados').map((i) => i.nome).join(', ')}): Step A medido até o último arquivo de referência não regravado`);
    if (grupos.has('onda1')) avisos.push(`${descascados.filter((i) => i.grupo === 'onda1').map((i) => i.nome).join(' e ')} regravado no Step C: Onda 1 medida pelo que restou dela`);
    if (grupos.has('design')) avisos.push('design.yaml regravado depois: Design não medido');
    if (grupos.has('discovery')) avisos.push('discovery.yaml regravado depois: Design e Criação não medidos');
  }
  const dur = (de, ate, rotulo = null) => {
    if (!confiavel) return null;
    const a = ms(de);
    const b = ms(ate);
    if (a === null || b === null || b < a) return null;
    if (b - a > ESPALHAMENTO_MAX_MS) {
      if (rotulo) avisos.push(`${rotulo}: mais de 6 h entre os carimbos — não foi um ato contínuo; não medido`);
      return null;
    }
    return Math.round(((b - a) / 60000) * 10) / 10;
  };
  // A onda 3 conta desde o pipeline.yaml. Sem ele (squad sem pipeline) não é medida;
  // regravado no Step C (carimbo original perdido), conta desde o fim da onda 1.
  const inicioOnda3 = pipelineYaml || (descascados.some((i) => i.grupo === 'onda2') ? fimOnda1 : null);
  const onda3Min = dur(inicioOnda3, onda3Fim, 'Onda 3');
  const porArquivo = ordenados.map((a, i) => ({
    nome: a.nome,
    tipo: a.tipo,
    pronto: a.criado,
    modificado: a.modificado,
    reescrito: reescrito(a),
    minDesdeAnterior: i === 0 ? dur(inicioOnda3, a.criado) : dur(ordenados[i - 1].criado, a.criado),
  }));
  const minPorArquivo = onda3Min !== null && ordenados.length ? Math.round((onda3Min / ordenados.length) * 100) / 100 : null;
  const chegadas = confiavel && ordenados.length ? fracaoDeChegadasCurtas(ordenados.map((a) => a.criado)) : null;
  const maiorLote = confiavel && ordenados.length ? maiorLoteNaJanela(ordenados.map((a) => a.criado)) : null;

  const fases = {
    discoveryMin: null, // o carimbo de discovery.yaml é o FIM da Discovery: ela não é medível por aqui
    designMin: dur(discovery, design, 'Design'),
    stepAMin: dadosInicio && dadosFim ? dur(design, dadosFim, 'Step A') : null,
    onda1Min: dur(dadosFim || design, fimOnda1, 'Onda 1'),
    onda2Min: dur(fimOnda1, pipelineYaml, 'Onda 2'),
    onda3Min,
    reescritaMin: gravacoesNoBuild.length ? dur(ultimoNascimento, fimBuild, 'Regravação (Step C)') : null,
    buildMin: dur(inicioBuild, fimBuild, 'Build'),
    criacaoMin: dur(discovery, fimBuild, 'Criação'),
  };

  const bruto = (k) => carimbo(origem[k]);
  return {
    medido,
    confiavel,
    motivo,
    avisos,
    fases,
    onda3: {
      arquivos: ordenados.length,
      porTipo: {
        agente: ordenados.filter((a) => a.tipo === 'agente').length,
        task: ordenados.filter((a) => a.tipo === 'task').length,
        step: ordenados.filter((a) => a.tipo === 'step').length,
      },
      inicio: onda3Inicio,
      fim: onda3Fim,
      minPorArquivo,
      maiorLoteNaJanela: maiorLote,
      janelaLoteSeg: JANELA_LOTE_MS / 1000,
      chegadasCurtas: chegadas ? { curtas: chegadas.curtas, de: chegadas.de } : null,
      modo: confiavel && ordenados.length ? modoInferido(ordenados.length, minPorArquivo, chegadas ? chegadas.fracao : null) : null,
      porArquivo,
    },
    reescrita: {
      arquivos: confiavel ? reescritos.map((r) => ({ nome: r.nome, criado: r.criado, modificado: r.modificado, sinal: r.sinal, minDepoisDeCriado: r.minDepoisDeCriado, dentroDoBuild: r.dentroDoBuild })) : [],
      fimBuild: confiavel ? fimBuild : null,
    },
    marcos: {
      discovery: bruto('discovery'),
      design: bruto('design'),
      dadosInicio: Array.isArray(origem.dados) ? carimbo(maisAntigo(...origem.dados.map((d) => deEntrada(d).criado))) : bruto('dadosInicio'),
      dadosFim: Array.isArray(origem.dados) ? carimbo(maisRecente(...origem.dados.map((d) => deEntrada(d).criado))) : bruto('dadosFim'),
      squadYaml: bruto('squadYaml'),
      squadParty: bruto('squadParty'),
      pipelineYaml: bruto('pipelineYaml'),
    },
  };
}

const fmt = (n) => (n === null || n === undefined ? 'não medido' : String(n).replace('.', ','));
/** Zero aqui é arredondamento de segundos, não zero inventado — e não pode parecer o segundo. */
const min = (n) => (n === null || n === undefined ? 'não medido' : n === 0 ? '< 0,1 min' : `${fmt(n)} min`);

/** A seção que um relatório de criação publica. Nunca inventa: o que não foi medido sai como "não medido". */
export function paraMarkdown(m) {
  const linhas = ['## Métricas da criação'];
  if (!m.medido) {
    linhas.push('- Sem `squad.yaml`, `_build/design.yaml` nem arquivos de agente/step: criação não medida.');
    return linhas.join('\n');
  }
  const o = m.onda3;
  const inventario = `${o.arquivos} arquivo${o.arquivos === 1 ? '' : 's'} (${o.porTipo.agente} agente, ${o.porTipo.task} task, ${o.porTipo.step} step)`;
  if (!m.confiavel) {
    linhas.push(`- **Não confiável:** ${m.motivo}. Só o inventário abaixo vale.`);
    linhas.push(`- Onda 3: ${inventario} · durações: não medidas`);
    return linhas.join('\n');
  }
  const f = m.fases;
  linhas.push(`- Criação (fim da Discovery → última gravação): ${min(f.criacaoMin)} · Design: ${min(f.designMin)} (inclui espera humana no checkpoint) · Discovery: não medido (o carimbo de discovery.yaml é o fim dela)`);
  linhas.push(`- Build: ${min(f.buildMin)} · Step A: ${min(f.stepAMin)} · Onda 1: ${min(f.onda1Min)} · Onda 2: ${min(f.onda2Min)} · Onda 3: ${min(f.onda3Min)}`);
  const lote = o.maiorLoteNaJanela === null ? 'não medido' : String(o.maiorLoteNaJanela);
  const curtas = o.chegadasCurtas ? `${o.chegadasCurtas.curtas}/${o.chegadasCurtas.de}` : 'não medido';
  linhas.push(`- Onda 3: ${inventario} · ${fmt(o.minPorArquivo)} min/arquivo · maior lote em ${o.janelaLoteSeg} s: ${lote} · modo: ${o.modo || 'não medido'} · chegadas a menos de ${o.janelaLoteSeg} s da anterior: ${curtas}`);
  const r = m.reescrita.arquivos.filter((a) => a.dentroDoBuild);
  if (r.length) {
    linhas.push(`- Regravados no Step C: ${r.length} arquivo${r.length === 1 ? '' : 's'} (${r.map((a) => a.nome).join(', ')}) · última gravação ${min(f.reescritaMin)} depois do último arquivo gerado`);
  } else {
    linhas.push('- Regravados no Step C: nenhum detectado');
  }
  if (m.avisos.length) linhas.push(`- Avisos: ${m.avisos.join('; ')}`);
  return linhas.join('\n');
}

/**
 * Os dois carimbos de um arquivo. `birthtime` vale quando existe e não é
 * posterior ao mtime — em sistemas sem ele o Node devolve 0 ou o ctime, e nos
 * dois casos o mtime assume. Serve de sinal extra: a Write/Edit do Claude Code
 * recria o arquivo e o birthtime acompanha o mtime; a regra que segura a medição
 * é a de ordem, em `separar`.
 */
function carimboDe(caminho) {
  if (!existsSync(caminho)) return null;
  try {
    const s = statSync(caminho);
    const mt = s.mtimeMs;
    const bt = s.birthtimeMs;
    const criado = Number.isFinite(bt) && bt > 0 && bt <= mt ? bt : mt;
    return { criado: iso(criado), modificado: iso(mt) };
  } catch { return null; }
}

function arquivosDe(dir, filtro) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && filtro(e.name))
      .map((e) => ({ nome: e.name, caminho: join(dir, e.name) }));
  } catch { return []; }
}

/** Lê os carimbos e a onda 3 de `squads/<nome>/` e mede. */
export function medirSquad(squadDir) {
  const dir = resolve(squadDir);
  const dados = arquivosDe(join(dir, 'pipeline', 'data'), (n) => /\.md$/i.test(n))
    .map((a) => ({ nome: `pipeline/data/${a.nome}`, ...carimboDe(a.caminho) }))
    .filter((d) => d.criado);

  const onda3 = [];
  for (const a of arquivosDe(join(dir, 'agents'), (n) => /\.agent\.md$/i.test(n))) {
    onda3.push({ nome: `agents/${a.nome}`, tipo: 'agente', ...carimboDe(a.caminho) });
  }
  const agentsDir = join(dir, 'agents');
  if (existsSync(agentsDir)) {
    try {
      for (const e of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        for (const t of arquivosDe(join(agentsDir, e.name, 'tasks'), (n) => /\.md$/i.test(n))) {
          onda3.push({ nome: `agents/${e.name}/tasks/${t.nome}`, tipo: 'task', ...carimboDe(t.caminho) });
        }
      }
    } catch { /* pasta ilegível não vira medição inventada */ }
  }
  for (const s of arquivosDe(join(dir, 'pipeline', 'steps'), (n) => /\.md$/i.test(n))) {
    onda3.push({ nome: `pipeline/steps/${s.nome}`, tipo: 'step', ...carimboDe(s.caminho) });
  }

  return medirCriacao({
    marcos: {
      discovery: carimboDe(join(dir, '_build', 'discovery.yaml')),
      design: carimboDe(join(dir, '_build', 'design.yaml')),
      dados,
      squadYaml: carimboDe(join(dir, 'squad.yaml')),
      squadParty: carimboDe(join(dir, 'squad-party.csv')),
      pipelineYaml: carimboDe(join(dir, 'pipeline', 'pipeline.yaml')),
    },
    onda3,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stderr.write('uso: build-metricas.mjs <squad-dir> [--json]\n');
    process.exit(1);
  }
  const m = medirSquad(dir);
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(m, null, 2)}\n` : `${paraMarkdown(m)}\n`);
  process.exit(0);
}
