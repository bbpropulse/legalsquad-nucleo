// O PDF integral do PJe, separado nos documentos que o compõem.
//
// O "download do processo" do PJe junta todos os documentos num PDF só. Cada folha
// traz, no rodapé, o número do documento no PJe e a página dentro dele
// (`Num. 12345678 - Pág. 3`), e a capa, quando o PDF a tem, lista os documentos
// (Num., data, título e, às vezes, a página do PDF onde cada um começa). A sentença,
// as partes e o tribunal citam por esse número ("Num. 12345678 - Pág. 3", "ID
// 12345678"), não pela página do PDF.
//
// Medido no teste com autos reais de 27/09/2026 (motor 0.9.62, apelação cível, PDF
// de 561 páginas): o índice tratava o PDF inteiro como UM documento. O sinal
// `folhas` do Redação Gate ficava "não avaliado" (a peça não menciona "autos
// integrais") e o ANEXOS saía "folha inicial: não consta" para tudo.
//
// Três partes:
// - `separarPecasPje(paginas)`: do texto de cada página (pdftotext ou o Markdown do
//   conversor) aos documentos, pelo rodapé e pela capa. Página sem rodapé legível
//   herda do vizinho, com aviso. Usada pelo indexador.
// - `lerPecasPje(textoDoIndice)`: o bloco `pje:` do `_index.yaml`.
// - `expandirPecasPje(docs, pecas)`: troca o PDF integral pelos documentos dele,
//   para o sinal `folhas` e o ANEXOS verem cada documento com a folha onde começa.
//
// Módulo PURO (só texto e regex). SINCRONIA: o bloco entre os marcadores é copiado
// VERBATIM pelo `scripts/sync-blocos.mjs` para o indexador, o empacotador (raiz e
// templates) e o hook de redação (raiz, .codex e templates). Nenhum import.

// >>> autos-pje:begin
/** Rodapé do PJe: `Num. 12345678 - Pág. 3`. Tolerante ao OCR (`Pag` sem acento, sem ponto, sem hífen). */
const PJE_RODAPE = /\bnum\.?[ \t]*(\d{5,})[ \t]*-?[ \t]*p[aá]g\.?[ \t]*(\d{1,4})\b/gi;
/** O mesmo rodapé sozinho na linha: é o que o PJe imprime; a menção no corpo vem no meio da frase. */
const PJE_RODAPE_LINHA = /^[ \t]*num\.?[ \t]*(\d{5,})[ \t]*-?[ \t]*p[aá]g\.?[ \t]*(\d{1,4})[ \t]*$/gim;
const PJE_ASSINATURA = /assinado (?:eletronicamente|digitalmente) por:?[^\n]{0,160}?(\d{2})\/(\d{2})\/(\d{4})/i;
/** Linha do índice da capa: Num. (ou Id.), data (e hora), o título do documento e, às vezes, a página. */
const PJE_CAPA_LINHA = /^[ \t]*(?:(?:num|id)\.?[ \t]*)?(\d{6,})[ \t]+(\d{2})\/(\d{2})\/(\d{4})(?:[ \t]+\d{2}:\d{2}(?::\d{2})?)?[ \t]+(.+?)[ \t]*$/i;
/** Capa com a coluna da página: o cabeçalho da tabela nomeia `Pág.` ao lado de `Documento`. */
const PJE_CAPA_COM_PAGINA = /\bdocumento\b[^\n]{0,80}\bp[aá]g(?:ina)?\.?(?=\s|$)/i;
/** Até onde a capa vai: o índice de um processo de milhares de folhas cabe em dezenas de páginas. */
const PJE_MAX_PAGINAS_DE_CAPA = 60;

/** `{ num, pag }` do rodapé da página, ou `null`. Vale o rodapé sozinho na linha; senão, a última menção. */
function rodapeDaPagina(texto) {
  const t = String(texto || '');
  const naLinha = [...t.matchAll(PJE_RODAPE_LINHA)];
  const achados = naLinha.length ? naLinha : [...t.matchAll(PJE_RODAPE)];
  if (!achados.length) return null;
  const m = achados[achados.length - 1];
  return { num: m[1], pag: Number(m[2]) };
}

