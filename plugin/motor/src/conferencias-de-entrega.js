// Conferências de entrega por código: o que a final promete e o pacote tem de cumprir.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para o
// `squad-state` (raiz e templates), onde o `manifesto-final` o usa. Usa `LINHA_DA_NOTA_AO_REVISOR`
// do bloco `pendencia`, que mora no mesmo arquivo de destino; aqui, pelo import.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LINHA_DA_NOTA_AO_REVISOR } from './pendencia.js';

// >>> conferencias-de-entrega:begin
// Padrões medidos na 1a rodada por molde (01/10/2026, motor 0.9.80): anexo citado na final e ausente do
// pacote (m2: "segue anexa como arquivo próprio (contingencia.md)"; m3: "a saída íntegra no Anexo I
// deste parecer"); ponto aprovado no diagnóstico que some da final (m4: a cl. 8.1, no ponto 4 do
// foco); premissa marcada [CONFIRMAR] que entra no total sem linha própria (m2: contribuição de
// 20%); documento à contraparte no mesmo arquivo do roteiro interno (m4).

const semAcentoDaEntrega = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** O texto sem o bloco da nota ao revisor (linhas trocadas por vazias, para as linhas não mudarem). */
function pecaSemNota(texto) {
  let dentro = false;
  return String(texto ?? '').split('\n').map((l) => {
    const m = l.match(LINHA_DA_NOTA_AO_REVISOR);
    if (m) { dentro = m[1] === 'inicio'; return ''; }
    return dentro ? '' : l;
  }).join('\n');
}

/** Arquivos do run por nome (versões `vN/` e a raiz do run; nunca `_meta`, `_tmp` nem `pacote`). */
function arquivosDoRunPorNome(runDir) {
  const mapa = new Map();
  const andar = (d, nivel) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('_') || e.name.startsWith('.') || e.name === 'pacote') continue;
      const c = join(d, e.name);
      if (e.isDirectory()) { if (nivel < 3) andar(c, nivel + 1); continue; }
      const atual = mapa.get(e.name);
      // A versão mais alta vence: `v12/contingencia.md` sobre `v2/contingencia.md`.
      const v = Number((c.match(/\/v(\d+)\//) || [])[1] || 0);
      if (!atual || v > atual.v) mapa.set(e.name, { caminho: c, v });
    }
  };
  andar(runDir, 0);
  return mapa;
}

