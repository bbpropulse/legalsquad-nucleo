// O Citation Gate em camadas (plano do servidor de referência, seção 3.5): a ponte entre a citação que
// o extrator do hook acha na peça e a conferência do servidor de referência.
//
// O que o código decide aqui, e só isto:
// - monta, da citação do extrator, o texto canônico que o servidor lê ("art. 157, § 2º, inciso II,
//   do CP"; "Súmula 7 do STJ") e o trecho entre aspas que a peça transcreve junto dela, se houver;
// - classifica o resultado do servidor em quatro saídas:
//   `verificada`  lei ou ato com selo `conferido`, de pé, e trecho (se a peça transcreveu) batendo:
//                 vai ao cartório como VERIFICADA por código, com url_oficial, conferido_em e sha256;
//   `revogada`    o dispositivo está revogado ou vetado, ou a súmula cancelada: contestação na hora;
//   `fidelidade`  súmula, tema ou OJ com selo `conferido`: existência e vigência conferidas por
//                 código, e o verificador julga só se a peça diz o que a tese diz, com o texto
//                 oficial no pacote, sem busca (a fidelidade continua com o modelo);
//   `excecao`     o resto (selo `coleta`, `divergente`, `ilegivel`, `sem_fonte`, ausente, ambíguo,
//                 dispositivo que o texto conferido não tem, trecho que não bate, servidor fora do
//                 ar): segue o fluxo de sempre, fonte oficial aberta no run, como exceção.
// Nada aqui aprova sem conferência: servidor indisponível é `excecao`, e o índice local só fecha lei
// quando foi verificado contra o servidor nos últimos dias.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM para `scripts/squad-state.mjs` e
// `templates/scripts/squad-state.mjs` (`npm run sync:blocos`).

// >>> ref-gate:begin
/** Classes do extrator que o servidor de referência confere, e o que cada uma é para o gate. */
const REF_GATE_TIPOS = Object.freeze({ lei: 'lei', sumula: 'precedente', tema: 'precedente', oj: 'precedente', adi: 'julgado', adc: 'julgado', adpf: 'julgado', ado: 'julgado' });
/** Dias que o índice local vale como conferência quando o servidor não responde. */
const REF_GATE_DIAS_DO_INDICE = 7;
const REF_GATE_SIGLA = { cf: 'CF', adct: 'ADCT', cpc: 'CPC', cpp: 'CPP', clt: 'CLT', cdc: 'CDC', ctn: 'CTN', ctb: 'CTB', cp: 'CP', cc: 'CC', lep: 'LEP', eca: 'ECA', lindb: 'LINDB', ce: 'Código Eleitoral' };
const refSemAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** O que a citação do extrator é para o gate (`lei`, `precedente`, `julgado`), ou null (o servidor não confere). */
function tipoDaCitacaoNoGate(c) {
  if (!c || c.sem_diploma) return null;
  return REF_GATE_TIPOS[String(c.classe || '').toLowerCase()] || null;
}

/** O dispositivo do extrator (`p:2/i:ii/a:b`) como o servidor lê: "§ 2º, inciso II, alínea b". */
function dispositivoParaOServidor(dispositivo) {
  const partes = [];
  for (const p of String(dispositivo || '').split('/').filter(Boolean)) {
    if (p === 'caput') partes.push('caput');
    else if (p === 'p:u') partes.push('parágrafo único');
    else if (p.startsWith('p:')) partes.push(`§ ${p.slice(2)}º`);
    else if (p.startsWith('i:')) partes.push(`inciso ${p.slice(2).toUpperCase()}`);
    else if (p.startsWith('a:')) partes.push(`alínea ${p.slice(2)}`);
  }
  return partes;
}

