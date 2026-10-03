// Maturidade de um squad-modelo de pacote: V1, V2 ou V3 (decisão do dono, 28/09/2026; o termo
// "rascunho" não se usa). O dono publica modelos em volume antes de revisá-los um a um, e o aluno
// precisa saber, na hora em que o chefe cria o squad, o quanto aquele modelo já foi provado:
//
// - V1: passou no piso automático (`squad-modelo --piso`); a prosa não foi lida pelo dono e não
//   houve run medido;
// - V2: um run com caso de gabarito, três avaliadores e a nota da meta registrada em `provas.run`;
// - V3: ouro, pelo critério de ouro (O1 a O10) e a revisão da prosa pelo dono.
//
// O campo é `maturidade` no `modelo.yaml`. Sem ele, a versão é derivada das provas (ouro → V3;
// run com nota 85 ou mais, três avaliadores e caso de gabarito → V2; senão V1) e o `--testar` avisa que falta
// declarar. Declaração acima do que as provas sustentam não vale: a versão mostrada cai para a
// derivada e o problema é dito (o modelo nunca se apresenta mais provado do que é).
//
// A versão não entra na pontuação da escolha; só desempata variantes da mesma peça.

export const MATURIDADES = Object.freeze(['V1', 'V2', 'V3']);
export const ORDEM_DA_MATURIDADE = Object.freeze({ V1: 1, V2: 2, V3: 3 });
/** Régua da meta para V2 e ouro, e o número de avaliadores que a nota precisa ter. */
export const NOTA_DA_REGUA = 85;
export const AVALIADORES_MINIMOS = 3;

const verdadeiro = (v) => v === true || v === 'true';
const vazio = (v) => v === undefined || v === null || v === '' || v === 'null' || v === '~';
const numero = (v) => (vazio(v) || !Number.isFinite(Number(v)) ? null : Number(v));

/** Ouro declarado: `provas.ouro` (o lugar de hoje) ou `ouro` na raiz (onde o `--extrair` o preserva). */
export function ehOuro(meta) {
  return verdadeiro(meta?.provas?.ouro) || verdadeiro(meta?.ouro);
}

/** O run medido registrado em `provas.run`, ou null (texto solto não é run medido). */
export function runDoModelo(meta) {
  const r = meta?.provas?.run;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
}

/** Há caso de gabarito registrado (`provas.run.gabarito` ou `provas.gabarito`)? */
export function temGabarito(meta) {
  return !vazio(runDoModelo(meta)?.gabarito) || !vazio(meta?.provas?.gabarito);
}

/** A leitura do dono (`provas.revisao_do_curador`) está registrada? */
export function temLeituraDoDono(meta) {
  const r = meta?.provas?.revisao_do_curador;
  return !vazio(r) && !(typeof r === 'object' && !Array.isArray(r) && !Object.keys(r).length);
}

/** A versão que as provas sustentam, sem olhar a declaração. */
export function maturidadeDerivada(meta) {
  if (ehOuro(meta)) return 'V3';
  const run = runDoModelo(meta);
  // O caso de gabarito é condição da V2, como no critério: run com nota e três avaliadores num caso sem
  // gabarito (a medição dos moldes de 24 a 26/09/2026) mede a peça, mas não prova que ela achou o que devia.
  if (run && numero(run.nota) !== null && numero(run.nota) >= NOTA_DA_REGUA && (numero(run.avaliadores) ?? 0) >= AVALIADORES_MINIMOS && temGabarito(meta)) return 'V2';
  return 'V1';
}

/**
 * A versão de um modelo: `{ versao, declarada, derivada, problemas, nota, avaliadores, o_que_garante }`.
 * `declarada` é null quando o `modelo.yaml` não traz o campo (ou traz valor inválido).
 */
export function maturidadeDoModelo(meta) {
  const bruta = meta?.maturidade;
  const texto = vazio(bruta) ? null : String(bruta).trim().toUpperCase();
  const declarada = texto && ORDEM_DA_MATURIDADE[texto] ? texto : null;
  const derivada = maturidadeDerivada(meta);
  const problemas = [];
  if (texto && !declarada) problemas.push(`maturidade «${bruta}» inválida: use V1, V2 ou V3`);
  let versao = derivada;
  if (declarada) {
    if (ORDEM_DA_MATURIDADE[declarada] <= ORDEM_DA_MATURIDADE[derivada]) versao = declarada;
    if (declarada === 'V3' && !ehOuro(meta)) problemas.push('declara V3 sem provas.ouro: true (V3 é o modelo ouro); vale a versão das provas, ' + derivada);
    else if (declarada === 'V2' && derivada === 'V1') problemas.push(`declara V2 sem run medido com nota ${NOTA_DA_REGUA} ou mais, ${AVALIADORES_MINIMOS} avaliadores e caso de gabarito em provas.run (nota, avaliadores, gabarito); vale V1`);
    if (ehOuro(meta) && declarada !== 'V3') problemas.push(`provas.ouro: true com maturidade ${declarada}: ouro é V3 (declare V3 ou tire o ouro)`);
  }
  const run = runDoModelo(meta);
  const nota = numero(run?.nota);
  const avaliadores = numero(run?.avaliadores);
  return { versao, declarada, derivada, problemas, nota, avaliadores, o_que_garante: oQueGarante(versao, { nota, avaliadores, temRun: Boolean(run) }) };
}

