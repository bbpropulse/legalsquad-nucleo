// Calendário forense por código: feriados e suspensões de expediente e de prazo do tribunal, da
// fonte oficial, para a calculadora de prazo contar com eles.
//
// Medido no m5r e no m5g da 0.9.84 (contestação no TJSP, comarca de Campinas): as páginas oficiais
// de feriados vêm sem o calendário no texto baixado (a página monta a tabela por JavaScript) e o
// Playwright não estava instalado nos projetos. Ninguém conferia feriado local nem suspensão, e a
// Verificação da Meta derrubou o critério de prazo nas duas rodadas do m5g e numa do m5r. O agente
// do m5r achou o calendário nos endpoints oficiais que a própria página do TJSP chama
// (`/CanaisComunicacao/Feriados/PesquisarFeriados` e `PesquisarSuspensoes`, por município e ano,
// em JSON). Este módulo guarda o que é comum a todo tribunal: a consolidação da janela com as regras
// do lado seguro, o nome do arquivo e a junção com a calculadora. Os adaptadores por tribunal (de
// onde vem o calendário e como lê-lo) estão em `src/calendario-adaptadores.js`; o download é o de
// sempre (`baixar` do `fonte-oficial`), com cópia, hash e linha no INDEX.
//
// Regras de segurança da contagem (cada uma escolhe o lado em que o erro antecipa a data, nunca o
// que a adia):
// - suspensão que nomeia unidades (varas, juizados, anexos, RAJ) não entra sozinha: sai em
//   `suspensoes_restritas`, com o trecho, para o profissional conferir se a vara do caso está lá
//   (com `--vara`, a que a nomeia entra);
// - feriado com dois registros no ano, um deles "ALTERADO", entra só pelo alterado; o outro vai a
//   `a_conferir`;
// - o que o adaptador leu e não pôs na conta vai a `a_conferir`, com o motivo;
// - tribunal sem adaptador devolve `sem_adaptador`, que a regra do dado público trata como fonte
//   que falhou (marcador permitido, com a diligência de conferir o calendário).
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para
// `scripts/fonte-oficial.mjs` (que baixa e grava o calendário) e para
// `scripts/prazo-com-calendario.mjs` (que o passa à calculadora), na raiz e em `templates/`.

// >>> calendario-forense:begin
/** Palavras que dizem que a suspensão vale só para algumas unidades da comarca, lidas sem acento. */
const CALENDARIO_UNIDADES = /\b(?:varas?|juizados?|unidades?|anexos?|oficios?|cartorios?|setor(?:es)?|foros? regionai?s?|raj|deecrim|turmas? recursa\w*|colegios? recursa\w*|camaras?)\b/;
/** Suspensão geral pelo regimento (recesso, art. 116 do RITJSP): vale para a comarca inteira. */
const CALENDARIO_GERAL = /\brecesso\b|\bart\.?\s*116\b/;