/** O mesmo dispositivo como o título do cartório o escreve: "§ 2º, II, b" (o hook o lê de volta). */
function dispositivoParaOTitulo(dispositivo) {
  const partes = [];
  for (const p of String(dispositivo || '').split('/').filter(Boolean)) {
    if (p === 'caput') partes.push('caput');
    else if (p === 'p:u') partes.push('parágrafo único');
    else if (p.startsWith('p:')) partes.push(`§ ${p.slice(2)}º`);
    else if (p.startsWith('i:')) partes.push(p.slice(2).toUpperCase());
    else if (p.startsWith('a:')) partes.push(p.slice(2));
  }
  return partes;
}

/**
 * O diploma numerado como a peça o escreve, lido do trecho da citação ("Lei nº 11.343/2006", "LC
 * 101/2000", "Resolução CNJ 213/2015"): o extrator guarda só o número, e o tipo decide o id. Null
 * quando o trecho não diz o diploma de forma que o servidor leia (portaria, instrução normativa).
 */
// Lei complementar que a prática cita pelo apelido ("Lei Kandir", "LRF"): o extrator dá o número, e a
// espécie vem do nome (sem ela, o texto ia ao servidor como "Lei 87").
const REF_GATE_COMPLEMENTAR_DO_APELIDO = { 87: /(?<![a-z])kandir(?![a-z])/, 101: /(?<![a-z])(?:lrf|responsabilidade fiscal)(?![a-z])/ };
function diplomaNumeradoDaCitacao(c) {
  // A remissão herdada ("art. 3º" depois de "LC 123/2006, art. 1º") traz o diploma em `diploma_de`:
  // a espécie (lei complementar, decreto-lei) é lida lá também.
  const bruto = refSemAcento(`${c.bruto || ''} ${c.diploma_de || ''}`).toLowerCase();
  const [num, ano] = String(c.numeroLei || '').split('/');
  const digitos = String(num || '').replace(/\D/g, '');
  if (!digitos) return null;
  const n = digitos.replace(/\B(?=(\d{3})+(?!\d))/g, '\\.?');
  const ato = new RegExp(`(resolucao|res\\.?|provimento|prov\\.?|recomendacao|rec\\.?)\\s*(?:conjunt[ao]\\s*)?(?:(cnj|cnmp)\\s*)?(?:n[o°º.]*\\s*)?${n}(?![\\d])`).exec(bruto);
  if (ato) {
    const orgao = ato[2] || ((/(?<![a-z])cnmp(?![a-z])/.test(bruto) && 'cnmp') || (/(?<![a-z])cnj(?![a-z])/.test(bruto) && 'cnj'));
    if (!orgao) return null;
    const especie = /^prov/.test(ato[1]) ? 'Provimento' : /^rec/.test(ato[1]) ? 'Recomendação' : 'Resolução';
    return `${especie} ${orgao.toUpperCase()} ${digitos}${ano ? `/${ano}` : ''}`;
  }
  if (/(?<![a-z])(?:portaria|port\.|instrucao normativa|(?<![a-z])in(?![a-z])|codigo de normas)/.test(bruto)) return null;
  const tipos = [['lei complementar', 'Lei Complementar'], ['lc', 'Lei Complementar'], ['decreto-lei', 'Decreto-Lei'], ['decreto lei', 'Decreto-Lei'], ['dl', 'Decreto-Lei'], ['medida provisoria', 'Medida Provisória'], ['mpv', 'Medida Provisória'], ['mp', 'Medida Provisória'], ['emenda constitucional', 'Emenda Constitucional'], ['ec', 'Emenda Constitucional'], ['decreto', 'Decreto'], ['dec', 'Decreto'], ['lei', 'Lei']];
  let nome = REF_GATE_COMPLEMENTAR_DO_APELIDO[digitos] && REF_GATE_COMPLEMENTAR_DO_APELIDO[digitos].test(bruto) ? 'Lei Complementar' : 'Lei';
  for (const [forma, rotulo] of tipos) {
    if (new RegExp(`(?<![a-z])${forma.replace(/[-\s]/g, '[-\\s]')}\\.?\\s*(?:federal\\s*)?(?:n[o°º.]*\\s*)?${n}(?![\\d])`).test(bruto)) { nome = rotulo; break; }
  }
  return `${nome} ${digitos.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${ano ? `/${ano}` : ''}`;
}

