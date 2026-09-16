#!/usr/bin/env node
/**
 * Verificador de contrato — consistência interna, determinística
 * (ENTREGA.md §4, linha "Contrato"; PLANO-ORQUESTRADOR.md, Fase 7).
 *
 * Para `delivery_type: legal-draft` com leitor `contraparte`, o gate de
 * persuasão não vale: quem lê é o advogado do outro lado, e o que ele derruba
 * primeiro é a incoerência interna — termo definido que ninguém usa, remissão
 * a cláusula que não existe, numeração que salta, dois prazos para a mesma
 * obrigação, campo que ficou em branco. Este script mede isso sem interpretar.
 *
 * Cinco sinais, cada um `aprovado`, `reprovado` ou `nao-avaliado` — mesmo
 * desenho do Redação Gate (`src/redacao-gate.js`): o que não dá para medir é
 * declarado com motivo, nunca presumido; `nao-avaliado` não é aprovação.
 *
 * 1. termos-definidos — termo definido (`"Termo" significa…`, `(a "Termo")`,
 *    `doravante "Termo"`, seção de Definições com `**Termo**:` / `Termo –`) e
 *    nunca usado fora da definição reprova. Termo capitalizado no meio de
 *    frase, 2+ vezes, sem definição, é AVISO no motivo e não reprova sozinho:
 *    pode ser nome próprio, e o gate não adivinha.
 * 2. remissoes — "Cláusula 5.2", "item 3.1", "cláusula quinta" apontam para
 *    cláusula que existe. "cláusula anterior/seguinte" não tem número, logo
 *    não é remissão medível.
 * 3. numeracao — `1.`, `1.1`, `CLÁUSULA PRIMEIRA`, `Cláusula 1ª` formam UMA
 *    sequência, sem salto nem repetição (ordinal por extenso até a trigésima
 *    nona). Lista numerada dentro de cláusula é lida como cláusula: o script
 *    não distingue, e prefere apontar a linha a calar.
 * 4. contradicoes — o MESMO parâmetro (prazo em dias/meses/anos, valor em R$,
 *    multa em %, foro/comarca, índice de reajuste) fixado com valores
 *    diferentes em cláusulas diferentes; e algarismo divergindo do extenso
 *    entre parênteses na mesma cláusula. Lexical: só compara quando o
 *    parâmetro está nomeado na frase ou no título da cláusula — "prazo de
 *    pagamento" e "prazo de vigência" são parâmetros distintos, e número sem
 *    nome não é comparado com nada.
 * 5. campos-abertos — `[●]`, `[___]`, `{{…}}`, `XX/XX/XXXX`, `R$ ____`,
 *    `[CAIXA ALTA]`, `____` no meio da linha (linha só de sublinhado é
 *    assinatura ou régua, não campo).
 *
 * Blockquote não é redação (é minuta alheia, lei ou modelo transcrito) e fica
 * fora de todos os sinais. Todo motivo nomeia a cláusula ou a linha.
 *
 * Uso:
 *   node scripts/verifica-contrato.mjs <contrato.md>          # uma linha por sinal
 *   node scripts/verifica-contrato.mjs <contrato.md> --json   # resultado completo
 *
 * Sai com 0 em consulta — é o runner quem decide o que fazer com `ok: false`;
 * 1 quando o arquivo não existe ou o uso está errado.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SINAIS = ['termos-definidos', 'remissoes', 'numeracao', 'contradicoes', 'campos-abertos'];
const NAO_AVALIADO = 'nao-avaliado';

export class ErroDeUso extends Error {}

const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Minúsculas sem acento — a base de toda comparação. */
export const normalizar = (t) => semAcento(t).toLowerCase();
const escaparRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_LISTA = 12;
const lista = (itens) => (itens.length > MAX_LISTA ? `${itens.slice(0, MAX_LISTA).join('; ')}; … (+${itens.length - MAX_LISTA})` : itens.join('; '));
const plural = (n, um, muitos) => `${n} ${n === 1 ? um : muitos}`;

// ── Estrutura: linhas, cláusulas, títulos ────────────────────────────────

