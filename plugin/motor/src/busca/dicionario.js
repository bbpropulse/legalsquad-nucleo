// Carrega o dicionário de consulta (dados/busca/dicionario.json) e o do usuário, se houver.
// O do usuário fica em `<raiz da referência>/busca/dicionario.json` e SOMA ao embarcado.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizar } from './texto.js';

let embarcado = null;
function ler(caminho) {
  try { return JSON.parse(readFileSync(caminho, 'utf8')); } catch { return null; }
}

export function carregarDicionario(raiz = null) {
  if (!embarcado) embarcado = ler(fileURLToPath(new URL('../../dados/busca/dicionario.json', import.meta.url))) || { equivalencias: [], assuntos: [], areas: {} };
  const meu = raiz ? ler(join(raiz, 'busca', 'dicionario.json')) : null;
  const soma = (a, b) => [...(a || []), ...(b || [])];
  const d = { equivalencias: soma(embarcado.equivalencias, meu?.equivalencias), assuntos: soma(embarcado.assuntos, meu?.assuntos), areas: { ...(embarcado.areas || {}), ...(meu?.areas || {}) } };
  const frase = (s) => ` ${normalizar(s).replace(/[^a-z0-9]+/g, ' ').trim()} `;
  d.equivalencias = d.equivalencias.map((e) => ({ quando: (e.quando || []).map(frase), acrescentar: (e.acrescentar || []).map((x) => normalizar(x)) }));
  d.assuntos = d.assuntos.map((e) => ({ quando: (e.quando || []).map(frase), diplomas: (e.diplomas || []).map((x) => normalizar(x)) }));
  return d;
}

/** Entradas cuja frase aparece na consulta (em palavras inteiras, e também pelo radical do começo). */
export function entradasQueCasam(lista, consultaNormalizada) {
  const alvo = ` ${consultaNormalizada.replace(/[^a-z0-9]+/g, ' ').trim()} `;
  return lista.filter((e) => e.quando.some((f) => alvo.includes(f)));
}

export function areaDoDicionario(dic, area) {
  const a = normalizar(String(area || '').replace(/[-_]+/g, ' ')).replace(/\bdireitos?\b/g, '').replace(/\b(?:d[aeo]s?)\b/g, '').replace(/\s+/g, ' ').trim();
  if (!a) return null;
  const chaves = Object.keys(dic.areas).filter((k) => k !== 'descricao');
  const alias = { criminal: 'penal', civel: 'civil', trabalhista: 'trabalho', 'do trabalho': 'trabalho', previdenciaria: 'previdenciario', consumerista: 'consumidor', 'do consumidor': 'consumidor', tributaria: 'tributario', 'processual civil': 'processual', 'processual penal': 'penal', 'processo penal': 'penal', 'processo civil': 'processual', lgpd: 'digital', 'protecao de dados': 'digital', transito: 'transito', 'familia e sucessoes': 'familia', sucessoes: 'sucessoes' };
  const chave = alias[a] || a;
  const k = chaves.find((c) => c === chave) || chaves.find((c) => chave.includes(c) || c.includes(chave));
  return k ? { chave: k, ...dic.areas[k] } : null;
}

export { existsSync };
