// O gerador de convites de agenda (.ics), por código. Medido no m7 da 0.9.81: os convites, feitos por
// um script do chefe, saíram com alarme duplicado (D-3 e D-1 no mesmo dia), audiência com hora como
// evento de dia inteiro, alarme à meia-noite, "Data legal" numa data de controle e a hipótese de data
// depois da legal na descrição.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para
// `scripts/convites-ics.mjs` (raiz e templates), onde o bloco `datas-legais` também mora.
import { alternativasDepoisDaLegalNoTrecho } from './datas-legais.js';

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

export { alarmesDoEvento, gerarConvite };