/** Linhas redigidas com o número original; blockquote sai. */
export function linhasRedigidas(texto) {
  return String(texto ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map((t, i) => ({ numero: i + 1, texto: t }))
    .filter((l) => !/^\s*>/.test(l.texto));
}

const UNIDADES_ORDINAIS = { primeira: 1, segunda: 2, terceira: 3, quarta: 4, quinta: 5, sexta: 6, setima: 7, oitava: 8, nona: 9 };
const DEZENAS_ORDINAIS = { decima: 10, vigesima: 20, trigesima: 30 };
const ORD = '(?:d[eé]cima|vig[eé]sima|trig[eé]sima)(?:[\\s-]+(?:primeira|segunda|terceira|quarta|quinta|sexta|s[eé]tima|oitava|nona))?|primeira|segunda|terceira|quarta|quinta|sexta|s[eé]tima|oitava|nona';

/** "décima primeira" → 11; fora do vocabulário → null. */
export function ordinalParaNumero(texto) {
  const partes = normalizar(texto).trim().split(/[\s-]+/).filter(Boolean);
  if (partes.length === 1) return UNIDADES_ORDINAIS[partes[0]] ?? DEZENAS_ORDINAIS[partes[0]] ?? null;
  if (partes.length !== 2) return null;
  const dez = DEZENAS_ORDINAIS[partes[0]];
  const uni = UNIDADES_ORDINAIS[partes[1]];
  return dez && uni ? dez + uni : null;
}

/** Linha curta e em caixa alta — título de cláusula sem separador (`CLÁUSULA PRIMEIRA DO OBJETO`). */
function ehCaixaAlta(texto) {
  if (texto.length > 120) return false;
  const letras = texto.match(/\p{L}/gu) || [];
  if (letras.length < 4) return false;
  return (texto.match(/\p{Lu}/gu) || []).length / letras.length >= 0.8;
}

/** Sem separador depois do número, só é título se a linha for caixa alta, heading markdown ou negrito: "Cláusula Quinta" solta pode ser remissão com quebra de linha. */
function tituloSolto(linha) {
  return ehCaixaAlta(linha) || /^\s{0,3}#{1,6}\s/.test(linha) || /^\s*(?:\*\*|__)/.test(linha);
}

const PREFIXO = '^\\s{0,3}(?:#{1,6}\\s+)?(?:\\*{1,2}|_{1,2})?\\s*';
const SEPARADOR = '(\\s*(?:[.:)|]|[-–—]|\\*\\*|$))';
const RE_TITULO_ORDINAL = new RegExp(`${PREFIXO}cl[aá]usula\\s+(${ORD})(?![\\p{L}])${SEPARADOR}\\**\\s*(.*)$`, 'iu');
const RE_TITULO_CLAUSULA_N = new RegExp(`${PREFIXO}cl[aá]usula\\s+(\\d{1,3})\\s*(?:[ªº°]|a\\b|o\\b)?${SEPARADOR}\\**\\s*(.*)$`, 'iu');
// `1.`, `1)`, `1 –`, `1.1`, `1.1.`, `**1.1**`. Subnível com até dois dígitos:
// `1.500` (milhar) não é cláusula 1.500, e `10 dias` no início da linha não é cláusula 10.
const RE_TITULO_NUMERO = /^\s{0,3}(?:#{1,6}\s+)?(?:\*{1,2}|_{1,2})?\s*(?:(\d{1,3}(?:\.\d{1,2})+)\.?|(\d{1,3})(?:[.)]|(?=\s+[-–—]\s)))(?:\*{1,2}|_{1,2})?(?=\s|$)\s*(?:[-–—]\s*)?(.*)$/u;

/**
 * Título de cláusula na linha: `{ id, partes, resto }` ou null. `resto` é o
 * texto depois do número — o que ainda é redação e entra nos outros sinais.
 */
export function lerCabecalho(texto) {
  const linha = String(texto ?? '');
  let m = linha.match(RE_TITULO_ORDINAL);
  if (m) {
    const n = ordinalParaNumero(m[1]);
    if (n && (m[2].trim() !== '' || tituloSolto(linha))) return { id: String(n), partes: [n], resto: m[3].replace(/\*+\s*$/, '').trim() };
  }
  m = linha.match(RE_TITULO_CLAUSULA_N);
  if (m && (m[2].trim() !== '' || tituloSolto(linha))) {
    const n = Number(m[1]);
    return { id: String(n), partes: [n], resto: m[3].replace(/\*+\s*$/, '').trim() };
  }
  m = linha.match(RE_TITULO_NUMERO);
  if (m) {
    const partes = (m[1] ?? m[2]).split('.').map(Number);
    return { id: partes.join('.'), partes, resto: m[3].replace(/\*+\s*$/, '').trim() };
  }
  return null;
}

/** Título de seção (para achar a seção de Definições): markdown, cláusula, negrito só, caixa alta. */
function lerTitulo(texto, cabecalho) {
  const md = texto.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
  if (md) return { tipo: 'md', nivel: md[1].length, texto: md[2] };
  if (cabecalho) return { tipo: 'clausula', nivel: cabecalho.partes.length, texto: cabecalho.resto };
  const negrito = texto.match(/^\s*(?:\*\*|__)([^*_].*?)(?:\*\*|__)\s*:?\s*$/);
  if (negrito) return { tipo: 'negrito', nivel: 1, texto: negrito[1] };
  if (ehCaixaAlta(texto.trim()) && texto.trim().length <= 100) return { tipo: 'caixa', nivel: 1, texto: texto.trim() };
  return null;
}

/**
 * Estrutura do contrato: cada linha com o seu `conteudo` (texto sem o número
 * de cláusula), a cláusula em que está e o título de seção, se for um; e a
 * lista de cláusulas numeradas em ordem de documento.
 */
export function extrairEstrutura(texto) {
  const linhas = [];
  const clausulas = [];
  let atual = null;
  for (const l of linhasRedigidas(texto)) {
    const cabecalho = lerCabecalho(l.texto);
    if (cabecalho) {
      atual = { id: cabecalho.id, partes: cabecalho.partes, linha: l.numero, titulo: cabecalho.resto };
      clausulas.push(atual);
    }
    linhas.push({
      numero: l.numero,
      texto: l.texto,
      conteudo: cabecalho ? cabecalho.resto : l.texto,
      clausula: atual ? atual.id : null,
      titulo: lerTitulo(l.texto, cabecalho),
    });
  }
  return { linhas, clausulas };
}

// ── 1. Termos definidos ──────────────────────────────────────────────────

const ABRE = '["“„]';
const FECHA = '["”]';
const TERMO = '([^"“”„\\n]{2,60}?)';
const VERBO_DEFINE = '(?:significa(?:m|r[aá]|r[aã]o)?|designa(?:m|r[aá]|r[aã]o)?|refere(?:m)?-se|corresponde(?:m)?|compreende(?:m)?|abrange(?:m)?|denota(?:m)?)';
/** Definição inline, em qualquer ponto do contrato. */
const RE_DEF_INLINE = [
  new RegExp(`${ABRE}${TERMO}${FECHA}\\s*${VERBO_DEFINE}\\b`, 'giu'),
  new RegExp(`\\(\\s*(?:(?:a|o|as|os|doravante|simplesmente|denominad[oa]s?|em\\s+conjunto|conjuntamente|individualmente|cada\\s+uma|e|,)\\s*)*${ABRE}${TERMO}${FECHA}\\s*\\)`, 'giu'),
  new RegExp(`\\b(?:doravante|denominad[oa]s?)\\s+(?:denominad[oa]s?\\s+)?(?:simplesmente\\s+)?(?:como\\s+|de\\s+)?${ABRE}${TERMO}${FECHA}`, 'giu'),
  new RegExp(`\\bentende-se\\s+por\\s+${ABRE}${TERMO}${FECHA}`, 'giu'),
];
/** Entrada de uma seção de Definições (depois do marcador de lista ou da célula de tabela). */
const MARCADOR_LISTA = /^\s{0,3}(?:[-*+•]\s+|\(?(?:[a-z]|[ivx]{1,4}|\d{1,2})[.)]\s+)?\|?\s*/iu;
const RE_DEF_ENTRADA = [
  /^(?:\*\*|__)([^*_\n]{2,60}?)(?:\*\*|__)\s*(?:[:|.]|[-–—]|\s+(?:significa|designa)\b)/iu,
  new RegExp(`^${ABRE}${TERMO}${FECHA}\\s*(?:[:|.]|[-–—]|\\s*${VERBO_DEFINE}\\b)`, 'iu'),
  /^(\p{Lu}[\p{L}\d&'-]*(?:\s+(?:d[aeo]s?\s+|e\s+)?\p{Lu}[\p{L}\d&'-]*){0,4})\s*(?::|\s[-–—]\s|\s*[–—]\s*)/u,
];
/** Rótulo de estrutura não é termo definido. */
const NAO_E_TERMO = /^(?:paragrafo|nota|observacao|exemplo|item|subitem|clausula|secao|anexo|art|artigo|tabela|quadro)\b/;

/** Índices das linhas dentro de uma seção cujo título fala em Definições. */
function linhasDeDefinicoes(linhas) {
  const dentro = new Set();
  let inicio = null;
  linhas.forEach((l, i) => {
    const t = l.titulo;
    if (inicio) {
      const fecha = t && (
        (t.tipo === 'md' && t.nivel <= (inicio.tipo === 'md' ? inicio.nivel : 6))
        || (t.tipo === 'clausula' && t.nivel === 1 && inicio.tipo !== 'md')
        || (t.tipo === inicio.tipo && (inicio.tipo === 'negrito' || inicio.tipo === 'caixa'))
      );
      if (!fecha) { dentro.add(i); return; }
      inicio = null;
    }
    if (t && /\bdefinic/.test(normalizar(t.texto))) inicio = t;
  });
  return dentro;
}

/** Definições encontradas: `{ termo, linha, origem: 'inline'|'secao', indice, ini, fim }`. */
export function extrairDefinicoes(estrutura) {
  const { linhas } = estrutura;
  const secao = linhasDeDefinicoes(linhas);
  const definicoes = [];
  linhas.forEach((l, i) => {
    for (const re of RE_DEF_INLINE) {
      for (const m of l.conteudo.matchAll(re)) {
        definicoes.push({ termo: m[1].trim(), linha: l.numero, origem: 'inline', indice: i, ini: m.index, fim: m.index + m[0].length });
      }
    }
    if (!secao.has(i)) return;
    const corpo = l.conteudo.replace(MARCADOR_LISTA, '');
    for (const re of RE_DEF_ENTRADA) {
      const m = corpo.match(re);
      if (!m) continue;
      definicoes.push({ termo: m[1].trim(), linha: l.numero, origem: 'secao', indice: i, ini: 0, fim: l.conteudo.length });
      break;
    }
  });
  return definicoes.filter((d) => d.termo.length >= 2 && d.termo.length <= 60 && /\p{L}/u.test(d.termo) && !NAO_E_TERMO.test(normalizar(d.termo)));
}

/** Regex do termo no texto normalizado: palavra inteira, plural em -s/-es tolerado. */
function regexDoTermo(termo) {
  let base = normalizar(termo).trim();
  if (base.length > 3 && base.endsWith('s')) base = base.slice(0, -1);
  return new RegExp(`(?<![\\p{L}\\d])${escaparRegex(base).replace(/\s+/g, '\\s+')}(?:s|es)?(?![\\p{L}\\d])`, 'giu');
}

const RE_CAPITALIZADO = /(?<=\p{Ll}[,;]?\s+)(\p{Lu}\p{Ll}{2,}(?:\s+(?:d[aeo]s?\s+)?\p{Lu}\p{Ll}{2,})*)/gu;
/** Estrutura, referência legal e endereço: capitalizados por convenção, não por definição. */
const STOP_CAPITALIZADO = new Set([
  'clausula', 'clausulas', 'paragrafo', 'item', 'subitem', 'anexo', 'anexos', 'secao', 'capitulo', 'artigo', 'art', 'inciso', 'alinea',
  'lei', 'decreto', 'codigo', 'resolucao', 'portaria', 'sumula', 'tema', 'constituicao', 'medida',
  'foro', 'comarca', 'vara', 'juizo', 'tribunal', 'justica', 'estado', 'municipio', 'uniao', 'brasil', 'republica',
  'rua', 'avenida', 'praca', 'bairro', 'cidade', 'unico', 'unica',
  ...Object.keys(UNIDADES_ORDINAIS), ...Object.keys(DEZENAS_ORDINAIS),
]);

/**
 * Avalia `termos-definidos`. Devolve `{ sinal, motivo, definidos, naoUsados, avisos }`;
 * `naoUsados` é null quando não há definição para medir.
 */
export function avaliarTermosDefinidos(estrutura) {
  const { linhas } = estrutura;
  const definicoes = extrairDefinicoes(estrutura);
  const unicos = new Map();
  for (const d of definicoes) {
    const chave = normalizar(d.termo);
    if (!unicos.has(chave)) unicos.set(chave, d);
  }
  const definidos = [...unicos.values()].map((d) => ({ termo: d.termo, linha: d.linha }));

  // Uso: fora da definição. Entrada de seção mascara a linha inteira; definição
  // inline mascara só o trecho entre aspas — o parágrafo pode usar o termo logo depois.
  const mascaradas = linhas.map((l) => l.conteudo);
  for (const d of definicoes) {
    const atual = mascaradas[d.indice];
    mascaradas[d.indice] = d.origem === 'secao' ? '' : `${atual.slice(0, d.ini)}${' '.repeat(d.fim - d.ini)}${atual.slice(d.fim)}`;
  }
  const corpoNormalizado = mascaradas.map(normalizar).join('\n');

  // Aviso: capitalizado no meio de frase, 2+ vezes, sem definição.
  const contagem = new Map();
  for (const l of linhas) {
    for (const m of l.conteudo.matchAll(RE_CAPITALIZADO)) contagem.set(m[1], (contagem.get(m[1]) || 0) + 1);
  }
  const chavesDefinidas = [...unicos.keys()];
  const avisos = [...contagem.entries()]
    .filter(([frase, n]) => {
      const chave = normalizar(frase);
      if (n < 2 || STOP_CAPITALIZADO.has(chave.split(/\s+/)[0])) return false;
      return !chavesDefinidas.some((d) => d === chave || d.includes(chave) || chave.includes(d));
    })
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([termo, ocorrencias]) => ({ termo, ocorrencias }));
  const textoAviso = avisos.length
    ? ` Aviso: ${lista(avisos.map((a) => `"${a.termo}" (${a.ocorrencias}×)`))} aparece(m) com inicial maiúscula no meio de frase sem definição — nome próprio ou termo por definir; não reprova sozinho.`
    : '';

  if (!definidos.length) {
    return {
      sinal: NAO_AVALIADO,
      motivo: `termos-definidos NÃO AVALIADO: nenhuma definição encontrada ("Termo" significa…, (a "Termo"), doravante "Termo", ou seção de Definições com **Termo**: / Termo –).${textoAviso}`,
      definidos, naoUsados: null, avisos,
    };
  }
  const naoUsados = definidos.filter((d) => !regexDoTermo(d.termo).test(corpoNormalizado));
  if (naoUsados.length) {
    return {
      sinal: 'reprovado',
      motivo: `termos-definidos REPROVADO: ${lista(naoUsados.map((d) => `"${d.termo}" (definido na linha ${d.linha})`))} — termo definido e nunca usado fora da definição. Ou o contrato usa outro nome para a mesma coisa, ou a definição sobrou.${textoAviso}`,
      definidos, naoUsados, avisos,
    };
  }
  return { sinal: 'aprovado', motivo: `termos-definidos APROVADO: ${plural(definidos.length, 'termo definido', 'termos definidos')}, todos usados fora da definição.${textoAviso}`, definidos, naoUsados, avisos };
}

