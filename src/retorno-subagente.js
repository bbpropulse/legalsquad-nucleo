// O retorno dos subagentes que dão veredito, lido por código (harness, etapa 1, item 2, 06/10/2026).
//
// O hook SubagentStop (`.claude/hooks/retorno-subagente.mjs`) grava o retorno bruto de cada
// verificador no run e o entrega a `squad-state retorno-subagente`, que confere o formato com os
// mesmos leitores que o cartório usa e, fora do formato, devolve ao subagente o que falta (até dois
// bloqueios). Aqui ficam os leitores que ainda não existiam como código:
//
// - a tabela do `verificador-citacoes` (Citação · Veredito · Fonte conferida · Consultada em ·
//   Trecho que sustenta · Observação) vira o `citations[]` que `gate-verdict --citacoes` registra;
//   antes, o chefe a transcrevia à mão para JSON, gravando a hora da máquina em `consulted_at`;
// - o bloco YAML `verdict`/`fixes`/`ajustes` que abre o arquivo do revisor do squad vira o veredito
//   que `review-verdict --retorno` registra, sem o chefe copiar cada fix para um `--fix`;
// - o relatório do `verificador-persuasao` (a tabela SOBREVIVE/PERDIDO e o veredito).
//
// O voto da meta (`extrairAvaliacaoMeta`, `normalizarAvaliacaoMeta`) e a tabela do contraditor
// (`ataquesDoContraditor`) já tinham leitor nos blocos meta-consenso e red-team: o comando usa
// esses, sem cópia.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM para `scripts/squad-state.mjs` e
// `templates/scripts/squad-state.mjs` (`npm run sync:blocos`). `gravidadeDoFix` vem do bloco
// review-loop, que o squad-state também carrega.

import { gravidadeDoFix } from './review-loop.js';

// >>> retorno-subagente:begin
/** Quantas vezes o hook devolve o mesmo subagente ao trabalho por formato; no terceiro, ele termina. */
const RETORNO_TETO_DE_BLOQUEIOS = 2;
/** Os nativos que dão veredito (o nome sem o prefixo `legalsquad:` do plugin). */
const RETORNO_NATIVOS_COM_VEREDITO = Object.freeze(['verificador-citacoes', 'verificador-persuasao', 'avaliador-squad', 'contraditor']);
/**
 * Os papéis do agente do squad que dão veredito. Ele vai como `general-purpose`, e o hook só o
 * reconhece pela marca que o código põe no despacho (`marcaDoVeredito`).
 */
const RETORNO_PAPEIS_COM_VEREDITO = Object.freeze(['revisao', 'conferencia']);

/** A linha que o código põe no despacho do agente do squad que dá veredito; o hook a lê no prompt. */
function marcaDoVeredito({ squad, run, papel }) {
  return `[legalsquad:veredito squad=${squad} run=${run} papel=${papel}]`;
}

const semAcentoDoRetorno = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const celulasDoRetorno = (linha) => linha.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const ehSeparadorDoRetorno = (celulas) => celulas.every((c) => /^:?-{2,}:?$/.test(c) || c === '');

/** As tabelas Markdown do texto: `{ cabecalho, linhas }`, com o cabeçalho sem acento e em minúsculas. */
function tabelasDoRetorno(texto) {
  const tabelas = [];
  let atual = null;
  for (const linha of String(texto ?? '').split(/\r?\n/)) {
    if (!/^\s*\|.*\|\s*$/.test(linha)) { atual = null; continue; }
    const celulas = celulasDoRetorno(linha);
    if (!atual) { atual = { cabecalho: celulas.map(semAcentoDoRetorno), linhas: [] }; tabelas.push(atual); continue; }
    if (ehSeparadorDoRetorno(celulas)) continue;
    atual.linhas.push(celulas);
  }
  return tabelas;
}

/** O texto fora das tabelas (onde ficam a contagem e o veredito geral). */
const foraDasTabelasDoRetorno = (texto) => String(texto ?? '').split(/\r?\n/).filter((l) => !/^\s*\|.*\|\s*$/.test(l)).join('\n');

/** O último APROVADO ou REPROVADO fora das tabelas, ou null. */
function vereditoGeralDoRetorno(texto) {
  const achados = [...foraDasTabelasDoRetorno(texto).matchAll(/\b(APROVADO|REPROVADO)\b/g)];
  return achados.length ? achados[achados.length - 1][1] : null;
}

