// ---------------------------------------------------------------------------
// Área do Direito como FILTRO do roteador: casa a área de um squad ou de um
// squad-modelo (slug do pacote, ou texto livre do curador) com a área do caso.
// Revisão de 22/09/2026: sem isso, um escritório cível recebia squad criminal.
// ---------------------------------------------------------------------------
import { normalizarSlugDeArea } from './deposito.js';

/** Sinônimos que o Direito usa para a mesma área (slug do pacote × palavra do pedido). */
// Só palavras simples: slug composto ("direito-processual-civil") casa pelos tokens.
const SINONIMOS = {
  criminal: ['criminal', 'penal'],
  penal: ['criminal', 'penal'],
  trabalho: ['trabalho', 'trabalhista'],
  trabalhista: ['trabalho', 'trabalhista'],
  civil: ['civil', 'civel'],
  civel: ['civil', 'civel'],
  consumidor: ['consumidor', 'consumerista', 'consumo'],
  consumo: ['consumidor', 'consumerista', 'consumo'],
  empresarial: ['empresarial', 'comercial', 'societario'],
  tributario: ['tributario', 'fiscal'],
  // "fiscal" pedido alcança o tributário (casaArea); o canônico continua "fiscal", e o ramo "fiscal"
  // declarado pela contabilidade na disputa continua valendo antes deste sinônimo (areasNomeadas).
  fiscal: ['tributario', 'fiscal'],
  previdenciario: ['previdenciario', 'previdencia'],
  administrativo: ['administrativo', 'publico'],
  imobiliario: ['imobiliario', 'imoveis'],
  digital: ['digital', 'lgpd', 'internet'],
};

/** `direito-do-consumidor` → `consumidor`; `direito-processual-do-trabalho` → `processual-do-trabalho`; `criminal` → `criminal`. */
export function nucleoDaArea(texto) {
  return normalizarSlugDeArea(texto).replace(/^direito-(?:d[aeo]s?-)?/, '');
}

/**
 * A área de um squad (slug do pacote ou texto livre do modelo, "direito civil e do
 * consumidor") casa com a área pedida ("civil", "direito-civil", "cível")? Compara
 * pelos núcleos e pelos sinônimos; texto livre é tokenizado, para "civil e do
 * consumidor" casar tanto com civil quanto com consumidor.
 */
const VAZIAS = new Set(['direito', 'direitos', 'do', 'da', 'de', 'dos', 'das', 'e', 'ou', 'processual', 'processo', 'processos']);
const tokensDeArea = (texto) => normalizarSlugDeArea(texto).split('-').filter((t) => t && !VAZIAS.has(t));
// Singular e plural são a mesma área: `recursos-trabalhistas` é trabalhista. Tirar o `s`
// final dos dois lados é tosco e basta, porque só se compara token com token.
const raiz = (t) => (t.length > 3 ? t.replace(/s$/, '') : t);

/**
 * `ramos` são os ramos que o CURADOR declara para o pacote da área (`area_ramos` no
 * `_packs.yaml`, gravados no depósito): é por eles que "família" casa com
 * `direito-civil`. O motor não carrega tabela de matéria; quem sabe que família mora no
 * pacote civil é o pacote.
 */
/**
 * Ramos que valem para a área de um squad ou modelo escrita em texto livre ("direito
 * civil e do consumidor"): a união dos ramos de cada pacote cuja área casa com ela.
 * `ramosPorSlug` vem de `ramosDoDeposito`.
 */
export function ramosDaArea(areaDoItem, ramosPorSlug = {}) {
  if (!areaDoItem) return [];
  const ramos = new Set();
  for (const [slug, lista] of Object.entries(ramosPorSlug || {})) {
    if (casaArea(slug, areaDoItem) || casaArea(areaDoItem, slug)) for (const r of lista || []) ramos.add(r);
  }
  return [...ramos];
}

/**
 * Formas de uma palavra do pedido para comparar com o nome de uma área: singular ("cíveis" → cível,
 * "criminais" → criminal, "consumidores" → consumidor) e masculino ("previdenciárias" → previdenciário).
 * Só se compara palavra com palavra, então a forma a mais que não é área não casa com nada.
 */
function formasDaPalavra(t) {
  const formas = new Set([t, raiz(t)]);
  if (t.length > 4) {
    formas.add(t.replace(/eis$/, 'el').replace(/ais$/, 'al'));
    formas.add(t.replace(/([rz])es$/, '$1'));
  }
  for (const f of [...formas]) if (f.length > 4 && f.endsWith('a')) formas.add(`${f.slice(0, -1)}o`);
  return [...formas].map(raiz);
}

const alvosDaPalavra = (w) => (SINONIMOS[w] || SINONIMOS[raiz(w)] || [w]).map(raiz);
const canonicoDaPalavra = (w) => SINONIMOS[w] || SINONIMOS[raiz(w)] ? [...(SINONIMOS[w] || SINONIMOS[raiz(w)])].sort()[0] : null;