// ── 2. Remissões ─────────────────────────────────────────────────────────

const ALVO = `(\\d{1,3}(?:\\.\\d{1,2})*)\\s*[ªº°]?|(${ORD})(?![\\p{L}])`;
const RE_REMISSAO = new RegExp(`\\b(cl[aá]usulas?|subitens|subitem|itens|item)\\s+(?:${ALVO})`, 'giu');
const RE_REMISSAO_SEGUINTE = new RegExp(`^\\s*(?:,|;|\\be\\b|\\bou\\b)\\s*(?:cl[aá]usulas?\\s+|subitens?\\s+|itens?\\s+)?(?:${ALVO})`, 'iu');

/** Remissões numeradas: `{ tipo, alvo, linha, clausula }`. "cláusula anterior" não tem número e não entra. */
export function extrairRemissoes(estrutura) {
  const remissoes = [];
  for (const l of estrutura.linhas) {
    for (const m of l.conteudo.matchAll(RE_REMISSAO)) {
      const tipo = /^cl/i.test(m[1]) ? 'cláusula' : 'item';
      const alvos = [];
      const alvo = (numero, ordinal) => (numero ? numero.split('.').map(Number).join('.') : String(ordinalParaNumero(ordinal)));
      alvos.push(alvo(m[2], m[3]));
      let resto = l.conteudo.slice(m.index + m[0].length);
      let seg;
      while ((seg = resto.match(RE_REMISSAO_SEGUINTE))) {
        alvos.push(alvo(seg[1], seg[2]));
        resto = resto.slice(seg[0].length);
      }
      for (const a of alvos) if (a !== 'null') remissoes.push({ tipo, alvo: a, linha: l.numero, clausula: l.clausula });
    }
  }
  return remissoes;
}

