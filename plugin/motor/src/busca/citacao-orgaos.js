// Formas de citar que o leitor do servidor (src/ref-leitor, cópia byte a byte) não reconhece, tratadas
// ANTES dele, só no motor:
//   - "NR-35", "NR 35", "item 35.4.5 da NR-35": a norma regulamentadora é um documento por número e
//     versão (`reg:mte:norma-regulamentadora:<N>:<ano>`); vale a versão mais recente;
//   - siglas de ato de órgão: "RN ANS 465/2021", "RDC ANVISA 44", "IN RFB 2.055": viram a forma por
//     extenso que o leitor entende ("Resolução Normativa ANS 465/2021");
//   - súmula regional que só existe como item atomizado (`<trib>:at:<hash>`, título "Súmula N: ..."),
//     achada por tribunal e número (`resolverSumulaAtomizada`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizar } from './texto.js';

const SIGLAS = [
  [/\brn\s+ans\b/gi, 'Resolução Normativa ANS'],
  [/\brdc\s+anvisa\b/gi, 'Resolução RDC ANVISA'],
  [/\bres\.?\s+normativa\s+ans\b/gi, 'Resolução Normativa ANS'],
  [/\bin\s+inss\b/gi, 'Instrução Normativa INSS'],
  [/\bin\s+rfb\b/gi, 'Instrução Normativa RFB'],
  [/\bport\.?\s+mte\b/gi, 'Portaria MTE'],
];

let nomesDeLeis = null;
/** Nomes populares de lei (dados/busca/nomes-de-leis.json), do mais longo ao mais curto: "lei de alimentos gravídicos" antes de "lei de alimentos". */
function carregarNomes() {
  if (nomesDeLeis) return nomesDeLeis;
  let lista = [];
  try { lista = JSON.parse(readFileSync(fileURLToPath(new URL('../../dados/busca/nomes-de-leis.json', import.meta.url)), 'utf8')).nomes || []; } catch { /* sem o arquivo: só as siglas */ }
  nomesDeLeis = lista.map(([nome, forma]) => [new RegExp(`(?<![\\p{L}\\d])${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'giu'), forma]).sort((a, b) => b[0].source.length - a[0].source.length);
  return nomesDeLeis;
}

/** Texto com as siglas de órgão e os nomes populares de lei por extenso (o que o leitor do servidor entende). */
export function expandirSiglas(texto) {
  let t = String(texto || '');
  for (const [re, por] of SIGLAS) t = t.replace(re, por);
  // Só quando a citação é por nome ("art. 20 da LOAS"); com número de lei no texto, o número vale.
  if (!/\b(?:lei|lc|decreto)\b[^,;]{0,25}\d/i.test(t)) for (const [re, por] of carregarNomes()) if (re.test(t)) { t = t.replace(re, por); break; }
  return t;
}

/** `{ numero, item }` se o texto cita uma NR ("NR-35", "NR 12", "Norma Regulamentadora nº 35"); senão null. */
export function lerNr(texto) {
  const n = normalizar(texto);
  const m = /(?:^|[^a-z])(?:nr|norma regulamentadora)\s*(?:n\s*)?[-.º°o]*\s*(\d{1,2})(?!\d)/.exec(n);
  if (!m) return null;
  const numero = Number(m[1]);
  if (numero < 1 || numero > 40) return null;
  const item = /\b(?:item|subitem)\s+(\d{1,2}(?:\.\d+)+)/.exec(n)?.[1] || null;
  return { numero, item };
}

/** Resolve a NR no índice (camada reg-mte): o documento de maior ano. `{ docs: [ids] }` ou `{ docs: [] }`. */
export function resolverNr(bancos, numero) {
  const ids = new Set();
  for (const b of bancos) {
    try {
      for (const a of b.db.prepare('SELECT doc_id FROM apelido WHERE forma = ?').all(`norma-regulamentadora mte ${numero}`)) ids.add(a.doc_id);
    } catch { /* banco sem apelido */ }
  }
  const lista = [...ids].sort((a, b) => Number(b.split(':').pop()) - Number(a.split(':').pop()));
  return { docs: lista, escolhido: lista[0] || null, outras_versoes: lista.slice(1) };
}

/** "Súmula 55 do TRF5" → `{ tribunal: 'trf5', numero: '55' }`; senão null. */
export function lerSumulaRegional(texto) {
  const n = normalizar(texto);
  const m = /(?:sumula|enunciado)\s*(?:n\s*)?[.º°o]*\s*(\d+)\s*(?:do|da|de|\/|-)?\s*(?:tribunal\s+[a-z ]+?\s)?(trf\s?\d|trt\s?\d{1,2}|tj[a-z]{2}|tnu|tru\s?\d?)\b/.exec(n);
  if (!m) return null;
  return { numero: m[1], tribunal: m[2].replace(/\s+/g, '') };
}

/**
 * Súmula regional que o índice só tem como item atomizado: procura, nas camadas do índice, o item cujo título é "Súmula N: ..." (ou processo "Súmula N do TRIB"). `ref` é a Referencia.
 */
export function resolverSumulaAtomizada(ref, { tribunal, numero }) {
  const achados = [];
  const prefixo = `${/^tru\d?$/.test(tribunal) ? 'jef5' : tribunal}:at:%`;
  for (const b of ref.bancos) {
    try {
      for (const d of b.db.prepare("SELECT id, titulo, vigencia, selo, url_oficial, sha256_texto, conferido_em FROM doc WHERE id LIKE ? AND (titulo LIKE ? OR titulo LIKE ?) LIMIT 5").all(prefixo, `Súmula ${numero}: %`, `Súmula ${numero} %`)) achados.push({ ...d, camada: b.camada });
    } catch { /* ignora */ }
  }
  const vistos = new Set();
  return achados.filter((a) => (vistos.has(a.id) ? false : vistos.add(a.id)));
}
