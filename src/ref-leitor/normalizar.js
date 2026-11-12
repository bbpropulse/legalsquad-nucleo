// Normalização de texto compartilhada pelo índice, pela carga e pela API.
// Módulo puro: nada de disco, nada de rede.
import { createHash } from 'node:crypto';

/** Tira acentos e outros sinais diacríticos ("inscrição" vira "inscricao"). */
export function semAcento(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '');
}

/** Forma usada nas buscas: sem acento, minúscula, espaços colapsados. */
export function normalizarBusca(texto) {
  return semAcento(texto).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function sha256(texto) {
  return createHash('sha256').update(typeof texto === 'string' ? Buffer.from(texto, 'utf8') : texto).digest('hex');
}

/** "1.030" e "1030" são o mesmo número de artigo, de lei ou de súmula. */
export function numeroSemPonto(numero) {
  return String(numero ?? '').replace(/[.\s]/g, '').toLowerCase();
}

const ROMANOS = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** Algarismo romano em número; devolve null se a sequência não é romana válida. */
export function romanoParaNumero(romano) {
  const s = String(romano || '').toLowerCase();
  if (!/^[ivxlcdm]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const atual = ROMANOS[s[i]];
    const prox = ROMANOS[s[i + 1]] || 0;
    total += atual < prox ? -atual : atual;
  }
  return total > 0 && total < 4000 ? total : null;
}

/** Ano de dois dígitos ("90", "15") vira quatro, olhando o ano corrente. */
export function anoCompleto(ano, agora = new Date()) {
  const s = String(ano || '').trim();
  if (/^\d{4}$/.test(s)) return s;
  if (!/^\d{2}$/.test(s)) return null;
  const n = Number(s);
  const corte = agora.getUTCFullYear() % 100;
  return String(n <= corte ? 2000 + n : 1900 + n);
}

/**
 * Texto do dispositivo como ele é guardado e servido: linhas sem espaço sobrando nas pontas e
 * sem linhas em branco repetidas. O sha256 do índice é calculado sobre exatamente este texto.
 */
export function textoCanonico(texto) {
  return String(texto ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** JSON com chaves em ordem: a assinatura de um manifesto não pode depender da ordem de inserção. */
export function jsonCanonico(valor) {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  const chaves = Object.keys(valor).filter((k) => valor[k] !== undefined).sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${jsonCanonico(valor[k])}`).join(',')}}`;
}