/**
 * Os nomes de área dentro do texto livre de um modelo ("direito civil, constitucional e administrativo",
 * "direito civil (família)", "advocacia extrajudicial"): cada trecho separado por vírgula, "e" ou
 * parênteses é um nome, com as palavras que o distinguem. Nome de duas palavras só vale inteiro:
 * "extrajudicial" sozinho é a notificação, não a advocacia extrajudicial.
 */
function nomesDaArea(area) {
  const trechos = String(area || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[(),/;]|\s+e\s+|-e-/);
  const nomes = [];
  for (const trecho of trechos) {
    const palavras = tokensDeArea(trecho);
    if (!palavras.length) continue;
    const canonico = palavras.map(canonicoDaPalavra).find(Boolean) || palavras.join('-');
    nomes.push({ palavras, canonico });
  }
  return nomes;
}

/**
 * As áreas que um texto livre (o pedido do usuário) nomeia, entre as `areas` conhecidas (as dos modelos
 * instalados e as do depósito): um nome de área inteiro no pedido, no singular ou no feminino, ou pelo
 * sinônimo; ou um ramo que o curador declara (`area_ramos`, por `ramosDe`), pela frase inteira do ramo
 * ("saúde suplementar", "família"), nunca por uma palavra solta dele ("tribunal" de tribunal do júri,
 * "contrato" de contratos). Volta a forma canônica (cível e civil são uma área só; penal e criminal
 * também), para contar quantas áreas diferentes o pedido nomeia; o ramo de uma área que o pedido também
 * nomeia não conta de novo ("cíveis e de família" é uma área).
 */
export function areasNomeadas(textoLivre, areas = [], ramosDe = () => []) {
  const slug = normalizarSlugDeArea(textoLivre);
  const formas = new Set(slug.split('-').filter((t) => t && !VAZIAS.has(t)).flatMap(formasDaPalavra));
  const nomeadas = new Set();
  const ramosNomeados = new Map();
  // Ramo de uma palavra que o curador declara para uma área da disputa e que está no pedido: essa
  // palavra é daquela área e não soma OUTRA pelo sinônimo. "fiscal" é ramo da contabilidade e
  // sinônimo do tributário; com a contabilidade na disputa, "diagnóstico fiscal" é dela, e o
  // tributário só conta pelo nome ("tributário"). Sem a contabilidade, o sinônimo vale como sempre.
  const ramosDaDisputa = new Set();
  for (const a of areas) for (const r of ramosDe(a) || []) {
    const ramo = normalizarSlugDeArea(r);
    if (ramo && !ramo.includes('-') && `-${slug}-`.includes(`-${ramo}-`)) ramosDaDisputa.add(raiz(ramo));
  }
  const casaPalavra = (w, proprios) => alvosDaPalavra(w).some((x) => formas.has(x) && (x === raiz(w) || !ramosDaDisputa.has(x) || proprios.has(x)));
  for (const a of areas) {
    const nomes = nomesDaArea(a);
    const proprios = new Set((ramosDe(a) || []).map((r) => raiz(normalizarSlugDeArea(r))));
    for (const n of nomes) if (n.palavras.every((w) => casaPalavra(w, proprios))) nomeadas.add(n.canonico);
    for (const r of ramosDe(a) || []) {
      const ramo = normalizarSlugDeArea(r);
      if (!ramo || !`-${slug}-`.includes(`-${ramo}-`)) continue;
      const canonico = ramo.split('-').map(canonicoDaPalavra).find(Boolean) || ramo;
      if (!ramosNomeados.has(canonico)) ramosNomeados.set(canonico, new Set());
      for (const n of nomes) ramosNomeados.get(canonico).add(n.canonico);
    }
  }
  for (const [canonico, donas] of ramosNomeados) if (![...donas].some((d) => nomeadas.has(d))) nomeadas.add(canonico);
  return [...nomeadas].sort();
}

export function casaArea(areaDoSquad, areaPedida, ramos = []) {
  if (!areaDoSquad || !areaPedida) return false;
  const n = normalizarSlugDeArea(areaDoSquad);
  if (n === normalizarSlugDeArea(areaPedida)) return true;
  // A área pedida pode ter mais de uma palavra ("processual civil", "civil e consumidor"):
  // cada palavra dela, com os sinônimos, é um alvo; "processual"/"processo" não distinguem área.
  const alvos = new Set();
  for (const t of tokensDeArea(areaPedida)) for (const s of SINONIMOS[t] || SINONIMOS[raiz(t)] || [t]) alvos.add(raiz(s));
  if (!alvos.size) return false;
  if (alvos.has(raiz(nucleoDaArea(areaDoSquad)))) return true;
  const doSquad = [areaDoSquad, ...(ramos || [])].flatMap(tokensDeArea);
  return doSquad.some((t) => alvos.has(raiz(t)));
}

