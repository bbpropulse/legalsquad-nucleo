// Adaptadores do calendário forense, um por tribunal: de onde vem o calendário oficial (a URL e de
// onde ela foi achada) e como ler o que o tribunal devolve. O download é o do `fonte-oficial`
// (`baixar`, com cópia, hash e linha no INDEX); a consolidação da janela, com as regras do lado
// seguro, é a do bloco `calendario-forense`.
//
// Os tribunais entraram pela ordem dos casos de medição (04/10/2026): TJSP (Campinas, 0.9.87),
// TJMG (Belo Horizonte), TRT3 (Lavras), TJPR (Curitiba e São José dos Pinhais), TRT4 (Caxias do
// Sul) e TJSC (Criciúma). Cada fonte é a do próprio tribunal; nenhuma é agregador:
// - TJSP: endpoints JSON que a página oficial de expediente forense chama;
// - TJMG: o Guia Judiciário, "Feriados Locais" (www8.tjmg.jus.br/servicos/gj/calendario), em HTML
//   por ano, com as datas de todo o estado e as de cada comarca, que é a Portaria Conjunta da
//   Presidência do ano (2026: nº 1.798/PR/2026, conferida comarca a comarca nos casos de medição);
// - TRT3: as páginas "Calendário AAAA" e "Feriados Locais AAAA" do portal (tabelas HTML);
// - TJPR: o Decreto Judiciário anual do calendário de feriados (PDF), cuja URL o tribunal dá na
//   notícia oficial de divulgação; o decreto de cada ano entra na tabela TJPR_DECRETOS;
// - TRT4: a Portaria da Corregedoria do calendário do exercício (texto compilado, PDF), achada na
//   página "Feriados locais" pelo ano do exercício;
// - TJSC: a Resolução GP que consolida o calendário (o Anexo Único é substituído a cada
//   alteração), achada pela busca do Diário da Justiça Eletrônico (busca.tjsc.jus.br, JSON) e lida
//   no caderno da edição (PDF). O portal institucional do TJSC (www.tjsc.jus.br) recusa acesso por
//   programa ("bloqueio temporário", classificado como robô); o DJe responde.
//
// Regras do lado seguro, além das do bloco base (cada uma escolhe o lado em que o erro antecipa a
// data, nunca o que a adia):
// - dia sem expediente entra como feriado (prorroga o termo final), nunca como suspensão de prazo
//   (que pararia a contagem em dias corridos); a suspensão de prazo do art. 220 do CPC é da
//   calculadora, que sabe a área;
// - data que o adaptador não consegue atribuir com segurança (célula de tabela ambígua, feriado
//   restrito a distrito, ponto facultativo, ano ainda não publicado pelo tribunal, dia da semana
//   que não bate) vai a `a_conferir`, fora da conta;
// - comarca ou cidade que a fonte não lista dá `acesso_falhou` (nunca calendário vazio dado como
//   certo), salvo no TJPR, cujo decreto só lista quem tem feriado local (aí vai aviso).
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para
// `scripts/fonte-oficial.mjs`, na raiz e em `templates/`. Ele usa as funções do bloco
// `calendario-forense`, que o mesmo arquivo carrega.

import {
  CALENDARIO_UNIDADES, CALENDARIO_GERAL, calendarioSemAcento, calendarioIsoDeBr, calendarioIsoDeMs, calendarioDiaDaSemana,
  calendarioTribunal, calendarioAnos, consolidarCalendario,
} from './calendario-forense.js';

