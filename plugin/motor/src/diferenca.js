// Diferença de um squad sobre o modelo de onde nasceu: as peças puras (sem disco) que o modelo do
// escritório usa para guardar só o que o escritório mudou e reaplicar isso por cima do modelo da
// área na versão de hoje.
//
// Por que diferença, e não cópia (revisão por execução de 24/09/2026, D2 a D4): a primeira versão
// guardava arquivos compilados inteiros. Um squad nunca mexido virava modelo duplicado em 15 dos
// 37 modelos (a numeração que o compilador refaz parecia mudança), o code do caso ia junto para o
// squad novo, e o texto fixo que o motor corrigiu depois ficava congelado no modelo (um pré-mortem
// perdia a trava de conflito de peça). Aqui há três níveis, do mais estável ao mais frágil:
//
// 1. desenho (`design.yaml`): campo a campo, listas de agentes e steps pelo id;
// 2. prosa (`prosa.yaml`): marcador a marcador, comparando texto normalizado (numeração de lista,
//    espaços e linhas em branco não são diferença);
// 3. trecho fixo (o que não cabe num marcador): diferença de linhas ancorada no texto em volta,
//    reaplicada só onde a âncora é encontrada uma única vez; âncora sumida é conflito relatado,
//    nunca aplicação às cegas.

import { createHash } from 'node:crypto';

export const hashDe = (texto) => createHash('sha256').update(String(texto)).digest('hex').slice(0, 16);

/**
 * Forma comparável da prosa de um marcador. O compilador renumera a lista que continua uma lista
 * fixa ("5." sai "7."), e o Build pode deixar espaço no fim ou linha em branco a mais: nada disso é
 * mudança do escritório (D2, medido em 15 dos 37 modelos).
 */