function isoDaData(dia, mes, ano) {
  const d = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));
  if (d.getUTCMonth() !== Number(mes) - 1 || d.getUTCDate() !== Number(dia)) return null;
  return d.toISOString().slice(0, 10);
}

/** [3,4,5,9] → "3-5, 9". */
function faixasPje(numeros) {
  const n = [...new Set(numeros)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n.length; i += 1) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j += 1;
    out.push(i === j ? String(n[i]) : `${n[i]}-${n[j]}`);
    i = j;
  }
  return out.join(', ');
}

/** O índice da capa, nas páginas antes do primeiro rodapé: `{ folhas: [1..k], itens: Map(num → {...}) }` ou `null`. */
function capaDoPdf(paginas, mascarar) {
  const itens = new Map();
  let ultima = -1;
  const comPagina = paginas.some((p) => PJE_CAPA_COM_PAGINA.test(String(p || '')));
  paginas.forEach((p, i) => {
    // O Markdown do conversor junta as linhas da capa numa só: cada Num. seguido de data abre uma linha.
    // (também colado no traço da régua do cabeçalho: `-----10000001 05/03/2024 ...`).
    const texto = String(p || '').replace(/(?:[ \t]+|(?<=[-=_]))(?=\d{6,}[ \t]+\d{2}\/\d{2}\/\d{4}\b)/g, '\n');
    for (const linha of texto.split(/\r?\n/)) {
      const m = linha.match(PJE_CAPA_LINHA);
      if (!m) continue;
      let resto = m[5];
      let pagina = null;
      if (comPagina) {
        const fim = resto.match(/^(.*?)[ \t]+(\d{1,5})$/);
        if (fim) { resto = fim[1]; pagina = Number(fim[2]); }
      }
      const titulo = mascarar(resto.replace(/[ \t]*(?:…|\.\.\.)$/, '').replace(/\s+/g, ' ').trim()) || null;
      if (!itens.has(m[1])) itens.set(m[1], { num: m[1], data: isoDaData(m[2], m[3], m[4]), titulo, pagina, ordem: itens.size });
      ultima = i;
    }
  });
  if (!itens.size) return null;
  return { folhas: Array.from({ length: ultima + 1 }, (_, k) => k + 1), itens, comPagina };
}

/**
 * Os documentos do PDF integral do PJe, a partir do texto de cada página (índice 0 = folha 1).
 * `tipoDe(titulo, textoDaPrimeiraFolha)` devolve `{ tipo, tipo_fonte }` (o indexador passa o dele);
 * `mascarar` tira CPF, CNPJ, e-mail e telefone do título.
 * Devolve `null` quando o PDF não é do PJe (nenhum rodapé e nenhuma capa com página), ou
 * `{ pecas, capa, avisos }`: cada peça com o Num., as folhas do PDF (`folha_inicial`/`folha_final`),
 * as páginas do PJe (`pag_inicial`/`pag_final`), a correspondência quando não é linear, título,
 * data, tipo e o aviso do que foi deduzido.
 */