// >>> calendario-adaptadores:begin
const CALENDARIO_MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const CAL_RE_MES = 'janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const calMes = (nome) => CALENDARIO_MESES.indexOf(calendarioSemAcento(nome)) + 1;
const calIso = (ano, mes, dia) => `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
const calDataValida = (ano, mes, dia) => { const d = new Date(Date.UTC(ano, mes - 1, dia)); return mes > 0 && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia; };
const calLimpo = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
/** Nome de comarca ou cidade comparável: sem acento, sem "(Posto)", só letras e números. */
const calNome = (t) => calendarioSemAcento(t).replace(/\(\s*posto\s*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

const CAL_ACENTOS = { acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', cedil: '\u0327' };
const CAL_ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ordm: 'º', ordf: 'ª', sect: '§', deg: '°', ndash: '–', mdash: '-' };
/** Texto de um trecho de HTML: `<br>` vira quebra de linha, tags somem, entidades decodificadas. */
function calTextoDeHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z])(acute|grave|circ|tilde|uml|cedil);/g, (_, l, a) => `${l}${CAL_ACENTOS[a]}`.normalize('NFC'))
    .replace(/&([a-z]+);/gi, (m, e) => CAL_ENTIDADES[e.toLowerCase()] ?? m);
}

/**
 * As datas de uma expressão por extenso do ano: "1º de janeiro", "1º a 6 de janeiro", "16 e 17 de
 * fevereiro", "30 de novembro a 2 de dezembro". Devolve uma lista por expressão achada, na ordem.
 */
function calExpressoesDeData(texto, ano) {
  const t = calendarioSemAcento(texto).replace(/(\d)\s*[º°]/g, '$1');
  const re = new RegExp(`(\\d{1,2})\\s+de\\s+(${CAL_RE_MES.replace('[cç]', 'c')})\\s+a\\s+(\\d{1,2})\\s+de\\s+(${CAL_RE_MES.replace('[cç]', 'c')})|(\\d{1,2})\\s+(a|e)\\s+(\\d{1,2})\\s+de\\s+(${CAL_RE_MES.replace('[cç]', 'c')})|(\\d{1,2})\\s+(?:de\\s+)?(${CAL_RE_MES.replace('[cç]', 'c')})`, 'g');
  const expressoes = [];
  for (const m of t.matchAll(re)) {
    const datas = [];
    const intervalo = (m1, d1, m2, d2) => {
      for (let d = new Date(Date.UTC(ano, m1 - 1, d1)); d <= new Date(Date.UTC(ano, m2 - 1, d2)); d.setUTCDate(d.getUTCDate() + 1)) datas.push(d.toISOString().slice(0, 10));
    };
    if (m[1]) intervalo(calMes(m[2]), Number(m[1]), calMes(m[4]), Number(m[3]));
    else if (m[5]) {
      const mes = calMes(m[8]);
      if (m[6] === 'a') intervalo(mes, Number(m[5]), mes, Number(m[7]));
      else datas.push(calIso(ano, mes, Number(m[5])), calIso(ano, mes, Number(m[7])));
    } else datas.push(calIso(ano, calMes(m[10]), Number(m[9])));
    expressoes.push({ texto: m[0], datas });
  }
  return expressoes;
}

// ---------------------------------------------------------------------------
// TJSP: endpoints JSON da página oficial de expediente forense.
// ---------------------------------------------------------------------------

/** Os registros `data[]` de uma resposta do TJSP, ou null se o JSON não tem a forma esperada. */
function calendarioRegistrosTjsp(texto) {
  let json;
  try { json = typeof texto === 'string' ? JSON.parse(texto) : texto; } catch { return null; }
  return json && Array.isArray(json.data) ? json.data : null;
}

/** Feriado do TJSP: `{ data, descricao }`. */
function calendarioFeriadoTjsp(r) {
  return { data: calendarioIsoDeBr(r.Data) || calendarioIsoDeMs(r.DataFeriado), descricao: String(r.Descricao || '').replace(/\s+/g, ' ').trim() };
}

/** Suspensão do TJSP: `{ inicio, fim, descricao, ato }`, com o alcance lido da descrição. */
function calendarioSuspensaoTjsp(r) {
  const datas = String(r.Data || '').match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  const inicio = calendarioIsoDeBr(datas[0]) || calendarioIsoDeMs(r.DataInicial);
  const fim = calendarioIsoDeBr(datas[1] || datas[0]) || calendarioIsoDeMs(r.DataFinal) || inicio;
  const descricao = String(r.Descricao || '').replace(/\s+/g, ' ').trim();
  const t = calendarioSemAcento(descricao);
  const restrita = !CALENDARIO_GERAL.test(t) && CALENDARIO_UNIDADES.test(t);
  return { inicio, fim, descricao, ato: r.DJE || null, alcance: restrita ? 'unidades' : 'comarca' };
}

function lerTjsp(respostas, { comarca }) {
  const avisos = [];
  const feriados = [];
  const suspensoes = [];
  let formaInvalida = false;
  for (const r of respostas) {
    const registros = calendarioRegistrosTjsp(r.texto);
    if (!registros) { formaInvalida = true; avisos.push(`resposta sem a lista data[] esperada: ${r.url}`); continue; }
    for (const reg of registros) {
      if (r.tipo === 'feriados') feriados.push({ ...calendarioFeriadoTjsp(reg), fonte: r.url });
      else suspensoes.push({ ...calendarioSuspensaoTjsp(reg), fonte: r.url });
    }
  }
  const comFeriados = respostas.filter((r) => r.tipo === 'feriados' && calendarioRegistrosTjsp(r.texto));
  if (comFeriados.length && !feriados.length) avisos.push(`nenhum feriado listado para "${comarca}": confira a grafia do município na página do tribunal`);
  return { feriados, suspensoes, avisos, falha: formaInvalida && !feriados.length ? 'resposta-fora-do-formato' : null };
}

// ---------------------------------------------------------------------------
// TJMG: Guia Judiciário, "Feriados Locais", por ano (todas as comarcas numa página).
// ---------------------------------------------------------------------------

function lerTjmg(respostas, { comarca }) {
  const alvo = calNome(comarca);
  const feriados = [];
  const aConferir = [];
  const avisos = ['a página "Feriados Locais" do TJMG avisa que não substitui as publicações oficiais: suspensão extraordinária de expediente por ato do Diretor do Foro pode não estar nela'];
  for (const r of respostas) {
    const html = String(r.texto || '');
    const comarcas = [...html.matchAll(/<option value="\d+">([^<]*)<\/option>/g)].map((m) => calLimpo(calTextoDeHtml(m[1]))).filter((n) => /[a-z]/i.test(n));
    if (!comarcas.length || !/class="feriado"/.test(html)) return { falha: 'resposta-fora-do-formato', avisos: [`a página do TJMG veio sem a lista de comarcas ou sem o calendário: ${r.url}`] };
    if (!comarcas.some((n) => calNome(n) === alvo)) return { falha: 'comarca-nao-encontrada', avisos: [`"${comarca}" não está na lista de comarcas do Guia Judiciário do TJMG: use o nome da comarca como a página o escreve`] };
    // Ano sem ato do próprio ano citado é projeção do ano anterior, não o calendário publicado.
    const projecao = !new RegExp(`/PR/${r.ano}\\b`).test(html);
    if (projecao) avisos.push(`o TJMG ainda não publicou a portaria do calendário de ${r.ano}: as datas desse ano ficam em a_conferir`);
    for (const celula of html.matchAll(/class="feriado">([\s\S]*?)<\/td>/g)) {
      const partes = celula[1].split(/<b>\s*(\d{2}\/\d{2}\/\d{4})\s*<\/b>/);
      for (let i = 1; i < partes.length; i += 2) {
        const data = calendarioIsoDeBr(partes[i]);
        for (const item of partes[i + 1].split(/<br\s*\/?>/i)) {
          const local = item.match(/^([\s\S]*?)&nbsp;-&nbsp;([\s\S]*)$/);
          const nomeLocal = local ? calLimpo(calTextoDeHtml(local[1])) : null;
          const descricao = calLimpo(calTextoDeHtml(local ? local[2] : item));
          if (!descricao) continue;
          if (local && calNome(nomeLocal) !== alvo) continue;
          const registro = { data, descricao: local ? `${nomeLocal}: ${descricao}` : descricao, fonte: r.url };
          if (projecao) aConferir.push({ ...registro, motivo: `projeção: a página não cita ato de ${r.ano}` });
          else feriados.push(registro);
        }
      }
    }
  }
  return { feriados, aConferir, avisos };
}

// ---------------------------------------------------------------------------
// TRT3: "Calendário AAAA" (datas de toda a Região) e "Feriados Locais AAAA" (por cidade-sede).
// ---------------------------------------------------------------------------

/** As linhas `<tr>` de um trecho de HTML, cada uma como a lista de textos das suas `<td>`. */
const calLinhasDeTabela = (html) => [...String(html).matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((tr) => [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((td) => calLimpo(calTextoDeHtml(td[1]))));

function lerTrt3(respostas, { comarca }) {
  const alvo = calNome(comarca);
  const feriados = [];
  const avisos = ['suspensão extraordinária de expediente (portaria da Vara ou do Foro, por chuva ou mudança) não está nas páginas do calendário: confira as notícias e portarias do TRT3 no período'];
  for (const r of respostas.filter((x) => x.tipo === 'geral')) {
    const html = String(r.texto || '');
    const i = html.search(/id="Feriados-nacionais"/);
    if (i < 0 || !new RegExp(`Calend[^<]{0,20}${r.ano}`).test(html)) return { falha: 'resposta-fora-do-formato', avisos: [`a página do calendário do TRT3 veio sem a tabela "Feriados da Justiça do Trabalho de Minas Gerais" de ${r.ano}: ${r.url}`] };
    for (const [dias, , motivo] of calLinhasDeTabela(html.slice(i)).filter((c) => c.length >= 3)) {
      // Corpus Christi e o dia seguinte valem onde há feriado municipal: vêm da tabela local.
      if (/regulamenta[cç][aã]o municipal|localidades em que haja/i.test(motivo)) continue;
      for (const { datas } of calExpressoesDeData(dias, r.ano)) for (const data of datas) feriados.push({ data, descricao: motivo, fonte: r.url });
    }
  }
  for (const r of respostas.filter((x) => x.tipo === 'locais')) {
    const html = String(r.texto || '');
    const localidades = new Set();
    let tabelas = 0;
    for (const tabela of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
      const cap = calendarioSemAcento(calTextoDeHtml((tabela[0].match(/<caption>([\s\S]*?)<\/caption>/i) || [])[1] || ''));
      const m = cap.match(new RegExp(`(${CAL_RE_MES.replace('[cç]', 'c')})\\s*/\\s*(\\d{4})`));
      if (!m || Number(m[2]) !== r.ano) continue;
      tabelas += 1;
      for (const c of calLinhasDeTabela(tabela[0]).filter((x) => x.length >= 3)) {
        localidades.add(calNome(c[1]));
        if (calNome(c[1]) !== alvo) continue;
        for (const dia of c[0].match(/\d{1,2}/g) || []) {
          if (calDataValida(r.ano, calMes(m[1]), Number(dia))) feriados.push({ data: calIso(r.ano, calMes(m[1]), Number(dia)), descricao: `${c[1]}: ${c[2]}`, fonte: r.url });
        }
      }
    }
    if (!tabelas) return { falha: 'resposta-fora-do-formato', avisos: [`a página de feriados locais do TRT3 veio sem as tabelas por mês de ${r.ano}: ${r.url}`] };
    if (!localidades.has(alvo)) return { falha: 'localidade-nao-encontrada', avisos: [`"${comarca}" não está na tabela de feriados locais do TRT3 de ${r.ano}: a tabela lista as cidades-sede de Varas do Trabalho; rode com a cidade da Vara que tem jurisdição sobre o município (página "Jurisdição" do portal do TRT3)`] };
  }
  return { feriados, avisos };
}

// ---------------------------------------------------------------------------
// TJPR: Decreto Judiciário anual (PDF, lido pelo texto que o pdftotext extrai).
// ---------------------------------------------------------------------------

/**
 * Decreto do calendário de cada ano, com a URL que o próprio TJPR publica. Ano novo entra aqui
 * quando o tribunal divulga o decreto (notícia "TJPR divulga calendário de feriados no ano de AAAA").
 */
const TJPR_DECRETOS = {
  2026: {
    caminho: '/documents/d/comunicacao/sei_12428873_decreto',
    ato: 'Decreto Judiciário n.º 621/2025 - P-SEP',
    origem: 'link do decreto na notícia oficial "TJPR divulga calendário de feriados no ano de 2026" (tjpr.jus.br/noticias)',
  },
};

/** "dia 03 (sexta-feira) - Paixão de Cristo e 21 (terça-feira) - Tiradentes" → os itens. */
function calItensDoDecretoTjpr(texto) {
  const itens = [];
  const corpo = String(texto).replace(/^\s*dias?\s+/i, '').replace(/[;.:\s]+$/, '');
  const re = /(\d{1,2})\s*[º°]?\s*\(([^)]*)\)\s*(?:[-–]\s*(.*?))?(?=(?:,|\s+e)\s+\d{1,2}\s*[º°]?\s*\(|$)/g;
  for (const m of corpo.matchAll(re)) itens.push({ dia: Number(m[1]), semana: m[2], descricao: calLimpo(m[3] || '').replace(/[,;]+$/, '') });
  return itens;
}

function lerTjpr(respostas, { comarca }) {
  const alvo = calNome(comarca);
  const feriados = [];
  const aConferir = [];
  const avisos = ['alterações do calendário do TJPR depois do decreto anual (decretos e portarias das comarcas, seção "Prazos e Suspensões" do portal) não entram por código: confira a seção no período'];
  for (const r of respostas) {
    const linhas = String(r.texto || '').replace(/\f/g, '\n').split('\n').filter((l) => !/\/\s*pg\.\s*\d+\s*$/.test(l) && !/^\s*(?:TRIBUNAL DE JUSTIÇA DO ESTADO DO PARANÁ|Pç\.)/.test(l));
    const s = calLimpo(linhas.join(' '));
    const ano = Number((s.match(/calend[aá]rio de feriados\s+no ano de (\d{4})/i) || [])[1]);
    if (ano !== r.ano) return { falha: 'resposta-fora-do-formato', avisos: [`o decreto do TJPR não traz o calendário de ${r.ano} (o texto extraído não tem "calendário de feriados no ano de ${r.ano}"; sem pdftotext não há texto): ${r.url}`] };
    const ato = (TJPR_DECRETOS[r.ano] || {}).ato || 'decreto do calendário';
    const artigos = [...s.matchAll(/Art\.\s*(\d)\s*[º°o]/g)].map((m) => ({ n: Number(m[1]), i: m.index }));
    const artigo = (n) => { const a = artigos.find((x) => x.n === n); const b = artigos.find((x) => x.n === n + 1); return a ? s.slice(a.i, b ? b.i : undefined) : ''; };
    const meses = new RegExp(`\\b(${CAL_RE_MES}):`, 'gi');
    const registrar = (dia, mes, semana, descricao, alcanceLocal) => {
      if (!calDataValida(r.ano, mes, dia)) return;
      const data = calIso(r.ano, mes, dia);
      const registro = { data, descricao, fonte: r.url };
      if (semana && !calendarioSemAcento(semana).startsWith(calendarioSemAcento(calendarioDiaDaSemana(data)))) aConferir.push({ ...registro, motivo: `o decreto diz "${semana}", e ${data} é ${calendarioDiaDaSemana(data)}` });
      else if (alcanceLocal) aConferir.push({ ...registro, motivo: alcanceLocal });
      else feriados.push(registro);
    };
    // Arts. 1º a 3º: feriados e suspensões de expediente de todo o estado.
    for (const n of [1, 2, 3]) {
      const texto = artigo(n);
      const partes = texto.split(meses);
      for (let i = 1; i < partes.length; i += 2) {
        for (const it of calItensDoDecretoTjpr(partes[i + 1])) {
          const somente = it.descricao.match(/somente no Munic[ií]pio de ([^,;.]+)/i);
          if (somente && calNome(somente[1]) !== alvo) continue;
          const descricao = it.descricao || (n === 1 ? 'feriado' : 'suspensão do expediente');
          registrar(it.dia, calMes(partes[i]), it.semana, `${descricao} (art. ${n}º do ${ato})`, null);
        }
      }
    }
    // Art. 4º: feriados locais dos municípios-sede de comarca, mês a mês e dia a dia.
    const locais = artigo(4);
    const porMes = locais.split(meses);
    let achou = false;
    for (let i = 1; i < porMes.length; i += 2) {
      const mes = calMes(porMes[i]);
      const porDia = porMes[i + 1].split(/\bdia\s+(\d{1,2})\s*[º°]?\s*:/);
      for (let j = 1; j < porDia.length; j += 2) {
        for (const m of porDia[j + 1].matchAll(/([^(),;:]+?)\s*\(([^()]*?)(?:\)|(?=;|$))/g)) {
          const nome = calLimpo(m[1]).replace(/^e\s+/, '');
          if (calNome(nome) !== alvo) continue;
          achou = true;
          // "Dia dos Santos Pastorinhos ... em Juranda": vale num distrito, não na sede.
          const restrito = /\bem\s+[A-ZÁÉÍÓÚÂÊÔÃÕ][a-záéíóúâêôãõç]+/.test(m[2]) ? `o decreto restringe a data a uma localidade ("${calLimpo(m[2])}")` : null;
          registrar(Number(porDia[j]), mes, null, `${nome}: ${calLimpo(m[2])} (art. 4º do ${ato})`, restrito);
        }
      }
    }
    if (!achou) avisos.push(`"${comarca}" não tem feriado local no art. 4º do ${ato} (o decreto só lista os municípios-sede que têm): confira a grafia do município-sede da comarca`);
  }
  return { feriados, aConferir, avisos };
}

// ---------------------------------------------------------------------------
// TRT4: Portaria da Corregedoria do calendário do exercício (texto compilado, PDF).
// ---------------------------------------------------------------------------

/** O link da portaria do exercício na página "Feriados locais": o `href` do parágrafo que diz "exercício de AAAA". */
function calLinkDaPortariaTrt4(html, ano) {
  for (const p of String(html).split(/<p[\s>]/i)) {
    if (!new RegExp(`exerc[ií]cio de ${ano}\\b`).test(calTextoDeHtml(p))) continue;
    const href = (p.match(/href="([^"]+\.pdf)"/i) || [])[1];
    if (href) return href.replace(/&amp;/g, '&');
  }
  return null;
}

const CAL_RE_ENTRADA_TRT4 = new RegExp(`^(\\d{1,2})\\s+(?:de\\s+)?(${CAL_RE_MES})\\s*[–-]\\s*(.*)$`, 'i');
const CAL_RE_CABECALHO_TRT4 = /^(?:PODER JUDICIÁRIO|JUSTIÇA DO TRABALHO|TRIBUNAL REGIONAL DO TRABALHO|CORREGEDORIA|CIDADE\s{2,}PERÍODO|FERIADOS MUNICIPAIS|\(Redação dada|Documento assinado)/;

/** Os feriados municipais da tabela (cidade à esquerda, datas à direita) para a cidade pedida. */
function calMunicipaisTrt4(paginas, alvo) {
  const linhas = [];
  for (const pagina of paginas) {
    const brutas = pagina.split('\n').filter((l) => l.trim() && !CAL_RE_CABECALHO_TRT4.test(l.trim()));
    const re = new RegExp(`(^|\\s{2,})(\\d{1,2}\\s+(?:de\\s+)?(?:${CAL_RE_MES})\\s*[–-])`, 'i');
    const posicoes = brutas.map((l) => { const m = l.match(re); return m ? m.index + m[1].length : null; }).filter((x) => x !== null);
    if (!posicoes.length) continue;
    const coluna = Math.min(...posicoes);
    for (const l of brutas) {
      // A coluna da direita começa no primeiro caractere depois de espaço a partir de duas casas antes dela.
      let p = l.length;
      for (let i = Math.max(0, coluna - 2); i < l.length; i += 1) if (l[i] !== ' ' && (i === 0 || l[i - 1] === ' ')) { p = i; break; }
      linhas.push({ esquerda: l.slice(0, p).trim(), direita: l.slice(p).trim() });
    }
  }
  // Entradas (cada data com a sua continuação) e blocos de cidade: as datas de uma cidade vêm em
  // ordem; data que não avança abre a cidade seguinte.
  const blocos = [];
  const fragmentos = [];
  let anterior = null;
  linhas.forEach((l, i) => {
    if (l.esquerda) fragmentos.push({ i, texto: l.esquerda });
    if (!l.direita) return;
    const m = l.direita.match(CAL_RE_ENTRADA_TRT4);
    if (m) {
      const chave = calMes(m[2]) * 100 + Number(m[1]);
      if (!blocos.length || chave <= anterior) blocos.push({ inicio: i, fim: i, entradas: [], dentro: [], antes: [], depois: [] });
      anterior = chave;
      const b = blocos[blocos.length - 1];
      b.entradas.push({ dia: Number(m[1]), mes: calMes(m[2]), texto: m[3] });
      b.fim = i;
    } else if (blocos.length) {
      const b = blocos[blocos.length - 1];
      const e = b.entradas[b.entradas.length - 1];
      e.texto = `${e.texto} ${l.direita}`;
      b.fim = i;
    }
  });
  // O nome da cidade fica centrado ao lado das suas datas; pedaço que cai entre duas cidades pode
  // ser de qualquer uma, e as duas leituras são tentadas.
  for (const f of fragmentos) {
    const k = blocos.findIndex((b) => f.i >= b.inicio && f.i <= b.fim);
    if (k >= 0) { blocos[k].dentro.push(f.texto); continue; }
    const depois = blocos.findIndex((b) => b.inicio > f.i);
    if (depois > 0) { blocos[depois - 1].depois.push(f.texto); blocos[depois].antes.push(f.texto); } else if (depois === 0) blocos[0].antes.push(f.texto);
    else if (blocos.length) blocos[blocos.length - 1].depois.push(f.texto);
  }
  const casam = blocos.filter((b) => {
    for (let p = 0; p <= b.antes.length; p += 1) {
      for (let q = 0; q <= b.depois.length; q += 1) {
        if (calNome([...b.antes.slice(b.antes.length - p), ...b.dentro, ...b.depois.slice(0, q)].join(' ')) === alvo) return true;
      }
    }
    return false;
  });
  return casam;
}

function lerTrt4(respostas, { comarca }) {
  const alvo = calNome(comarca);
  const feriados = [];
  const aConferir = [];
  const avisos = [];
  for (const r of respostas) {
    const texto = String(r.texto || '');
    if (!new RegExp(`(?:exerc[ií]cio|Ano Judici[aá]rio) de ${r.ano}\\b`).test(texto) || !/FERIADOS MUNICIPAIS/.test(texto)) return { falha: 'resposta-fora-do-formato', avisos: [`a portaria do TRT4 não traz o calendário de ${r.ano} com a tabela de feriados municipais (sem pdftotext não há texto): ${r.url}`] };
    const ato = (texto.match(/PORTARIA\s+N[ºo°]\s*([\d.]+),?\s+DE\s+[\dº]+\s+DE\s+[A-ZÇ]+\s+DE\s+(\d{4})/i) || []).slice(1).join('/') || 'portaria do calendário';
    // Feriados nacionais e estaduais: datas na coluna da esquerda, descrição na da direita.
    const linhas = texto.replace(/\f/g, '\n').split('\n');
    const iNac = linhas.findIndex((l) => /FERIADOS NACIONAIS E ESTADUAIS/.test(l));
    const iFim = linhas.findIndex((l, i) => i > iNac && (/^\s*Nota 1/.test(l) || /FERIADOS MUNICIPAIS/.test(l)));
    const esquerda = [];
    const direita = [];
    for (const l of linhas.slice(iNac + 1, iFim)) {
      const t = l.trim();
      if (!t || CAL_RE_CABECALHO_TRT4.test(t) || /^DATA\s*\/\s*PER/.test(t)) continue;
      const m = l.match(/^\s*(\S.*?)(?:\s{3,}(\S.*))?$/);
      if (new RegExp(`^(?:\\d{1,2}(?:\\s|º|°|$)|de\\b|a\\b|e\\b|(?:${CAL_RE_MES})$)`, 'i').test(m[1])) { esquerda.push(m[1]); if (m[2]) direita.push(m[2]); } else direita.push(t);
    }
    const expressoes = calExpressoesDeData(esquerda.join(' '), r.ano);
    const descricoes = direita.join(' ').match(/[^()]+\([^()]*\)(?:\s*[–-]\s*m[oó]vel)?/gi) || [];
    if (!expressoes.length) return { falha: 'resposta-fora-do-formato', avisos: [`a portaria do TRT4 veio sem a tabela de feriados nacionais e estaduais lida: ${r.url}`] };
    expressoes.forEach((e, k) => {
      const descricao = descricoes.length === expressoes.length ? calLimpo(descricoes[k]) : 'feriado nacional ou estadual';
      for (const data of e.datas) feriados.push({ data, descricao: `${descricao} (Anexo Único da Portaria ${ato})`, fonte: r.url });
    });
    const nota = calLimpo(linhas.slice(iFim, iFim + 4).join(' ')).match(/prazos processuais ficam suspensos no período de [^,.]+/i);
    if (nota) avisos.push(`a portaria do TRT4 registra que os ${nota[0]} (art. 220 do CPC): a calculadora trata essa suspensão, que não entra aqui como dia sem expediente`);
    // Feriados municipais da cidade-sede pedida.
    const iMun = texto.indexOf('FERIADOS MUNICIPAIS');
    const casam = calMunicipaisTrt4(texto.slice(iMun).split('\f'), alvo);
    if (!casam.length) return { falha: 'cidade-nao-encontrada', avisos: [`"${comarca}" não está na tabela de feriados municipais do TRT4 de ${r.ano} (a tabela lista as cidades-sede de Foros, Varas e Postos): rode com a cidade da Vara que tem jurisdição sobre o município`] };
    if (casam.length > 1) return { falha: 'tabela-ambigua', avisos: [`a tabela de feriados municipais do TRT4 tem mais de uma leitura para "${comarca}": confira na portaria`] };
    for (const e of casam[0].entradas) {
      if (!calDataValida(r.ano, e.mes, e.dia)) continue;
      const registro = { data: calIso(r.ano, e.mes, e.dia), descricao: `${comarca}: ${calLimpo(e.texto)} (Portaria ${ato})`, fonte: r.url };
      if (/facultativo/i.test(e.texto)) aConferir.push({ ...registro, motivo: 'a portaria marca a data como facultativa: não há certeza de que o expediente fica suspenso' });
      else feriados.push(registro);
    }
  }
  return { feriados, aConferir, avisos };
}

// ---------------------------------------------------------------------------
// TJSC: Resolução GP do calendário, achada pela busca do DJe e lida no caderno (PDF).
// ---------------------------------------------------------------------------

const CAL_RE_RESOLUCAO_TJSC = (ano) => new RegExp(`RESOLUÇÃO GP N\\.\\s*(\\d+)\\s+DE\\s+(\\d{1,2}º?\\s+DE\\s+[A-ZÇ]+\\s+DE\\s+\\d{4})\\s+(?:Altera a Resolução GP n\\.\\s*\\d+ de [^,]+? de \\d{4}, que consolida|Consolida) o calendário de feriados para efeitos forenses\\s+no\\s+âmbito\\s+do\\s+Poder\\s+Judiciário\\s+do\\s+Estado\\s+de\\s+Santa\\s+Catarina\\s+para\\s+o\\s+ano\\s+de\\s+${ano}`, 'i');

/** A edição do DJe com a última resolução do calendário do ano, pela resposta da busca. */
function calUltimaResolucaoTjsc(texto, ano) {
  let json;
  try { json = JSON.parse(texto); } catch { return null; }
  let melhor = null;
  for (const r of (json && json.resultados) || []) {
    const doc = r && r.documento;
    if (!doc || !doc.edicao) continue;
    const m = String(doc.integra || '').match(CAL_RE_RESOLUCAO_TJSC(ano));
    if (m && (!melhor || Number(doc.edicao) > melhor.edicao)) melhor = { edicao: Number(doc.edicao), caderno: Number(doc.cdCaderno) || 4, numero: m[1], data: calLimpo(m[2]).toLowerCase() };
  }
  return melhor;
}

/**
 * Lê as células de uma coluna numa tabela cujas células de várias linhas ficam centradas na linha
 * da data: o que fica acima da data é igual ao que fica abaixo. Devolve, por linha de data, o texto
 * da célula e se a divisão entre duas linhas vizinhas foi ambígua.
 */
function calCelulasCentradas(linhas, coluna) {
  const linhasDeData = linhas.map((l, i) => (l.data ? i : -1)).filter((i) => i >= 0);
  const celulas = linhasDeData.map(() => ({ acima: [], proprio: null, abaixo: [], ambigua: false }));
  let pendentes = [];
  let k = -1;
  linhas.forEach((l) => {
    const pedaco = l.pedacos[coluna] || null;
    if (!l.data) { if (pedaco) pendentes.push(pedaco); return; }
    if (k < 0) celulas[0].acima = pendentes;
    else {
      const abaixo = celulas[k].acima.length;
      if (pendentes.length < abaixo) { celulas[k].ambigua = true; celulas[k + 1].ambigua = true; }
      celulas[k].abaixo = pendentes.slice(0, abaixo);
      celulas[k + 1].acima = pendentes.slice(abaixo);
    }
    k += 1;
    celulas[k].proprio = pedaco;
    pendentes = [];
  });
  if (k >= 0) {
    if (pendentes.length !== celulas[k].acima.length) celulas[k].ambigua = true;
    celulas[k].abaixo = pendentes;
  }
  return celulas.map((c) => ({ texto: calLimpo([...c.acima, c.proprio, ...c.abaixo].filter(Boolean).join(' ')), ambigua: c.ambigua }));
}

/** As linhas do Anexo Único da resolução `numero` no texto do caderno: `[{ data, tipo, fundamento, comarcas, ambigua }]`. */
function calAnexoTjsc(texto, numero, ano) {
  const linhas = String(texto).replace(/\f/g, '\n').split('\n');
  const i0 = linhas.findIndex((l) => new RegExp(`RESOLUÇÃO GP N\\.\\s*${numero}\\b`, 'i').test(l));
  if (i0 < 0) return null;
  const segmentos = [];
  let atual = null;
  let comecou = false;
  for (const l of linhas.slice(i0 + 1)) {
    const cab = l.match(/^(\s*)Data\s{2,}Tipo\s{2,}Fundamento\s{2,}Comarcas afetadas/);
    if (cab) {
      atual = { colunas: [['data', l.indexOf('Data')], ['tipo', l.indexOf('Tipo')], ['fundamento', l.indexOf('Fundamento')], ['comarcas', l.indexOf('Comarcas afetadas')]], linhas: [] };
      segmentos.push(atual);
      continue;
    }
    const t = l.trim();
    if (!atual || !t || /^Presid[eê]ncia$|Di[aá]rio da Justi[cç]a Eletr[oô]nico|[ií]ndice$|^\(Resolu[cç][aã]o GP|^ANEXO [ÚU]NICO$/.test(t)) continue;
    if (l.search(/\S/) < atual.colunas[0][1]) { if (comecou) break; continue; }
    const pedacos = {};
    for (const m of l.matchAll(/\S+(?: \S+)*/g)) {
      const col = [...atual.colunas].reverse().find(([, c]) => m.index >= c - 3);
      const nome = col ? col[0] : 'data';
      pedacos[nome] = pedacos[nome] ? `${pedacos[nome]} ${m[0]}` : m[0];
    }
    const d = (pedacos.data || '').match(new RegExp(`^(\\d{1,2})\\s*[°º]?\\s+de\\s+(${CAL_RE_MES})$`, 'i'));
    atual.linhas.push({ pedacos, data: d && calDataValida(ano, calMes(d[2]), Number(d[1])) ? calIso(ano, calMes(d[2]), Number(d[1])) : null });
    comecou = true;
  }
  const saida = [];
  for (const seg of segmentos) {
    const comarcas = calCelulasCentradas(seg.linhas, 'comarcas');
    const fundamentos = calCelulasCentradas(seg.linhas, 'fundamento');
    const tipos = calCelulasCentradas(seg.linhas, 'tipo');
    seg.linhas.filter((l) => l.data).forEach((l, k) => saida.push({ data: l.data, tipo: tipos[k].texto, fundamento: fundamentos[k].texto, comarcas: comarcas[k].texto, ambigua: comarcas[k].ambigua }));
  }
  return saida;
}

function lerTjsc(respostas, { comarca }) {
  const alvo = calNome(comarca);
  const feriados = [];
  const aConferir = [];
  const avisos = ['o recesso de fim de ano do TJSC é regulamentado por resolução própria, fora do Anexo Único do calendário: confira-a se a janela cruza dezembro e janeiro'];
  for (const r of respostas) {
    const meta = r.meta || {};
    const linhas = calAnexoTjsc(r.texto, meta.numero, r.ano);
    if (!linhas || !linhas.length) return { falha: 'resposta-fora-do-formato', avisos: [`o caderno do DJe do TJSC não trouxe o Anexo Único da Resolução GP n. ${meta.numero} lido (sem pdftotext não há texto): ${r.url}`] };
    const ato = `Resolução GP n. ${meta.numero} de ${meta.data || r.ano} (DJe n. ${meta.edicao})`;
    for (const l of linhas) {
      const c = calendarioSemAcento(l.comarcas);
      const todas = /todas as comarcas/.test(c);
      const nomes = l.comarcas.replace(/^Tribunal de Justi[cç]a,?\s*Turmas Recursais e\s*/i, '').split(/,\s*|\s+e\s+/).map(calNome);
      const capital = alvo === 'florianopolis' && /comarca da capital/.test(c);
      if (!todas && !capital && !nomes.includes(alvo)) continue;
      const registro = { data: l.data, descricao: `${l.fundamento || l.tipo} (${ato})`, fonte: r.url };
      if (l.ambigua) aConferir.push({ ...registro, motivo: 'a célula de comarcas da tabela não tem divisão segura entre duas linhas: confira a data no Anexo Único' });
      else feriados.push(registro);
    }
    if (!linhas.some((l) => l.comarcas.split(/,\s*|\s+e\s+/).map(calNome).includes(alvo)) && alvo !== 'florianopolis') avisos.push(`"${comarca}" não tem feriado municipal no Anexo Único da ${ato}: confira a grafia da comarca`);
  }
  return { feriados, aConferir, avisos };
}

// ---------------------------------------------------------------------------
// O registro dos adaptadores.
// ---------------------------------------------------------------------------

/**
 * Cada adaptador: `base` (a suíte troca por um servidor local), `pagina` (a página oficial que o
 * profissional abre para conferir), `origem` (de onde a URL foi achada), `pedidos` (o que baixar
 * por ano: `{ tipo, ano, url, essencial, fresco, meta }`; `url: null` com `motivo` quando não há
 * fonte para o ano), `seguir` (para pedidos `indice`: o que baixar a partir da resposta) e `ler`.
 * Pedido `fresco` não sai do cache: a página muda quando o tribunal altera o calendário.
 */
const CALENDARIO_ADAPTADORES = {
  tjsp: {
    nome: 'Tribunal de Justiça do Estado de São Paulo',
    base: 'https://www.tjsp.jus.br',
    pagina: (base) => `${base}/CanaisComunicacao/Feriados/ExpedienteForense`,
    origem: 'endpoints PesquisarFeriados e PesquisarSuspensoes que a página oficial de expediente forense chama (achados no run m5r da 0.9.84)',
    pedidos(comarca, anos, base) {
      const municipio = encodeURIComponent(String(comarca).trim().toUpperCase());
      return anos.flatMap((ano) => [
        { tipo: 'feriados', ano, url: `${base}/CanaisComunicacao/Feriados/PesquisarFeriados?nomeMunicipio=${municipio}&codigoMunicipio=&ano=${ano}` },
        { tipo: 'suspensoes', ano, url: `${base}/CanaisComunicacao/Feriados/PesquisarSuspensoes?nomeMunicipio=${municipio}&codigoMunicipio=&ano=${ano}`, essencial: false },
      ]);
    },
    ler: lerTjsp,
  },
  tjmg: {
    nome: 'Tribunal de Justiça do Estado de Minas Gerais',
    base: 'https://www8.tjmg.jus.br',
    pagina: (base) => `${base}/servicos/gj/calendario/index.jsp`,
    origem: 'Guia Judiciário do portal do TJMG, "Feriados Locais" (consulta de todas as comarcas por ano); o ato que consolida o calendário de 2026 é a Portaria Conjunta nº 1.798/PR/2026 (www8.tjmg.jus.br/institucional/at/pdf/pc17982026.pdf)',
    pedidos: (comarca, anos, base) => anos.map((ano) => ({ tipo: 'feriados', ano, url: `${base}/servicos/gj/calendario/index.jsp?tipoFeriado=todos&comarca=null&mes=null&ano=${ano}&btn_pesquisar=Pesquisar`, fresco: true })),
    ler: lerTjmg,
  },
  trt3: {
    nome: 'Tribunal Regional do Trabalho da 3ª Região',
    base: 'https://portal.trt3.jus.br',
    pagina: (base) => `${base}/internet/institucional/calendario`,
    origem: 'portal do TRT3, Institucional > Calendário: "Calendário AAAA" (Resolução Administrativa do ano) e "Feriados Locais AAAA" (Portaria TRT3/SEGP do ano, com as alterações da SEMA); o portal só mantém nesse endereço o ano corrente',
    pedidos: (comarca, anos, base) => anos.flatMap((ano) => [
      { tipo: 'geral', ano, url: `${base}/internet/institucional/calendario/calendario-${ano}`, fresco: true },
      { tipo: 'locais', ano, url: `${base}/internet/institucional/calendario/feriados-locais-1/feriados-locais-${ano}`, fresco: true },
    ]),
    ler: lerTrt3,
  },
  tjpr: {
    nome: 'Tribunal de Justiça do Estado do Paraná',
    base: 'https://www.tjpr.jus.br',
    pagina: (base) => `${base}/noticias`,
    origem: 'Decreto Judiciário anual do calendário de feriados, pela URL que o TJPR dá na notícia oficial de divulgação (tabela TJPR_DECRETOS)',
    pedidos: (comarca, anos, base) => anos.map((ano) => (TJPR_DECRETOS[ano]
      ? { tipo: 'decreto', ano, url: `${base}${TJPR_DECRETOS[ano].caminho}` }
      : { tipo: 'decreto', ano, url: null, motivo: `sem-decreto-registrado-${ano}` })),
    ler: lerTjpr,
  },
  trt4: {
    nome: 'Tribunal Regional do Trabalho da 4ª Região',
    base: 'https://www.trt4.jus.br',
    pagina: (base) => `${base}/portais/trt4/feriados-locais`,
    origem: 'página "Feriados locais" do portal do TRT4, que liga a Portaria da Corregedoria do calendário de cada exercício (2026: Portaria nº 08/2025, texto compilado)',
    pedidos: (comarca, anos, base) => [{ tipo: 'indice', ano: anos[0], url: `${base}/portais/trt4/feriados-locais`, fresco: true, meta: { anos } }],
    seguir(resposta, ctx, base) {
      return (resposta.meta.anos || [resposta.ano]).map((ano) => {
        const href = calLinkDaPortariaTrt4(resposta.texto, ano);
        if (!href) return { tipo: 'portaria', ano, url: null, motivo: `portaria-do-exercicio-${ano}-nao-encontrada` };
        return { tipo: 'portaria', ano, url: /^https?:/.test(href) ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`, fresco: true };
      });
    },
    ler: lerTrt4,
  },
  tjsc: {
    nome: 'Tribunal de Justiça do Estado de Santa Catarina',
    base: 'https://busca.tjsc.jus.br',
    pagina: (base) => `${base}/dje-consulta/`,
    origem: 'busca do Diário da Justiça Eletrônico do TJSC (rest/busca, pela frase "consolida o calendário de feriados para efeitos forenses") e caderno da edição (rest/diario/caderno); o portal www.tjsc.jus.br recusa acesso por programa',
    pedidos: (comarca, anos, base) => anos.map((ano) => ({
      tipo: 'indice', ano, fresco: true,
      url: `${base}/dje-consulta/rest/busca?q=&pg=1&ps=20&frase=${encodeURIComponent('consolida o calendário de feriados para efeitos forenses')}&ou=&not=&dtIni=01/10/${ano - 1}&dtFim=31/12/${ano}&sort=data%20desc`,
    })),
    seguir(resposta, ctx, base) {
      const r = calUltimaResolucaoTjsc(resposta.texto, resposta.ano);
      if (!r) return [{ tipo: 'anexo', ano: resposta.ano, url: null, motivo: `resolucao-do-calendario-${resposta.ano}-nao-encontrada-no-dje` }];
      return [{ tipo: 'anexo', ano: resposta.ano, url: `${base}/dje-consulta/rest/diario/caderno?edicao=${r.edicao}&cdCaderno=${r.caderno}`, meta: r }];
    },
    ler: lerTjsc,
  },
};