export function normalizarProsa(texto) {
  return String(texto ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^(\s*)\d+\.(\s)/, '$1#.$2').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export const mesmaProsa = (a, b) => normalizarProsa(a) === normalizarProsa(b);

/**
 * Desfaz a renumeração do compilador: a prosa extraída de um squad traz a lista que continua a
 * lista fixa com os números do squad ("7., 8."), e a do modelo com os do modelo ("5., 6."). Com a
 * mesma numeração dos dois lados, a diferença de linhas mostra só o que o escritório escreveu.
 */
export function alinharNumeracao(texto, base) {
  const nt = /^\s*(\d+)\.\s/.exec(String(texto));
  const nb = /^\s*(\d+)\.\s/.exec(String(base));
  if (!nt || !nb) return String(texto);
  const delta = Number(nt[1]) - Number(nb[1]);
  if (!delta) return String(texto);
  let esperado = Number(nt[1]);
  let aberta = true;
  return String(texto).split('\n').map((l) => {
    if (!aberta) return l;
    if (!l.trim()) { aberta = false; return l; }
    const m = /^(\d+)\.\s/.exec(l);
    if (!m) return l;
    if (Number(m[1]) !== esperado) { aberta = false; return l; }
    esperado += 1;
    return l.replace(/^\d+\./, `${Number(m[1]) - delta}.`);
  }).join('\n');
}

// ───────────────────────── trechos de linha (texto fixo) ─────────────────────────

const CONTEXTO = 3;
const linhasDe = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
const igualLinha = (a, b) => a.trimEnd() === b.trimEnd();

/** Script de edição linha a linha (LCS), com o começo e o fim comuns cortados antes. */
function editar(a, b) {
  let ini = 0;
  while (ini < a.length && ini < b.length && igualLinha(a[ini], b[ini])) ini++;
  let fimA = a.length;
  let fimB = b.length;
  while (fimA > ini && fimB > ini && igualLinha(a[fimA - 1], b[fimB - 1])) { fimA--; fimB--; }
  const ops = [];
  for (let i = 0; i < ini; i++) ops.push(['=', i, i]);
  const ma = a.slice(ini, fimA);
  const mb = b.slice(ini, fimB);
  if (ma.length * mb.length > 4_000_000) {
    // Miolo grande demais para a tabela: um bloco só, trocado inteiro. Nunca acontece com agente
    // ou step (centenas de linhas); é a proteção contra um arquivo acrescentado gigante.
    ma.forEach((_, k) => ops.push(['-', ini + k, null]));
    mb.forEach((_, k) => ops.push(['+', null, ini + k]));
  } else {
    const n = ma.length;
    const m = mb.length;
    const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = igualLinha(ma[i], mb[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && igualLinha(ma[i], mb[j])) { ops.push(['=', ini + i, ini + j]); i++; j++; } else if (j < m && (i >= n || t[i][j + 1] >= t[i + 1][j])) { ops.push(['+', null, ini + j]); j++; } else { ops.push(['-', ini + i, null]); i++; }
    }
  }
  for (let k = 0; k < a.length - fimA; k++) ops.push(['=', fimA + k, fimB + k]);
  return ops;
}

/**
 * Trechos que levam `antigo` a `novo`: cada um com até três linhas de contexto antes e depois
 * (a âncora), as linhas a remover e as a inserir. `inicio`/`fim` marcam trecho colado na borda do
 * arquivo, onde a âncora é a própria borda.
 */
export function trechosEntre(antigo, novo) {
  const a = linhasDe(antigo);
  const b = linhasDe(novo);
  const ops = editar(a, b);
  const trechos = [];
  let k = 0;
  let limiteAnterior = 0;
  while (k < ops.length) {
    if (ops[k][0] === '=') { k++; continue; }
    // junta mudanças separadas por poucas linhas iguais: âncoras sobrepostas confundem a reaplicação
    let fim = k;
    while (fim < ops.length) {
      if (ops[fim][0] !== '=') { fim++; continue; }
      let iguais = 0;
      while (fim + iguais < ops.length && ops[fim + iguais][0] === '=') iguais++;
      if (fim + iguais < ops.length && iguais <= CONTEXTO * 2) { fim += iguais; continue; }
      break;
    }
    const bloco = ops.slice(k, fim);
    const inicioA = bloco.find((o) => o[1] !== null)?.[1] ?? (k > 0 ? ops[k - 1][1] + 1 : 0);
    const remover = bloco.filter((o) => o[0] !== '+').map((o) => a[o[1]]);
    // A âncora cresce até ser única no texto de base (até 12 linhas de cada lado): uma âncora
    // repetida (linha em branco, "## Output") não localiza nada na reaplicação.
    let antes = [];
    let depois = [];
    // Nunca entra no trecho vizinho: a âncora de um trecho é texto que o outro não muda.
    for (let ctx = CONTEXTO; ctx <= 12; ctx += 3) {
      antes = [];
      for (let x = k - 1; x >= limiteAnterior && antes.length < ctx; x--) antes.unshift(a[ops[x][1]]);
      depois = [];
      for (let x = fim; x < ops.length && ops[x][0] === '=' && depois.length < ctx; x++) depois.push(a[ops[x][1]]);
      if (acharSequencia(a, [...antes, ...remover, ...depois], 0, { inicio: k === 0, fim: fim === ops.length }).length <= 1) break;
    }
    trechos.push({
      antes,
      remover,
      inserir: bloco.filter((o) => o[0] !== '-').map((o) => b[o[2]]),
      depois,
      inicio: k === 0,
      fim: fim === ops.length,
      linha: inicioA + 1,
      secao: secaoAcima(a, inicioA),
    });
    limiteAnterior = fim;
    k = fim;
  }
  return trechos;
}

/** O título Markdown (`#`, `##`, `###`) mais próximo acima da linha `i`: a seção em que o trecho mora. */
function secaoAcima(linhas, i) {
  for (let x = Math.min(i, linhas.length) - 1; x >= 0; x--) if (/^#{1,6}\s/.test(linhas[x])) return linhas[x].trim();
  return null;
}

// Linha que não localiza nada sozinha: em branco, título solto, marcador de lista curto.
const linhaGenerica = (l) => !l.trim() || /^#{1,6}\s/.test(l.trim()) || l.trim().length < 12;
const normalLinha = (l) => l.replace(/^\s*(?:\d+\.|[-*])\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Depois de inserir item numerado, a lista em volta volta a contar em ordem: o escritório
 * acrescentou o "3." e o curador também, e sairiam dois "3." (revisão v2 de 25/09/2026, N6).
 */
function renumerarEmVolta(linhas, p) {
  let ini = p;
  while (ini > 0 && /^\d+\.\s/.test(linhas[ini - 1])) ini--;
  let fim = p;
  while (fim < linhas.length && /^\d+\.\s/.test(linhas[fim])) fim++;
  if (fim - ini < 2) return linhas;
  let n = Number(/^(\d+)\./.exec(linhas[ini])[1]);
  const saida = [...linhas];
  for (let x = ini; x < fim; x++) saida[x] = saida[x].replace(/^\d+\./, `${n++}.`);
  return saida;
}

function acharSequencia(linhas, seq, desde, { inicio = false, fim = false } = {}) {
  const achados = [];
  for (let p = inicio ? 0 : desde; p + seq.length <= linhas.length; p++) {
    if (inicio && p !== 0) break;
    let ok = true;
    for (let q = 0; q < seq.length; q++) if (!igualLinha(linhas[p + q], seq[q])) { ok = false; break; }
    if (ok && (!fim || p + seq.length === linhas.length)) achados.push(p);
    if (achados.length > 1) break;
  }
  return achados;
}

/**
 * Reaplica os trechos sobre `texto`. Cada trecho é procurado com a âncora inteira; sem ela, com uma
 * linha de contexto de cada lado (o motor mudou uma linha vizinha). Achado uma vez, aplica; já
 * aplicado (o modelo da área passou a trazer a mesma mudança), pula; sem âncora ou com âncora
 * repetida, é conflito, e o texto fica como o compilador gerou.
 */
export function aplicarTrechos(texto, trechos) {
  let linhas = linhasDe(texto);
  const finalComQuebra = /\n$/.test(String(texto));
  const aplicados = [];
  const conflitos = [];
  const jaEstavam = [];
  for (const t of trechos) {
    // Já está no texto (o curador passou a trazer a mesma linha, noutro ponto ou no mesmo): nada a
    // fazer. Só vale para o que acrescenta, e pela linha inteira normalizada: inserir duas vezes a
    // mesma regra era o defeito (revisão v2, N6).
    const novas = t.inserir.filter((l) => l.trim() && !linhaGenerica(l));
    const presentes = new Set(linhas.map(normalLinha));
    if (novas.length && !t.remover.some((l) => l.trim()) && novas.every((l) => presentes.has(normalLinha(l)))) { jaEstavam.push(t); continue; }
    // Âncora inteira; uma linha de cada lado; só o lado de cima ou só o de baixo (o curador mudou a
    // linha vizinha do outro lado). Qualquer delas só vale achada uma única vez, e a âncora curta
    // só vale com linha que localiza (não em branco, não título solto) e na mesma seção: com "uma
    // linha em branco depois de - Conferir a folha." a regra da seção B caía na seção A.
    const tentativas = [[t.antes, t.depois, false], [t.antes.slice(-1), t.depois.slice(0, 1), true]];
    if (t.antes.some((l) => l.trim())) tentativas.push([t.antes, [], true]);
    if (t.depois.some((l) => l.trim())) tentativas.push([[], t.depois, true]);
    let feito = false;
    let motivo = 'o texto em volta não existe mais no modelo de hoje';
    for (const [antes, depois, reduzida] of tentativas) {
      const ancoraVazia = ![...antes, ...t.remover, ...depois].some((l) => l.trim());
      if (ancoraVazia && !t.inicio && !t.fim) continue;
      if (reduzida && [...antes, ...t.remover, ...depois].every(linhaGenerica)) continue;
      const seq = [...antes, ...t.remover, ...depois];
      const opcoes = { inicio: t.inicio && antes.length === t.antes.length, fim: t.fim && depois.length === t.depois.length };
      const achados = acharSequencia(linhas, seq, 0, opcoes);
      if (achados.length === 1) {
        const p = achados[0] + antes.length;
        if (reduzida && t.secao !== undefined && secaoAcima(linhas, p) !== t.secao) { motivo = 'a seção em que o escritório mexeu não existe mais no modelo de hoje'; continue; }
        linhas = [...linhas.slice(0, p), ...t.inserir, ...linhas.slice(p + t.remover.length)];
        if (t.inserir.some((l) => /^\d+\.\s/.test(l))) linhas = renumerarEmVolta(linhas, p);
        aplicados.push(t);
        feito = true;
        break;
      }
      if (achados.length > 1) motivo = 'o texto em volta aparece mais de uma vez';
      const jaAplicado = acharSequencia(linhas, [...antes, ...t.inserir, ...depois], 0, opcoes);
      if (jaAplicado.length === 1) { jaEstavam.push(t); feito = true; break; }
    }
    if (!feito) conflitos.push({ ...t, motivo });
  }
  return { texto: `${linhas.join('\n')}${finalComQuebra ? '\n' : ''}`, aplicados, conflitos, jaEstavam };
}

// ───────────────────────── desenho (design.yaml) ─────────────────────────

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (ehObjeto(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  if (v === null || v === undefined) return 'null';
  return JSON.stringify(String(v).replace(/\s+/g, ' ').trim());
};
export const canonico = canon;
const chaveDaLista = (lista) => {
  if (!lista.length || !lista.every(ehObjeto)) return null;
  for (const k of ['id', 'name']) {
    const vals = lista.map((x) => x[k]);
    if (vals.every((v) => typeof v === 'string' && v.trim()) && new Set(vals).size === vals.length) return k;
  }
  return null;
};

/**
 * Diferença de desenho: operações `alterar`, `acrescentar` e `remover` por caminho. Mapas campo a
 * campo; listas de objetos com `id` (agentes, steps) ou `name` (tasks) item a item, pela chave; o
 * resto (texto, lista de skills, critérios) como valor inteiro. Ordem de chave e espaço não contam.
 * Cada operação guarda o hash do valor de base, para a reaplicação saber se o modelo da área
 * também mudou aquele ponto.
 */
export function diferencaDeDesign(base, atual, caminho = []) {
  if (canon(base) === canon(atual)) return [];
  if (ehObjeto(base) && ehObjeto(atual)) {
    const ops = [];
    for (const k of new Set([...Object.keys(base), ...Object.keys(atual)])) {
      if (!(k in atual)) ops.push({ op: 'remover', caminho: [...caminho, k], base: hashDe(canon(base[k])) });
      else if (!(k in base)) ops.push({ op: 'acrescentar', caminho: [...caminho, k], valor: atual[k] });
      else ops.push(...diferencaDeDesign(base[k], atual[k], [...caminho, k]));
    }
    return ops;
  }
  if (Array.isArray(base) && Array.isArray(atual)) {
    const chave = chaveDaLista(base) && chaveDaLista(base) === chaveDaLista(atual) ? chaveDaLista(base) : null;
    if (chave) {
      const ops = [];
      const idsBase = new Set(base.map((x) => x[chave]));
      const idsAtual = new Set(atual.map((x) => x[chave]));
      for (const item of base) if (!idsAtual.has(item[chave])) ops.push({ op: 'remover', caminho: [...caminho, { [chave]: item[chave] }], base: hashDe(canon(item)) });
      atual.forEach((item, i) => {
        if (!idsBase.has(item[chave])) ops.push({ op: 'acrescentar', caminho: [...caminho, { [chave]: item[chave] }], valor: item, apos: i > 0 ? atual[i - 1][chave] : null });
        else ops.push(...diferencaDeDesign(base.find((x) => x[chave] === item[chave]), item, [...caminho, { [chave]: item[chave] }]));
      });
      return ops;
    }
  }
  return [{ op: 'alterar', caminho, valor: atual, base: hashDe(canon(base)) }];
}

const rotuloDoPasso = (p) => (ehObjeto(p) ? Object.values(p)[0] : p);
export const caminhoLegivel = (caminho) => caminho.map(rotuloDoPasso).join(' › ');

/** Reaplica a diferença de desenho sobre o desenho do modelo de hoje. Devolve o desenho e os conflitos. */
export function aplicarDiferencaDeDesign(design, ops) {
  const alvo = structuredClone(design);
  const conflitos = [];
  const avisos = [];
  for (const o of ops) {
    const pai = o.caminho.slice(0, -1);
    const ultimo = o.caminho[o.caminho.length - 1];
    let no = alvo;
    let perdido = false;
    for (const passo of pai) {
      if (ehObjeto(passo)) {
        const [k, v] = Object.entries(passo)[0];
        no = Array.isArray(no) ? no.find((x) => ehObjeto(x) && x[k] === v) : undefined;
      } else no = ehObjeto(no) ? no[passo] : undefined;
      if (no === undefined || no === null) { perdido = true; break; }
    }
    if (perdido) { conflitos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o ponto do desenho que o escritório mudou não existe mais no modelo da área' }); continue; }
    if (ehObjeto(ultimo)) {
      if (!Array.isArray(no)) { conflitos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o desenho do modelo da área mudou de forma' }); continue; }
      const [k, v] = Object.entries(ultimo)[0];
      const i = no.findIndex((x) => ehObjeto(x) && x[k] === v);
      if (o.op === 'remover') {
        if (i < 0) continue;
        if (hashDe(canon(no[i])) !== o.base) avisos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o modelo da área mudou este item, que o escritório tinha tirado; continua tirado' });
        no.splice(i, 1);
      } else if (o.op === 'acrescentar') {
        if (i >= 0) {
          if (canon(no[i]) !== canon(o.valor)) avisos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o modelo da área passou a ter um item com o mesmo nome; ficou o do escritório' });
          no[i] = o.valor;
        } else {
          const j = o.apos ? no.findIndex((x) => ehObjeto(x) && x[k] === o.apos) : -1;
          no.splice(j >= 0 ? j + 1 : (o.apos === null ? 0 : no.length), 0, o.valor);
        }
      } else conflitos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'operação desconhecida' });
      continue;
    }
    if (!ehObjeto(no)) { conflitos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o desenho do modelo da área mudou de forma' }); continue; }
    if (o.op === 'remover') {
      if (!(ultimo in no)) continue;
      if (hashDe(canon(no[ultimo])) !== o.base) avisos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o modelo da área mudou este campo, que o escritório tinha tirado; continua tirado' });
      delete no[ultimo];
    } else if (o.op === 'alterar') {
      if (!(ultimo in no)) { conflitos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o campo que o escritório mudou não existe mais no modelo da área' }); continue; }
      if (hashDe(canon(no[ultimo])) !== o.base) avisos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o modelo da área também mudou este campo depois que o escritório salvou; ficou o valor do escritório' });
      no[ultimo] = o.valor;
    } else if (o.op === 'acrescentar') {
      if (ultimo in no && canon(no[ultimo]) !== canon(o.valor)) avisos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'o modelo da área passou a ter este campo; ficou o valor do escritório' });
      no[ultimo] = o.valor;
    } else conflitos.push({ caminho: caminhoLegivel(o.caminho), motivo: 'operação desconhecida' });
  }
  return { design: alvo, conflitos, avisos };
}
