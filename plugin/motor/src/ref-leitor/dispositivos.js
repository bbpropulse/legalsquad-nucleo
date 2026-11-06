// Corte do texto de uma norma em dispositivos: artigo, parágrafo, inciso e alínea, cada um com o
// próprio texto (sem os filhos) e o sha256 desse texto. Módulo puro.
//
// O texto de cada dispositivo é o trecho literal da base, só com a marcação de Markdown tirada
// (negrito, itálico, citação); o sha256 é calculado sobre esse texto, e é com ele que o motor
// confere o que o servidor entrega.
import { romanoParaNumero, sha256, textoCanonico } from './normalizar.js';
import { rotuloDeCaminho } from './citacao.js';

// Sufixo de letra só colado no número ("Art. 59-A", "Art. 1º-A"): "Art. 59 - O juiz" é o caput.
const RE_ART = /^art(?:igo)?\.?\s*(\d{1,2}(?:\.\d{3})+|\d+)\s*(?:[ºo°](?![a-zà-ú]))?(?:-([A-Za-z]{1,2})(?![a-zà-ú]))?\s*(?:\.(?=\s|$))?(?=[\s.\-–—:]|$)/i;
const RE_PAR = /^§\s*(\d+)\s*[ºo°]?\s*(?:-\s*([A-Za-z])(?![a-zà-ú]))?(?=[\s.\-–—:]|$)/;
const RE_PAR_UNICO = /^(?:par[aá]grafo\s+[uú]nico|§\s*[uú]nico)/i;
const RE_INC = /^([IVXLCDM]+)(?:\s*-\s*([A-Z])(?![a-z]))?(?:\s*[-–—.]\s*|\s+(?=[a-zà-ú(]))/;
const RE_ALI = /^([a-z])\)\s*/;
const RE_TITULO = /^(?:#|t[ií]tulo\s+[ivxlcdm]+\b|cap[ií]tulo\s+[ivxlcdm]+\b|se[cç][aã]o\s+[ivxlcdm]+\b|subse[cç][aã]o\s+[ivxlcdm]+\b|livro\s+[ivxlcdm]+\b|parte\s+(?:geral|especial)\b)/i;
const RE_FECHO = /^bras[ií]lia,?\s+\d{1,2}\s*[ºo°]?\s+de\s+[a-zç]+/i;
const RE_ANEXO = /^(?:#+\s*)?(?:anexo\b|regulamento\b|ato das disposi[cç][oõ]es constitucionais transit[oó]rias)/i;
const RE_ADCT = /ato das disposi[cç][oõ]es constitucionais transit[oó]rias/i;

/** Tira a marcação de Markdown que não é texto da norma. */
export function semMarcacao(linha) {
  return linha
    .replace(/^\s*>+\s?/, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[^\w])\*(?=\S)|(?<=\S)\*(?=[^\w]|$)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

/** Ordem de artigos: 121 < 121-A < 121-B < 122. */
function chaveOrdem(art) {
  const [n, suf] = art.split('-');
  return Number(n) * 1000 + (suf ? suf.toLowerCase().charCodeAt(0) - 96 + (suf.length > 1 ? suf.toLowerCase().charCodeAt(1) - 96 : 0) / 30 : 0);
}

// Nota de alteração: "(Redação dada pela Lei nº 13.964, de 2019)", e as formas da Legis: "(Artigo com
// redação dada pela Lei nº 7.209, de 11/7/1984)", "(Parágrafo acrescido pela Lei ...)", "(Revogado pela
// Lei nº 13.654, de 23/4/2018)". O ano vem por extenso, sozinho ou na data com barra ou ponto.
const RE_ALTERACAO = /\((?:[a-zà-ú]+(?:\s+[a-zà-ú]+)?\s+(?:com\s+)?)?(?:reda[cç][aã]o\s+dada|inclu[ií]d[oa]s?|acrescid[oa]s?|renumerad[oa]s?|revogad[oa]s?|vide)[^()]*?\b(lei(?:\s+complementar)?|decreto[- ]lei|decreto|medida\s+provis[oó]ria|emenda\s+constitucional|lc|ec)\s*(?:n[ºo°.]*\s*)?(\d{1,3}(?:\.\d{3})+|\d+(?:-\d+)?)(?:,?\s*de\s*(?:(?:\d{1,2}[ºo°]?\s*(?:de\s*)?[a-zç]+\s*de\s*)?(\d{4})|\d{1,2}\s*[./]\s*\d{1,2}\s*[./]\s*(\d{4})))?/gi;
// Nota de controle concentrado, nas formas da Legis e do Planalto: "(Vide ADI 6.298)", "(Vide ADIs
// nºs 6.298, 6.299 e 6.305 ...)", "(Vide ADIN 5436)", "(Vide ADIN nº 1.127-8)" (o "-8" é o dígito do
// número antigo do STF), "(Vide: ADIN 2.556-2 e ADIN 2.568-6)", "(Vide ADPF 1107)", "(Vide ADI-5)".
const RE_VIDE_NOTA = /\(\s*vide:?\s+([^()]*)\)/gi;
const NUM_ACAO = String.raw`(?:\d{1,2}(?:\.\d{3})+|\d+)(?:-\d(?!\d))?`;
const RE_VIDE_ACAO = new RegExp(String.raw`(?<![a-z])(adin|adi|adc|adpf|ado)s?\s*(?:-\s*)?(?:n[ºo°.s]*\s*)?(${NUM_ACAO}(?:\s*(?:,|e)\s*${NUM_ACAO})*)`, 'gi');

/** Situação do dispositivo pelo próprio texto: revogado, vetado ou vigente. */
export function situacaoDoTexto(texto) {
  const t = texto.replace(/\s+/g, ' ');
  // Só a parte depois do rótulo decide: "§ 1º (Revogado)" e "I - (revogado);" são revogação, mas
  // uma remissão no meio da frase ("revogada a Lei X") não é.
  const corpo = t.replace(/^(?:art\.?\s*[\d.]+\s*[ºo°]?(?:-[a-z]{1,2})?\.?|§\s*\d+\s*[ºo°]?(?:-[a-z])?\.?|par[aá]grafo [uú]nico\.?|[ivxlcdm]+(?:-[a-z])?\s*[-–—.]|[a-z]\))\s*/i, '');
  if (/^[\s\-–—.;:,]*\(?\s*(?:revogad[oa]s?|suprimid[oa])\b/i.test(corpo)) return 'revogado';
  if (/^[\s\-–—.;:,]*\(?\s*vetad[oa]s?\b/i.test(corpo) || /^\(vetado\)$/i.test(corpo.trim())) return 'vetado';
  return 'vigente';
}

// Regimento (modo `regimento`): o texto vem de PDF do tribunal e traz o que lei federal não traz.
// Espaço de largura zero no lugar do espaço (TRT12: "Art.", zero, espaço, zero, "2º"; e "Parágrafo", dois zeros, "único"); a nota de
// localização do STF numa linha própria ("**Art. 5º**, III", "**Art. 21**, caput") e o rodapé da
// página ("— 23 — Sumário"), que não são texto; a redação antiga logo antes da nova, com o mesmo
// rótulo (o PDF mostra a antiga riscada): vale a última.
const RE_LARGURA_ZERO_PAR = /[\u200B-\u200D\u2060\uFEFF][ \t]*[\u200B-\u200D\u2060\uFEFF]/g;
const RE_LARGURA_ZERO = /[\u200B-\u200D\u2060\uFEFF]/g;
const RE_NOTA_LOCAL = /^art(?:igo)?\.?\s*[\d.]+\s*[ºo°]?(?:\s*-\s*[a-z]{1,2})?\s*,\s*(?:caput|§\s*\d+\s*[ºo°]?(?:-[a-z])?|par[aá]grafo\s+[uú]nico|[ivxlcdm]+(?:-[a-z])?(?:\s*,\s*[a-z])?)\s*$/i;
const RE_RODAPE = /^(?:[—–-]\s*\d{1,4}\s*[—–-]\s*sum[aá]rio|\d{1,4}|p[aá]gina\s+\d{1,4}(?:\s+de\s+\d{1,4})?)$/i;
const JANELA_REGIMENTO = 10;
// Apêndice com a legislação citada (TRF1): artigos de outras leis, transcritos; o corte para ali.
const RE_LEGISLACAO_CITADA = /^(?:[íi]ndice\s+da\s+)?legisla[cç][aã]o\s+(?:citada|referida)$/i;
// "§ 2º - O Presidente": o "- O" é o começo do texto, não sufixo (o sufixo vem colado: "§ 1º-A").
const RE_PAR_REGIMENTO = /^§\s*(\d+)\s*\.?\s*[ºo°]?(?:-([A-Za-z])(?![a-zà-ú]))?(?=[\s.\-–—:]|$)/;
const RE_INC_MIN = /^([ivxlcdm]+)(?:-([a-z])(?![a-z]))?\s*[-–—]\s*/;

function semLarguraZero(linha) {
  return linha.replace(RE_LARGURA_ZERO_PAR, ' ').replace(RE_LARGURA_ZERO, '');
}

/**
 * Corta o corpo (sem frontmatter) em dispositivos.
 * Devolve `{ dispositivos, conflitos, ignorados }`:
 * - `conflitos`: rótulos repetidos (mantém o primeiro; o repetido é tratado como texto citado);
 * - `ignorados`: artigos fora de ordem que viraram continuação (texto de outra lei citado).
 *
 * Com `regimento: true`, o rótulo repetido logo em seguida no mesmo artigo é redação nova e
 * substitui a anterior (`substituidos`), e as marcas de PDF de tribunal (acima) saem do texto.
 */
export function cortarDispositivos(corpo, { docId, cf = false, pararNoFecho = !cf, regimento = false } = {}) {
  let linhas = String(corpo).replace(/\r\n?/g, '\n').split('\n');
  if (regimento) linhas = linhas.map(semLarguraZero);
  let dispositivos = [];
  const vistos = new Set();
  let conflitos = 0;
  let ignorados = 0;
  let desfeitos = 0;
  let substituidos = 0;
  let foraDeOrdem = 0;
  let prefixo = '';
  let anexos = 0;
  // Histórico dos artigos abertos: { ordem, inicio (índice do dispositivo), prefixo }.
  const artigos = [];
  let atual = null; // dispositivo recebendo texto
  let ctx = { art: null, par: null, inc: null };
  let emCitacao = false;
  let tituloDesdeUltimoArt = false;

  // Regimento: tira o dispositivo (e os filhos dele) para a redação nova entrar no lugar.
  const tirar = (caminho) => {
    const fica = [];
    for (const d of dispositivos) {
      if (d.caminho === caminho || d.caminho.startsWith(`${caminho}/`)) vistos.delete(d.caminho);
      else fica.push(d);
    }
    dispositivos = fica;
    substituidos++;
  };

  const abrir = (caminho, linha) => {
    if (vistos.has(caminho) && regimento && ctx.art && caminho.startsWith(`${prefixo}art-${ctx.art}/`)) tirar(caminho);
    if (vistos.has(caminho)) {
      // Rótulo repetido: o segundo vira texto do dispositivo aberto (quase sempre é transcrição).
      conflitos++;
      if (atual) atual.linhas.push(linha);
      return false;
    }
    vistos.add(caminho);
    atual = { id: `${docId}#${caminho}`, caminho, ordem: 0, linhas: [linha] };
    dispositivos.push(atual);
    return true;
  };

  /**
   * Desfaz um salto espúrio: quando a lei transcreve um artigo de outra sem aspas ("Art. 643.")
   * e depois volta à própria numeração ("Art. 2º"), o artigo transcrito e o que veio depois dele
   * são texto do artigo anterior ao salto.
   */
  const desfazerSalto = (salto) => {
    const removidos = dispositivos.splice(salto.inicio);
    const destino = dispositivos[dispositivos.length - 1];
    for (const r of removidos) {
      vistos.delete(r.caminho);
      if (destino) destino.linhas.push(...r.linhas);
    }
    artigos.length = artigos.indexOf(salto);
    atual = destino || null;
    desfeitos++;
  };

  // Rubricas (títulos marginais: "Pena de multa", "Emoção e paixão") ficam numa linha própria,
  // logo antes do artigo. Não são texto do dispositivo anterior: são puladas.
  const limpas = linhas.map((l) => {
    let t = semMarcacao(l);
    if (!regimento) return t;
    if (RE_NOTA_LOCAL.test(t) || RE_RODAPE.test(t)) return '';
    // Sufixo com travessão ("Art. 174–A.", TRT10) ou separado ("Art. 164 – A – A distribuição", TJES).
    return t
      .replace(/^([Aa]rt(?:igo)?\.?\s*[\d.]+\s*[ºo°]?)\s*[-–—]\s*([A-Z])\s*[-–—]\s+(?=[A-ZÀ-Ú])/, '$1-$2 - ')
      .replace(/^(art(?:igo)?\.?\s*[\d.]+\s*[ºo°]?)[–—]([A-Z])(?![A-Za-zà-ú])/i, '$1-$2');
  });
  const rubrica = new Set();
  for (let i = 0; i < limpas.length; i++) {
    const l = limpas[i];
    if (!l || l.length > 140) continue;
    let j = i + 1;
    while (j < limpas.length && !limpas[j]) j++;
    if (j >= limpas.length || !RE_ART.test(limpas[j])) continue;
    const semNota = l.replace(/\((?:[^()]|\([^()]*\))*\)/g, '').trim();
    if (semNota && semNota.length <= 100 && /^[A-ZÀ-Ú]/.test(semNota) && !/[.;:,]$/.test(semNota) &&
        !RE_ART.test(semNota) && !RE_PAR.test(semNota) && !RE_PAR_UNICO.test(semNota) && !RE_INC.test(semNota) && !/^[“"]/.test(semNota)) {
      rubrica.add(i);
    }
  }

  // Início no art. 1º de verdade: regimento e compilação costumam abrir com índice, sumário ou lista
  // de emendas que cita artigos no começo da linha ("Art. 174 ...", "**Art. 1º**" seguido de
  // "**Art. 26**"). O corte começa no primeiro "Art. 1º" seguido de "Art. 2º" (ou "Art. 1º-A"); o
  // que vem antes não é dispositivo. Sem esse par, começa no primeiro "Art. 1º" depois de um artigo
  // de outro número; sem nenhum, do começo.
  let inicio = 0;
  const arts = [];
  // Linha de sumário: o rótulo, talvez um intervalo ("a art. 4º"), e o número da página no fim.
  const RE_SUMARIO = /^art(?:igo)?s?\.?\s*[\d.]+\s*[ºo°]?(?:-[a-z]{1,2})?\s*(?:(?:a|e)\s+art\.?\s*[\d.]+\s*[ºo°]?(?:-[a-z]{1,2})?\s*)?\.{0,40}\s*\d{1,4}$/i;
  limpas.forEach((l, i) => {
    const m = RE_ART.exec(l);
    if (m && !RE_SUMARIO.test(l)) arts.push({ i, n: m[1].replace(/\./g, ''), suf: m[2] || null });
  });
  if (arts.length && !(arts[0].n === '1' && !arts[0].suf && (arts[1]?.n === '2' || (arts[1]?.n === '1' && arts[1]?.suf)))) {
    const par = arts.findIndex((a, k) => a.n === '1' && !a.suf && (arts[k + 1]?.n === '2' || (arts[k + 1]?.n === '1' && arts[k + 1]?.suf)));
    if (par > 0) inicio = arts[par].i;
    else if (arts[0].n !== '1') {
      const um = arts.find((a) => a.n === '1' && !a.suf);
      if (um) inicio = um.i;
    }
  }
  // Regimento: começa no primeiro "Art. 1º" com o art. 2º (ou o 1º-A) entre os cinco artigos
  // seguintes. Pula o sumário que vem antes ("**Art. 2º** a art. 4º 21") e não cai numa resolução
  // transcrita no fim quando o art. 1º do regimento cita outro artigo no começo de uma linha
  // ("Art. 107 da Constituição", TRF3), o que a regra de cima (par 1º-2º seguido) tomaria.
  if (regimento && arts.length) {
    const ehUm = (a) => a.n === '1' && !a.suf;
    const ehDois = (a) => a.n === '2' || (a.n === '1' && a.suf);
    // O art. 2º tem de vir antes de outro "Art. 1º" (índice do TJSP: "**Art. 1º**" e, logo depois
    // no corpo, o art. 1º de verdade).
    const segue = (j) => {
      for (const a of arts.slice(j + 1, j + 6)) {
        if (ehUm(a)) return false;
        if (ehDois(a)) return true;
      }
      return false;
    };
    let k = arts.findIndex((a, j) => ehUm(a) && segue(j));
    // Resolução que aprova o regimento, com ele no anexo (turmas recursais do TJRN): o corte
    // começa no art. 1º do regimento, não no da resolução.
    if (k >= 0 && /aprovad[oa]\s+o\s+regimento|aprova\s+o\s+regimento/i.test(`${limpas[arts[k].i]} ${limpas[arts[k].i + 1] || ''}`)) {
      const k2 = arts.findIndex((a, j) => j > k && ehUm(a) && segue(j));
      if (k2 > k) k = k2;
    }
    if (k >= 0) inicio = arts[k].i;
  }

  for (const [indice, bruta] of linhas.entries()) {
    if (indice < inicio) continue;
    const linha = limpas[indice];
    if (!linha) continue;
    if (regimento && RE_LEGISLACAO_CITADA.test(linha)) break;
    if (rubrica.has(indice) && !emCitacao) continue;
    let m;

    if (emCitacao) {
      // Saída de segurança: o próximo artigo da própria lei, sem aspas, fecha a transcrição.
      const ultimo = artigos[artigos.length - 1];
      if ((m = RE_ART.exec(linha)) && ultimo && !/^[“"]/.test(linha) &&
          Math.floor(chaveOrdem(m[1].replace(/\./g, '')) / 1000) === Math.floor(ultimo.ordem / 1000) + 1) {
        emCitacao = false;
      } else {
        if (atual) atual.linhas.push(linha);
        if (/[”"]\s*(?:\(NR\))?\s*[.;]?\s*$|\(NR\)\s*$/.test(linha) || (regimento && /[”"]/.test(linha))) emCitacao = false;
        continue;
      }
    }
    if (cf && RE_ADCT.test(linha) && /^#|^ato/i.test(bruta.trim())) {
      atual = null;
      prefixo = 'adct/';
      artigos.length = 0;
      ctx = { art: null, par: null, inc: null };
      continue;
    }
    if (RE_FECHO.test(linha)) {
      // Na CF o fecho vem antes do ADCT: só fecha o dispositivo aberto.
      if (pararNoFecho) break;
      atual = null;
      continue;
    }
    if (RE_TITULO.test(bruta.trim()) || RE_TITULO.test(linha)) {
      if (!cf && RE_ANEXO.test(linha)) tituloDesdeUltimoArt = 'anexo';
      else if (!tituloDesdeUltimoArt) tituloDesdeUltimoArt = true;
      atual = null;
      continue;
    }
    if (!cf && RE_ANEXO.test(linha) && linha.length < 120) {
      tituloDesdeUltimoArt = 'anexo';
      atual = null;
      continue;
    }

    // Regimento: "art. 616 do Código de Processo Penal" no começo de uma linha quebrada, ou
    // "Art. 942 do CPC", é remissão, não artigo: o rótulo de artigo começa por maiúscula e o caput
    // não começa por minúscula.
    // ("Art. 262 O sobrestamento": o "O" é a primeira palavra do caput, não ordinal.)
    if ((m = RE_ART.exec(linha)) && regimento && (!/^A/.test(linha) || /^[a-zà-ú]/.test(linha.slice(m[0].replace(/\s+[oO]$/, '').length).replace(/^[\s.\-–—:]+/, '')))) m = null;
    if (m) {
      const art = m[1].replace(/\./g, '') + (m[2] ? `-${m[2].toLowerCase()}` : '');
      const ordem = chaveOrdem(art);
      let ultimo = artigos[artigos.length - 1];
      if (regimento && ultimo && ordem === ultimo.ordem && !tituloDesdeUltimoArt) {
        // Redação nova do mesmo artigo, logo depois da antiga: a antiga sai (só ela e os filhos; o
        // artigo aberto fora de ordem depois dela fica).
        tirar(`${prefixo}art-${art}`);
        artigos.pop();
        ultimo = artigos[artigos.length - 1];
      }
      if (ultimo && ordem <= ultimo.ordem) {
        const anterior = artigos[artigos.length - 2];
        if (tituloDesdeUltimoArt === 'anexo' && ordem < 2000) {
          anexos++;
          prefixo = `anexo-${anexos}/`;
          artigos.length = 0;
        } else if (ultimo.salto && anterior && ordem > anterior.ordem) {
          desfazerSalto(ultimo);
        } else if (regimento && !vistos.has(`${prefixo}art-${art}`) && Math.floor(ultimo.ordem / 1000) - Math.floor(ordem / 1000) <= JANELA_REGIMENTO) {
          // PDF em duas colunas (TJGO: "Art. 8º" antes do "Art. 7º", "Art. 14" antes do "Art. 13"):
          // artigo ainda não lido, perto do último, entra fora de ordem; a pilha fica como estava.
          tituloDesdeUltimoArt = false;
          ctx = { art, par: null, inc: null };
          abrir(`${prefixo}art-${art}`, linha);
          foraDeOrdem++;
          continue;
        } else {
          ignorados++;
          if (atual) atual.linhas.push(linha);
          continue;
        }
      }
      ultimo = artigos[artigos.length - 1];
      tituloDesdeUltimoArt = false;
      ctx = { art, par: null, inc: null };
      const inicio = dispositivos.length;
      if (abrir(`${prefixo}art-${art}`, linha)) {
        // Salto (artigo de outra lei transcrito sem aspas): no regimento, só acima da janela, porque
        // o PDF fora de ordem pula um ou dois artigos e volta.
        const salto = Boolean(ultimo) && Math.floor(ordem / 1000) > Math.floor(ultimo.ordem / 1000) + (regimento ? JANELA_REGIMENTO : 1);
        artigos.push({ ordem, inicio, salto });
      }
      continue;
    }
    if (ctx.art && ((m = RE_PAR_UNICO.exec(linha)) || (m = (regimento ? RE_PAR_REGIMENTO : RE_PAR).exec(linha)))) {
      const par = m[1] ? m[1] + (m[2] ? `-${m[2].toLowerCase()}` : '') : 'u';
      ctx = { art: ctx.art, par, inc: null };
      abrir(`${prefixo}art-${ctx.art}/par-${par}`, linha);
      continue;
    }
    if (ctx.art && ((m = RE_INC.exec(linha)) || (regimento && (m = RE_INC_MIN.exec(linha)))) && romanoParaNumero(m[1])) {
      const inc = `${romanoParaNumero(m[1])}${m[2] ? `-${m[2].toLowerCase()}` : ''}`;
      ctx = { ...ctx, inc };
      const base = `${prefixo}art-${ctx.art}${ctx.par ? `/par-${ctx.par}` : ''}`;
      abrir(`${base}/inc-${inc}`, linha);
      continue;
    }
    if (ctx.art && (m = RE_ALI.exec(linha))) {
      const base = `${prefixo}art-${ctx.art}${ctx.par ? `/par-${ctx.par}` : ''}${ctx.inc ? `/inc-${ctx.inc}` : ''}`;
      abrir(`${base}/ali-${m[1]}`, linha);
      continue;
    }
    // Linha comum: continua o dispositivo aberto. Texto transcrito de outra lei abre aspas.
    if (atual) {
      atual.linhas.push(linha);
      // No regimento, a aspa que fecha em qualquer ponto da linha fecha a transcrição ('"visto" como
      // relator', TRT19; '"Prometo desempenhar ... grau". (Acrescentado...)', TJSC).
      if (/^[“"]/.test(linha) && !/[”"]\s*(?:\(NR\))?\s*[.;]?\s*$/.test(linha) && !(regimento && /.[”"]/.test(linha))) emCitacao = true;
    }
  }

  dispositivos = dispositivos.map((d, i) => {
    const texto = textoCanonico(d.linhas.join('\n'));
    return {
      id: d.id,
      caminho: d.caminho,
      ordem: i,
      rotulo: rotuloDeCaminho(d.caminho),
      texto,
      sha256: sha256(texto),
      situacao: situacaoDoTexto(texto),
      alterado_por: alteracoesDoTexto(texto),
      vide_controle: videControle(texto),
    };
  });
  return { dispositivos, conflitos, ignorados, desfeitos, substituidos, foraDeOrdem };
}

/** "(Redação dada pela Lei nº 13.964, de 2019)" -> [{codigo:'lei', numero:'13964', ano:'2019', nota}] */
export function alteracoesDoTexto(texto) {
  const out = [];
  for (const m of texto.matchAll(RE_ALTERACAO)) {
    const palavra = m[1].toLowerCase().replace(/\s+/g, ' ');
    const codigo = palavra.startsWith('lei complementar') || palavra === 'lc' ? 'lc'
      : palavra.startsWith('decreto') && /lei/.test(palavra) ? 'dl'
        : palavra.startsWith('decreto') ? 'dec'
          : palavra.startsWith('medida') ? 'mp'
            : palavra.startsWith('emenda') || palavra === 'ec' ? 'ec' : 'lei';
    const nota = /^\((?:[a-zà-ú]+(?:\s+[a-zà-ú]+)?\s+(?:com\s+)?)?(reda[cç][aã]o\s+dada|inclu[ií]d|acrescid|renumerad|revogad|vide)/i.exec(m[0])?.[1].toLowerCase() || '';
    const tipo = nota.startsWith('reda') ? 'redacao_dada_por' : nota.startsWith('inclu') || nota.startsWith('acresc') ? 'incluido_por'
      : nota.startsWith('renum') ? 'renumerado_por' : nota.startsWith('revog') ? 'revogado_por' : 'vide';
    out.push({ tipo, codigo, numero: m[2].replace(/\./g, ''), ano: m[3] || m[4] || null });
  }
  return out;
}

/** "(Vide ADI 6.298)" -> [{classe:'adi', numero:'6298'}] */
export function videControle(texto) {
  const out = [];
  const vistos = new Set();
  for (const nota of texto.matchAll(RE_VIDE_NOTA)) {
    for (const m of nota[1].matchAll(RE_VIDE_ACAO)) {
      const classe = m[1].toLowerCase() === 'adin' ? 'adi' : m[1].toLowerCase();
      for (const n of m[2].split(/\s*(?:,|\be\b)\s*/)) {
        const numero = n.replace(/-\d$/, '').replace(/\./g, '');
        if (!numero || vistos.has(`${classe}:${numero}`)) continue;
        vistos.add(`${classe}:${numero}`);
        out.push({ classe, numero });
      }
    }
  }
  return out;
}
