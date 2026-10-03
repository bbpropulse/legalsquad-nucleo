// Datas depois da data legal e convites de agenda (.ics), por código.
//
// Medido no m7 da 0.9.81 (rotina de triagem de publicações): a hipótese "07/10 se a suspensão tirar o
// dia" para um prazo penal com data legal calculada de 06/10 apareceu na síntese, na tabela, no anexo
// e no convite; a própria portaria do run a afastava. Data alternativa posterior à legal nunca pode
// virar entrada de agenda nem aparecer sem a marca "não usar". E os convites, gerados por um script
// do chefe, saíram com alarme duplicado (D-3 e D-1 no mesmo dia), audiência com hora como evento de
// dia inteiro, alarme à meia-noite e "Data legal" numa data de controle.
//
// A data legal é a que a calculadora da área gravou (`data_limite` no JSON de saída); o verificador
// confere, na final e na descrição de cada convite, a data apresentada como alternativa (cláusula
// condicional: "se", "caso", "hipótese", "alternativa") que vem depois da data legal
// mais próxima antes dela no mesmo trecho, e o convite cuja data vem depois da data legal que ele
// mesmo declara.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para o
// `squad-state` (raiz e templates), onde o `manifesto-final` o usa, e para `scripts/convites-ics.mjs`
// (raiz e templates), ao lado do gerador de convites (`src/convites-ics.js`, bloco `convites-ics`).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// >>> datas-legais:begin
const semAcentoDasDatas = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** As datas dd/mm[/aaaa] do texto, com o ano do contexto quando faltar. Devolve `{ iso, indice, bruto }`. */
function datasDoTexto(texto, anoPadrao = null) {
  const t = String(texto ?? '');
  const brutas = [...t.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)];
  const anoDoTexto = brutas.map((m) => m[3]).find((a) => a && a.length === 4) || anoPadrao || String(new Date().getFullYear());
  const out = [];
  for (const m of brutas) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
    const ano = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : anoDoTexto;
    out.push({ iso: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`, indice: m.index, bruto: m[0] });
  }
  return out;
}

/** Palavra que faz da data uma alternativa (hipótese, condição), lida sem acento. */
const DATA_ALTERNATIVA = /\b(?:se|caso|hipoteses?|alternativ\w*)\b/;
/** A marca explícita de que a data alternativa não vale. */
const DATA_NAO_USAR = /\bnao usar\b|\bnunca usar\b|\bnao vale\b|\bdescartad\w*\b|\bafastad\w*\b|\bnao se aplica\b/;
/** O que separa as cláusulas de um trecho: ponto e vírgula, colchete, barra de tabela, fim de frase. */
const SEPARADOR_DE_CLAUSULA = /[;[\]|]|\.\s/g;

/** O começo e o fim da cláusula em que está a posição `i` do texto. */
function clausulaEm(texto, i) {
  let inicio = 0;
  let fim = texto.length;
  for (const m of texto.matchAll(SEPARADOR_DE_CLAUSULA)) {
    if (m.index < i) inicio = m.index + 1;
    else { fim = m.index; break; }
  }
  return { inicio, fim, texto: texto.slice(inicio, fim) };
}

/**
 * As datas apresentadas como alternativa (cláusula condicional) depois da data legal calculada, num
 * texto de uma linha só (linha da final, descrição de convite). A data legal de referência é a mais
 * próxima antes da cláusula, no mesmo trecho, entre as `legais` (ISO). A cláusula que diz "não usar"
 * (ou "descartada", "afastada") não conta. Devolve `{ data, legal, trecho }`.
 */
function alternativasDepoisDaLegalNoTrecho(trecho, legais, anoPadrao = null) {
  const t = String(trecho ?? '');
  const datas = datasDoTexto(t, anoPadrao);
  const conjunto = legais instanceof Set ? legais : new Set(legais || []);
  const achados = [];
  for (const d of datas) {
    const c = clausulaEm(t, d.indice);
    const clausula = semAcentoDasDatas(c.texto);
    if (!DATA_ALTERNATIVA.test(clausula) || DATA_NAO_USAR.test(clausula)) continue;
    const antes = datas.filter((x) => x.indice < c.inicio && conjunto.has(x.iso));
    if (!antes.length) continue;
    const legal = antes[antes.length - 1].iso;
    if (d.iso > legal) achados.push({ data: d.iso, legal, trecho: c.texto.trim().slice(0, 200) });
  }
  return achados;
}

/** Na final (sem a nota ao revisor, que o chamador tira), linha a linha: `{ linha, data, legal, trecho }`. */
function datasDepoisDaLegal(texto, legais) {
  const linhas = String(texto ?? '').split('\n');
  const ano = (String(texto ?? '').match(/\b\d{1,2}\/\d{1,2}\/(\d{4})\b/) || [])[1] || null;
  return linhas.flatMap((l, k) => alternativasDepoisDaLegalNoTrecho(l, legais, ano).map((a) => ({ linha: k + 1, ...a })));
}

/** O texto de uma propriedade do iCalendar, com as linhas desdobradas e os escapes desfeitos. */
function propriedadesDoIcs(ics) {
  const linhas = String(ics ?? '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  return linhas.map((l) => {
    const m = l.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    return m ? { nome: m[1], parametros: m[2], valor: m[3].replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1') } : null;
  }).filter(Boolean);
}

/**
 * No convite (.ics): a data alternativa da descrição depois da data legal, e o evento marcado depois
 * da data legal que a própria descrição declara ("Data legal: 06/10/2026"). `{ evento, data, legal, trecho }`.
 */
function convitesDepoisDaLegal(ics, legais) {
  const achados = [];
  let evento = null;
  for (const p of propriedadesDoIcs(ics)) {
    if (p.nome === 'BEGIN' && p.valor === 'VEVENT') evento = { props: [] };
    else if (p.nome === 'END' && p.valor === 'VEVENT' && evento) {
      const pega = (n) => evento.props.find((x) => x.nome === n);
      const inicio = pega('DTSTART');
      const dataDoEvento = inicio ? `${inicio.valor.slice(0, 4)}-${inicio.valor.slice(4, 6)}-${inicio.valor.slice(6, 8)}` : null;
      const texto = [pega('SUMMARY'), pega('DESCRIPTION')].filter(Boolean).map((x) => x.valor).join(' | ');
      const declarada = texto.match(/\bdata legal(?: anotada)?:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      const legalDeclarada = declarada ? datasDoTexto(declarada[1])[0].iso : null;
      // A data legal que o convite declara é a do prazo dele; sem ela, as do run.
      const conjunto = new Set(legalDeclarada ? [legalDeclarada] : (legais || []));
      const resumo = pega('SUMMARY') ? pega('SUMMARY').valor : '';
      for (const a of alternativasDepoisDaLegalNoTrecho(texto, conjunto, dataDoEvento ? dataDoEvento.slice(0, 4) : null)) achados.push({ evento: resumo, ...a });
      if (dataDoEvento && legalDeclarada && dataDoEvento > legalDeclarada) achados.push({ evento: resumo, data: dataDoEvento, legal: legalDeclarada, trecho: 'a data do evento vem depois da data legal que o convite declara' });
      evento = null;
    } else if (evento) evento.props.push(p);
  }
  return achados;
}

/** Os JSON do run com `data_limite` (a saída das calculadoras de prazo), fora de `_meta`, do pacote e das fontes. */
function saidasDeCalculadora(runDir) {
  const achados = [];
  const andar = (d, nivel) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const c = join(d, e.name);
      if (e.isDirectory()) { if (nivel < 3 && !['_meta', 'pacote', 'fontes', 'citacoes', 'despachos', 'persuasao'].includes(e.name)) andar(c, nivel + 1); continue; }
      if (!e.name.endsWith('.json') || /-entrada\.json$/.test(e.name)) continue;
      try { const v = JSON.parse(readFileSync(c, 'utf-8')); if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.data_limite === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.data_limite)) achados.push(c); } catch { /* não é JSON */ }
    }
  };
  andar(runDir, 0);
  return achados.sort();
}

/** As datas legais calculadas no run (o `data_limite` de cada saída de calculadora), em ISO. */
function datasLegaisDoRun(runDir) {
  const out = new Set();
  for (const f of saidasDeCalculadora(runDir)) { try { out.add(JSON.parse(readFileSync(f, 'utf-8')).data_limite); } catch { /* lida acima */ } }
  return out;
}
// <<< datas-legais:end

export { saidasDeCalculadora, datasLegaisDoRun, datasDoTexto, alternativasDepoisDaLegalNoTrecho, datasDepoisDaLegal, convitesDepoisDaLegal, propriedadesDoIcs };