const REF_GATE_UFS = 'AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SE|SP|TO';
const REF_GATE_GENTILICOS = 'paulista|mineir[ao]|fluminense|carioca|ga[uú]ch[ao]|baian[ao]|pernambucan[ao]|paranaense|catarinense|cearense|goian[ao]|capixaba|amazonense|paraense|maranhense|piauiense|potiguar|paraiban[ao]|alagoan[ao]|sergipan[ao]|tocantinense|rondoniense|acrean[ao]|roraimense|amapaense|(?:sul-)?mato-grossense|distrital';
const REF_GATE_GENTILICO = new RegExp(`(?<![a-z])(?:${REF_GATE_GENTILICOS})(?![a-z])`);

/** A citação diz de que estado (ou município) é a norma: "(SP)", "-SP", "do Estado de São Paulo", "lei paulista". */
function ufNaCitacaoDoGate(bruto) {
  const t = String(bruto || '');
  if (new RegExp(`\\(\\s*(?:${REF_GATE_UFS})\\s*\\)|[-–]\\s?(?:${REF_GATE_UFS})(?![A-Za-z])`).test(t)) return true;
  const s = refSemAcento(t).toLowerCase();
  return /do estado d[eoa]s? [a-z]|do distrito federal|do municipio d[eoa]s? [a-z]/.test(s) || REF_GATE_GENTILICO.test(s);
}

/**
 * Norma que não é federal (estadual, municipal, distrital, constituição estadual, lei orgânica). O
 * extrator do hook a lê como a lei federal do mesmo número; o texto canônico federal levaria o
 * servidor ao documento errado. Ela vai ao servidor como a peça a escreve: com a UF, resolve no
 * estado; sem a UF, o leitor do servidor responde `ambigua` com as UFs candidatas (`exige_uf`),
 * nunca a lei federal, e a citação vai ao verificador com essa lista.
 */
// A Lei Orgânica da Saúde (8.080) e a da Assistência Social (8.742) são federais: o extrator as lê
// pelo apelido, e o texto canônico federal é o certo para elas.
function esferaNaoFederalDoGate(c) {
  const s = refSemAcento(c?.bruto || '').toLowerCase();
  return /(?<![a-z])(?:estadua(?:l|is)|municipa(?:l|is)|distrital|lei organica(?! da (?:saude|assistencia social))|constituicao (?:estadual|do estado))(?![a-z])/.test(s)
    || String(c?.diploma || '').toLowerCase() === 'constituicao-estadual' || ufNaCitacaoDoGate(c?.bruto);
}

/**
 * As esferas em que a peça cita o mesmo número de norma ("10.261/1968"): `com-uf`, `sem-uf`
 * (estadual sem o estado) ou `federal`, olhando a vizinhança de cada ocorrência. O extrator do hook
 * guarda uma citação por chave, e a chave não separa a esfera: a lei estadual de SP, a estadual sem
 * UF e a federal do mesmo número são a mesma chave. Com mais de uma esfera na peça, o título do
 * cartório cobriria as outras ocorrências; quem chama não verifica por código e manda ao verificador.
 * Com `artigo`, só contam as ocorrências que citam esse artigo (as que o extrator junta na mesma chave).
 */