function separarPecasPje(paginas, { tipoDe = () => ({ tipo: 'documento', tipo_fonte: 'desconhecido' }), mascarar = (s) => s } = {}) {
  const lista = Array.isArray(paginas) ? paginas.map((p) => String(p || '')) : [];
  const total = lista.length;
  if (!total) return null;
  const rod = lista.map(rodapeDaPagina);
  const primeira = rod.findIndex(Boolean);
  const capa = capaDoPdf(lista.slice(0, Math.min(primeira < 0 ? total : primeira, PJE_MAX_PAGINAS_DE_CAPA)), mascarar);
  const avisos = [];

  // Sem rodapé nenhum: só a capa com a página inicial de cada documento separa.
  if (primeira < 0) {
    if (!capa || !capa.comPagina) return null;
    const itens = [...capa.itens.values()].filter((it) => Number.isInteger(it.pagina) && it.pagina >= 1 && it.pagina <= total).sort((a, b) => a.pagina - b.pagina);
    if (!itens.length) return null;
    const pecas = itens.map((it, k) => {
      const fim = k + 1 < itens.length ? Math.max(it.pagina, itens[k + 1].pagina - 1) : total;
      const { tipo, tipo_fonte } = tipoDe(it.titulo, lista[it.pagina - 1]);
      return { num: it.num, titulo: it.titulo, tipo, tipo_fonte, data: it.data, folha_inicial: it.pagina, folha_final: fim, pag_inicial: 1, pag_final: fim - it.pagina + 1, correspondencia: null, fonte: 'capa', aviso: 'sem rodapé do PJe legível: folhas pela página da capa' };
    });
    return { pecas, capa: { folhas: faixasPje(capa.folhas), documentos: capa.itens.size }, avisos: ['nenhuma folha com rodapé do PJe legível: os documentos saem da capa, pela página inicial de cada um'] };
  }

  // Menção no corpo que escapou como "rodapé" (a sentença citando outro documento): o vizinho decide.
  for (let i = 1; i + 1 < total; i += 1) {
    const [a, b, c] = [rod[i - 1], rod[i], rod[i + 1]];
    if (a && b && c && a.num === c.num && b.num !== a.num && c.pag === a.pag + 2) rod[i] = { num: a.num, pag: a.pag + 1, corrigido: true };
  }

  const naCapa = new Set(capa ? capa.folhas.map((f) => f - 1) : []);
  const atrib = new Array(total).fill(null);
  for (let i = 0; i < total; i += 1) {
    if (naCapa.has(i)) continue;
    if (rod[i]) { atrib[i] = { ...rod[i], herdado: false }; continue; }
    // Sem rodapé legível (folha de imagem sem a tarja, OCR que errou): herda do vizinho.
    let j = i - 1;
    while (j >= 0 && !atrib[j]) j -= 1;
    let k = i + 1;
    while (k < total && !rod[k]) k += 1;
    const antes = j >= 0 ? atrib[j] : null;
    const depois = k < total ? rod[k] : null;
    if (depois && (!antes || antes.num === depois.num || depois.pag - (k - i) >= 1)) atrib[i] = { num: depois.num, pag: Math.max(1, depois.pag - (k - i)), herdado: true };
    else if (antes) atrib[i] = { num: antes.num, pag: antes.pag + (i - j), herdado: true };
  }

  const pecas = [];
  const vistos = new Map();
  for (let i = 0; i < total; i += 1) {
    if (!atrib[i]) continue;
    let j = i;
    while (j + 1 < total && atrib[j + 1] && atrib[j + 1].num === atrib[i].num) j += 1;
    const folhas = [];
    for (let f = i; f <= j; f += 1) folhas.push({ folha: f + 1, ...atrib[f] });
    const num = atrib[i].num;
    const linear = folhas.every((f, n) => f.pag === folhas[0].pag + n);
    const it = capa ? capa.itens.get(num) : null;
    const assinatura = lista[i].match(PJE_ASSINATURA);
    const data = (it && it.data) || (assinatura ? isoDaData(assinatura[1], assinatura[2], assinatura[3]) : null);
    const titulo = it ? it.titulo : null;
    const { tipo, tipo_fonte } = tipoDe(titulo, lista[i]);
    const notas = [];
    const herdadas = folhas.filter((f) => f.herdado).map((f) => f.folha);
    if (herdadas.length) notas.push(`${herdadas.length > 1 ? 'folhas' : 'folha'} ${faixasPje(herdadas)} sem rodapé legível: atribuída(s) pelo vizinho, confira`);
    const corrigidas = folhas.filter((f) => f.corrigido).map((f) => f.folha);
    if (corrigidas.length) notas.push(`folhas ${faixasPje(corrigidas)} com outro Num. no texto: atribuídas pela sequência`);
    if (it && Number.isInteger(it.pagina) && it.pagina !== i + 1) notas.push(`a capa diz que começa na folha ${it.pagina}; o rodapé, na ${i + 1}`);
    if (capa && !it) notas.push('fora do índice da capa');
    if (vistos.has(num)) notas.push(`o mesmo Num. já apareceu nas folhas ${vistos.get(num)}`);
    if (!linear) notas.push('páginas do PJe fora de sequência: veja a correspondência');
    vistos.set(num, `${i + 1}-${j + 1}`);
    pecas.push({
      num, titulo, tipo, tipo_fonte, data,
      folha_inicial: i + 1, folha_final: j + 1,
      pag_inicial: folhas[0].pag, pag_final: folhas[folhas.length - 1].pag,
      correspondencia: linear ? null : folhas.map((f) => `${f.folha}=${f.pag}`).join(', '),
      fonte: it ? 'rodape+capa' : 'rodape',
      aviso: notas.length ? notas.join('; ') : null,
    });
    i = j;
  }
  if (capa) {
    const achados = new Set(pecas.map((p) => p.num));
    const faltam = [...capa.itens.values()].filter((it) => !achados.has(it.num));
    if (faltam.length) avisos.push(`${faltam.length} documento(s) da capa sem folha com o rodapé correspondente: Num. ${faltam.slice(0, 10).map((it) => it.num).join(', ')}${faltam.length > 10 ? '…' : ''}`);
  }
  const semDono = atrib.map((a, i) => (!a && !naCapa.has(i) ? i + 1 : null)).filter(Boolean);
  if (semDono.length) avisos.push(`folhas ${faixasPje(semDono)} sem documento do PJe`);
  return { pecas, capa: capa ? { folhas: faixasPje(capa.folhas), documentos: capa.itens.size } : null, avisos };
}