/** Avalia `remissoes`. Devolve `{ sinal, motivo, total, naoResolvidas }`; `naoResolvidas` é null sem remissão. */
export function avaliarRemissoes(estrutura) {
  const remissoes = extrairRemissoes(estrutura);
  if (!remissoes.length) {
    return { sinal: NAO_AVALIADO, motivo: 'remissoes NÃO AVALIADO: o contrato não remete a nenhuma cláusula ou item numerado.', total: 0, naoResolvidas: null };
  }
  const ids = new Set(estrutura.clausulas.map((c) => c.id));
  const existe = (alvo) => ids.has(alvo) || [...ids].some((id) => id.startsWith(`${alvo}.`));
  const naoResolvidas = remissoes.filter((r) => !existe(r.alvo));
  if (naoResolvidas.length) {
    const topo = estrutura.clausulas.filter((c) => c.partes.length === 1).map((c) => c.partes[0]);
    const existentes = ids.size
      ? `cláusulas numeradas no contrato: ${topo.length ? `${Math.min(...topo)} a ${Math.max(...topo)}` : [...ids].join(', ')}`
      : 'o contrato não tem cláusula numerada';
    const itens = naoResolvidas.map((r) => `${r.clausula ? `cláusula ${r.clausula} (linha ${r.linha})` : `linha ${r.linha}`} remete a ${r.tipo} ${r.alvo}, que não existe`);
    return { sinal: 'reprovado', motivo: `remissoes REPROVADO: ${lista(itens)} (${existentes}).`, total: remissoes.length, naoResolvidas };
  }
  return { sinal: 'aprovado', motivo: `remissoes APROVADO: ${plural(remissoes.length, 'remissão resolve', 'remissões resolvem')} para cláusula existente.`, total: remissoes.length, naoResolvidas };
}