/** O veredito de uma linha do verificador no enum do cartório, ou null. */
function statusDaCitacaoDoRetorno(celula) {
  const v = semAcentoDoRetorno(celula).replace(/[`*_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^verificad[ao] no acervo\b/.test(v)) return 'verificada_no_acervo';
  if (/^verificad[ao]\b/.test(v)) return 'verificada';
  if (/^divergente\b/.test(v)) return 'divergente';
  if (/^nao encontrad[ao]\b/.test(v)) return 'nao_encontrada';
  if (/^(?:cancelad|revogad|superad)/.test(v)) return 'cancelada';
  if (/^acesso falhou\b/.test(v)) return 'acesso_falhou';
  if (/^fonte mudou\b/.test(v)) return 'fonte_mudou';
  return null;
}

const tirarAspasDoRetorno = (t) => String(t ?? '').trim().replace(/^[`*]+|[`*]+$/g, '').replace(/^["“”«']+|["“”»']+$/g, '').trim();

/**
 * A frase inteira de ausência ("nenhuma citação a verificar", "não há citação"), nunca o pedaço de
 * outra frase. Medido no run de 09/10/2026 (trib-reforma-regime): o atalho casava "sem reprovar
 * nenhuma citação:" no resumo de um retorno com 17 citações em bloco JSON, e o hook gravou
 * `citations: []` com APROVADO. "Nenhuma citação inventada" ou "divergente" não é ausência.
 */
function retornoDizQueNaoHaCitacao(texto) {
  const t = semAcentoDoRetorno(texto).replace(/[`*_]/g, ' ').replace(/[ \t]+/g, ' ');
  const aVerificar = '(?:a|para) (?:verificar|conferir|checar)';
  return new RegExp(`\\b(?:(?:nenhuma|zero) citac(?:ao|oes) ${aVerificar}|nao ha (?:nenhuma )?citac(?:ao|oes)(?: ${aVerificar})?(?: (?:na|no|nesta|neste) (?:peca|minuta|texto|parecer|documento))? ?(?:[.;!?\\n]|$)|sem citac(?:ao|oes) ${aVerificar}|a (?:peca|minuta) nao (?:cita|traz) (?:nenhuma )?(?:citacao|lei|sumula|precedente|julgado) ?(?:[.;!?\\n]|$))`).test(t);
}

/** O primeiro array de citações de um objeto lido do retorno (`citations`, `tabela` ou `citacoes`), ou null. */
function arrayDeCitacoesDoRetorno(objeto) {
  if (Array.isArray(objeto)) return objeto;
  if (!objeto || typeof objeto !== 'object') return null;
  for (const chave of ['citations', 'tabela', 'citacoes']) if (Array.isArray(objeto[chave])) return objeto[chave];
  return null;
}

/**
 * O bloco JSON do retorno do verificador (```json ... ``` ou o retorno inteiro em JSON) com o array
 * de citações. Devolve `{ objeto, itens }` do primeiro bloco que tem o array, ou null.
 */
