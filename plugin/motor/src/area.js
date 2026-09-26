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
  consumidor: ['consumidor', 'consumerista'],
  empresarial: ['empresarial', 'comercial', 'societario'],
  tributario: ['tributario', 'fiscal'],
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