// ── 3. Numeração ─────────────────────────────────────────────────────────

/** `cur` segue `prev`: irmão seguinte em algum nível (com o resto em 1) ou primeiro filho. */
function segue(prev, cur) {
  if (cur.length > prev.length && prev.every((p, i) => p === cur[i]) && cur.slice(prev.length).every((p) => p === 1)) return true;
  for (let nivel = 0; nivel < prev.length && nivel < cur.length; nivel++) {
    if (cur[nivel] === prev[nivel] + 1 && cur.slice(nivel + 1).every((p) => p === 1)) return true;
    if (cur[nivel] !== prev[nivel]) return false;
  }
  return false;
}

function esperados(prev) {
  const out = [];
  for (let nivel = prev.length - 1; nivel >= 0; nivel--) out.push([...prev.slice(0, nivel), prev[nivel] + 1].join('.'));
  out.push([...prev, 1].join('.'));
  return out;
}

/** Quebras de sequência: `{ clausula, linha, motivo }`. Depois de uma quebra a contagem recomeça dali. */
export function verificarSequencia(clausulas) {
  const quebras = [];
  const vistos = new Set();
  let prev = null;
  for (const c of clausulas) {
    let motivo = null;
    if (vistos.has(c.id)) motivo = `${c.id} repetida (linha ${c.linha})`;
    else if (!prev) { if (!c.partes.every((p) => p === 1)) motivo = `começa em ${c.id} (linha ${c.linha}), não em 1`; }
    else if (!segue(prev.partes, c.partes)) motivo = `quebra em ${c.id} (linha ${c.linha}): depois de ${prev.id} esperava ${esperados(prev.partes).join(', ')}`;
    if (motivo) quebras.push({ clausula: c.id, linha: c.linha, motivo });
    vistos.add(c.id);
    prev = c;
  }
  return quebras;
}

/** Avalia `numeracao`. Devolve `{ sinal, motivo, clausulas, quebras }`; `quebras` é null sem numeração. */
export function avaliarNumeracao(estrutura) {
  const { clausulas } = estrutura;
  if (!clausulas.length) {
    return { sinal: NAO_AVALIADO, motivo: 'numeracao NÃO AVALIADO: nenhuma cláusula numerada (1., 1.1, CLÁUSULA PRIMEIRA, Cláusula 1ª).', clausulas: 0, quebras: null };
  }
  const quebras = verificarSequencia(clausulas);
  if (quebras.length) {
    return { sinal: 'reprovado', motivo: `numeracao REPROVADO: ${lista(quebras.map((q) => q.motivo))}.`, clausulas: clausulas.length, quebras };
  }
  return { sinal: 'aprovado', motivo: `numeracao APROVADO: ${plural(clausulas.length, 'cláusula numerada', 'cláusulas numeradas')} em sequência (${clausulas[0].id} a ${clausulas[clausulas.length - 1].id}).`, clausulas: clausulas.length, quebras };
}

// ── 4. Contradições ──────────────────────────────────────────────────────

const NUMERO_EXTENSO = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
  cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400,
  quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900,
};

/** "dez mil e quinhentos reais e cinquenta centavos" → 10500 (centavos ignorados); fora do vocabulário → null. */
export function extensoParaNumero(texto) {
  const t = normalizar(texto)
    .replace(/\b(?:reais?|centavos?|por\s+cento|dias?|meses|mes|anos?|uteis|corridos)\b[\s\S]*$/, '')
    .replace(/[()%,.]/g, ' ');
  const tokens = t.split(/[\s-]+/).filter((x) => x && x !== 'e');
  if (!tokens.length) return null;
  let total = 0;
  let grupo = 0;
  for (const tok of tokens) {
    if (tok === 'mil') { total += (grupo || 1) * 1000; grupo = 0; }
    else if (tok === 'milhao' || tok === 'milhoes') { total += (grupo || 1) * 1000000; grupo = 0; }
    else if (tok in NUMERO_EXTENSO) grupo += NUMERO_EXTENSO[tok];
    else return null;
  }
  return total + grupo;
}