function blocoJsonDoVerificador(texto) {
  const bruto = String(texto ?? '');
  const candidatos = [...bruto.matchAll(/```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)].map((m) => m[1]);
  if (/^\s*[[{]/.test(bruto)) candidatos.push(bruto);
  for (const c of candidatos) {
    let objeto;
    try { objeto = JSON.parse(c); } catch { continue; }
    const itens = arrayDeCitacoesDoRetorno(objeto);
    if (itens) return { objeto, itens };
  }
  return null;
}

/** APROVADO ou REPROVADO no começo de um campo (`"APROVADO (para as citações pedidas)"`), ou null. */
function vereditoDoCampo(valor) {
  const m = semAcentoDoRetorno(valor).trim().match(/^\W*(aprovado|reprovado)\b/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Uma linha já lida (da tabela Markdown ou do bloco JSON) no formato do cartório, com os mesmos
 * erros para os dois formatos. `bruta` traz `title`, `veredito`, `fonte`, `obs`, `trecho` e a
 * `evidence` que o bloco JSON já trouxe estruturada.
 */
function citacaoDoRetorno(bruta, k, { consultadoEm, erros }) {
  const title = tirarAspasDoRetorno(bruta.title);
  if (!title) return null;
  const onde = `linha ${k + 1} (${title.slice(0, 60)})`;
  const status = statusDaCitacaoDoRetorno(bruta.veredito);
  if (!status) { erros.push(`${onde}: veredito "${String(bruta.veredito ?? '').trim()}" fora do formato (VERIFICADA, VERIFICADA NO ACERVO, DIVERGENTE, NÃO ENCONTRADA, CANCELADA ou acesso_falhou)`); return null; }
  const fonte = String(bruta.fonte ?? '');
  const obs = String(bruta.obs ?? '');
  const juntas = `${fonte} ${obs}`;
  const url = (fonte.match(/https:\/\/[^\s|)>\]"'`]+/) || [])[0] || '';
  const trechoBruto = tirarAspasDoRetorno(bruta.trecho);
  const trecho = /^(?:n[aã]o h[aá]|nenhum|n\/a|-+|\u2014)?$/i.test(trechoBruto) ? '' : trechoBruto;
  const evidence = {};
  const dada = bruta.evidence && typeof bruta.evidence === 'object' ? bruta.evidence : {};
  if (trecho) evidence.trecho = trecho;
  for (const campo of ['sha256_texto', 'sha256_bytes']) {
    const v = typeof dada[campo] === 'string' && /^[a-f0-9]{64}$/i.test(dada[campo].trim()) ? dada[campo].trim() : (juntas.match(new RegExp(`${campo}\\s*[:=]?\\s*\`?([a-f0-9]{64})`, 'i')) || [])[1];
    if (v) evidence[campo] = v.toLowerCase();
  }
  for (const campo of ['fonte_local', 'registro', 'dt_publicacao']) {
    const v = typeof dada[campo] === 'string' && dada[campo].trim() ? dada[campo].trim() : (juntas.match(new RegExp(`${campo}\\s*[:=]\\s*\`?([^\\s;|\`,]+)`, 'i')) || [])[1];
    if (v) evidence[campo] = v;
  }
  if (status === 'verificada' || status === 'verificada_no_acervo') {
    if (!url) erros.push(`${onde}: ${status === 'verificada' ? 'VERIFICADA' : 'VERIFICADA NO ACERVO'} sem a URL https da fonte conferida na coluna Fonte`);
    if (!trecho) erros.push(`${onde}: sem o trecho literal que sustenta (sem trecho, o veredito é acesso_falhou)`);
    if (status === 'verificada_no_acervo' && !/(^|[\\/])acervo[\\/]/.test(evidence.fonte_local || '')) erros.push(`${onde}: VERIFICADA NO ACERVO sem "fonte_local: <o arquivo do acervo lido>" na Observação`);
  }
  // A hora é a do relógio da máquina quando o retorno chegou; a declarada só vale sem ela.
  const consultada = consultadoEm || (typeof bruta.consultadaDeclarada === 'string' && !Number.isNaN(Date.parse(bruta.consultadaDeclarada)) ? bruta.consultadaDeclarada.trim() : '');
  return {
    title,
    status,
    ...(url ? { source_url: url } : {}),
    ...(consultada ? { consulted_at: consultada } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}),
    ...(obs.trim() && status !== 'verificada' && status !== 'verificada_no_acervo' ? { observacao: obs.trim().slice(0, 400) } : {}),
  };
}