function esferasDoNumeroNaPeca(linhas, numeroLei, { artigo = null } = {}) {
  const [num, ano] = String(numeroLei || '').split('/');
  const digitos = String(num || '').replace(/\D/g, '');
  const out = new Set();
  if (!digitos) return out;
  const re = new RegExp(`(?<![\\d.])${digitos.replace(/\B(?=(\d{3})+(?!\d))/g, '\\.?')}${ano ? `\\s*/\\s*(?:${ano}|${String(ano).slice(-2)})(?!\\d)` : '(?![\\d.])'}`, 'g');
  for (const linha of linhas || []) {
    for (const m of String(linha).matchAll(re)) {
      const antes = String(linha).slice(Math.max(0, m.index - 45), m.index);
      const depois = String(linha).slice(m.index + m[0].length, m.index + m[0].length + 30);
      const viz = `${antes}${m[0]}${depois}`;
      const s = refSemAcento(viz).toLowerCase();
      if (artigo && !new RegExp(`art(?:igo)?s?\\.?\\s*${String(artigo).replace(/\D/g, '')}(?!\\d)`).test(s)) continue;
      if (ufNaCitacaoDoGate(viz)) out.add('com-uf');
      else if (/(?<![a-z])(?:estadua(?:l|is)|municipa(?:l|is)|distrital)(?![a-z])/.test(s)) out.add('sem-uf');
      else out.add('federal');
    }
  }
  return out;
}

const refLimparCitacao = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(/[\s,;:.]+$/, '');

/** O diploma da citação de lei, para o texto do servidor e para o título. */
function diplomaDaCitacaoNoGate(c) {
  const sigla = String(c.diploma || '').toLowerCase();
  if (REF_GATE_SIGLA[sigla]) return { servidor: `do ${REF_GATE_SIGLA[sigla]}`, titulo: REF_GATE_SIGLA[sigla] };
  if (sigla && sigla !== 'lei') return null; // constituição estadual e o que mais o servidor ainda não tem
  const numerado = diplomaNumeradoDaCitacao(c);
  return numerado ? { servidor: `, ${numerado}`, titulo: numerado } : null;
}

/** O texto canônico que vai ao servidor (o leitor dele o leva à chave do apelido), ou null. */
function textoCanonicoDaCitacao(c) {
  const tipo = tipoDaCitacaoNoGate(c);
  if (!tipo) return null;
  const classe = String(c.classe).toLowerCase();
  const orgao = String(c.orgao || '').toUpperCase();
  if (classe === 'lei') {
    if (esferaNaoFederalDoGate(c)) return /\d/.test(String(c.bruto)) ? refLimparCitacao(c.bruto) : null;
    const d = diplomaDaCitacaoNoGate(c);
    if (!d) return null;
    if (!c.artigo) return d.titulo;
    const art = `art. ${c.artigo}${c.sufixo ? `-${String(c.sufixo).toUpperCase()}` : ''}`;
    return [art, ...dispositivoParaOServidor(c.dispositivo)].join(', ') + (d.servidor.startsWith(',') ? d.servidor : ` ${d.servidor}`);
  }
  // A lista enxuta do extrator (`--citacoes`) não traz `vinculante`: a marca vem na chave (`|sv|`) ou no trecho.
  const vinculante = c.vinculante || /\|sv\|/.test(String(c.chave || '')) || /vinculante|(?<![a-z])sv(?![a-z])/i.test(String(c.bruto || ''));
  if (classe === 'sumula') return vinculante ? `Súmula Vinculante ${c.numero}` : orgao ? `Súmula ${c.numero} do ${orgao}` : `Súmula ${c.numero}`;
  if (classe === 'tema') {
    if (orgao === 'STF') return `Tema ${c.numero} da repercussão geral`;
    if (orgao) return `Tema ${c.numero} do ${orgao}`;
    return String(c.bruto || `Tema ${c.numero}`);
  }
  if (classe === 'oj') return String(c.bruto || `OJ ${c.numero}`);
  return `${classe.toUpperCase()} ${c.numero}`;
}

/** O título do cartório para a citação de lei verificada por código ("CP, art. 157, § 2º, II"). */
function tituloCanonicoDaCitacao(c) {
  // Norma estadual ou municipal: o título é a citação como a peça a escreve (o hook a lê de volta à mesma chave).
  if (esferaNaoFederalDoGate(c)) return ufNaCitacaoDoGate(c.bruto) ? refLimparCitacao(c.bruto) : null;
  const d = diplomaDaCitacaoNoGate(c);
  if (!d) return null;
  if (!c.artigo) return d.titulo;
  return [d.titulo, `art. ${c.artigo}${c.sufixo ? `-${String(c.sufixo).toUpperCase()}` : ''}`, ...dispositivoParaOTitulo(c.dispositivo)].join(', ');
}