const TOPICOS_PRAZO = [
  ['vigência', /\bvigenc|\bvigor|\bdurac|\bdurar|\bprazo (?:do|deste|do presente) contrato\b|\bprazo contratual\b|\bprazo de duracao\b/g],
  ['pagamento', /\bpagament|\bpagar\b|\bpag[oa]s?\b|\bquita/g],
  ['entrega', /\bentreg/g],
  ['aviso prévio', /\baviso previo\b|\bantecedencia\b|\bdenunci|\brescis|\brescind/g],
  ['garantia', /\bgarantia\b/g],
  ['carência', /\bcarencia\b/g],
  ['cura', /\bsana[rd]|\bregulariza|\bpurga/g],
  ['confidencialidade', /\bconfidencial|\bsigilo\b/g],
  ['notificação', /\bnotific|\bcomunic/g],
  ['execução', /\bexecu[cç]|\bconclu|\bprestac/g],
];
const TOPICOS_VALOR = [
  ['mensal', /\bmensal|\bmensalidade|\bpor mes\b|\bcada mes\b/g],
  ['total', /\btotal\b|\bglobal\b|\bdo contrato\b|\bcontratual\b|\bpreco\b|\bremunerac/g],
  ['por hora', /\bhoras?\b|\bhorario/g],
  ['anual', /\banual|\bpor ano\b/g],
  ['multa', /\bmulta/g],
  ['caução', /\bcaucao\b|\bdeposito\b/g],
  ['sinal', /\bsinal\b|\bentrada\b/g],
  ['honorários', /\bhonorari/g],
  ['aluguel', /\balugue/g],
  ['limite', /\blimite\b|\bteto\b/g],
];
const DONOS_DE_PERCENTUAL = [
  ['multa', /\bmulta/g], ['juros', /\bjuros\b/g], ['desconto', /\bdescont/g], ['reajuste', /\breajust/g],
  ['comissão', /\bcomiss/g], ['honorários', /\bhonorari/g], ['participação', /\bparticipac/g], ['tributo', /\btribut|\bimposto|\bretenc/g],
];
const TOPICOS_MULTA = [
  ['moratória', /\bmorator|\bmora\b|\batraso/g],
  ['rescisória', /\brescis|\brescind|\bcompensator|\bdenunci/g],
  ['por descumprimento', /\bdescumpr|\binadimpl|\binfrac|\bviola/g],
];
const RE_PRAZO = /(\d{1,4})\s*(?:\(([^)]{1,80})\))?\s*(dias?|meses|mes|anos?)\b(?:\s+(uteis|corridos))?/g;
const RE_VALOR = /R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*(?:\(([^)]{1,120})\))?/g;
const RE_PERCENTUAL = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:\(([^)]{1,60})\))?\s*(?:%|por cento)\s*(?:\(([^)]{1,60})\))?/g;
// Sem a flag `i`: com ela, `\p{Lu}` casaria minúscula e "foro do domicílio do
// contratante" viraria comarca. A comarca tem de vir com inicial maiúscula.
const RE_FORO = /\b[Ff]oro\b(?:[^.;\n]{0,60}?\b[Cc]omarca\s+d[aeo]s?\s+|\s+(?:[Cc]entral\s+|[Rr]egional\s+)?d[aeo]s?\s+(?:[Cc]idade\s+d[aeo]s?\s+)?)(?!Elei|Compet|Privileg)(\p{Lu}\p{L}+(?:\s+(?:d[aeo]s?\s+)?\p{Lu}\p{L}+)*)/gu;
const RE_INDICE = /\b(IPCA(?:-?E)?|IGP-?M|IGP-?DI|INPC|IPC-?FIPE|IPC|INCC|SELIC|CDI|TR)\b/g;
const RE_FALA_DE_REAJUSTE = /\breajust|\bcorrig|\bcorrecao|\batualiz|\bindex/;

/** Tópico cuja palavra-chave está mais perto da posição do número; null se nenhuma aparece. */
function topicoMaisProximo(texto, posicao, topicos) {
  let melhor = null;
  for (const [nome, re] of topicos) {
    re.lastIndex = 0;
    for (const m of texto.matchAll(re)) {
      const distancia = Math.abs(m.index - posicao);
      if (!melhor || distancia < melhor.distancia) melhor = { nome, distancia };
    }
  }
  return melhor ? melhor.nome : null;
}

const numeroDigitos = (s) => Number(s.replace(/\./g, '').replace(',', '.'));

/**
 * Parâmetros fixados com valor: `{ parametro, topico, chave, qualificador, rotulo, algarismo, extenso, linha, clausula }`.
 * `topico` null = parâmetro sem nome na frase nem no título da cláusula (não entra em comparação).
 */
export function extrairParametros(estrutura) {
  const titulos = new Map(estrutura.clausulas.map((c) => [c.id, normalizar(c.titulo)]));
  const parametros = [];
  for (const l of estrutura.linhas) {
    const n = normalizar(l.conteudo);
    const titulo = l.clausula ? titulos.get(l.clausula) || '' : '';
    const topico = (topicos, posicao) => topicoMaisProximo(n, posicao, topicos) ?? topicoMaisProximo(titulo, 0, topicos);
    const base = { linha: l.numero, clausula: l.clausula };

    for (const m of n.matchAll(RE_PRAZO)) {
      const unidade = /^dia/.test(m[3]) ? 'dias' : /^mes/.test(m[3]) ? 'meses' : 'anos';
      const algarismo = Number(m[1]);
      const meses = unidade === 'anos' ? algarismo * 12 : algarismo;
      parametros.push({
        ...base, parametro: 'prazo', topico: topico(TOPICOS_PRAZO, m.index),
        chave: unidade === 'dias' ? `${algarismo} dias` : `${meses} meses`, qualificador: m[4] || null,
        exibicao: `${algarismo} ${m[3] === 'mes' ? 'mês' : m[3]}${m[4] ? ` ${m[4] === 'uteis' ? 'úteis' : m[4]}` : ''}`,
        rotulo: m[0].replace(/\s+/g, ' ').trim(), algarismo, extenso: m[2] ? extensoParaNumero(m[2]) : null,
      });
    }
    for (const m of l.conteudo.matchAll(RE_VALOR)) {
      const algarismo = numeroDigitos(m[1]);
      parametros.push({
        ...base, parametro: 'valor', topico: topico(TOPICOS_VALOR, m.index),
        chave: `R$ ${algarismo.toFixed(2).replace('.', ',')}`, qualificador: null, exibicao: `R$ ${m[1]}`,
        rotulo: m[0].replace(/\s+/g, ' ').trim(), algarismo, extenso: m[2] ? extensoParaNumero(m[2]) : null,
      });
    }
    for (const m of n.matchAll(RE_PERCENTUAL)) {
      if (topicoMaisProximo(n, m.index, DONOS_DE_PERCENTUAL) !== 'multa') continue;
      const algarismo = numeroDigitos(m[1]);
      const extensoBruto = m[2] ?? m[3];
      parametros.push({
        ...base, parametro: 'multa', topico: topicoMaisProximo(n, m.index, TOPICOS_MULTA) ?? topicoMaisProximo(titulo, 0, TOPICOS_MULTA) ?? 'multa',
        chave: `${String(algarismo).replace('.', ',')}%`, qualificador: null, exibicao: `${m[1]}%`,
        rotulo: m[0].replace(/\s+/g, ' ').trim(), algarismo, extenso: extensoBruto ? extensoParaNumero(extensoBruto) : null,
      });
    }
    for (const m of l.conteudo.matchAll(RE_FORO)) {
      parametros.push({ ...base, parametro: 'foro', topico: 'comarca', chave: normalizar(m[1]).trim(), qualificador: null, exibicao: m[1].trim(), rotulo: m[0].trim(), algarismo: null, extenso: null });
    }
    if (RE_FALA_DE_REAJUSTE.test(n)) {
      const m = l.conteudo.match(RE_INDICE);
      if (m) parametros.push({ ...base, parametro: 'reajuste', topico: 'índice', chave: m[0].toUpperCase().replace('-', ''), qualificador: null, exibicao: m[0], rotulo: m[0], algarismo: null, extenso: null });
    }
  }
  return parametros;
}