const textoDoCampo = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * A tabela do `verificador-citacoes` como `citations[]` no formato que o cartório registra
 * (`gate-verdict --citacoes`). Aceita a tabela Markdown (Citação · Veredito · Fonte conferida ·
 * Consultada em · Trecho que sustenta · Observação) e o bloco JSON (```json com `citations`,
 * `tabela` ou `citacoes`; por item, `citacao`/`title`, `veredito`/`status`, `source_url`,
 * `consulted_at`, `trecho` e `evidence`): medido em 09/10/2026, o verificador devolveu 17 citações
 * só em JSON e o leitor, que só conhecia a tabela, gravou zero com APROVADO. `consultadoEm` é a
 * hora em que o retorno chegou, do relógio da máquina (o verificador não tem relógio, e o runner
 * nunca usa a hora que ele declara). Devolve `{ citations, veredito_geral, erros }`; `erros` diz,
 * linha a linha, o que falta. Retorno com conteúdo e nenhuma citação lida é fora do formato; só a
 * frase inteira de ausência ("nenhuma citação a verificar") com APROVADO devolve a lista vazia.
 */
function citacoesDaTabelaDoVerificador(texto, { consultadoEm } = {}) {
  const erros = [];
  const tabela = tabelasDoRetorno(texto).find((t) => t.cabecalho.some((c) => /^cita/.test(c)) && t.cabecalho.some((c) => /^veredito/.test(c)));
  const bloco = tabela ? null : blocoJsonDoVerificador(texto);
  let veredito_geral = vereditoGeralDoRetorno(texto);
  let brutas;
  if (tabela) {
    const col = (re) => tabela.cabecalho.findIndex((c) => re.test(c));
    const iCitacao = col(/^cita/);
    const iVeredito = col(/^veredito/);
    const iFonte = col(/fonte|source/);
    const iTrecho = col(/trecho/);
    const iObs = col(/observ|corre/);
    brutas = tabela.linhas.map((c) => ({ title: c[iCitacao], veredito: c[iVeredito], fonte: iFonte >= 0 ? c[iFonte] : '', trecho: iTrecho >= 0 ? c[iTrecho] : '', obs: iObs >= 0 ? c[iObs] : '' }));
  } else if (bloco) {
    const doBloco = bloco.objeto && !Array.isArray(bloco.objeto) ? vereditoDoCampo(bloco.objeto.veredito_geral ?? bloco.objeto.veredito) : null;
    if (doBloco) veredito_geral = doBloco;
    brutas = bloco.itens.map((it) => {
      const o = it && typeof it === 'object' ? it : {};
      const ev = o.evidence && typeof o.evidence === 'object' ? o.evidence : {};
      return {
        title: textoDoCampo(o.citacao ?? o.title ?? o.citação),
        veredito: textoDoCampo(o.veredito ?? o.status),
        fonte: textoDoCampo(o.source_url ?? o.fonte ?? o.url),
        trecho: textoDoCampo(o.trecho ?? ev.trecho),
        obs: [o.observacao, o.observação, o.motivo, o.fiel_na_minuta].filter((v) => typeof v === 'string' && v.trim()).join(' '),
        evidence: ev,
        consultadaDeclarada: o.consulted_at,
      };
    });
  } else {
    if (veredito_geral === 'APROVADO' && retornoDizQueNaoHaCitacao(texto)) return { citations: [], veredito_geral, erros };
    return { citations: [], veredito_geral, erros: ['sem a tabela de citações: uma linha por citação, com as colunas Citação | Veredito | Fonte conferida (source_url) | Consultada em | Trecho que sustenta | Observação (ou o bloco ```json com `citations[]`); só "nenhuma citação a verificar", com APROVADO, dispensa a tabela'] };
  }
  const citations = [];
  brutas.forEach((b, k) => {
    const c = citacaoDoRetorno(b, k, { consultadoEm, erros });
    if (c) citations.push(c);
  });
  if (!citations.length && !erros.length && !(veredito_geral === 'APROVADO' && retornoDizQueNaoHaCitacao(texto))) erros.push(`${tabela ? 'a tabela' : 'o bloco JSON'} de citações não tem nenhuma linha com citação lida: retorno com conteúdo e zero citações é fora do formato`);
  if (!veredito_geral) erros.push('sem o veredito geral no fechamento: APROVADO (todas verificadas, na fonte ou no acervo) ou REPROVADO');
  return { citations, veredito_geral, erros };
}

/**
 * O bloco `verdict`/`fixes`/`ajustes` que abre o arquivo do revisor do squad (cercado por ```yaml,
 * por `---` ou solto no topo). Devolve `{ verdict, fixes, ajustes, erros }`: `verdict` só APPROVE ou
 * REJECT; cada fix com a gravidade no prefixo; REJECT com ao menos um fix crítico ou alto (só eles
 * sustentam REJECT); APPROVE sem fix crítico ou alto (o APPROVE descarta os fixes, e o problema
 * sumiria). `null` em `verdict` quando o bloco não existe.
 */