/** Base oficial de cada tribunal com adaptador; a suíte troca por um servidor local. */
const CALENDARIO_BASES = Object.fromEntries(Object.entries(CALENDARIO_ADAPTADORES).map(([t, a]) => [t, a.base]));

/**
 * Os pedidos do adaptador: `{ tribunal, nome, pagina, origem, pedidos }`, ou null quando o
 * tribunal não tem adaptador.
 */
function calendarioPedidos(tribunal, comarca, de, ate, bases = CALENDARIO_BASES) {
  const t = calendarioTribunal(tribunal);
  const a = CALENDARIO_ADAPTADORES[t];
  if (!a || !bases[t]) return null;
  const base = String(bases[t]).replace(/\/+$/, '');
  const pedidos = a.pedidos(comarca, calendarioAnos(de, ate), base).map((p) => ({ essencial: true, fresco: false, meta: null, ...p }));
  return { tribunal: t, nome: a.nome, pagina: a.pagina(base), origem: a.origem, pedidos };
}

/** O que baixar a partir de uma resposta `indice` (`{ tipo, ano, url, texto, meta }`). */
function calendarioSeguir(tribunal, resposta, ctx = {}, bases = CALENDARIO_BASES) {
  const t = calendarioTribunal(tribunal);
  const a = CALENDARIO_ADAPTADORES[t];
  if (!a || !a.seguir) return [];
  const base = String(bases[t]).replace(/\/+$/, '');
  return a.seguir({ meta: {}, ...resposta }, ctx, base).map((p) => ({ essencial: true, fresco: false, meta: null, ...p }));
}