/**
 * O trecho que a peça transcreve entre aspas junto da citação, na mesma linha: logo depois dela
 * (até 140 caracteres de distância) ou logo antes (até 40). Só um candidato; com dois, null (não se
 * adivinha qual transcrição é de qual dispositivo).
 */
function trechoEntreAspasDaCitacao(linha, bruto) {
  const texto = String(linha || '');
  const pos = texto.indexOf(String(bruto || ''));
  if (pos < 0 || !bruto) return null;
  const fim = pos + String(bruto).length;
  // As aspas se pareiam na ordem da linha (a 1ª abre, a 2ª fecha, e assim por diante; a curva “ só
  // abre e a ” só fecha). Medido em 10/11/2026 (resposta a ofício do MP): com a busca por regex, o
  // texto ENTRE o "chargeback" e o "imediato" da mesma linha virou um trecho citado do art. 49 do CDC,
  // não conferia com a lei, e a citação voltava ao verificador a cada versão, sem fim.
  const pares = [];
  let abre = null;
  for (let i = 0; i < texto.length; i += 1) {
    const ch = texto[i];
    if (ch === '“' || (ch === '"' && abre === null)) { if (abre === null) abre = i; continue; }
    if ((ch === '”' || ch === '"') && abre !== null) { pares.push([abre, i]); abre = null; }
  }
  const candidatos = [];
  for (const [ini, fecha] of pares) {
    const dentro = texto.slice(ini + 1, fecha);
    if (dentro.length < 20 || dentro.length > 800) continue;
    const ate = fecha + 1;
    if ((ini >= fim && ini - fim <= 140) || (ate <= pos && pos - ate <= 40)) candidatos.push(dentro.trim());
  }
  return candidatos.length === 1 ? candidatos[0] : null;
}

const REF_GATE_GATILHO_FORA = new RegExp([
  '(?<![\\p{L}])(?:portarias?|resolu[çc][ãa]o|res\\.|rdc|instru[çc][ãa]o normativa|provimento|recomenda[çc][ãa]o|delibera[çc][ãa]o|ato normativo|normas? regulamentadoras?|nrs?(?=\\s*-?\\s*\\d)',
  'regimento interno|lei org[âa]nica|constitui[çc][ãa]o (?:estadual|do estado)',
  '(?:lei|decreto|lei complementar|decreto-lei) (?:estadual|municipal|distrital)',
  `lei (?:${REF_GATE_GENTILICOS}))(?![\\p{L}])`,
].join('|'), 'giu');
// O regimento pela sigla do tribunal (RISTF, RITJSP, RITRF4). Medido em 10/11/2026: com RI seguido de
// qualquer maiúscula, "RISCO DE CRONOLOGIA" virava citação e ia ao verificador a cada versão.
const REF_GATE_GATILHO_SIGLA = /(?<![\p{L}])(?:IN|RI(?:ST[FJM]|T(?:ST|SE|CU|J[A-Z]{2}|JM[A-Z]{2}|RF\d{0,2}|RT\d{0,2}|RE[A-Z]{2})|CNJ|CNMP|CJF|CARF))(?![\p{L}])/gu;
// Depois do gatilho de ato ou de norma estadual vem o número (com o órgão, a espécie ou o "nº" no meio):
// "Resolução CNMP nº 174", "Resolução do Conselho Nacional do Ministério Público nº 174", "resolução
// normativa nº 465". A palavra solta não é citação: "a resolução prevê que, vencido o prazo do art. 3º"
// virava trecho a conferir, o servidor não o lia, e ele voltava ao verificador a cada versão.
const REF_GATE_NUMERO_DO_ATO = /^[\s-]*(?:(?:\p{Lu}[\p{L}/.-]*|d[aoe]s?|n[º°o]\.?|n\.\s*[º°o]|n[úu]mero|normativ[ao]s?|conjunta|administrativa|interministerial|executiva|regulamentadoras?|complementar|estadual|municipal|distrital)[\s,]*){0,9}\d/u;