/** Valor de uma linha do bloco `pje:` do índice: número, null ou string entre aspas. */
function valorPje(bruto) {
  const s = String(bruto ?? '').trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  return s;
}

/** O bloco `pje:` do `_index.yaml` (um item por documento do PJe), ou `[]`. */
function lerPecasPje(textoDoIndice) {
  const pecas = [];
  let dentro = false;
  let atual = null;
  for (const linha of String(textoDoIndice || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!linha.trim() || /^\s*#/.test(linha)) continue;
    if (/^\S/.test(linha)) { dentro = /^pje:\s*$/.test(linha); atual = null; continue; }
    if (!dentro) continue;
    const item = linha.match(/^\s*-\s+([a-z_]+):\s?(.*)$/);
    if (item) { atual = { [item[1]]: valorPje(item[2]) }; pecas.push(atual); continue; }
    const kv = linha.match(/^\s+([a-z_]+):\s?(.*)$/);
    if (kv && atual) atual[kv[1]] = valorPje(kv[2]);
  }
  return pecas.filter((p) => typeof p.pdf === 'string' && p.num != null && Number.isInteger(p.folha_inicial));
}

/**
 * Troca cada PDF integral do PJe pelos documentos dele: `{ arquivo, num, titulo, tipo, paginas,
 * folha_inicial, folha_final, pags, origem: 'autos' }`, na ordem do PDF. PDF sem bloco `pje:`, ou com um
 * documento só, fica como está.
 */
function expandirPecasPje(docs, pecas) {
  const porPdf = new Map();
  for (const p of Array.isArray(pecas) ? pecas : []) {
    if (!porPdf.has(p.pdf)) porPdf.set(p.pdf, []);
    porPdf.get(p.pdf).push(p);
  }
  const saida = [];
  for (const d of Array.isArray(docs) ? docs : []) {
    const doPdf = d && porPdf.get(d.arquivo);
    // Um documento só no PDF (a sentença baixada avulsa): o arquivo já é o documento.
    if (!doPdf || doPdf.length < 2) { saida.push(d); continue; }
    for (const p of doPdf) {
      saida.push({
        arquivo: d.arquivo, num: String(p.num), titulo: p.titulo || null, tipo: p.especie || 'documento',
        paginas: p.folha_final - p.folha_inicial + 1, folha_inicial: p.folha_inicial, folha_final: p.folha_final,
        pags: p.pags || null, data: p.data || null, origem: 'autos',
      });
    }
  }
  return saida;
}
// <<< autos-pje:end

export { rodapeDaPagina, separarPecasPje, lerPecasPje, expandirPecasPje };