/** "30 dias" e "30 dias úteis" não se contradizem; "30 dias úteis" e "30 dias corridos" sim. */
const mesmoValor = (a, b) => a.chave === b.chave && (!a.qualificador || !b.qualificador || a.qualificador === b.qualificador);
const locusDe = (p) => (p.clausula ? `cláusula ${p.clausula}` : `linha ${p.linha}`);
const NOME_VALOR = {
  mensal: 'valor mensal', total: 'valor total', 'por hora': 'valor por hora', anual: 'valor anual', multa: 'valor da multa',
  caução: 'valor da caução', sinal: 'valor do sinal', honorários: 'valor dos honorários', aluguel: 'valor do aluguel', limite: 'valor-limite',
};
function nomeDoParametro(p) {
  if (p.parametro === 'prazo') return `prazo de ${p.topico}`;
  if (p.parametro === 'valor') return NOME_VALOR[p.topico] || `valor (${p.topico})`;
  if (p.parametro === 'multa') return p.topico === 'multa' ? 'multa' : `multa ${p.topico}`;
  if (p.parametro === 'foro') return 'foro (comarca)';
  return 'índice de reajuste';
}

/** Avalia `contradicoes`. Devolve `{ sinal, motivo, comparados, contradicoes, divergenciasDeExtenso }`. */
export function avaliarContradicoes(estrutura) {
  const parametros = extrairParametros(estrutura);
  const divergenciasDeExtenso = parametros
    .filter((p) => p.extenso !== null && p.algarismo !== null && Math.trunc(p.algarismo) !== p.extenso)
    .map((p) => ({ locus: locusDe(p), linha: p.linha, rotulo: p.rotulo, algarismo: p.algarismo, extenso: p.extenso }));

  const grupos = new Map();
  for (const p of parametros) {
    if (!p.topico) continue;
    const chave = `${p.parametro}|${p.topico}`;
    if (!grupos.has(chave)) grupos.set(chave, { nome: nomeDoParametro(p), loci: new Map() });
    const loci = grupos.get(chave).loci;
    const locus = locusDe(p);
    if (!loci.has(locus)) loci.set(locus, { linha: p.linha, valores: [] });
    if (!loci.get(locus).valores.some((v) => mesmoValor(v, p))) loci.get(locus).valores.push(p);
  }
  const comparados = [];
  const contradicoes = [];
  for (const { nome, loci } of grupos.values()) {
    if (loci.size < 2) continue;
    comparados.push(nome);
    const entradas = [...loci.entries()].sort((a, b) => a[1].linha - b[1].linha);
    const divergem = entradas.some(([, a], i) => entradas.slice(i + 1).some(([, b]) => !a.valores.some((va) => b.valores.some((vb) => mesmoValor(va, vb)))));
    if (divergem) {
      contradicoes.push({ parametro: nome, loci: entradas.map(([locus, { linha, valores }]) => ({ locus, linha, valores: valores.map((v) => v.exibicao) })) });
    }
  }

  const itens = [
    ...contradicoes.map((c) => `${c.parametro}: ${c.loci.map((l) => `${l.locus} (linha ${l.linha}) diz ${l.valores.join(' / ')}`).join(', ')}`),
    ...divergenciasDeExtenso.map((d) => `${d.locus} (linha ${d.linha}): "${d.rotulo}" — algarismo ${d.algarismo} e extenso ${d.extenso} divergem`),
  ];
  if (itens.length) {
    return { sinal: 'reprovado', motivo: `contradicoes REPROVADO: ${lista(itens)}.`, comparados, contradicoes, divergenciasDeExtenso };
  }
  if (!comparados.length) {
    return { sinal: NAO_AVALIADO, motivo: 'contradicoes NÃO AVALIADO: nenhum parâmetro nomeado (prazo, valor, multa, foro, reajuste) fixado em mais de uma cláusula.', comparados, contradicoes, divergenciasDeExtenso };
  }
  return { sinal: 'aprovado', motivo: `contradicoes APROVADO: ${plural(comparados.length, 'parâmetro fixado', 'parâmetros fixados')} em mais de uma cláusula, sem divergência (${comparados.join(', ')}).`, comparados, contradicoes, divergenciasDeExtenso };
}

// ── 5. Campos abertos ────────────────────────────────────────────────────