function vereditoDoRevisor(texto) {
  const linhas = String(texto ?? '').split(/\r?\n/);
  const inicio = linhas.findIndex((l, i) => i < 400 && /^\s*verdict\s*:/.test(l));
  if (inicio < 0) return { verdict: null, fixes: [], ajustes: [], erros: ['sem o bloco YAML no topo do arquivo do step: `verdict: APPROVE | REJECT`, `fixes:` (cada um com a gravidade no prefixo: critica, alta, media ou baixa) e `ajustes:`'] };
  const recuo = linhas[inicio].match(/^\s*/)[0].length;
  const bruto = linhas[inicio].replace(/^\s*verdict\s*:\s*/, '').replace(/\s+#.*$/, '');
  const verdict = tirarAspasDoRetorno(bruto).toUpperCase();
  const listas = { fixes: [], ajustes: [] };
  let atual = null;
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const l = linhas[i];
    if (/^\s*(```|---)\s*$/.test(l)) break;
    if (!l.trim()) continue;
    const nivel = l.match(/^\s*/)[0].length;
    const item = l.match(/^\s*-\s+(.*)$/);
    if (item && atual && nivel >= recuo) { listas[atual].push(tirarAspasDoRetorno(item[1]).replace(/\\"/g, '"')); continue; }
    const chave = l.match(/^\s*([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (chave && nivel <= recuo) {
      atual = Object.hasOwn(listas, chave[1]) ? chave[1] : null;
      const resto = chave[2].trim();
      if (atual && resto.startsWith('[')) {
        try { listas[atual].push(...JSON.parse(resto).map((x) => String(x))); } catch { /* lista inline que não é JSON: fica vazia */ }
        atual = null;
      }
      continue;
    }
    // Prosa no nível do bloco: o bloco acabou.
    if (nivel <= recuo && !item) break;
  }
  const erros = [];
  if (verdict !== 'APPROVE' && verdict !== 'REJECT') erros.push(`verdict "${bruto.trim() || '(vazio)'}" não é APPROVE nem REJECT`);
  for (const fix of listas.fixes) if (!gravidadeDoFix(fix).explicita) erros.push(`fix sem a gravidade no prefixo (critica, alta, media ou baixa): "${fix.slice(0, 120)}"`);
  const bloqueantes = listas.fixes.filter((f) => ['critica', 'alta'].includes(gravidadeDoFix(f).gravidade) && gravidadeDoFix(f).explicita);
  if (verdict === 'REJECT' && !bloqueantes.length) erros.push('REJECT sem fix critica ou alta: só crítica e alta sustentam REJECT; correção de forma vai em `ajustes:` com APPROVE');
  if (verdict === 'APPROVE' && bloqueantes.length) erros.push(`APPROVE com ${bloqueantes.length} fix critica ou alta: o APPROVE descarta os fixes; com problema crítico ou alto o veredito é REJECT (ou a correção é de forma e vai em \`ajustes:\`)`);
  return { verdict: verdict === 'APPROVE' || verdict === 'REJECT' ? verdict : null, fixes: listas.fixes, ajustes: listas.ajustes, erros };
}

/** O relatório do `verificador-persuasao`: a tabela SOBREVIVE/PERDIDO e o veredito. `{ veredito, sobrevivem, perdidos, erros }`. */
function formatoDaPersuasao(texto) {
  const erros = [];
  const tabela = tabelasDoRetorno(texto).find((t) => t.cabecalho.some((c) => /sobreviv/.test(c)));
  let sobrevivem = 0;
  let perdidos = 0;
  if (!tabela) erros.push('sem a tabela do inventário: uma linha por pedido, tese, Tema e linha de ataque, com a coluna Sobrevive? (SOBREVIVE ou PERDIDO)');
  else {
    const i = tabela.cabecalho.findIndex((c) => /sobreviv/.test(c));
    for (const c of tabela.linhas) {
      const v = semAcentoDoRetorno(c[i]);
      if (/\bperdid/.test(v)) perdidos += 1;
      else if (/\bsobreviv/.test(v)) sobrevivem += 1;
    }
    if (!sobrevivem && !perdidos) erros.push('a tabela do inventário não marca nenhum item como SOBREVIVE ou PERDIDO');
  }
  const veredito = vereditoGeralDoRetorno(texto);
  if (!veredito) erros.push('sem o veredito: APROVADO ou REPROVADO, seguido dos fixes, um por linha');
  return { veredito, sobrevivem, perdidos, erros };
}
// <<< retorno-subagente:end

export {
  RETORNO_NATIVOS_COM_VEREDITO,
  RETORNO_PAPEIS_COM_VEREDITO,
  RETORNO_TETO_DE_BLOQUEIOS,
  blocoJsonDoVerificador,
  citacoesDaTabelaDoVerificador,
  formatoDaPersuasao,
  marcaDoVeredito,
  retornoDizQueNaoHaCitacao,
  statusDaCitacaoDoRetorno,
  tabelasDoRetorno,
  vereditoDoRevisor,
  vereditoGeralDoRetorno,
};