/**
 * As citações que o extrator do hook não acha (ele lê lei com artigo, súmula, tema e julgado) e que
 * o servidor lê desde a carga completa: ato de regulador e de conselho (portaria, resolução, RDC,
 * IN), norma estadual e municipal, regimento interno, lei orgânica, constituição estadual. Devolve
 * `{ bruto, linha, chave }` com o trecho a partir do gatilho (e do "art. N do" logo antes, se houver);
 * o leitor do servidor lê a primeira citação do trecho. O que já é citação do extrator fica fora.
 * Não vai ao cartório: o servidor confere e o resultado avisa (revogado volta à redação).
 */
function citacoesForaDoExtrator(linhas, descobertas = [], { limite = 40 } = {}) {
  const porLinha = new Map();
  for (const c of descobertas || []) {
    if (!c || !c.linha || !c.bruto) continue;
    if (!porLinha.has(c.linha)) porLinha.set(c.linha, []);
    porLinha.get(c.linha).push(String(c.bruto));
  }
  const vistos = new Set();
  const out = [];
  (linhas || []).forEach((textoDaLinha, i) => {
    const linha = i + 1;
    const texto = String(textoDaLinha || '');
    const spans = (porLinha.get(linha) || []).flatMap((b) => { const ini = texto.indexOf(b); return ini >= 0 ? [[ini, ini + b.length]] : []; });
    // O "art. N, § 2º, inciso II, do" logo antes do gatilho é parte da citação; frase solta, não.
    const inicio = (m) => {
      const antes = texto.slice(Math.max(0, m.index - 60), m.index);
      const art = /art(?:igo)?s?\.?\s*\d+[ºo°]?(?:-[A-Za-z])?(?:\s*,\s*(?:§\s*\d+[ºo°]?|par[áa]grafo [úu]nico|inc(?:iso)?\.?\s*[IVXLC]+|[IVXLC]+|al[íi]nea\s*["“]?[a-z]["”]?|caput))*\s*,?\s+d[aoe]s?\s+$/i.exec(antes);
      return art ? m.index - antes.length + art.index : m.index;
    };
    const achados = [...texto.matchAll(REF_GATE_GATILHO_FORA), ...texto.matchAll(REF_GATE_GATILHO_SIGLA)].sort((a, b) => a.index - b.index).map((m) => ({ m, ini: inicio(m) }));
    for (const [k, { m, ini }] of achados.entries()) {
      if (out.length >= limite) return;
      if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      // Até o fim da frase, sem passar da citação seguinte.
      const proxima = achados.slice(k + 1).find((x) => x.ini > m.index);
      let fim = Math.min(texto.length, m.index + 160, proxima ? proxima.ini : Infinity);
      const corte = /[;!?]|\.\s+(?=\p{Lu})|\.$/u.exec(texto.slice(m.index + m[0].length, fim));
      if (corte) fim = m.index + m[0].length + corte.index;
      const bruto = refLimparCitacao(texto.slice(ini, fim));
      const semNumero = /regimento|lei org|constitui|^ri|(?<![\p{L}])RI[A-Z]/iu.test(m[0]);
      if (!semNumero && !/\d/.test(bruto)) continue;
      if (!semNumero && !REF_GATE_NUMERO_DO_ATO.test(texto.slice(m.index + m[0].length, m.index + m[0].length + 90))) continue;
      const chaveTexto = refSemAcento(bruto).toLowerCase();
      if (vistos.has(chaveTexto)) continue;
      vistos.add(chaveTexto);
      out.push({ bruto, linha, chave: `fora:${linha}:${ini}` });
    }
  });
  return out;
}