const ANEXO_PROPRIO = /\banex[oa]s?\b[^.\n]{0,60}?\b(?:a|deste|desta|a este|a esta|neste|nesta)\s+(?:parecer|relatorio|peca|peticao|roteiro|documento|minuta|memorial|laudo|estudo)\b|\b(?:segue|seguem|vai|vao|acompanha|acompanham)\s+(?:em\s+)?anex[oa]s?\b|\banexo\s+(?:[ivxlc]+|\d+|[a-z])\s+(?:deste|desta)\b/;
// O que a final diz que a acompanha sem dizer "anexo" (m2c da 0.9.82: "na tabela de contingência que
// acompanha este relatório (arquivo contingencia.md)") e o arquivo que ela nomeia como tal ("arquivo
// contingencia.md"): também é anexo, e tem de estar no pacote.
const ACOMPANHA_A_FINAL = /\b(?:acompanha|acompanham|segue|seguem|vai|vao)\s+(?:junto\s+(?:a|com)\s+|com\s+)?(?:este|esta|o presente|a presente)\s+(?:parecer|relatorio|peca|peticao|roteiro|documento|minuta|memorial|laudo|estudo|dossie)\b/;
const ARQUIVO_NOMEADO = /\barquivos?\s+(?:proprios?\s+|anexos?\s+|separados?\s+)?\(?[\w.-]+\.(?:md|pdf|xlsx|csv|docx)\b/;
// Documento do cliente citado pela numeração dos autos ("a procuração que acompanha esta petição
// (Doc. 01)"): é prova, não anexo da peça; o cruzamento dos documentos é do empacotador.
const DOC_DO_CLIENTE = /\bdocs?\.\s*(?:\d|$)/;

/**
 * Os anexos que a final diz trazer: a frase que diz que algo "segue anexo", está "no Anexo I deste
 * parecer", "acompanha este relatório" ou está no "arquivo contingencia.md". Cada um se resolve pelo
 * arquivo que a frase nomeia (`contingencia.md`), achado no run, ou pelo `--anexo "Anexo I=<caminho>"`
 * (ou `--anexo "contingencia.md=<caminho>"`) do conferente. O documento do cliente ("Anexo I do
 * contrato do Município", "acompanha esta petição (Doc. 01)") e o anexo de lei ("Anexo XII da LC
 * 214/2025") não são anexo da peça.
 */
function anexosDaFinal(texto, runDir, mapeados = new Map()) {
  const doRun = arquivosDoRunPorNome(runDir);
  const frases = pecaSemNota(texto).split(/(?<=[.;!?])\s+|\n/);
  const resolvidos = [];
  const semArquivo = [];
  for (const frase of frases) {
    const n = semAcentoDaEntrega(frase);
    const nomes = [...frase.matchAll(/([\w.-]+\.(?:md|pdf|xlsx|csv|docx|json))\b/g)].map((m) => m[1]);
    const acompanha = ACOMPANHA_A_FINAL.test(n) && (nomes.length || !DOC_DO_CLIENTE.test(n));
    if (!ANEXO_PROPRIO.test(n) && !acompanha && !ARQUIVO_NOMEADO.test(n)) continue;
    const ref = (frase.match(/\bAnexo\s+(?:[IVXLC]+|\d+|[A-Z])\b/) || [null])[0];
    const mapeado = (ref && mapeados.get(semAcentoDaEntrega(ref))) || nomes.map((x) => mapeados.get(semAcentoDaEntrega(x))).find(Boolean);
    const achado = mapeado ? { caminho: mapeado } : nomes.map((x) => doRun.get(x)).find(Boolean);
    const item = { referencia: ref || nomes[0] || frase.trim().slice(0, 80), frase: frase.trim().slice(0, 200) };
    if (achado && existsSync(achado.caminho)) { if (!resolvidos.some((r) => r.arquivo === achado.caminho)) resolvidos.push({ ...item, arquivo: achado.caminho }); } else semArquivo.push({ ...item, ...(nomes.length ? { nomeado: nomes } : {}) });
  }
  return { resolvidos, semArquivo };
}

/** As seções do foco aprovado que listam o que a final carrega (pontos, teses, danos e valores aprovados). */
function itensAprovadosDoFoco(foco) {
  const L = String(foco ?? '').split('\n');
  const itens = [];
  for (let i = 0; i < L.length; i += 1) {
    const h = L[i].match(/^(#{1,6})\s+(.+)/);
    if (!h || !/(?:pontos|teses) aprovad|danos e valores aprovad|clausulas aprovad/.test(semAcentoDaEntrega(h[2]))) continue;
    for (let j = i + 1; j < L.length; j += 1) {
      const o = L[j].match(/^(#{1,6})\s/);
      if (o && o[1].length <= h[1].length) break;
      const m = L[j].match(/^\s*(?:\d+[.)]|[-*])\s+(.+)/);
      if (m) itens.push(m[1]);
      else if (itens.length && L[j].trim()) itens[itens.length - 1] += ` ${L[j].trim()}`;
    }
  }
  return itens;
}

/**
 * O que o foco aprovado nomeia e a final não traz. A âncora que recusa é a cláusula (do contrato,
 * da convenção): é o ponto que a tese usa e que o resumo perde em silêncio. Valor e data faltando
 * vão como aviso, porque a final os escreve de outro jeito (por extenso, somados).
 */
function focoForaDaFinal(foco, final) {
  const f = semAcentoDaEntrega(final);
  const recusas = [];
  const avisos = [];
  itensAprovadosDoFoco(foco).forEach((it, i) => {
    for (const m of it.matchAll(/\b(?:cl\.|cl[aá]usula)\s*(\d+(?:\.\d+)*)/gi)) {
      const v = m[1].replace(/\./g, '\\.');
      if (!new RegExp(`\\b(?:cl\\.|clausulas?)\\s*(?:\\d+(?:\\.\\d+)*\\s*(?:,|e|a)\\s*)*${v}\\b`).test(f) && !recusas.some((r) => r.ancora === `cl. ${m[1]}`)) recusas.push({ item: i + 1, ancora: `cl. ${m[1]}`, trecho: it.slice(0, 160) });
    }
    for (const m of it.matchAll(/R\$\s*([\d.]+,\d{2})/g)) if (!f.includes(m[1])) avisos.push({ item: i + 1, ancora: `R$ ${m[1]}` });
  });
  return { recusas, avisos };
}

/** Premissa marcada como dado a confirmar que entra em valor: aviso, para o total sair com e sem ela. */
function premissasNoTotal(texto) {
  const peca = pecaSemNota(texto);
  if (!/\btotal\b/i.test(peca)) return [];
  const out = [];
  peca.split('\n').forEach((l, i) => {
    if (!/\[(?:A[ _])?CONFIRMAR\b/.test(l)) return;
    const n = semAcentoDaEntrega(l);
    if (/\d+(?:,\d+)?\s?%|\baliquota\b|\bpremissa\b|\bbase de calculo\b|\bencargos?\b|\bcontribuicao\b/.test(n) && /r\$\s*[\d.]+,\d{2}/.test(n)) out.push({ linha: i + 1, trecho: l.trim().slice(0, 160) });
  });
  return out;
}

const BLOCO_DA_CONTRAPARTE = /^[ \t]*<!--\s*para-a-contraparte:(inicio|fim)\s*-->[ \t]*\r?$/m;

// <<< conferencias-de-entrega:end

export { pecaSemNota, arquivosDoRunPorNome, anexosDaFinal, itensAprovadosDoFoco, focoForaDaFinal, premissasNoTotal, BLOCO_DA_CONTRAPARTE };