/** O calendário de quem não tem adaptador: a fonte falhou, e o marcador de dado é permitido. */
function calendarioSemAdaptador({ tribunal, comarca, de, ate }) {
  return {
    kind: 'legalsquad.calendario-forense', schema_version: '1', tribunal: calendarioTribunal(tribunal), comarca: String(comarca || '').trim().toUpperCase(), vara: null, de, ate,
    status: 'sem_adaptador', motivo: 'sem_adaptador', dias_sem_expediente: [], suspensoes_restritas: [], a_conferir: [], feriados: [], suspensoes: [],
    avisos: [`o motor ainda não tem adaptador para o calendário de "${tribunal}" (há: ${Object.keys(CALENDARIO_BASES).join(', ')}): feriado local e suspensão ficam com marcador [CONFIRMAR: calendário do tribunal] e a diligência de conferir no site do tribunal; a linha acesso_falhou no INDEX é o que permite o marcador`],
  };
}

/**
 * Monta o calendário da janela a partir das respostas do adaptador (`[{ tipo, ano, url, texto,
 * meta }]`, as que abriram; `texto` é o HTML decodificado, o JSON ou o texto extraído do PDF).
 */
function montarCalendarioForense({ tribunal, comarca, de, ate, vara = null, respostas = [] }) {
  const a = CALENDARIO_ADAPTADORES[calendarioTribunal(tribunal)];
  if (!a) return calendarioSemAdaptador({ tribunal, comarca, de, ate });
  const leitura = a.ler(respostas, { comarca, de, ate, anos: calendarioAnos(de, ate) });
  return consolidarCalendario({ tribunal, comarca, de, ate, vara, ...leitura });
}
// <<< calendario-adaptadores:end

export {
  CALENDARIO_ADAPTADORES, CALENDARIO_BASES, TJPR_DECRETOS, calendarioPedidos, calendarioSeguir, calendarioSemAdaptador, montarCalendarioForense,
  calendarioSuspensaoTjsp, calExpressoesDeData, calCelulasCentradas, calAnexoTjsc, calUltimaResolucaoTjsc, calLinkDaPortariaTrt4, calMunicipaisTrt4,
};