const calendarioSemAcento = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** "16/02/2026" → "2026-02-16"; null se não for data. */
function calendarioIsoDeBr(texto) {
  const m = String(texto ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** "/Date(1771210800000)/" → a data em São Paulo (UTC-3, sem horário de verão desde 2019). */
function calendarioIsoDeMs(texto) {
  const m = String(texto ?? '').match(/Date\((-?\d+)\)/);
  if (!m) return null;
  return new Date(Number(m[1]) - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Os dias ISO de `de` a `ate`, inclusive. */
function calendarioDias(de, ate) {
  const out = [];
  for (let d = new Date(`${de}T12:00:00Z`); d.toISOString().slice(0, 10) <= ate; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

const calendarioDiaDaSemana = (iso) => ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][new Date(`${iso}T12:00:00Z`).getUTCDay()];

/** O tribunal pedido, normalizado ("TJSP", "tj-sp" → "tjsp"). */
const calendarioTribunal = (t) => calendarioSemAcento(t).replace(/[^a-z0-9]/g, '');

/** Os anos que a janela cobre. */
function calendarioAnos(de, ate) {
  const anos = [];
  for (let a = Number(de.slice(0, 4)); a <= Number(ate.slice(0, 4)); a += 1) anos.push(a);
  return anos;
}

/** O nome do feriado sem a norma e sem a marca de alteração, para achar dois registros do mesmo dia. */
const calendarioChaveDoFeriado = (descricao) => calendarioSemAcento(descricao).replace(/\(.*$/, '').replace(/\balterad[oa]\b.*$/, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * O calendário da janela a partir do que o adaptador do tribunal leu: `feriados` (`{ data,
 * descricao, fonte }`, um por dia sem expediente), `suspensoes` (`{ inicio, fim, descricao, ato,
 * alcance, fonte }`), `aConferir` (o que o adaptador leu e não pôs na conta, com o motivo),
 * `avisos` e `falha` (o motivo, quando a fonte não deu o calendário). Devolve o objeto que vai ao
 * arquivo, sem `fontes` (quem baixou as junta).
 */
function consolidarCalendario({ tribunal, comarca, de, ate, vara = null, feriados = [], suspensoes = [], aConferir: doAdaptador = [], avisos: avisosDoAdaptador = [], falha = null }) {
  const avisos = [...avisosDoAdaptador];
  const naJanela = (d) => d && d >= de && d <= ate;

  // Dois registros do mesmo feriado no ano, um "ALTERADO": vale o alterado; o outro vai a conferir.
  const aConferir = doAdaptador.filter((a) => naJanela(a.data));
  const grupos = new Map();
  for (const f of feriados) {
    const k = `${f.data ? f.data.slice(0, 4) : ''}|${calendarioChaveDoFeriado(f.descricao)}`;
    grupos.set(k, [...(grupos.get(k) || []), f]);
  }
  const descartados = new Set();
  for (const lista of grupos.values()) {
    const alterados = lista.filter((f) => /\balterad[oa]\b/i.test(calendarioSemAcento(f.descricao)));
    if (!alterados.length || lista.length < 2) continue;
    for (const f of lista.filter((x) => !alterados.includes(x))) {
      descartados.add(f);
      aConferir.push({ data: f.data, descricao: f.descricao, motivo: `outro registro do mesmo feriado foi alterado (${alterados.map((a) => a.data).join(', ')}): esta data não entra na conta sem conferência` });
    }
  }

  const varaNorm = vara ? calendarioSemAcento(vara).replace(/\s+/g, ' ').trim() : null;
  const dias = new Map();
  const anotar = (data, descricao, tipo, fonte) => { if (naJanela(data) && !dias.has(data)) dias.set(data, { data, dia_da_semana: calendarioDiaDaSemana(data), descricao, tipo, fonte }); };
  for (const f of feriados) if (!descartados.has(f)) anotar(f.data, f.descricao, 'feriado', f.fonte);
  const gerais = [];
  const restritas = [];
  for (const s of suspensoes) {
    if (!s.inicio || s.fim < de || s.inicio > ate) continue;
    const aplica = s.alcance === 'comarca' || (varaNorm && calendarioSemAcento(s.descricao).replace(/\s+/g, ' ').includes(varaNorm));
    const resumo = s.descricao.length > 400 ? `${s.descricao.slice(0, 400)}...` : s.descricao;
    if (aplica) {
      gerais.push([s.inicio < de ? de : s.inicio, s.fim > ate ? ate : s.fim]);
      for (const d of calendarioDias(s.inicio < de ? de : s.inicio, s.fim > ate ? ate : s.fim)) anotar(d, resumo, 'suspensao', s.fonte);
    } else {
      restritas.push({ inicio: s.inicio, fim: s.fim, descricao: resumo, fonte: s.fonte, ato: s.ato });
    }
  }
  if (restritas.length) avisos.push(`${restritas.length} suspensão(ões) na janela valem só para as unidades que nomeiam e não entraram na conta: confira se a vara do caso está em alguma (suspensoes_restritas; com --vara "<nome da vara>", a que a nomeia entra)`);
  if (aConferir.length) avisos.push(`${aConferir.length} data(s) a conferir (a_conferir): o calendário do tribunal as traz, mas elas não entraram na conta (o motivo está em cada uma)`);
  const lista = [...dias.values()].sort((a, b) => a.data.localeCompare(b.data));
  return {
    kind: 'legalsquad.calendario-forense',
    schema_version: '1',
    tribunal: calendarioTribunal(tribunal),
    comarca: String(comarca).trim().toUpperCase(),
    vara: vara || null,
    de,
    ate,
    status: falha ? 'acesso_falhou' : 'ok',
    motivo: falha || null,
    dias_sem_expediente: falha ? [] : lista,
    suspensoes_restritas: falha ? [] : restritas,
    a_conferir: falha ? [] : aConferir.sort((a, b) => String(a.data).localeCompare(String(b.data))),
    // A entrada das calculadoras de prazo (cível, trabalhista, corridos): `feriados` e `suspensoes`.
    feriados: falha ? [] : [...new Set(feriados.filter((f) => !descartados.has(f) && naJanela(f.data)).map((f) => f.data))].sort(),
    suspensoes: falha ? [] : gerais,
    avisos,
  };
}

/** O nome do arquivo do calendário na pasta `fontes/` do run. */
const nomeDoCalendario = ({ tribunal, comarca, de, ate }) => `calendario-${calendarioTribunal(tribunal)}-${calendarioSemAcento(comarca).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${de}-${ate}.json`;

/**
 * A entrada da calculadora com o calendário: `feriados` somados (sem repetir) e `suspensoes`
 * acrescentadas, no formato que as calculadoras de prazo aceitam. O calendário que não abriu não
 * muda nada (a calculadora avisa que a data é provisória).
 */
function entradaComCalendario(entrada, calendario) {
  const e = { ...(entrada || {}) };
  if (!calendario || calendario.status !== 'ok') return e;
  e.feriados = [...new Set([...(Array.isArray(e.feriados) ? e.feriados : []), ...(calendario.feriados || [])])].sort();
  const suspensoes = [...(Array.isArray(e.suspensoes) ? e.suspensoes : []), ...(calendario.suspensoes || [])];
  if (suspensoes.length) e.suspensoes = suspensoes;
  return e;
}

/**
 * A data-limite da saída, onde cada calculadora a guarda: no topo (cível, tempestividade), em
 * `resultado` (dias corridos, trabalhista) ou no termo final (decadência).
 */
function dataLimiteDaSaida(saida) {
  if (!saida) return null;
  const r = saida.resultado || {};
  return saida.data_limite || saida.data_limite_para_praticar || r.data_limite || r.termo_final || (r.mais_urgente && r.mais_urgente.termo_final) || (Array.isArray(r.ofensas) && r.ofensas[0] && r.ofensas[0].termo_final) || null;
}

/** O que a saída da calculadora leva do calendário, com o aviso quando a janela não cobre a data-limite. */
function resumoDoCalendarioNaSaida(calendario, arquivo, saida) {
  const limite = dataLimiteDaSaida(saida);
  const cobre = !limite || !calendario || calendario.status !== 'ok' ? null : limite >= calendario.de && limite <= calendario.ate;
  const avisos = [...((calendario && calendario.avisos) || [])];
  if (calendario && calendario.status !== 'ok') avisos.push(`calendário do tribunal não obtido (${calendario.motivo || calendario.status}): a data é provisória até a conferência do calendário; o marcador [CONFIRMAR] do feriado local é permitido porque a fonte falhou no run`);
  if (cobre === false) avisos.push(`a data-limite ${limite} fica fora da janela do calendário (${calendario.de} a ${calendario.ate}): rode o calendário de novo com --de e --ate que a cubram e refaça a conta`);
  return {
    arquivo,
    tribunal: calendario ? calendario.tribunal : null,
    comarca: calendario ? calendario.comarca : null,
    janela: calendario ? { de: calendario.de, ate: calendario.ate } : null,
    status: calendario ? calendario.status : 'ausente',
    feriados_aplicados: calendario && calendario.status === 'ok' ? calendario.feriados : [],
    suspensoes_aplicadas: calendario && calendario.status === 'ok' ? calendario.suspensoes : [],
    suspensoes_restritas: calendario ? calendario.suspensoes_restritas : [],
    a_conferir: calendario ? calendario.a_conferir : [],
    cobre_a_data_limite: cobre,
    avisos,
  };
}
// <<< calendario-forense:end

export {
  CALENDARIO_UNIDADES, CALENDARIO_GERAL, calendarioSemAcento, calendarioIsoDeBr, calendarioIsoDeMs, calendarioDias, calendarioDiaDaSemana,
  calendarioTribunal, calendarioAnos, consolidarCalendario, nomeDoCalendario, entradaComCalendario, dataLimiteDaSaida, resumoDoCalendarioNaSaida,
};
