// A identificação do caso que o chefe fez pelo pedido e pelos documentos: a peça, o polo, a fase e o
// último ato com prazo. Gravada no squad (`identificacao.json`) pelo `squad-modelo --identificacao`
// e, desde o teste de ponta a ponta de 30/09/2026 (achados 14 e 28), também pelo compilador quando o
// Arquiteto cria o squad de uma pasta de caso: o intake a mostra e a fase zero a confere contra os
// autos. Módulo sem dependência do squad-modelo nem do compilador: os dois a usam, cada um com o
// seu erro (`falha`).

import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const falhaPadrao = (m) => { throw new Error(m); };

/**
 * A identificação da peça que o chefe fez pelo pedido e pelos documentos, antes de escolher o
 * modelo (revisão de 23/09/2026): o seletor recebe só o nome técnico da peça, sem dado do caso;
 * o que liga o squad ao caso (polo, fase, último ato com prazo e a folha) fica gravado no squad,
 * para o intake mostrar e a fase zero conferir contra os autos.
 */
const CAMPOS_DA_IDENTIFICACAO = ['peca', 'polo', 'fase', 'ultimo_ato', 'fontes'];
/**
 * Fase pré-processual: ainda não há processo, então não há último ato com prazo nem folha (achado 8
 * do teste de ponta a ponta de 30/09/2026: a inicial de vizinhança, com os documentos do cliente
 * como fonte, era recusada sem `ultimo_ato.arquivo`, e o chefe inventou a notificação como último ato).
 */
const RE_PRE_PROCESSUAL = /^\s*pr[eé][\s-]*processual\b/i;
export const fasePreProcessual = (fase) => RE_PRE_PROCESSUAL.test(String(fase || ''));

/**
 * Sem processo (`processo: nenhum` no design do modelo: contrato, escritura, requerimento ao
 * registro), não há último ato com prazo nem folha: a identificação pelos documentos fixa peça,
 * polo e fase, e o último ato, quando houver (a minuta recebida, a nota devolutiva), vai pelo
 * documento do cliente, nunca pela folha (onda extrajudicial de 25/09/2026).
 */
export function validarIdentificacao(bruta, { semProcesso = false, falha = falhaPadrao } = {}) {
  let ident;
  try { ident = typeof bruta === 'string' ? JSON.parse(bruta) : bruta; } catch (e) { falha(`--identificacao não é JSON válido: ${e.message}`); }
  if (!ident || typeof ident !== 'object' || Array.isArray(ident)) falha('--identificacao precisa ser um objeto JSON');
  for (const c of ['peca', 'polo', 'fase']) if (!String(ident[c] || '').trim()) falha(`--identificacao sem «${c}»: o chefe fixa peça, polo e fase antes de criar`);
  const fontes = Array.isArray(ident.fontes) ? ident.fontes.map(String) : [];
  if (!fontes.length || fontes.some((f) => !['pedido', 'documentos'].includes(f))) falha('--identificacao.fontes: "pedido", "documentos" ou os dois (de onde saiu a identificação)');
  const desconhecidos = Object.keys(ident).filter((k) => !CAMPOS_DA_IDENTIFICACAO.includes(k));
  // `processo` (nenhum, a_ajuizar, judicial) é do design do squad, não da identificação: a
  // instrução os descrevia juntos e o chefe o mandava aqui (achado 5 do run de 01/10/2026).
  const doDesign = desconhecidos.includes('processo') ? '; `processo` é campo do design (squad.yaml), não da identificação: tire-o daqui' : '';
  if (desconhecidos.length) falha(`--identificacao com campo desconhecido: ${desconhecidos.join(', ')} (campos: ${CAMPOS_DA_IDENTIFICACAO.join(', ')})${doDesign}`);
  if (semProcesso || fasePreProcessual(ident.fase)) {
    if (ident.ultimo_ato !== undefined && ident.ultimo_ato !== null) {
      if (typeof ident.ultimo_ato !== 'object' || Array.isArray(ident.ultimo_ato) || !String(ident.ultimo_ato.ato || '').trim()) falha('--identificacao: ultimo_ato, quando houver, é um objeto com ato (e, havendo, data e arquivo, o documento do cliente onde está)');
      if (String(ident.ultimo_ato.folha || '').trim()) falha(`--identificacao: ${semProcesso ? 'sem processo' : 'na fase pré-processual'} não há folha; o último ato vai pelo documento do cliente (ultimo_ato.arquivo) e, se quiser, pela página`);
    }
    return { ...ident, fontes };
  }
  if (fontes.includes('documentos') && !(ident.ultimo_ato && String(ident.ultimo_ato.ato || '').trim())) falha('--identificacao pelos documentos precisa de ultimo_ato.ato (e, havendo, data e folha)');
  // A folha em texto livre não localiza o ato: "documento 10" era a numeração interna do PJe, e o
  // arquivo nos autos tinha o prefixo 18 (medido em 24/09/2026, despejo). O nome do arquivo é a
  // âncora que a fase zero confere; a folha fica como complemento.
  if (fontes.includes('documentos') && !String(ident.ultimo_ato.arquivo || '').trim()) {
    falha('--identificacao pelos documentos precisa de ultimo_ato.arquivo: o nome do arquivo dos autos onde está o ato (ex.: "18-sentenca.pdf"). A numeração interna do documento ("documento 10") não é o nome do arquivo e não serve de âncora.');
  }
  return { ...ident, fontes };
}

/**
 * Com `--caso`, os autos já estão no disco: o arquivo do último ato tem de existir lá (em
 * `autos/` ou na pasta do caso, pelo caminho ou pelo nome em qualquer subpasta). Devolve null
 * quando acha e a mensagem de erro quando não acha.
 */
export function conferirArquivoDoUltimoAto(ident, pastaDoCaso) {
  const arquivo = String(ident?.ultimo_ato?.arquivo || '').trim();
  if (!arquivo || !pastaDoCaso || !existsSync(pastaDoCaso)) return null;
  for (const base of [join(pastaDoCaso, 'autos'), pastaDoCaso]) if (existsSync(join(base, arquivo))) return null;
  const nome = basename(arquivo);
  const pilha = [pastaDoCaso];
  let vistos = 0;
  while (pilha.length && vistos < 5000) {
    const dir = pilha.pop();
    let entradas;
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      vistos += 1;
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) pilha.push(join(dir, e.name));
      else if (e.name === nome) return null;
    }
  }
  return `--identificacao: ultimo_ato.arquivo «${arquivo}» não está na pasta do caso. Use o nome do arquivo como está nos autos (a numeração interna do documento pode não bater com o prefixo do arquivo).`;
}

