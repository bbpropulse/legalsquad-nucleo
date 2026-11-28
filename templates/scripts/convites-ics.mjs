#!/usr/bin/env node
// Convites de agenda (.ics) da entrega, gerados por código.
//
//   node scripts/convites-ics.mjs <eventos.json> --saida <pasta> [--run <pasta do run>] [--final <final.md>] [--json]
//
// O JSON traz `{ "squad": "...", "eventos": [ { "id", "processo", "titulo", "tipo" (prazo, audiencia
// ou controle), "data" (AAAA-MM-DD), "hora" (HH:MM, na audiência), "duracao_min", "data_legal"
// (AAAA-MM-DD), "descricao", "local", "responsavel", "alertas_dias" ([7, 3, 1]), "alerta_no_dia" } ] }`.
// Grava um `.ics` por evento (`<processo>-<data>.ics`). Recusa, sem gravar nada, o evento depois da
// data legal, a descrição com data alternativa depois dela (sem a marca "não usar") e a audiência
// sem hora. Com `--run`, as datas legais que as calculadoras gravaram no run também valem; com
// `--final`, a final (fora da nota ao revisor) é conferida pela mesma regra, antes do manifesto-final.
//
// Medido no m7 da 0.9.81: os convites, feitos por um script do chefe, saíram com alarme duplicado,
// audiência como evento de dia inteiro, alarme à meia-noite, "Data legal" numa data de controle e a
// hipótese de data depois da legal na descrição. O gerador é o bloco `datas-legais`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

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

// >>> convites-ics:begin
const FUSO_DOS_CONVITES = 'America/Sao_Paulo';
const VTIMEZONE_SAO_PAULO = ['BEGIN:VTIMEZONE', 'TZID:America/Sao_Paulo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:-0300', 'TZOFFSETTO:-0300', 'TZNAME:-03', 'END:STANDARD', 'END:VTIMEZONE'];
/** A hora do alarme, em horário útil: 9h de Brasília (12h UTC). */
const HORA_DO_ALARME_UTC = '120000';