/** Revogado, vetado ou cancelado, pelo dispositivo ou pelo documento; null quando está de pé. */
function situacaoQueImpede(r) {
  const s = String(r?.situacao || '').toLowerCase();
  if (s === 'revogado' || s === 'vetado') return s;
  const v = refSemAcento(r?.vigencia || '').toLowerCase().trim();
  if (/^revogad/.test(v)) return 'revogado';
  if (/^cancelad/.test(v)) return 'cancelado';
  return null;
}

/** A URL oficial em HTTPS (o cartório e o manifesto exigem): `http://` de fonte pública vira `https://`; o resto, null. */
function urlOficialHttps(url) {
  const u = String(url || '').trim();
  if (/^https:\/\//i.test(u)) return u;
  if (/^http:\/\/[^/]*\.(?:gov|jus|leg|mp)\.br\//i.test(u)) return u.replace(/^http:/i, 'https:');
  return null;
}

/**
 * Classifica um item do lote (`conferirLoteDoGate`): `{ classificacao, motivo, resultado }`.
 * `indiceFresco`: o índice local foi verificado contra o servidor há menos de REF_GATE_DIAS_DO_INDICE
 * dias (só então ele fecha lei quando o servidor não responde).
 */
function classificarConferencia(item, c, { indiceFresco = false } = {}) {
  const tipo = tipoDaCitacaoNoGate(c);
  const r = item?.servidor || (item?.local && item.local.status === 'encontrada' && indiceFresco && tipo === 'lei' ? item.local : null);
  const fonte = item?.servidor ? 'servidor' : r ? 'indice-local' : null;
  if (!r) return { classificacao: 'excecao', motivo: item?.local?.status === 'encontrada' ? 'o servidor de referência não respondeu e o índice local não fecha esta citação: fonte oficial no run' : 'o servidor de referência não respondeu: fonte oficial no run', resultado: item?.local || null, fonte };
  if (r.status === 'ambigua') {
    // Norma estadual sem a UF: as UFs candidatas vão ao verificador (e à redação), nunca a lei federal.
    const ufs = [...new Set((r.candidatos || []).map((k) => k.uf || (/^est:([a-z]{2}):/.exec(String(k.id)) || [])[1]).filter(Boolean).map((u) => String(u).toUpperCase()))];
    if (r.exige_uf || /diga a UF/i.test(String(r.motivo || ''))) {
      return { classificacao: 'excecao', exige_uf: true, ufs_candidatas: ufs, motivo: `norma estadual citada sem a UF: ${ufs.length ? `a base tem essa norma em ${ufs.join(', ')} (${(r.candidatos || []).map((k) => k.id).join(', ')})` : 'nenhuma UF da base a tem'}; a peça precisa dizer o estado, e nunca vale a lei federal do mesmo número`, resultado: r, fonte };
    }
    return { classificacao: 'excecao', motivo: `a citação é ambígua no servidor (${(r.candidatos || []).map((k) => k.id).join(', ')}): a peça precisa dizer o tribunal ou o ano`, resultado: r, fonte };
  }
  // Artigo cujo texto NÃO foi conferido (assinatura do servidor pelo anel de artigos, sha256 do texto, sha256 do diploma igual ao do índice): nunca aprova, nem declara revogado, nem fecha pelo índice (regra 7 do plano da Legis).
  if (item?.artigo && item.artigo.ok === false) return { classificacao: 'excecao', motivo: `o texto do artigo não pôde ser conferido (${item.artigo.etapa || 'servidor'}: ${item.artigo.motivo}): fonte oficial no run`, resultado: r, fonte };
  if (r.status === 'dispositivo_nao_encontrado') return { classificacao: 'excecao', motivo: `o diploma está no servidor, mas o dispositivo ${r.rotulo || ''} não está no texto conferido: confira se ele existe`, resultado: r, fonte };
  if (r.status !== 'encontrada') return { classificacao: 'excecao', motivo: r.status === 'nao_encontrada' ? 'a citação não está na base do servidor de referência (ainda): fonte oficial no run' : `o servidor não leu a citação (${r.status})`, resultado: r, fonte };
  const impede = situacaoQueImpede(r);
  if (impede && ['conferido', 'coleta'].includes(r.selo)) return { classificacao: 'revogada', situacao: impede === 'cancelado' ? 'cancelada' : 'revogada', motivo: `${r.rotulo || r.titulo}: ${impede === 'vetado' ? 'dispositivo vetado' : impede === 'cancelado' ? 'súmula ou tema cancelado' : 'dispositivo revogado'} no texto conferido (${r.url_oficial || 'servidor de referência'}); não fundamente nele`, resultado: r, fonte };
  if (tipo === 'julgado') return { classificacao: 'excecao', motivo: 'julgado: a existência está no servidor; a fidelidade e o acórdão são do verificador', resultado: r, fonte };
  if (r.selo !== 'conferido') return { classificacao: 'excecao', motivo: `selo ${r.selo} no servidor${r.selo_motivo ? ` (${r.selo_motivo})` : ''}: fonte oficial no run`, resultado: r, fonte };
  if (impede) return { classificacao: 'excecao', motivo: `situação ${impede} com selo ${r.selo}: fonte oficial no run`, resultado: r, fonte };
  if (tipo === 'precedente') return { classificacao: 'fidelidade', motivo: 'existência e vigência conferidas por código no servidor de referência; o verificador julga só a fidelidade, com o texto oficial', resultado: r, fonte };
  if (item.trecho && r.trecho !== 'confere') {
    return { classificacao: 'excecao', motivo: r.trecho === 'nao_confere' ? 'o trecho entre aspas na peça não confere com o texto oficial do dispositivo' : `o trecho entre aspas não pôde ser comparado (${r.trecho || 'sem comparação'})`, resultado: r, fonte };
  }
  if (!urlOficialHttps(r.url_oficial)) return { classificacao: 'excecao', motivo: 'o servidor não tem a URL oficial em HTTPS deste diploma: fonte oficial no run', resultado: r, fonte };
  // Servidor fora do padrão (o `servidor_url` de um acervo.json de projeto): a resposta do `conferir`
  // não é assinada, então ela só fecha lei quando o índice assinado desta máquina diz o mesmo.
  if (item.servidor_confiavel === false && !item.confirmado_pelo_indice) return { classificacao: 'excecao', motivo: 'servidor de referência fora do padrão, sem o índice assinado desta máquina confirmando o mesmo texto: fonte oficial no run', resultado: r, fonte };
  return { classificacao: 'verificada', motivo: `conferida por código no servidor de referência (selo conferido${item.trecho ? ', trecho batendo' : ''})`, resultado: r, fonte };
}
// <<< ref-gate:end

// Fora do bloco: só o cliente (src/ref-cliente.js) usa.
/** "(Vide ADI 6.298)" no texto do dispositivo: a nota oficial que o Planalto põe no artigo. */
function videControleNoTexto(texto) {
  const out = [];
  for (const m of String(texto || '').matchAll(/\(\s*vide\s+(adi|adc|adpf|ado)\s*(?:n[ºo°.]*\s*)?(\d{1,2}(?:\.\d{3})+|\d+)/gi)) out.push(`stf:${m[1].toLowerCase()}:${m[2].replace(/\./g, '')}`);
  return [...new Set(out)];
}

export {
  REF_GATE_TIPOS, REF_GATE_DIAS_DO_INDICE, tipoDaCitacaoNoGate, textoCanonicoDaCitacao, tituloCanonicoDaCitacao, trechoEntreAspasDaCitacao,
  classificarConferencia, situacaoQueImpede, videControleNoTexto, urlOficialHttps, diplomaDaCitacaoNoGate, citacoesForaDoExtrator, esferaNaoFederalDoGate, esferasDoNumeroNaPeca,
};