/** O que a versão garante, em uma oração na voz do advogado (vai depois de "versão Vx:"). */
function oQueGarante(versao, { nota, avaliadores, temRun }) {
  if (versao === 'V3') return 'é ouro: run medido acima da régua e prosa revisada pelo curador';
  if (versao === 'V2') return `teve run medido com ${avaliadores ?? AVALIADORES_MINIMOS} avaliadores e nota ${nota}; ainda não é ouro`;
  if (!temRun || nota === null) return 'passou nas conferências automáticas e ainda não teve run medido';
  if (nota < NOTA_DA_REGUA) return `passou nas conferências automáticas; o run medido deu ${nota}, abaixo da régua de ${NOTA_DA_REGUA}`;
  return `passou nas conferências automáticas; o run medido deu ${nota}, mas sem os ${AVALIADORES_MINIMOS} avaliadores registrados`;
}

/** "versão V1: passou nas conferências automáticas e ainda não teve run medido". */
export function fraseDaMaturidade(mat) {
  return `versão ${mat.versao}: ${mat.o_que_garante}`;
}

/** O que falta para a próxima versão, na ordem em que o dono resolve. Vazio em V3. */
export function faltaParaAProxima(meta, versao = maturidadeDoModelo(meta).versao) {
  const falta = [];
  const run = runDoModelo(meta);
  const nota = numero(run?.nota);
  if (versao === 'V1') {
    if (!run || nota === null) falta.push(`run medido com nota ${NOTA_DA_REGUA} ou mais`);
    else if (nota < NOTA_DA_REGUA) falta.push(`run medido com nota ${NOTA_DA_REGUA} ou mais (o último deu ${nota})`);
    if (!run || (numero(run.avaliadores) ?? 0) < AVALIADORES_MINIMOS) falta.push(`${AVALIADORES_MINIMOS} avaliadores registrados no run`);
    if (!temGabarito(meta)) falta.push('caso de gabarito');
  } else if (versao === 'V2') {
    if (!temLeituraDoDono(meta)) falta.push('leitura do dono (provas.revisao_do_curador)');
    falta.push('critério de ouro registrado (provas.ouro)');
  }
  return falta;
}

/**
 * A fila de revisão do dono: os modelos de pacote V1 e V2, por área, com a data do modelo, o que
 * falta para a próxima versão e a nota do último run. `casa(areaDoModelo)` filtra pela área
 * pedida. Modelo do escritório e modelo incompleto (sem prosa) não entram: não são publicação.
 */
export function filaDeRevisao(modelos, { casa = null } = {}) {
  const itens = [];
  for (const m of modelos) {
    const meta = m.meta || {};
    if (meta.origem?.tipo === 'escritorio' || !m.completo) continue;
    if (casa && !casa(meta.area, meta)) continue;
    const mat = maturidadeDoModelo(meta);
    if (mat.versao === 'V3') continue;
    const run = runDoModelo(meta);
    itens.push({
      id: m.id,
      nome: meta.nome || m.id,
      area: meta.area ? String(meta.area) : '(sem área)',
      maturidade: mat.versao,
      declarada: mat.declarada,
      data: vazio(meta.versao) ? null : String(meta.versao),
      falta: faltaParaAProxima(meta, mat.versao),
      nota: mat.nota,
      data_do_run: run && !vazio(run.data) ? String(run.data) : null,
      problemas: mat.problemas,
    });
  }
  const porArea = new Map();
  for (const x of itens) {
    if (!porArea.has(x.area)) porArea.set(x.area, []);
    porArea.get(x.area).push(x);
  }
  // V2 primeiro (está mais perto do ouro); dentro da versão, o modelo mais antigo primeiro.
  const ordem = (a, b) => ORDEM_DA_MATURIDADE[b.maturidade] - ORDEM_DA_MATURIDADE[a.maturidade] || String(a.data || '').localeCompare(String(b.data || '')) || a.id.localeCompare(b.id);
  const areas = [...porArea.keys()].sort((a, b) => a.localeCompare(b)).map((area) => ({ area, modelos: porArea.get(area).sort(ordem) }));
  return { total: itens.length, v1: itens.filter((x) => x.maturidade === 'V1').length, v2: itens.filter((x) => x.maturidade === 'V2').length, areas };
}