const dataBrDoIso = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const isoMenosDias = (iso, dias) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - dias); return d.toISOString().slice(0, 10); };
/** O dia útil anterior quando o dia cai em sábado ou domingo (feriado não se conhece aqui). */
const diaUtilAnterior = (iso) => { let d = iso; for (let i = 0; i < 3; i += 1) { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); if (w !== 0 && w !== 6) return d; d = isoMenosDias(d, 1); } return d; };
const escaparIcs = (t) => String(t ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Dobra a linha em 75 octetos, como o RFC 5545 pede. */
function dobrarLinhaIcs(linha) {
  const bytes = Buffer.from(linha, 'utf8');
  if (bytes.length <= 75) return linha;
  const partes = [];
  let atual = '';
  for (const ch of linha) {
    if (Buffer.byteLength(atual + ch, 'utf8') > (partes.length ? 74 : 75)) { partes.push(atual); atual = ch; } else atual += ch;
  }
  partes.push(atual);
  return partes.join('\r\n ');
}

/**
 * Os alarmes de um evento: um por dia (os dias antes da data, levados ao dia útil anterior quando caem
 * no fim de semana, e o próprio dia se pedido), sem repetir dia, às 9h de Brasília. Medido no m7 da
 * 0.9.81: D-3 e D-1 caíam os dois na sexta e saíam duplicados; o alarme relativo de evento de dia
 * inteiro disparava à meia-noite.
 */
function alarmesDoEvento({ data, alertas_dias: dias = [7, 3, 1], alerta_no_dia: noDia = true }) {
  const datas = [];
  for (const n of [...new Set((Array.isArray(dias) ? dias : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => b - a)) {
    const d = diaUtilAnterior(isoMenosDias(data, n));
    if (!datas.some((x) => x.data === d)) datas.push({ data: d, rotulo: `D-${n}` });
  }
  if (noDia && !datas.some((x) => x.data === data)) datas.push({ data, rotulo: 'no dia' });
  return datas;
}

/**
 * O convite (.ics) de um evento. `evento`: `{ id, processo, titulo, tipo (prazo|audiencia|controle),
 * data (ISO), hora (HH:MM, para audiência), duracao_min, data_legal (ISO), descricao, local,
 * responsavel, alertas_dias, alerta_no_dia }`. Recusa (lança Error) o evento depois da data legal e a
 * descrição com data alternativa depois dela, e a audiência sem hora.
 */
function gerarConvite(evento, { squad = 'legalsquad', agora = new Date(), legais = [] } = {}) {
  const e = evento || {};
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(String(e.data || ''))) throw new Error(`convite ${e.id || e.titulo || '?'}: data "${e.data}" não é AAAA-MM-DD`);
  if (e.data_legal && !iso.test(String(e.data_legal))) throw new Error(`convite ${e.id || e.titulo}: data_legal "${e.data_legal}" não é AAAA-MM-DD`);
  const tipo = e.tipo || (e.hora ? 'audiencia' : 'prazo');
  if (tipo === 'audiencia' && !/^\d{1,2}:\d{2}$/.test(String(e.hora || ''))) throw new Error(`convite ${e.id || e.titulo}: audiência sem hora (HH:MM); a audiência é evento com hora`);
  if (e.data_legal && e.data > e.data_legal) throw new Error(`convite ${e.id || e.titulo}: a data do evento (${dataBrDoIso(e.data)}) vem depois da data legal (${dataBrDoIso(e.data_legal)}); data posterior à legal nunca vira entrada de agenda`);
  const legaisDoEvento = new Set([...(legais || []), ...(e.data_legal ? [e.data_legal] : [])]);
  const descricaoBase = String(e.descricao || '').trim();
  const alternativas = alternativasDepoisDaLegalNoTrecho(`${e.data_legal ? `Data legal: ${dataBrDoIso(e.data_legal)}. ` : ''}${descricaoBase}`, legaisDoEvento, e.data.slice(0, 4));
  if (alternativas.length) throw new Error(`convite ${e.id || e.titulo}: a descrição traz ${alternativas.map((a) => dataBrDoIso(a.data)).join(', ')} como alternativa depois da data legal (${dataBrDoIso(alternativas[0].legal)}); tire a data, ou marque-a "não usar"`);
  const controle = e.data_legal && e.data !== e.data_legal;
  const rotulo = tipo === 'audiencia'
    ? `Audiência: ${dataBrDoIso(e.data)} às ${e.hora}`
    : controle ? `Data de controle: ${dataBrDoIso(e.data)} (não é a data legal; data legal: ${dataBrDoIso(e.data_legal)})` : e.data_legal ? `Data legal: ${dataBrDoIso(e.data_legal)}` : `Data de controle: ${dataBrDoIso(e.data)}`;
  const resumo = `${tipo === 'audiencia' ? 'AUDIÊNCIA' : controle || !e.data_legal ? 'CONTROLE' : 'PRAZO'} ${dataBrDoIso(e.data).slice(0, 5)}${tipo === 'audiencia' ? ` ${e.hora}` : ''}: ${e.titulo || ''}${e.processo ? `, ${e.processo}` : ''}`;
  const descricao = [rotulo, descricaoBase, e.responsavel ? `Responsável: ${e.responsavel}.` : '', 'Rascunho do escritório: importar na agenda é ato do profissional; os alertas são internos e não mudam a data legal.'].filter(Boolean).join(' ');
  const carimbo = new Date(agora).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const sem = (d) => d.replace(/-/g, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//LegalSquad//${squad}//PT`, 'CALSCALE:GREGORIAN'];
  if (tipo === 'audiencia') L.push(...VTIMEZONE_SAO_PAULO);
  L.push('BEGIN:VEVENT', `UID:${escaparIcs(e.id || `${e.processo || 'evento'}-${e.data}`)}@${squad}`, `DTSTAMP:${carimbo}`);
  if (tipo === 'audiencia') {
    const [h, m] = String(e.hora).split(':').map(Number);
    const inicioMin = h * 60 + m;
    const fimMin = inicioMin + (Number(e.duracao_min) > 0 ? Number(e.duracao_min) : 60);
    const hhmm = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}${String(x % 60).padStart(2, '0')}00`;
    L.push(`DTSTART;TZID=${FUSO_DOS_CONVITES}:${sem(e.data)}T${hhmm(inicioMin)}`, `DTEND;TZID=${FUSO_DOS_CONVITES}:${sem(e.data)}T${hhmm(Math.min(fimMin, 23 * 60 + 59))}`);
  } else {
    const seguinte = new Date(`${e.data}T12:00:00Z`);
    seguinte.setUTCDate(seguinte.getUTCDate() + 1);
    L.push(`DTSTART;VALUE=DATE:${sem(e.data)}`, `DTEND;VALUE=DATE:${sem(seguinte.toISOString().slice(0, 10))}`);
  }
  L.push(`SUMMARY:${escaparIcs(resumo)}`, `DESCRIPTION:${escaparIcs(descricao)}`);
  if (e.local) L.push(`LOCATION:${escaparIcs(e.local)}`);
  L.push('CLASS:PRIVATE', 'STATUS:TENTATIVE', 'TRANSP:TRANSPARENT');
  for (const a of alarmesDoEvento(e)) {
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER;VALUE=DATE-TIME:${sem(a.data)}T${HORA_DO_ALARME_UTC}Z`, `DESCRIPTION:${escaparIcs(`${a.rotulo}: ${e.titulo || ''}${e.processo ? ` ${e.processo}` : ''}`)}`, 'END:VALARM');
  }
  L.push('END:VEVENT', 'END:VCALENDAR');
  return `${L.map(dobrarLinhaIcs).join('\r\n')}\r\n`;
}
// <<< convites-ics:end

function falhar(msg) {
  process.stderr.write(`convites-ics: ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const entrada = args.find((a, i) => !a.startsWith('--') && !['--saida', '--run', '--final'].includes(args[i - 1]));
if (!entrada) falhar('uso: convites-ics.mjs <eventos.json> --saida <pasta> [--run <pasta do run>] [--final <final.md>] [--json]');
const saidaDir = valor('--saida');
if (!saidaDir) falhar('convites-ics requer --saida <pasta onde os .ics vão>');
const caminho = isAbsolute(entrada) ? entrada : resolve(entrada);
if (!existsSync(caminho)) falhar(`${entrada}: arquivo não existe`);
let dado;
try { dado = JSON.parse(readFileSync(caminho, 'utf-8')); } catch (e) { falhar(`${entrada}: JSON ilegível (${e.message})`); }
const eventos = Array.isArray(dado) ? dado : (dado && Array.isArray(dado.eventos) ? dado.eventos : null);
if (!eventos || !eventos.length) falhar(`${entrada}: sem a lista "eventos"`);
const runDir = valor('--run');
const legais = runDir ? [...datasLegaisDoRun(resolve(runDir))] : [];
const squad = (dado && typeof dado.squad === 'string' && dado.squad.trim()) || 'legalsquad';

const gerados = [];
const recusas = [];
for (const e of eventos) {
  try {
    const nome = `${String(e.processo || e.id || 'evento').replace(/[^\w.-]+/g, '-')}-${e.data}.ics`;
    gerados.push({ arquivo: nome, texto: gerarConvite(e, { squad, legais }) });
  } catch (erro) {
    recusas.push(erro.message);
  }
}
const finalArg = valor('--final');
if (finalArg) {
  const final = isAbsolute(finalArg) ? finalArg : resolve(finalArg);
  if (!existsSync(final)) falhar(`--final ${finalArg}: arquivo não existe`);
  // Sem a nota ao revisor (que o pacote tira), com as linhas no lugar.
  const texto = readFileSync(final, 'utf-8').replace(/<!--\s*nota-ao-revisor:inicio\s*-->[\s\S]*?<!--\s*nota-ao-revisor:fim\s*-->/g, (m) => m.replace(/[^\n]/g, ''));
  const conjunto = new Set([...legais, ...eventos.map((e) => e.data_legal).filter(Boolean)]);
  for (const a of datasDepoisDaLegal(texto, conjunto)) recusas.push(`final, linha ${a.linha}: ${a.data} como alternativa depois da data legal ${a.legal} ("${a.trecho.slice(0, 80)}"); tire a data, ou marque-a "não usar"`);
}
if (recusas.length) {
  process.stdout.write(`${JSON.stringify({ acao: 'recusado', recusas }, null, 2)}\n`);
  falhar(`${recusas.length} convite(s) recusado(s); nada foi gravado: ${recusas[0]}`);
}
const destino = isAbsolute(saidaDir) ? saidaDir : resolve(saidaDir);
mkdirSync(destino, { recursive: true });
for (const g of gerados) writeFileSync(join(destino, g.arquivo), g.texto, 'utf-8');
// Os outros convites da pasta (de fora deste gerador) passam pela mesma regra: aviso, não recusa.
const avisos = readdirSync(destino).filter((f) => f.endsWith('.ics') && !gerados.some((g) => g.arquivo === f))
  .flatMap((f) => convitesDepoisDaLegal(readFileSync(join(destino, f), 'utf-8'), legais).map((a) => `${f}: ${a.data} depois da data legal ${a.legal}`));
const resultado = { acao: 'gravado', pasta: destino, convites: gerados.map((g) => g.arquivo), ...(avisos.length ? { avisos } : {}) };
process.stdout.write(args.includes('--json') ? `${JSON.stringify(resultado, null, 2)}\n` : `${gerados.length} convite(s) em ${destino}\n`);