const CAMPOS_ABERTOS = [
  /\[\s*[●•◦○■□]\s*\]/g,
  /\[\s*_{2,}\s*\]/g,
  /\[\s*\]/g,
  /\{\{[^}\n]*\}\}/g,
  /\bX{2,}(?:[./-]X{2,})+\b/gi,
  /R\$\s*_{2,}/g,
  /\[[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9 .,/_-]+\](?!\()/g,
  /\bX{3,}\b/g,
  /_{3,}/g,
];
/** Linha só de sublinhado é assinatura ou régua horizontal, não campo. */
const SO_SUBLINHADO = /^[\s_|]*$/;

/** Avalia `campos-abertos`. Devolve `{ sinal, motivo, campos }`. */
export function avaliarCamposAbertos(estrutura) {
  const campos = [];
  for (const l of estrutura.linhas) {
    if (SO_SUBLINHADO.test(l.texto)) continue;
    const achados = [];
    for (const re of CAMPOS_ABERTOS) {
      re.lastIndex = 0;
      for (const m of l.texto.matchAll(re)) achados.push({ ini: m.index, fim: m.index + m[0].length, texto: m[0] });
    }
    achados.sort((a, b) => a.ini - b.ini || b.fim - a.fim);
    let fimAnterior = -1;
    for (const a of achados) {
      if (a.ini < fimAnterior) continue;
      fimAnterior = a.fim;
      campos.push({ linha: l.numero, clausula: l.clausula, texto: a.texto.length > 30 ? `${a.texto.slice(0, 27)}…` : a.texto });
    }
  }
  if (campos.length) {
    return { sinal: 'reprovado', motivo: `campos-abertos REPROVADO: ${plural(campos.length, 'campo em aberto', 'campos em aberto')} — ${lista(campos.map((c) => `${c.clausula ? `cláusula ${c.clausula}, ` : ''}linha ${c.linha}: \`${c.texto}\``))}.`, campos };
  }
  return { sinal: 'aprovado', motivo: 'campos-abertos APROVADO: nenhum placeholder ([●], [___], {{…}}, XX/XX/XXXX, R$ ____, [CAIXA ALTA]).', campos };
}

// ── Veredito ─────────────────────────────────────────────────────────────

/**
 * Verifica um contrato em Markdown. Devolve `{ ok, problemas[], sinais, motivos, achados }`:
 * `sinais` mapeia cada sinal a `aprovado`, `reprovado` ou `nao-avaliado`;
 * `problemas` traz o motivo de tudo que não aprovou; `achados` traz o detalhe
 * por sinal — medida que não foi tomada sai como null, nunca como zero.
 */
export function verificarContrato(texto) {
  const estrutura = extrairEstrutura(texto);
  const sinais = {};
  const motivos = {};
  const achados = {};
  const problemas = [];
  const registrar = (sinal, { sinal: estado, motivo, ...detalhe }) => {
    sinais[sinal] = estado;
    motivos[sinal] = motivo;
    achados[sinal] = detalhe;
    if (estado !== 'aprovado') problemas.push(motivo);
  };

  if (!estrutura.linhas.some((l) => l.texto.trim() !== '')) {
    for (const sinal of SINAIS) registrar(sinal, { sinal: NAO_AVALIADO, motivo: `${sinal} NÃO AVALIADO: contrato vazio — nenhuma linha redigida fora de blockquote.` });
    return { ok: false, problemas, sinais, motivos, achados };
  }

  registrar('termos-definidos', avaliarTermosDefinidos(estrutura));
  registrar('remissoes', avaliarRemissoes(estrutura));
  registrar('numeracao', avaliarNumeracao(estrutura));
  registrar('contradicoes', avaliarContradicoes(estrutura));
  registrar('campos-abertos', avaliarCamposAbertos(estrutura));

  return { ok: !Object.values(sinais).includes('reprovado'), problemas, sinais, motivos, achados };
}

/** Saída curta: cabeçalho e uma linha por sinal. */
export function formatarMarkdown(resultado, arquivo = 'contrato') {
  const reprovados = SINAIS.filter((s) => resultado.sinais[s] === 'reprovado');
  const naoAvaliados = SINAIS.filter((s) => resultado.sinais[s] === NAO_AVALIADO);
  const veredito = reprovados.length
    ? `REPROVADO em ${reprovados.join(', ')}`
    : naoAvaliados.length ? `sem reprovação (não avaliado: ${naoAvaliados.join(', ')})` : `APROVADO nos ${SINAIS.length} sinais`;
  return [`verifica-contrato: ${arquivo} — ${veredito}`, ...SINAIS.map((s) => `- ${resultado.motivos[s]}`)].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────

const USO = 'uso: node scripts/verifica-contrato.mjs <contrato.md> [--json]';

export function lerContrato(caminho) {
  const abs = resolve(caminho);
  if (!existsSync(abs)) throw new ErroDeUso(`arquivo não encontrado: ${caminho}`);
  if (statSync(abs).isDirectory()) throw new ErroDeUso(`${caminho} é uma pasta, não um contrato em Markdown`);
  return readFileSync(abs, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const desconhecidas = flags.filter((f) => f !== '--json');
  const entrada = args.find((a) => !a.startsWith('--'));
  if (!entrada || desconhecidas.length) {
    process.stderr.write(`${desconhecidas.length ? `opção desconhecida: ${desconhecidas.join(' ')}\n` : ''}${USO}\n`);
    process.exit(1);
  }
  try {
    const resultado = verificarContrato(lerContrato(entrada));
    process.stdout.write(flags.includes('--json')
      ? `${JSON.stringify({ arquivo: entrada, ...resultado }, null, 2)}\n`
      : `${formatarMarkdown(resultado, entrada)}\n`);
    process.exit(0);
  } catch (e) {
    if (e instanceof ErroDeUso) {
      process.stderr.write(`verifica-contrato: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}
