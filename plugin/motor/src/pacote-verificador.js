// O pacote do verificador de citações, montado por código (0.9.102, 10/10/2026).
//
// Medido no run de 09/10/2026 (parecer tributário, 38 citações de lei julgadas em três rodadas):
// cada verificador fez de 53 a 131 buscas nas cópias de `fontes/` (7 a 8 minutos) só para achar o
// dispositivo, ver se existia e se a cópia compilada o riscava. As cópias são o texto da página numa
// linha só, e o mesmo "Art. 35." aparecia três vezes na LC 214 (duas dentro de alterações de outras
// leis, entre aspas). Achar o artigo, o parágrafo, o inciso e a alínea, e ler se o texto está
// riscado ou declarado revogado, é trabalho de código.
//
// O que este módulo faz, para cada citação pendente da minuta (a lista é a do cartório, que a tira do
// extrator do hook `verifica-citacoes`): a frase da minuta que usa a citação, com a linha; a fonte
// oficial casada no `fontes/INDEX.jsonl` do run (url, sha da cópia, `consulted_at` = `baixado_em`); o
// trecho recortado do dispositivo exato; nos achados, o artigo inteiro da mesma cópia (`artigo_inteiro`,
// para a precisão do dispositivo: conteúdo que está em outro parágrafo, item omitido de uma lista); e
// um estado de código:
//
//   achado                 o dispositivo está na cópia do diploma, sem risco nem marca de revogação;
//   achado-revogado        está, mas riscado por inteiro, "(Revogado ...)" ou "(VETADO)";
//   fonte-sem-dispositivo  a cópia do diploma foi baixada e o código não achou o dispositivo nela;
//   sem-fonte              nenhuma cópia oficial do diploma neste run;
//   precedente             súmula, Tema, OJ ou acórdão: o que der pelo acervo local, sem julgar;
//   ambiguo                o código não decide (remissão sem diploma, duas redações, dois diplomas).
//
// O código NUNCA declara uma citação verificada nem inexistente: só tria e recorta. Quem julga a
// existência e a fidelidade continua sendo o verificador, que recebe o pacote e só gasta busca
// própria no que não veio `achado` ou `achado-revogado`. O formato da tabela que ele devolve, o hook
// e o cartório não mudam.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM para `scripts/squad-state.mjs` e
// `templates/scripts/squad-state.mjs` (`npm run sync:blocos`). `situacaoDoTexto`,
// `mensagemDaSituacao`, `SITUACOES_QUE_IMPEDEM` e `coletadoAteDoTexto` vêm do bloco situacao-acervo,
// que o squad-state também carrega.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { situacaoDoTexto, mensagemDaSituacao, SITUACOES_QUE_IMPEDEM, coletadoAteDoTexto } from './situacao-acervo.js';

// >>> pacote-verificador:begin
/** Os estados que o código dá a uma citação. Nenhum deles é "verificada". */
const PACOTE_ESTADOS = Object.freeze(['achado', 'achado-revogado', 'fonte-sem-dispositivo', 'sem-fonte', 'precedente', 'ambiguo']);
/** Os estados em que o verificador precisa de busca própria (os outros vêm com o trecho recortado). */
const PACOTE_ESTADOS_COM_BUSCA = Object.freeze(['fonte-sem-dispositivo', 'sem-fonte', 'ambiguo', 'precedente']);
/** Orçamento de buscas próprias do verificador por ritmo (o pacote leva o do run). */
const PACOTE_ORCAMENTO_DE_BUSCAS = Object.freeze({ rapido: 15, equilibrado: 25, completo: 40 });
/**
 * Tamanho máximo do trecho recortado; dispositivo maior vai cortado, com aviso. Medido em 10/10/2026
 * (minuta tributária): com 1800, o § 1º, II, de um artigo (2205 caracteres) saiu sem a alínea c, e a
 * minuta que dizia os requisitos cumulativos omitindo a alínea c passou sem ressalva.
 */
const PACOTE_LIMITE_DO_TRECHO = 4000;
/**
 * Tamanho máximo do artigo inteiro que vai junto do trecho (`artigo_inteiro`). Acima dele vão o caput e
 * o parágrafo vizinho de cada lado do dispositivo citado, com aviso de corte.
 */
const PACOTE_LIMITE_DO_ARTIGO = 6000;
const PACOTE_LIMITE_DA_FRASE = 700;

// Códigos e a lei que os instituiu: a fonte do "CPC" é a página da Lei 13.105.
const PACOTE_LEI_DO_CODIGO = {
  cpc: ['lei', '13105'], cc: ['lei', '10406'], clt: ['del', '5452'], cdc: ['lei', '8078'], ctn: ['lei', '5172'], cpp: ['del', '3689'],
  cp: ['del', '2848'], lep: ['lei', '7210'], eca: ['lei', '8069'], ctb: ['lei', '9503'], lindb: ['del', '4657'], ce: ['lei', '4737'],
};
// Como cada tipo de diploma se escreve no texto (sem acento, minúsculas): para achar o tipo da citação
// e para conferir de quem é o artigo que a lei alteradora traz entre aspas.
const PACOTE_NOME_DO_TIPO = {
  lc: 'lei\\s+complementar|lc',
  lei: 'lei(?!\\s+complementar)',
  del: 'decreto-lei|dl',
  decreto: 'decreto(?!-lei)|dec\\.?',
  mp: 'medida\\s+provisoria|mp|mpv',
  ec: 'emenda\\s+constitucional|ec',
};

const pvSemAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const pvLetras = (t) => (String(t || '').match(/[\p{L}\p{N}]/gu) || []).length;
const pvEspacos = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const pvCortar = (t, n) => { const s = pvEspacos(t); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };
const pvNumero = (n) => String(n || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');

/**
 * O diploma que uma URL oficial serve. Planalto: `l<N>`, `lcp<N>`, `d<N>`, `del<N>`, `mpv<N>`,
 * `emc<N>` e a Constituição, com ou sem `compilado`/`compilada`/`cons`, com ponto no número
 * (`l10.833.htm`) ou o ano na pasta. Outra URL não diz o diploma: null.
 */
function diplomaDaUrlDoPacote(url) {
  const u = String(url || '').toLowerCase().split(/[?#]/)[0];
  if (!/planalto\.gov\.br/.test(u)) return null;
  if (/\/constituicao\/constituicao(?:compilado)?\.html?$/.test(u)) return { tipo: 'cf', numero: '', compilada: true };
  const m = u.match(/\/(lcp|emc|mpv|del|l|d)(\d[\d.]*)(compilad[oa]|consolidad[oa]|cons)?\.html?$/);
  if (!m) return null;
  const tipo = { lcp: 'lc', emc: 'ec', mpv: 'mp', del: 'del', l: 'lei', d: 'decreto' }[m[1]];
  return { tipo, numero: pvNumero(m[2]), compilada: !!m[3] };
}

/** O nome do diploma como o texto oficial o escreve, em regex sobre o texto sem acento. */
function rxDoDiploma(d) {
  if (d.tipo === 'cf') return d.adct ? /ato\s+das\s+disposicoes\s+constitucionais\s+transitorias/i : /constituicao\s+federal|constituicao\s+da\s+republica/i;
  const nome = PACOTE_NOME_DO_TIPO[d.tipo] || PACOTE_NOME_DO_TIPO.lei;
  const n = d.numero.replace(/\B(?=(\d{3})+(?!\d))/g, '\\.?');
  return new RegExp(`(?:${nome})\\s*(?:n[º°o.]*\\s*)?${n}(?![\\d])`, 'i');
}

/**
 * O diploma da citação: `{ tipo, numero, adct }`. Código (CPC, CLT...) vira a lei que o instituiu;
 * CF e ADCT, a Constituição. Lei numerada leva o tipo que a frase dá ao número ("LC 214", "Lei
 * 9.430", "Decreto 6.514"); sem ele, `tipo: null` (casa qualquer tipo com o número).
 */
function diplomaDaCitacaoDoPacote(c, frase) {
  const sigla = String(c.diploma || '').toLowerCase();
  if (sigla === 'cf' || sigla === 'adct') return { tipo: 'cf', numero: '', adct: sigla === 'adct', rotulo: sigla.toUpperCase() };
  if (PACOTE_LEI_DO_CODIGO[sigla]) { const [tipo, numero] = PACOTE_LEI_DO_CODIGO[sigla]; return { tipo, numero, rotulo: sigla.toUpperCase() }; }
  const numero = pvNumero(String(c.numeroLei || '').split('/')[0]);
  if (!numero) return null;
  const n = numero.replace(/\B(?=(\d{3})+(?!\d))/g, '\\.?');
  const achar = (texto) => {
    const t = pvSemAcento(texto).toLowerCase();
    for (const tipo of ['lc', 'del', 'decreto', 'mp', 'ec', 'lei']) {
      if (new RegExp(`(?:^|[^a-z])(?:${PACOTE_NOME_DO_TIPO[tipo]})\\s*(?:[a-z]{2,6}\\s+)?(?:n[º°o.]*\\s*)?${n}(?![\\d])`).test(t)) return tipo;
    }
    if (new RegExp(`(?:^|[^a-z])(?:resolucao|res\\.|portaria|instrucao\\s+normativa|in|provimento)\\b[^\\d]{0,20}${n}(?![\\d])`).test(t)) return 'infralegal';
    return null;
  };
  const tipo = achar(c.bruto) || achar(frase);
  const rotulo = `${{ lc: 'LC', del: 'Decreto-Lei', decreto: 'Decreto', mp: 'MP', ec: 'EC', lei: 'Lei', infralegal: 'ato' }[tipo] || 'diploma'} ${c.numeroLei}`;
  return { tipo, numero, rotulo };
}

/**
 * Os dispositivos que o extrator do hook não lê e o pacote lê na própria citação ou logo depois
 * dela: o parágrafo com letra ("§ 1º-A", que o hook lê como § 1º) e a lista ou o intervalo de
 * parágrafos depois do artigo ("art. 13, §§ 9º a 11", "art. 23, §§ 1º-A e 2º", que o hook lê como o
 * artigo inteiro). Medido no run de 09/10/2026: o "§ 1º-A" do art. 23 da LC 123 ia ao verificador
 * como § 1º, cujo texto é outro (o crédito de ICMS). Devolve `{ paragrafos: [{n, letra}], intervalo }`.
 */
function paragrafosDoTrecho(texto) {
  const t = String(texto || '');
  const art = t.match(/\bart(?:igo)?s?\.?\s*\d+(?:\.\d{3})*(?:\s*[ºo°])?(?:-[A-Za-z](?![\p{L}]))?/u);
  if (!art) return { paragrafos: [], intervalo: false };
  const depois = t.slice(art.index + art[0].length);
  const item = '\\d+\\s*[ºo°]?(?:\\s*-\\s*[A-Z](?![\\p{L}]))?';
  const m = depois.match(new RegExp(`^\\s*,?\\s*(?:caput\\s*(?:,|e)\\s*)?(§§?|par[áa]grafos?)\\s*(${item}(?:\\s*(?:,\\s*(?:e\\s+)?|e\\s+|a\\s+)${item})*)`, 'u'));
  if (!m) return { paragrafos: [], intervalo: false };
  const itens = [...m[2].matchAll(/(\d+)\s*[ºo°]?(?:\s*-\s*([A-Z]))?/g)].map((x) => ({ n: pvNumero(x[1]), letra: x[2] ? x[2].toLowerCase() : '' }));
  const intervalo = /\d\s*[ºo°]?\s+a\s+\d/.test(m[2]) && itens.length === 2 && !itens[0].letra && !itens[1].letra;
  if (intervalo) {
    const [de, ate] = [Number(itens[0].n), Number(itens[1].n)];
    if (ate > de && ate - de <= 20) return { paragrafos: Array.from({ length: ate - de + 1 }, (_, i) => ({ n: String(de + i), letra: '' })), intervalo: true };
  }
  return { paragrafos: itens, intervalo: false };
}

/** O caminho de dispositivo do hook ("p:1/i:ii/a:b") em partes. */
function partesDoDispositivo(dispositivo) {
  const partes = { caput: false, paragrafo: null, inciso: null, alinea: null };
  for (const p of String(dispositivo || '').split('/').filter(Boolean)) {
    if (p === 'caput') partes.caput = true;
    else if (p.startsWith('p:')) partes.paragrafo = { n: p.slice(2) === 'u' ? 'u' : pvNumero(p.slice(2)), letra: (p.slice(2).match(/-([a-z])$/) || [])[1] || '' };
    else if (p.startsWith('i:')) partes.inciso = p.slice(2).toUpperCase();
    else if (p.startsWith('a:')) partes.alinea = p.slice(2).toLowerCase();
  }
  return partes;
}

function rotuloDoAlvo(artigo, sufixo, partes) {
  const pedacos = [`art. ${artigo}${sufixo ? `-${sufixo.toUpperCase()}` : ''}`];
  if (partes.caput) pedacos.push('caput');
  if (partes.paragrafo) pedacos.push(partes.paragrafo.n === 'u' ? 'parágrafo único' : `§ ${partes.paragrafo.n}${partes.paragrafo.letra ? `-${partes.paragrafo.letra.toUpperCase()}` : ''}`);
  if (partes.inciso) pedacos.push(partes.inciso);
  if (partes.alinea) pedacos.push(partes.alinea);
  return pedacos.join(', ');
}

// ── O texto da cópia ───────────────────────────────────────────────────────────────────────────
// A cópia (`fontes/<sha1>.txt`) é a página numa linha, com o que ela risca marcado no lugar:
// `⟦riscado: …⟧`. O Planalto risca o "º" de "§ 1º" como formatação (medido na LC 123: "§ 1 ⟦riscado:
// º⟧ As pessoas"); esse risco não é revogação e sai antes de tudo.

function textoPreparado(bruto) {
  // Página em Windows-1252 lida como Latin-1 deixa o travessão e as aspas como controles C1 (medido na
  // LC 116: "I \u0096 (VETADO) II \u0096 demais serviços"); voltam a ser o que eram.
  const C1 = { '\u0091': '‘', '\u0092': '’', '\u0093': '“', '\u0094': '”', '\u0096': '–', '\u0097': '–' };
  return String(bruto || '').replace(/[\u0091-\u0097]/g, (ch) => C1[ch] || ch).replace(/⟦riscado:\s*([ºo°ª.,;:\s-]{0,4})⟧/g, (_, dentro) => dentro.replace(/\s+/g, ''));
}

function trechosRiscados(texto) {
  const spans = [];
  const re = /⟦riscado:[^⟧]*⟧/g;
  let m;
  while ((m = re.exec(texto))) spans.push([m.index, m.index + m[0].length]);
  return spans;
}
const dentroDe = (spans, i) => spans.some(([a, b]) => i >= a && i < b);
const ehCitado = (texto, i) => /[“"‘'«]\s*$/.test(texto.slice(Math.max(0, i - 4), i));

// "Art. 8 o As alíquotas", "Art. 129 . Ficam", "Art. 13-A.", "Art.1.048.". A letra do artigo vem
// colada ao traço; "Art. 13 - A Carteira" é o artigo 13. Vírgula logo depois é remissão.
const RE_ABERTURA_DO_PACOTE = /(?<![\p{L}\p{N}])Art\.\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:\s*(?:[ºo°]|o(?=\s)))?(?:\s?-([A-Z])(?![\p{L}])(?![ \t]+\p{Ll}))?(?![\p{L}\p{N}])(?!\s*,)\s*\.?/gu;

/** Cada abertura de artigo da cópia, com o que ela é: citada entre aspas (alteração de outra lei) ou riscada. */
function aberturasDaCopia(texto, riscos) {
  const lista = [];
  RE_ABERTURA_DO_PACOTE.lastIndex = 0;
  let m;
  while ((m = RE_ABERTURA_DO_PACOTE.exec(texto))) {
    lista.push({ ini: m.index, fimRotulo: m.index + m[0].length, numero: pvNumero(m[1]), sufixo: (m[2] || '').toLowerCase(), citado: ehCitado(texto, m.index), riscado: dentroDe(riscos, m.index) });
  }
  for (let k = 0; k < lista.length; k += 1) lista[k].fim = k + 1 < lista.length ? lista[k + 1].ini : texto.length;
  return lista;
}

/** A Constituição traz o ADCT no fim: o título em caixa alta, a última vez que aparece. */
function inicioDoAdct(texto) {
  const re = /ATO DAS DISPOSI[ÇC][ÕO]ES CONSTITUCIONAIS TRANSIT[ÓO]RIAS/g;
  let ultimo = -1;
  let m;
  while ((m = re.exec(texto))) ultimo = m.index;
  return ultimo;
}

// Rótulos dentro do artigo. Parágrafo: "§ 1º A", "§ 1º-A. As", "Parágrafo único. O"; o texto que
// segue abre em maiúscula, parêntese ou risco (remissão "no § 1º deste artigo" segue em minúscula).
const RE_PARAGRAFO_DO_PACOTE = /(?<![\p{L}\p{N}§])(?:§\s*(\d+)(?:\s*(?:[ºo°]|o(?=\s)))?(?:-([A-Z])(?![\p{L}]))?|(Par[áa]grafo\s+[úu]nico))\s*[.:-]?\s*(?=[\p{Lu}(⟦“"‘'])/gu;
const ROMANO_DO_PACOTE = '(?=[IVXLC])C{0,3}(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})';
// Inciso: "I - texto", "II – texto", "I (VETADO)". Sem o traço, só depois de pontuação e antes de
// minúscula ("I (VETADO) II demais serviços", LC 116): "Anexos I a V" não é inciso.
const RE_INCISO_DO_PACOTE = new RegExp(`(?<![\\p{L}\\p{N}§])(${ROMANO_DO_PACOTE})(?![\\p{L}\\p{N}])\\s*(?:[-–\u2014]\\s*(?=\\S)|(?=\\(\\s*(?:VETADO|Vetado|vetado|[Rr]evogad|[Ii]nclu[íi]d|[Rr]eda[çc])))`, 'gu');
const RE_INCISO_SEM_TRACO = new RegExp(`(?<=[;:.)⟧]\\s+)(${ROMANO_DO_PACOTE})(?![\\p{L}\\p{N}])(?=\\s+\\p{Ll})`, 'gu');
// Alínea: "a) texto", depois de dois-pontos, ponto e vírgula, ponto ou "; e".
const RE_ALINEA_DO_PACOTE = /(?<=(?:^|[:;.)⟧]|[;,]\s*(?:e|ou))\s*)([a-z])\)\s*(?=\S)/gu;

function rotulosEm(texto, re, chave) {
  const lista = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(texto))) {
    if (!m[0]) { re.lastIndex += 1; continue; }
    lista.push({ ini: m.index, fimRotulo: m.index + m[0].length, ...chave(m) });
  }
  for (let k = 0; k < lista.length; k += 1) lista[k].fim = k + 1 < lista.length ? lista[k + 1].ini : texto.length;
  return lista;
}

/** Os segmentos [ini, fim) do texto que respondem ao rótulo pedido (todas as ocorrências). */
function segmentosDe(texto, ini, fim, re, chave, casa) {
  const pedaco = texto.slice(ini, fim);
  return rotulosEm(pedaco, re, chave).filter(casa).map((r) => ({ ini: ini + r.ini, fimRotulo: ini + r.fimRotulo, fim: ini + r.fim }));
}

/** Os parágrafos de um artigo: o caput vai até o primeiro rótulo de parágrafo. */
function paragrafosDoArtigo(texto, art) {
  return rotulosEm(texto.slice(art.fimRotulo, art.fim), RE_PARAGRAFO_DO_PACOTE, (m) => ({ n: m[3] ? 'u' : pvNumero(m[1]), letra: (m[2] || '').toLowerCase() }))
    .map((p) => ({ ...p, ini: art.fimRotulo + p.ini, fimRotulo: art.fimRotulo + p.fimRotulo, fim: art.fimRotulo + p.fim }));
}

/** Os incisos de um segmento, com e (se o pedido não aparece com traço) sem traço. */
function incisosDe(texto, ini, fim, romano) {
  const casa = (r) => r.romano === romano;
  const chave = (m) => ({ romano: m[1] });
  const comTraco = segmentosDe(texto, ini, fim, RE_INCISO_DO_PACOTE, chave, casa);
  if (comTraco.length) {
    // O fim do inciso é o próximo rótulo de inciso de qualquer forma.
    const todos = [...rotulosEm(texto.slice(ini, fim), RE_INCISO_DO_PACOTE, chave), ...rotulosEm(texto.slice(ini, fim), RE_INCISO_SEM_TRACO, chave)].map((r) => ini + r.ini).sort((a, b) => a - b);
    return comTraco.map((s) => ({ ...s, fim: Math.min(fim, ...todos.filter((p) => p > s.ini)) }));
  }
  return segmentosDe(texto, ini, fim, RE_INCISO_SEM_TRACO, chave, casa);
}

// Notas editoriais da página: não são texto do dispositivo, nem quando a página as risca.
const RE_NOTAS_EDITORIAIS = /\((?:[^()]|\([^()]*\))*\)|Produ[çc][ãa]o\s+de\s+efeitos?|Vig[êe]ncia|Texto\s+compilado|Mensagem\s+de\s+veto/gi;

/**
 * O que o texto recortado diz de si: revogado (o núcleo é "(Revogado ...)" ou está todo riscado),
 * vetado, risco parcial, nota "Vide". Devolve `{ revogado: motivo|null, avisos: [] }`.
 */
function leituraDoRecorte(recorte, rotuloLen) {
  const corpo = recorte.slice(rotuloLen);
  const riscado = (corpo.match(/⟦riscado:[^⟧]*⟧/g) || []).map((r) => r.replace(/⟦riscado:\s*|⟧/g, '')).join(' ');
  const riscadoSemNotas = riscado.replace(RE_NOTAS_EDITORIAIS, ' ');
  const vivo = corpo.replace(/⟦riscado:[^⟧]*⟧/g, ' ');
  const nucleo = pvEspacos(vivo.replace(RE_NOTAS_EDITORIAIS, ' '));
  const avisos = [];
  let revogado = null;
  if (pvLetras(nucleo) < 4 && /\(\s*revogad[oa]s?\b/i.test(vivo)) revogado = 'revogado';
  else if (/^\(?\s*revogad[oa]s?\b/i.test(nucleo)) revogado = 'revogado';
  else if (pvLetras(nucleo) < 4 && /\(\s*vetad[oa]s?\s*\)/i.test(vivo)) revogado = 'vetado';
  else if (pvLetras(riscadoSemNotas) > 20 && pvLetras(nucleo) < 0.15 * pvLetras(riscadoSemNotas)) revogado = 'riscado';
  if (!revogado && pvLetras(riscadoSemNotas) >= 12) avisos.push({ tipo: 'riscado-parcial', texto: `a cópia risca parte do dispositivo: "${pvCortar(riscado, 160)}"; confira se a frase usa a redação vigente` });
  for (const nota of new Set((vivo.match(/\(\s*Vide[^()]*\)/gi) || []).map(pvEspacos))) avisos.push({ tipo: 'vide', texto: `a cópia traz junto do dispositivo a nota ${nota}: confira se ela muda a vigência ou o alcance` });
  return { revogado, avisos };
}

/**
 * Entre ocorrências do mesmo rótulo, vence a que tem texto vivo (rótulo fora de risco e corpo que não é
 * só risco e nota: "§ 1º ⟦riscado: redação antiga⟧ § 1º redação nova"); depois, a de rótulo fora de
 * risco; sem nenhuma, a riscada, marcada.
 */
function preferirVigente(ocorrencias, copia) {
  const temTextoVivo = (o) => pvLetras(copia.texto.slice(o.fimRotulo, o.fim).replace(/⟦riscado:[^⟧]*⟧/g, ' ').replace(RE_NOTAS_EDITORIAIS, ' ')) >= 4;
  const viva = ocorrencias.find((o) => !dentroDe(copia.riscos, o.ini) && temTextoVivo(o));
  if (viva) return { ...viva, riscado: false };
  const foraDeRisco = ocorrencias.find((o) => !dentroDe(copia.riscos, o.ini));
  return foraDeRisco ? { ...foraDeRisco, riscado: false } : { ...ocorrencias[0], riscado: true };
}

/**
 * Recorta o alvo (`partes`) dentro de um artigo da cópia. Devolve `{ achado, ini, fim, rotuloLen,
 * riscado, motivo }`: `achado: false` com o motivo (parágrafo, inciso ou alínea ausente); `riscado`
 * quando só há o rótulo dentro de um risco (a redação que não vale mais).
 */
function recorteNoArtigo(copia, art, partes) {
  const { texto } = copia;
  let escopo = { ini: art.ini, fim: art.fim, rotuloLen: art.fimRotulo - art.ini, riscado: false };
  const pars = paragrafosDoArtigo(texto, art);
  if (partes.paragrafo) {
    const alvo = pars.filter((p) => p.n === partes.paragrafo.n && p.letra === (partes.paragrafo.letra || ''));
    if (!alvo.length) return { achado: false, motivo: `${partes.paragrafo.n === 'u' ? 'parágrafo único' : `§ ${partes.paragrafo.n}${partes.paragrafo.letra ? `-${partes.paragrafo.letra.toUpperCase()}` : ''}`} não está no artigo da cópia` };
    const p = preferirVigente(alvo, copia);
    escopo = { ini: p.ini, fim: p.fim, rotuloLen: p.fimRotulo - p.ini, riscado: p.riscado };
  } else if (partes.caput || partes.inciso || partes.alinea) {
    // O caput vai até o primeiro rótulo de parágrafo, riscado ou não: o § 1º riscado não é do caput.
    escopo = { ini: art.ini, fim: pars.length ? pars[0].ini : art.fim, rotuloLen: art.fimRotulo - art.ini, riscado: false };
  }
  if (partes.inciso) {
    const incs = incisosDe(texto, escopo.ini + escopo.rotuloLen, escopo.fim, partes.inciso);
    if (!incs.length) return { achado: false, motivo: `inciso ${partes.inciso} não está no ${partes.paragrafo ? 'parágrafo' : 'caput'} da cópia` };
    const i = preferirVigente(incs, copia);
    escopo = { ini: i.ini, fim: i.fim, rotuloLen: i.fimRotulo - i.ini, riscado: escopo.riscado || i.riscado };
  }
  if (partes.alinea) {
    // Alínea sem inciso é do próprio caput ou parágrafo: vem antes do primeiro inciso, nunca de dentro
    // de um ("CP, art. 33, § 2º, c" não é a alínea c do inciso I de outro dispositivo).
    let fimDasAlineas = escopo.fim;
    if (!partes.inciso) {
      const primeiroInciso = rotulosEm(texto.slice(escopo.ini + escopo.rotuloLen, escopo.fim), RE_INCISO_DO_PACOTE, (m) => ({ romano: m[1] }))[0];
      if (primeiroInciso) fimDasAlineas = escopo.ini + escopo.rotuloLen + primeiroInciso.ini;
    }
    const als = segmentosDe(texto, escopo.ini + escopo.rotuloLen, fimDasAlineas, RE_ALINEA_DO_PACOTE, (m) => ({ letra: m[1] }), (r) => r.letra === partes.alinea);
    if (!als.length) return { achado: false, motivo: `alínea ${partes.alinea} não está ${partes.inciso ? `no inciso ${partes.inciso}` : 'no dispositivo'} da cópia` };
    const a = preferirVigente(als, copia);
    escopo = { ini: a.ini, fim: a.fim, rotuloLen: a.fimRotulo - a.ini, riscado: escopo.riscado || a.riscado };
  }
  return { achado: true, ...escopo };
}

/** O trecho sem a ponta de risco que o fim do segmento cortou e sem aspas soltas no fim. */
function trechoLimpo(bruto) {
  return String(bruto || '').replace(/\s*⟦riscado:[^⟧]*$/, '').replace(/[\s“"‘']+$/, '');
}

/** Lê a cópia uma vez por run e guarda aberturas e riscos. */
function copiaDoPacote(cache, fonte, lerTexto) {
  if (cache.has(fonte.arquivo)) return cache.get(fonte.arquivo);
  let texto = null;
  try { texto = textoPreparado(lerTexto(fonte.arquivo)); } catch { texto = null; }
  const dados = texto === null ? null : (() => { const riscos = trechosRiscados(texto); return { texto, riscos, aberturas: aberturasDaCopia(texto, riscos), adct: inicioDoAdct(texto) }; })();
  cache.set(fonte.arquivo, dados);
  return dados;
}

/** O nome do diploma está na cabeça do artigo que traz o bloco citado ("... passa a vigorar ...")? */
function cabecaDoArtigoNomeia(copia, abertura, diploma) {
  const dono = [...copia.aberturas].reverse().find((a) => a.ini < abertura.ini && !a.citado && !a.riscado);
  if (!dono) return false;
  const cabeca = copia.texto.slice(dono.fimRotulo, abertura.ini);
  const ateAspas = cabeca.split(/[“"]/)[0];
  return rxDoDiploma(diploma).test(pvSemAcento(ateAspas));
}

/**
 * Procura o alvo numa cópia. `modo: 'propria'` lê só os artigos do próprio diploma (fora de aspas);
 * `modo: 'alteradora'` lê os artigos citados entre aspas (a redação que a lei alteradora deu).
 * Devolve a lista de ocorrências `{ trecho, revogado, avisos, citado, confirmado }` e, sem nenhuma,
 * o motivo.
 */
function ocorrenciasNaCopia(copia, artigo, sufixo, partes, diploma, modo) {
  const corpo = diploma.tipo === 'cf' && copia.adct >= 0 ? (a) => (diploma.adct ? a.ini > copia.adct : a.ini < copia.adct) : () => true;
  const daqui = copia.aberturas.filter((a) => a.numero === artigo && a.sufixo === (sufixo || '') && (modo === 'propria' ? !a.citado : a.citado) && corpo(a));
  if (!daqui.length) return { ocorrencias: [], motivo: `art. ${artigo}${sufixo ? `-${sufixo.toUpperCase()}` : ''} não está na cópia${modo === 'alteradora' ? ' (nem entre aspas)' : ''}` };
  const ocorrencias = [];
  let motivo = null;
  for (const art of daqui) {
    const r = recorteNoArtigo(copia, art, partes);
    if (!r.achado) { motivo = motivo || r.motivo; continue; }
    const bruto = trechoLimpo(copia.texto.slice(r.ini, r.fim));
    const leitura = art.riscado || r.riscado ? { revogado: 'riscado', avisos: [] } : leituraDoRecorte(bruto, r.rotuloLen);
    ocorrencias.push({
      trecho: bruto,
      revogado: leitura.revogado,
      avisos: leitura.avisos,
      riscado: art.riscado,
      confirmado: modo === 'propria' ? true : cabecaDoArtigoNomeia(copia, art, diploma),
      artigo: { copia, art, alvo: [r.ini, r.fim] },
    });
  }
  return { ocorrencias, motivo: ocorrencias.length ? null : motivo };
}

const chaveDoTrecho = (t) => pvSemAcento(String(t || '').replace(/⟦riscado:[^⟧]*⟧/g, ' ').replace(/\((?:[^()]|\([^()]*\))*\)/g, ' ')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Dois recortes dizem o mesmo? Igual fora das notas e da pontuação, ou com até duas palavras de
 * diferença em cada lado (medido na Lei 9.430: a redação que ela deu ao art. 3º, § 1º, da Lei 9.249
 * traz "pela número de meses", e a compilada da 9.249, "pelo número"; é o mesmo texto).
 */
function mesmoTexto(a, b) {
  const [x, y] = [chaveDoTrecho(a), chaveDoTrecho(b)];
  if (x === y) return true;
  const contar = (t) => t.split(' ').reduce((m, p) => m.set(p, (m.get(p) || 0) + 1), new Map());
  const [mx, my] = [contar(x), contar(y)];
  const sobra = (m1, m2) => [...m1].reduce((n, [p, q]) => n + Math.max(0, q - (m2.get(p) || 0)), 0);
  return sobra(mx, my) <= 2 && sobra(my, mx) <= 2;
}

/** As fontes do run que servem o diploma: compiladas primeiro. */
function fontesDoDiploma(fontes, diploma) {
  return fontes
    .filter((f) => f.diploma && (diploma.tipo === 'cf' ? f.diploma.tipo === 'cf' : f.diploma.numero === diploma.numero && (!diploma.tipo || diploma.tipo === f.diploma.tipo)))
    .sort((a, b) => Number(b.diploma.compilada) - Number(a.diploma.compilada));
}

/**
 * A lei que, segundo a própria citação, deu a redação: o parêntese ou a remissão logo depois dela
 * ("(LC 227)", "(redação da LC 227/2026)", "(na redação do art. 517 da LC 214)", "(EC 132/2023)").
 * Outra lei citada na mesma frase não conta: medido no run de 09/10/2026, "Lei 9.249, art. 3º, caput e
 * § 1º; Lei 9.430, art. 1º" virava "duas redações" porque a 9.430 também altera o art. 3º da 9.249.
 */
function leisAlteradorasDaCauda(cauda, diploma, fontes) {
  // O que a citação ainda traz antes do parêntese ("-A", ", §§ 9º a 11") não é a lei da redação.
  const t = pvSemAcento(cauda).toLowerCase().replace(/^\s*-\s*[a-z](?![a-z])/, '').replace(/^\s*,?\s*(?:§§?|paragrafos?|caput)[^()]{0,40}?(?=\()/, '');
  const m = t.match(/^\s*,?\s*(?:\(|,\s*)\s*(?:(?:na\s+)?(?:nova\s+)?redacao\s+(?:dada\s+)?(?:pel[ao]s?|d[ao]s?)\s+(?:art(?:igo)?\.?\s*[\d.]+\s*[ºo°]?(?:-[a-z])?\s*,?\s*d[ao]\s+)?|(?:incluid|acrescid|alterad|introduzid)[oa]s?\s+pel[ao]s?\s+)?(lei\s+complementar|lc|emenda\s+constitucional|ec|lei|decreto-lei|decreto|medida\s+provisoria|mp)\s*(?:n[º°o.]*\s*)?(\d[\d.]*)/);
  if (!m) return [];
  const tipo = /complementar|^lc$/.test(m[1]) ? 'lc' : /emenda|^ec$/.test(m[1]) ? 'ec' : /decreto-lei/.test(m[1]) ? 'del' : /decreto/.test(m[1]) ? 'decreto' : /medida|^mp$/.test(m[1]) ? 'mp' : 'lei';
  const numero = pvNumero(m[2]);
  if (diploma.tipo !== 'cf' && numero === diploma.numero && (!diploma.tipo || diploma.tipo === tipo)) return [];
  return fontes.filter((f) => f.diploma && f.diploma.tipo === tipo && f.diploma.numero === numero);
}

const MOTIVO_DA_REVOGACAO = { revogado: 'a cópia declara o dispositivo revogado', vetado: 'a cópia traz o dispositivo como vetado', riscado: 'a cópia risca o dispositivo inteiro (redação que não vale mais)' };

/**
 * O alvo numa citação: procura nas fontes do diploma e na lei que a própria citação diz ter dado a
 * redação. Devolve `{ estado, fonte, trecho, motivo, avisos, candidatos }`.
 */
function alvoNasFontes(ctx, diploma, artigo, sufixo, partes, cauda) {
  const avisos = [];
  const proprias = fontesDoDiploma(ctx.fontes, diploma);
  const tipos = new Set(proprias.map((f) => f.diploma.tipo));
  if (!diploma.tipo && tipos.size > 1) {
    return { estado: 'ambiguo', motivo: `o número ${diploma.numero} casa com mais de um diploma baixado (${proprias.map((f) => f.url).join(', ')}), e a frase não diz qual`, avisos, candidatos: proprias.map((f) => ({ url: f.url })) };
  }
  // A redação que a lei alteradora nomeada deu ao dispositivo, com a confirmação de que o bloco entre
  // aspas é do diploma citado (o artigo que o traz nomeia o diploma: "A Lei Complementar nº 123 ...
  // passa a vigorar").
  const daAlteradora = [];
  for (const lei of leisAlteradorasDaCauda(cauda, diploma, ctx.fontes)) {
    const copia = copiaDoPacote(ctx.cache, lei, ctx.lerTexto);
    if (!copia) continue;
    for (const o of ocorrenciasNaCopia(copia, artigo, sufixo, partes, diploma, 'alteradora').ocorrencias) if (!o.revogado) daAlteradora.push({ ...o, lei });
  }
  const tentativas = [];
  for (const fonte of proprias) {
    const copia = copiaDoPacote(ctx.cache, fonte, ctx.lerTexto);
    if (!copia) { tentativas.push({ fonte, ocorrencias: [], motivo: 'cópia ilegível' }); continue; }
    tentativas.push({ fonte, ...ocorrenciasNaCopia(copia, artigo, sufixo, partes, diploma, 'propria') });
  }
  const comAchado = tentativas.filter((t) => t.ocorrencias.length);
  if (comAchado.length) {
    const principal = comAchado[0];
    const vigentes = principal.ocorrencias.filter((o) => !o.revogado);
    const distintas = vigentes.filter((o, i) => !vigentes.slice(0, i).some((p) => mesmoTexto(p.trecho, o.trecho)));
    if (distintas.length > 1) {
      return { estado: 'ambiguo', fonte: principal.fonte, motivo: `o ${rotuloDoAlvo(artigo, sufixo, partes)} aparece ${distintas.length} vezes na cópia, com textos diferentes`, avisos, candidatos: distintas.map((o) => ({ url: principal.fonte.url, trecho: pvCortar(o.trecho, 600) })) };
    }
    const escolhida = distintas[0] || principal.ocorrencias[0];
    if (principal !== tentativas[0] && tentativas[0].fonte.diploma.compilada) {
      avisos.push({ tipo: 'fora-da-compilada', texto: `a cópia compilada (${tentativas[0].fonte.url}) não traz o dispositivo (${tentativas[0].motivo}); o trecho é de ${principal.fonte.url}, que pode ter redação antiga` });
    }
    for (const outra of comAchado.slice(1)) {
      const dela = outra.ocorrencias.find((o) => !o.revogado);
      if (dela && !mesmoTexto(dela.trecho, escolhida.trecho)) avisos.push({ tipo: 'copias-divergem', texto: `a cópia ${outra.fonte.url} traz outro texto para o dispositivo: "${pvCortar(dela.trecho, 240)}"` });
    }
    // A citação diz "na redação da lei X", e a lei X traz outro texto: duas redações, quem decide é o
    // verificador. Medido no run de 09/10/2026: a compilada da LC 123 ainda trazia o § 2º do art. 23 do
    // ICMS, e a minuta citava a redação da LC 227 (ICMS, IBS e CBS).
    const outraRedacao = daAlteradora.find((o) => o.confirmado && !mesmoTexto(o.trecho, escolhida.trecho)) || daAlteradora.find((o) => !mesmoTexto(o.trecho, escolhida.trecho));
    if (outraRedacao) {
      return {
        estado: 'ambiguo',
        fonte: principal.fonte,
        motivo: `duas redações: a da cópia do diploma e a que a citação atribui a ${outraRedacao.lei.url}${outraRedacao.confirmado ? '' : ' (bloco entre aspas que o código não confirmou ser deste diploma)'}`,
        avisos,
        candidatos: [{ url: principal.fonte.url, trecho: pvCortar(escolhida.trecho, 900) }, { url: outraRedacao.lei.url, trecho: pvCortar(outraRedacao.trecho, 900), lei_alteradora: true, confirmado: outraRedacao.confirmado }],
      };
    }
    return { estado: escolhida.revogado ? 'achado-revogado' : 'achado', fonte: principal.fonte, trecho: escolhida.trecho, artigo: escolhida.artigo, motivo: escolhida.revogado ? MOTIVO_DA_REVOGACAO[escolhida.revogado] : null, avisos: [...avisos, ...escolhida.avisos] };
  }
  // Não está na cópia do diploma (ou ela não foi baixada): a redação da lei que a citação nomeia.
  const confirmadas = daAlteradora.filter((o) => o.confirmado);
  if (daAlteradora.length) {
    const unica = confirmadas.length === 1 ? confirmadas[0] : null;
    if (unica && !proprias.length) {
      return { estado: 'achado', fonte: unica.lei, trecho: unica.trecho, artigo: unica.artigo, avisos: [...avisos, ...unica.avisos, { tipo: 'lei-alteradora', texto: `recortado do texto de ${unica.lei.url}, que deu a redação (o artigo que a traz nomeia o diploma citado); a compilada não foi baixada neste run: confira se não houve alteração posterior` }] };
    }
    const lista = unica ? [unica] : daAlteradora.slice(0, 3);
    return {
      estado: proprias.length ? 'fonte-sem-dispositivo' : 'ambiguo',
      fonte: proprias[0] || lista[0].lei,
      motivo: proprias.length ? tentativas[0].motivo : `o dispositivo só aparece entre aspas em ${lista[0].lei.url}, e o código não confirmou que o bloco é do diploma citado`,
      avisos: [...avisos, { tipo: 'lei-alteradora', texto: unica ? `${unica.lei.url}, que a citação nomeia como fonte da redação, traz o dispositivo num bloco do diploma citado (trecho em \`candidatos\`); a cópia do diploma não o traz` : `${lista[0].lei.url}, que a citação nomeia como fonte da redação, traz ${daAlteradora.length} bloco(s) entre aspas com o dispositivo, sem que o código confirme de qual diploma (trechos em \`candidatos\`)` }],
      candidatos: lista.map((o) => ({ url: o.lei.url, trecho: pvCortar(o.trecho, 900), lei_alteradora: true, confirmado: o.confirmado })),
    };
  }
  if (!proprias.length) return { estado: 'sem-fonte', motivo: 'nenhuma cópia oficial do diploma neste run (fontes/INDEX.jsonl)', avisos };
  const t0 = tentativas[0];
  const copia0 = copiaDoPacote(ctx.cache, t0.fonte, ctx.lerTexto);
  const art0 = copia0 && copia0.aberturas.find((a) => a.numero === artigo && a.sufixo === (sufixo || '') && !a.citado && !a.riscado);
  return { estado: 'fonte-sem-dispositivo', fonte: t0.fonte, motivo: t0.motivo, avisos, ...(art0 ? { trecho_do_artigo: pvCortar(copia0.texto.slice(art0.ini, art0.fim), 600) } : {}) };
}

/**
 * O artigo inteiro da mesma cópia de onde saiu o trecho (caput, incisos, alíneas e parágrafos), para o
 * verificador conferir a PRECISÃO do dispositivo sem busca: se o conteúdo que a frase atribui ao
 * dispositivo citado está nele ou em outro do mesmo artigo, e se uma lista de requisitos foi copiada
 * inteira. Medido em 10/10/2026 (minuta tributária): com só o recorte, o verificador deixou passar o
 * "art. 348, III, c" citado para uma dispensa que está no § 1º do mesmo artigo e o "art. 26" citado
 * para o que diz o § 1º; o verificador antigo, que lia a cópia inteira, achou os dois.
 *
 * `alvos`: os intervalos [ini, fim) dos dispositivos recortados. Até `PACOTE_LIMITE_DO_ARTIGO`, vai o
 * artigo todo; acima, o caput e, de cada dispositivo citado, o parágrafo onde ele está e o parágrafo
 * vivo vizinho de cada lado (o que ficou de fora vira "[…]"). Devolve `{ texto, total, cortado }`.
 */
function artigoInteiroDoPacote(copia, art, alvos) {
  const { texto } = copia;
  const limpo = (a, b) => pvEspacos(trechoLimpo(texto.slice(a, b)));
  const inteiro = limpo(art.ini, art.fim);
  if (inteiro.length <= PACOTE_LIMITE_DO_ARTIGO) return { texto: inteiro, total: inteiro.length, cortado: false };
  const pars = paragrafosDoArtigo(texto, art);
  const fimDoCaput = pars.length ? pars[0].ini : art.fim;
  // Parágrafo vivo: rótulo fora de risco e texto que não é só risco e nota (o "§ 1º" da redação antiga,
  // riscado, não conta como vizinho).
  const vivo = (p) => !dentroDe(copia.riscos, p.ini) && pvLetras(texto.slice(p.fimRotulo, p.fim).replace(/⟦riscado:[^⟧]*⟧/g, ' ').replace(RE_NOTAS_EDITORIAIS, ' ')) >= 4;
  // As peças: -1 é o caput; k é o parágrafo k. As que têm dispositivo citado guardam o alvo.
  const entra = new Map([[-1, []]]);
  const marcar = (j, alvo) => { if (!entra.has(j)) entra.set(j, []); if (alvo) entra.get(j).push(alvo); };
  for (const alvo of alvos) {
    const k = pars.findIndex((p) => alvo[0] >= p.ini && alvo[0] < p.fim);
    if (k < 0) {
      marcar(-1, alvo);
      const proximo = pars.findIndex(vivo);
      if (proximo >= 0) for (let j = 0; j <= proximo; j += 1) marcar(j);
      continue;
    }
    marcar(k, alvo);
    let antes = k - 1;
    while (antes >= 0 && !vivo(pars[antes])) antes -= 1;
    let depois = k + 1;
    while (depois < pars.length && !vivo(pars[depois])) depois += 1;
    for (let j = Math.max(0, antes); j <= Math.min(pars.length - 1, depois); j += 1) marcar(j);
  }
  const ordem = [...entra.keys()].sort((a, b) => a - b);
  const pecas = ordem.map((j) => {
    const [a, b] = j === -1 ? [art.ini, fimDoCaput] : [pars[j].ini, pars[j].fim];
    return { j, a, b, alvos: entra.get(j), texto: limpo(a, b) };
  });
  // Peça grande demais: a que não tem dispositivo citado vai pelo começo; a que tem, pelo começo (o
  // rótulo e a cabeça) e pela janela em volta do dispositivo.
  const soma = pecas.reduce((n, p) => n + p.texto.length, 0);
  if (soma > PACOTE_LIMITE_DO_ARTIGO) {
    const semAlvo = pecas.filter((p) => !p.alvos.length);
    const comAlvo = pecas.filter((p) => p.alvos.length);
    const tetoSemAlvo = 1000;
    const usadoSemAlvo = semAlvo.reduce((n, p) => n + Math.min(p.texto.length, tetoSemAlvo), 0);
    const tetoComAlvo = Math.max(1500, Math.floor((PACOTE_LIMITE_DO_ARTIGO - usadoSemAlvo) / Math.max(1, comAlvo.length)));
    for (const p of pecas) {
      const teto = p.alvos.length ? tetoComAlvo : tetoSemAlvo;
      if (p.texto.length <= teto) continue;
      if (!p.alvos.length) { p.texto = `${pvCortar(p.texto, teto)} […]`; continue; }
      const cabeca = limpo(p.a, Math.min(p.b, p.a + 400));
      // A janela usa o teto: o que sobra da cabeça e do dispositivo, metade antes e metade depois; o
      // lado que bate na borda da peça cede a sobra ao outro.
      const [ai, af] = [Math.min(...p.alvos.map((x) => x[0])), Math.max(...p.alvos.map((x) => x[1]))];
      const folga = Math.max(0, teto - cabeca.length - (af - ai) - 20);
      let ini = Math.max(p.a, ai - Math.floor(folga / 2));
      const fim = Math.min(p.b, af + (folga - (ai - ini)));
      ini = Math.max(p.a, ai - (folga - (fim - af)));
      const janela = limpo(ini, fim);
      p.texto = ini <= p.a + 400 ? pvCortar(limpo(p.a, fim), teto) : `${cabeca} […] ${pvCortar(janela, Math.max(400, teto - cabeca.length))}`;
      if (fim < p.b) p.texto += ' […]';
    }
  }
  let saida = '';
  let anterior = -2;
  for (const p of pecas) {
    saida += saida ? (p.j === anterior + 1 ? ' ' : ' […] ') : '';
    saida += p.texto;
    anterior = p.j;
  }
  if (anterior < pars.length - 1) saida += ' […]';
  return { texto: pvCortar(saida, PACOTE_LIMITE_DO_ARTIGO), total: inteiro.length, cortado: true };
}

/** A epígrafe do diploma: "LEI COMPLEMENTAR Nº 227, DE ...", e o começo da ementa. */
function epigrafeDaCopia(texto) {
  const m = texto.match(/(?:LEI\s+COMPLEMENTAR|LEI|DECRETO-LEI|DECRETO|EMENDA\s+CONSTITUCIONAL|MEDIDA\s+PROVIS[ÓO]RIA)\s+N[º°o]\s*[\d.]+/);
  return m ? texto.slice(m.index, m.index + 420) : texto.slice(0, 420);
}

// ── A frase da minuta ──────────────────────────────────────────────────────────────────────────

/**
 * Onde a citação está na linha. O extrator dá a linha, não a coluna; com a mesma citação duas vezes
 * na linha, vale a ocorrência que não é o começo de uma citação mais longa da mesma linha (medido no
 * run de 09/10/2026: "(LC 123, art. 30, § 1º, I) ... | LC 123, art. 30 |" lia o § 1º na segunda).
 */
function posicaoNaLinha(linha, c, todas) {
  const bruto = String(c.bruto || '');
  const ocorrencias = [];
  for (let i = linha.indexOf(bruto); bruto && i >= 0; i = linha.indexOf(bruto, i + 1)) ocorrencias.push(i);
  if (!ocorrencias.length) return -1;
  const maiores = todas.filter((o) => o.linha === c.linha && String(o.bruto || '').length > bruto.length && String(o.bruto).startsWith(bruto));
  return ocorrencias.find((p) => !maiores.some((o) => linha.startsWith(o.bruto, p))) ?? ocorrencias[0];
}

/** A frase da minuta que usa a citação: a oração da linha (ou a linha da tabela), cortada. */
function fraseDaCitacao(linha, c, pos) {
  if (/^\s*\|/.test(linha)) return pvCortar(linha.replace(/^\s*\||\|\s*$/g, '').split('|').map((x) => x.trim()).filter(Boolean).join(' | '), PACOTE_LIMITE_DA_FRASE);
  const i = Math.max(0, pos);
  // Fim de frase: ponto, interrogação ou exclamação seguidos de espaço e maiúscula (não "art. 5", "nº 9.430").
  const fins = [...linha.matchAll(/[.!?](?=\s+[A-ZÀ-Ú"“(])/g)].map((m) => m.index);
  const ini = Math.max(0, ...fins.filter((f) => f < i).map((f) => f + 1));
  const fim = Math.min(linha.length, ...fins.filter((f) => f >= i + String(c.bruto || '').length - 1).map((f) => f + 1));
  return pvCortar(linha.slice(ini, fim), PACOTE_LIMITE_DA_FRASE);
}

// ── Precedentes pelo acervo local ──────────────────────────────────────────────────────────────

const lerOuNull = (caminho) => { try { return readFileSync(caminho, 'utf-8'); } catch { return null; } };
const listaOuVazia = (pasta) => { try { return readdirSync(pasta); } catch { return []; } };

/** As pastas de súmulas do acervo do projeto e dos pacotes ligados. */
function pastasDeSumulas(raiz) {
  if (!raiz) return [];
  const bases = [join(raiz, 'acervo')];
  const packs = join(raiz, 'acervo', '_packs');
  for (const p of listaOuVazia(packs)) bases.push(join(packs, p));
  return bases.map((b) => join(b, 'sumulas')).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** A súmula no acervo: `{ arquivo, situacao, trecho }`, ou null. Tema, OJ e acórdão não se montam aqui. */
function sumulaNoAcervo(c, raiz) {
  if (c.classe !== 'sumula' || !c.numero) return null;
  const vinculante = /\bsv\b/.test(String(c.chave || '')) || /vinculante/i.test(String(c.bruto || ''));
  const orgao = String(c.orgao || '').toUpperCase() || (vinculante ? 'STF' : '');
  const achados = [];
  for (const pasta of pastasDeSumulas(raiz)) {
    for (const sub of listaOuVazia(pasta)) {
      const eVinc = /VINCULANTE/i.test(sub);
      if (eVinc !== vinculante) continue;
      if (orgao && sub.toUpperCase().replace(/-VINCULANTE$/, '') !== orgao) continue;
      const nome = vinculante ? `${sub.toLowerCase().replace(/-vinculante$/, '')}-sv-${pvNumero(c.numero)}.md` : `${sub.toLowerCase()}-sumula-${pvNumero(c.numero)}.md`;
      const arquivo = join(pasta, sub, nome);
      if (existsSync(arquivo)) achados.push(arquivo);
    }
  }
  if (!achados.length) return null;
  const arquivo = achados[0];
  const texto = lerOuNull(arquivo);
  if (texto === null) return null;
  const { situacao } = situacaoDoTexto(texto);
  const enunciado = (texto.match(/##\s*Enunciado\s*\n+([\s\S]*?)(?:\n##\s|$)/) || [])[1] || texto.replace(/^---[\s\S]*?---/, '');
  return { arquivo, situacao: situacao || 'vigente', trecho: pvCortar(enunciado.replace(/^>\s?/gm, ''), 900), ...(achados.length > 1 ? { outras: achados.slice(1) } : {}) };
}

/** O texto local de legislação (pacote acervo.legislacao): acha, não fecha. */
function legislacaoLocal(raiz, diploma, artigo, sufixo) {
  if (!raiz || !diploma || !artigo) return null;
  const sigla = diploma.tipo === 'cf' ? (diploma.adct ? null : 'CF') : Object.entries(PACOTE_LEI_DO_CODIGO).find(([, [t, n]]) => t === diploma.tipo && n === diploma.numero)?.[0]?.toUpperCase()
    || ({ lei: 'L', lc: 'LC', decreto: 'D', del: 'DL', ec: 'EC' }[diploma.tipo || 'lei'] || 'L') + diploma.numero;
  if (!sigla) return null;
  const nome = `${sigla.toLowerCase()}-art-${artigo}${sufixo ? `-${sufixo}` : ''}.md`;
  const bases = [join(raiz, 'acervo', 'legislacao')];
  for (const p of listaOuVazia(join(raiz, 'acervo', '_packs'))) bases.push(join(raiz, 'acervo', '_packs', p, 'legislacao'));
  for (const b of bases) {
    const arquivo = join(b, sigla, nome);
    if (!existsSync(arquivo)) continue;
    const texto = lerOuNull(arquivo);
    if (texto === null) continue;
    const fonteUrl = (texto.match(/^fonte_url:\s*"?([^"\n]+)"?/m) || [])[1] || null;
    return { arquivo, fonte_url: fonteUrl, coletado_ate: coletadoAteDoTexto(texto), trecho: pvCortar(texto.replace(/^---[\s\S]*?---\s*/, '').replace(/^#.*$/m, ''), 900) };
  }
  return null;
}

// ── O pacote ───────────────────────────────────────────────────────────────────────────────────

/** As fontes `ok` do `fontes/INDEX.jsonl` do run, uma por URL, com o arquivo de texto achado. */
function fontesDoIndice(linhasDoIndice, dirFontes) {
  const porUrl = new Map();
  for (const linha of String(linhasDoIndice || '').split('\n')) {
    let e;
    try { e = JSON.parse(linha); } catch { continue; }
    if (!e || e.status !== 'ok' || typeof e.url !== 'string') continue;
    const candidatos = [e.texto, e.texto && dirFontes ? join(dirFontes, basename(e.texto)) : null].filter(Boolean);
    const arquivo = candidatos.find((p) => existsSync(p));
    if (!arquivo) continue;
    for (const url of new Set([e.url, e.url_final].filter(Boolean))) {
      if (porUrl.has(url)) continue;
      porUrl.set(url, { url, arquivo, sha256_texto: e.sha256_texto || null, sha256_bytes: e.sha256_bytes || null, consulted_at: e.baixado_em || null, diploma: diplomaDaUrlDoPacote(url) });
    }
  }
  return [...porUrl.values()];
}

/**
 * Monta o pacote. `citacoes`: as pendentes do cartório (formato do extrator do hook); `todas`: todas as
 * citações da peça, cobertas ou não (para achar na linha a ocorrência certa de cada uma); `peca`: o texto
 * da minuta; `fontes`: `fontesDoIndice(...)`; `raiz`: a raiz do projeto (acervo); `ritmo`: o do run,
 * para o orçamento de buscas; `inicioDoRun`: ISO, para avisar cópia baixada antes do run.
 */
function pacoteDoVerificador({ citacoes, todas = null, peca, fontes = [], raiz = null, ritmo = null, inicioDoRun = null, lerTexto = (p) => readFileSync(p, 'utf-8') }) {
  if (!todas) todas = citacoes || [];
  const linhas = String(peca || '').split('\n');
  const ctx = { fontes, cache: new Map(), lerTexto };
  const itens = [];
  const vistas = new Set();
  for (const c of citacoes || []) {
    const chave = c.chave || `${c.bruto}|${c.linha}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const linha = String(linhas[(c.linha || 1) - 1] || '');
    const pos = posicaoNaLinha(linha, c, todas);
    const frase = fraseDaCitacao(linha, c, pos);
    // O que vem logo depois da citação: o "§ 1º-A", o "§§ 9º a 11" e a lei da redação, que o extrator não lê.
    const cauda = pos >= 0 ? linha.slice(pos + String(c.bruto).length, pos + String(c.bruto).length + 90) : '';
    const item = { citacao: c.bruto, linha: c.linha, chave, classe: c.classe, frase, estado: null, fonte: null, trecho: null, avisos: [] };
    if (c.classe !== 'lei') {
      const sumula = sumulaNoAcervo(c, raiz);
      item.estado = 'precedente';
      if (sumula) {
        item.acervo = sumula;
        item.trecho = sumula.trecho;
        if (SITUACOES_QUE_IMPEDEM.has(sumula.situacao)) item.avisos.push({ tipo: 'situacao', texto: `${mensagemDaSituacao(sumula.situacao)} (${sumula.arquivo})` });
        else if (sumula.situacao !== 'vigente') item.avisos.push({ tipo: 'situacao', texto: mensagemDaSituacao(sumula.situacao) });
      } else item.motivo = c.classe === 'sumula' ? 'a súmula não está no acervo local: busca do verificador' : 'Tema, OJ, PN ou acórdão: o código não monta; busca do verificador na fonte oficial';
      itens.push(item);
      continue;
    }
    if (c.sem_diploma) {
      item.estado = 'ambiguo';
      item.motivo = 'remissão sem diploma no contexto: o redator nomeia o diploma no texto';
      itens.push(item);
      continue;
    }
    const diploma = diplomaDaCitacaoDoPacote(c, frase);
    item.diploma = diploma ? diploma.rotulo : null;
    if (c.diploma_de) item.avisos.push({ tipo: 'diploma-herdado', texto: `a citação não nomeia o diploma; o extrator o herdou de "${c.diploma_de}": confira se a remissão é mesmo a ele` });
    if (!diploma || diploma.tipo === 'infralegal') {
      item.estado = 'sem-fonte';
      item.motivo = diploma ? 'ato infralegal: o código não casa a URL de onde ele é publicado; busca do verificador' : 'o código não leu o diploma da citação';
      itens.push(item);
      continue;
    }
    if (!c.artigo) {
      const fonte = fontesDoDiploma(fontes, diploma)[0];
      if (fonte) {
        const copia = copiaDoPacote(ctx.cache, fonte, lerTexto);
        item.estado = 'achado';
        item.fonte = fonte;
        item.trecho = copia ? pvCortar(epigrafeDaCopia(copia.texto), 420) : null;
        item.avisos.push({ tipo: 'diploma-inteiro', texto: 'a citação nomeia o diploma inteiro: o trecho é a epígrafe; confira o que a frase atribui a ele' });
      } else {
        item.estado = 'sem-fonte';
        item.motivo = 'nenhuma cópia oficial do diploma neste run (fontes/INDEX.jsonl)';
      }
      itens.push(item);
      continue;
    }
    // Os alvos: o dispositivo do hook, com o que o pacote lê a mais na própria citação.
    const base = partesDoDispositivo(c.dispositivo);
    const doTrecho = paragrafosDoTrecho(`${c.bruto}${cauda}`);
    let alvos = [base];
    if (doTrecho.paragrafos.length) {
      if (!c.dispositivo) {
        alvos = doTrecho.paragrafos.map((p) => ({ ...base, caput: false, paragrafo: p }));
        item.avisos.push({ tipo: doTrecho.intervalo ? 'intervalo' : 'paragrafos-lidos-pelo-pacote', texto: doTrecho.intervalo ? `a frase cita os parágrafos em intervalo (${doTrecho.paragrafos[0].n} a ${doTrecho.paragrafos[doTrecho.paragrafos.length - 1].n}): cada um vai recortado; confira se todos sustentam a frase` : `o extrator leu só o artigo; o pacote leu na citação ${doTrecho.paragrafos.map((p) => `§ ${p.n}${p.letra ? `-${p.letra.toUpperCase()}` : ''}`).join(' e ')}` });
      } else if (base.paragrafo && base.paragrafo.n !== 'u') {
        const comLetra = doTrecho.paragrafos.find((p) => p.n === base.paragrafo.n && p.letra);
        if (comLetra) {
          alvos = [{ ...base, paragrafo: comLetra }];
          item.avisos.push({ tipo: 'paragrafo-com-letra', texto: `o extrator leu § ${base.paragrafo.n}; a citação diz § ${comLetra.n}-${comLetra.letra.toUpperCase()}, e é esse que vai recortado` });
        }
      }
    }
    const resultados = alvos.map((partes) => ({ rotulo: rotuloDoAlvo(c.artigo, c.sufixo, partes), ...alvoNasFontes(ctx, diploma, pvNumero(c.artigo), (c.sufixo || '').toLowerCase(), partes, cauda) }));
    const ordem = ['achado-revogado', 'sem-fonte', 'fonte-sem-dispositivo', 'ambiguo', 'achado'];
    const pior = resultados.map((r) => r.estado).sort((a, b) => ordem.indexOf(a) - ordem.indexOf(b))[0];
    item.estado = pior;
    item.dispositivo = resultados.map((r) => r.rotulo).join('; ');
    item.fonte = (resultados.find((r) => r.fonte) || {}).fonte || null;
    const comTrecho = resultados.filter((r) => r.trecho);
    const trechoBruto = comTrecho.map((r) => (resultados.length > 1 ? `[${r.rotulo}] ` : '') + pvEspacos(r.trecho)).join(' … ');
    if (trechoBruto) {
      item.trecho = pvCortar(trechoBruto, PACOTE_LIMITE_DO_TRECHO);
      if (trechoBruto.length > PACOTE_LIMITE_DO_TRECHO) item.avisos.push({ tipo: 'trecho-cortado', texto: `o dispositivo tem ${trechoBruto.length} caracteres e o trecho vai até ${PACOTE_LIMITE_DO_TRECHO}: o resto está no \`artigo_inteiro\` (se ele também vier cortado, na cópia)` });
    }
    // O artigo inteiro da mesma cópia, para a precisão do dispositivo (conteúdo que está em outro
    // parágrafo, inciso ou alínea; item omitido de uma lista).
    if (item.estado === 'achado' || item.estado === 'achado-revogado') {
      const comArtigo = resultados.filter((r) => r.artigo);
      if (comArtigo.length) {
        const { copia, art } = comArtigo[0].artigo;
        const alvosDoArtigo = comArtigo.filter((r) => r.artigo.copia === copia && r.artigo.art.ini === art.ini).map((r) => r.artigo.alvo);
        const inteiro = artigoInteiroDoPacote(copia, art, alvosDoArtigo);
        item.artigo_inteiro = inteiro.texto;
        if (inteiro.cortado) item.avisos.push({ tipo: 'artigo-cortado', texto: `o artigo tem ${inteiro.total} caracteres e passa de ${PACOTE_LIMITE_DO_ARTIGO}: em \`artigo_inteiro\` vão o caput e o parágrafo vizinho de cada lado do dispositivo citado ("[…]" marca o que ficou de fora); se a frase depende do resto, abra a cópia` });
      }
    }
    const motivos = resultados.filter((r) => r.motivo).map((r) => (resultados.length > 1 ? `${r.rotulo}: ${r.motivo}` : r.motivo));
    if (motivos.length) item.motivo = motivos.join('; ');
    if (resultados.length > 1) item.alvos = resultados.map((r) => ({ rotulo: r.rotulo, estado: r.estado, ...(r.motivo ? { motivo: r.motivo } : {}) }));
    for (const r of resultados) for (const a of r.avisos || []) if (!item.avisos.some((x) => x.texto === a.texto)) item.avisos.push(a);
    const candidatos = resultados.flatMap((r) => r.candidatos || []);
    if (candidatos.length) item.candidatos = candidatos;
    const doArtigo = resultados.find((r) => r.trecho_do_artigo);
    if (doArtigo) item.trecho_do_artigo = doArtigo.trecho_do_artigo;
    if (item.estado === 'sem-fonte') {
      const local = legislacaoLocal(raiz, diploma, pvNumero(c.artigo), (c.sufixo || '').toLowerCase());
      if (local) {
        item.texto_local = local;
        item.avisos.push({ tipo: 'texto-local', texto: `há o texto local de legislação (coletado até ${local.coletado_ate || 'data não informada'}): ele acha o artigo e a URL oficial (${local.fonte_url || 'sem URL'}), não fecha a citação; a conferência é na fonte oficial` });
      }
    }
    if (item.fonte && inicioDoRun && item.fonte.consulted_at && Date.parse(item.fonte.consulted_at) < Date.parse(inicioDoRun)) {
      item.avisos.push({ tipo: 'copia-anterior-ao-run', texto: `a cópia foi baixada em ${item.fonte.consulted_at}, antes do início do run (${inicioDoRun}): o cartório não aceita essa data como leitura deste run; reabra a fonte` });
    }
    itens.push(item);
  }
  for (const it of itens) if (it.fonte) it.fonte = { url: it.fonte.url, arquivo: it.fonte.arquivo, sha256_texto: it.fonte.sha256_texto, consulted_at: it.fonte.consulted_at };
  const porEstado = Object.fromEntries(PACOTE_ESTADOS.map((e) => [e, itens.filter((i) => i.estado === e).length]));
  const orcamento = ritmo && PACOTE_ORCAMENTO_DE_BUSCAS[ritmo] ? PACOTE_ORCAMENTO_DE_BUSCAS[ritmo] : PACOTE_ORCAMENTO_DE_BUSCAS.equilibrado;
  return {
    versao: 1,
    total: itens.length,
    por_estado: porEstado,
    com_busca: itens.filter((i) => PACOTE_ESTADOS_COM_BUSCA.includes(i.estado)).length,
    orcamento_de_buscas: orcamento,
    ...(ritmo ? { ritmo } : {}),
    aviso: 'o código só tria e recorta: nenhum estado é veredito. achado não é verificada, e fonte-sem-dispositivo não é inexistente.',
    itens,
  };
}

/** O pacote em Markdown, para o despacho ao verificador. */
function pacoteEmMarkdown(pacote, { peca = null } = {}) {
  const linhas = [
    '# Pacote do verificador de citações',
    '',
    `${peca ? `Minuta: \`${peca}\`. ` : ''}${pacote.total} citação(ões) pendente(s): ${PACOTE_ESTADOS.filter((e) => pacote.por_estado[e]).map((e) => `${pacote.por_estado[e]} ${e}`).join(', ') || 'nenhuma'}.`,
    '',
    'O código só tria e recorta; nenhum estado é veredito. Para `achado` e `achado-revogado`, julgue a citação pelo trecho recortado (existência, vigência e fidelidade da frase), sem busca, e confira a precisão pelo artigo inteiro que vem depois dele: o conteúdo que a frase atribui ao dispositivo está nele ou em outro do mesmo artigo (outro parágrafo, inciso, alínea)? A lista ou os requisitos que a minuta enumera estão completos? Busca própria só para `fonte-sem-dispositivo`, `sem-fonte`, `ambiguo` e `precedente`, ' +
      `até ${pacote.orcamento_de_buscas} buscas no total${pacote.ritmo ? ` (ritmo ${pacote.ritmo})` : ''}. Leia os avisos: são o que o código viu e não julga. A tabela de retorno é a de sempre.`,
    '',
  ];
  pacote.itens.forEach((it, i) => {
    linhas.push(`## ${i + 1}. ${it.citacao}${it.dispositivo && it.dispositivo !== it.citacao ? ` (${it.dispositivo})` : ''} · ${it.estado}`, '');
    linhas.push(`- Linha ${it.linha} da minuta: "${it.frase}"`);
    if (it.fonte) linhas.push(`- Fonte: ${it.fonte.url} · sha256_texto ${it.fonte.sha256_texto || 'sem hash'} · consulted_at ${it.fonte.consulted_at || 'sem data'} · cópia \`${it.fonte.arquivo}\``);
    if (it.motivo) linhas.push(`- Por que este estado: ${it.motivo}`);
    if (it.alvos) linhas.push(`- Dispositivos: ${it.alvos.map((a) => `${a.rotulo} (${a.estado})`).join('; ')}`);
    for (const a of it.avisos) linhas.push(`- Aviso (${a.tipo}): ${a.texto}`);
    if (it.trecho) linhas.push('', `Trecho recortado do dispositivo citado: > ${it.trecho}`);
    if (it.artigo_inteiro && it.artigo_inteiro !== it.trecho) linhas.push('', `Artigo inteiro na mesma cópia (caput, incisos, alíneas e parágrafos; para conferir se o conteúdo está no dispositivo citado ou em outro do mesmo artigo, e se a lista da minuta está completa): > ${it.artigo_inteiro}`);
    if (it.trecho_do_artigo) linhas.push('', `Caput do artigo na cópia: > ${it.trecho_do_artigo}`);
    for (const k of it.candidatos || []) linhas.push('', `Candidato${k.lei_alteradora ? ' (lei alteradora)' : ''} em ${k.url}:${k.trecho ? ` > ${k.trecho}` : ''}`);
    if (it.acervo) linhas.push('', `Acervo: \`${it.acervo.arquivo}\` (situação: ${it.acervo.situacao})`);
    if (it.texto_local) linhas.push('', `Texto local: \`${it.texto_local.arquivo}\` > ${it.texto_local.trecho}`);
    linhas.push('');
  });
  return `${linhas.join('\n').trimEnd()}\n`;
}
// <<< pacote-verificador:end

export {
  PACOTE_ESTADOS,
  PACOTE_ESTADOS_COM_BUSCA,
  PACOTE_ORCAMENTO_DE_BUSCAS,
  PACOTE_LIMITE_DO_TRECHO,
  PACOTE_LIMITE_DO_ARTIGO,
  diplomaDaUrlDoPacote,
  diplomaDaCitacaoDoPacote,
  paragrafosDoTrecho,
  textoPreparado,
  aberturasDaCopia,
  fontesDoIndice,
  pacoteDoVerificador,
  pacoteEmMarkdown,
};
