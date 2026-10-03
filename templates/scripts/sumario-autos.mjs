#!/usr/bin/env node
// Sumário durável dos autos, por caso (não por run), e o inventário das imagens
// que pedem leitura visual: as figuras embutidas nas folhas (foto num laudo com
// texto, print numa petição), as folhas de imagem ou `vazia` e as imagens avulsas.
//
// O motor não resume nem descreve nada: isto é um cartório. O agente escreve
// `autos/_sumario/sumario-dos-autos.md` (ancorado em folha) e as descrições de
// imagem em `autos/_sumario/imagens/`; este script diz se o sumário está EM DIA
// (o índice dos autos não mudou desde que ele foi marcado), lista as imagens
// que ainda não têm descrição (em lotes, para vários descritores em paralelo),
// leva cada descrição para o `documento.md`, no ponto da folha (`integrar`), e
// grava o manifesto quando o agente termina.
//
// Por que por caso: réplica e apelação sobre os mesmos 506 fólios reliam tudo
// na fase zero de cada squad. O sumário é lido pelos leitores como ponto de
// partida e nunca como fonte de citação: a folha se confere no documento.md.
// Invalidação honesta: o hash do `_index.yaml` mais o dos manifestos de conversão
// muda quando os autos mudam ou são reconvertidos, e aí o sumário volta a "desatualizado".
// As figuras recortadas não entram nesse hash: a passada de figuras (`autos-md.mjs --figuras`)
// acrescenta fotos sem mudar o texto lido, e a foto nova sai como imagem pendente (status 4).
//
//   node scripts/sumario-autos.mjs status  <squads/<nome>|pasta-do-caso|autos/> [--json]
//       sai 0 (em dia), 3 (desatualizado: refazer o sumário) ou 4 (em dia, faltam descrições de imagem,
//       ou há descrição nova fora da seção "Imagens relevantes")
//   node scripts/sumario-autos.mjs imagens <...> [--teto N] [--lote N] [--parte K] [--lotes] [--incluir-ocr] [--json]
//   node scripts/sumario-autos.mjs integrar <...> [--json]
//   node scripts/sumario-autos.mjs marcar  <...> --por "<squad/run>" [--indice-hash <do status>] [--sem-folhas] [--json]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const PASTA_SUMARIO = '_sumario';
export const ARQUIVO_SUMARIO = 'sumario-dos-autos.md';
export const MANIFESTO_SUMARIO = '_manifesto.json';
export const PASTA_DESCRICOES = 'imagens';
// Teto e lote medidos no PDF integral do PJe de 561 folhas (30/09/2026): o inventário passou de 10
// folhas de imagem para 62 itens (60 figuras embutidas, 52 delas em folhas de texto, e 2 folhas de
// imagem sem figura recortada). Cada figura custa em média ~490 tokens de imagem na leitura visual
// (w x h / 750, depois da redução a 1568 px), a folha inteira até ~1.530: um lote de 10 fica abaixo
// de 15 mil tokens de imagem e cabe folgado num descritor; 5 em paralelo fazem esse caso em duas
// ondas. O teto de 150 cobre 2,4 vezes esse caso numa rodada; o antigo, 40, deixava a maior parte
// para "a próxima rodada".
export const TETO_DE_IMAGENS = 150;
export const LOTE_DE_IMAGENS = 10;
export const DESCRITORES_EM_PARALELO = 5;
export const CABECALHO_DESCRICAO = '> Descrição por modelo de visão: interpretação de máquina, não fato dos autos. Confira na imagem antes de citar.';
/** Os campos da descrição orientada a prova, nesta ordem. */
export const CAMPOS_DESCRICAO = ['Tipo', 'Contexto no documento', 'Elementos de prova', 'Data e hora', 'Texto legível', 'Incerto', 'O que não se vê'];
/**
 * O que os campos Contexto e Data e hora pedem da imagem avulsa, que não tem folha nem legenda.
 * Avaliação independente do teste de ponta a ponta de 30/09/2026: a descrição das fotos do teto
 * trazia só a imagem e a data do EXIF, o leitor as marcou "cômodo não identificado" e a peça
 * descartou a cronologia, embora o relato da advogada dissesse onde foram tiradas.
 */
export const CONTEXTO_DA_AVULSA = 'Imagem avulsa (sem folha nem legenda): no campo Contexto no documento, cruze a imagem com o relato do profissional (o pedido, o intake do run e o relato na pasta do caso, quando houver) e com os documentos que falam dela, e diga onde foi tirada e do quê, com a fonte da atribuição entre parênteses ("teto do quarto, segundo o relato do profissional"); sem atribuição em relato nem documento, "local não atribuído em documento". Do relato vêm só o lugar e o objeto: prazo, data, valor, causa ou conclusão que o relato afirma não entram na descrição, nem como contexto, porque a foto não os mostra (no run de 01/10/2026, a descrição de uma foto trouxe o fim de prazo que o relato dava, errado). No campo Data e hora, a data do EXIF vai com a ressalva "data de captura nos metadados do arquivo (relógio do dispositivo, não conferido)": serve à cronologia com essa ressalva, não como prova da data.';
/**
 * A âncora com que a peça cita a imagem. Avaliação independente do run de 01/10/2026: a peça citou
 * as fotos avulsas pelo Doc., mas nunca as Fotografias 1 a 4 de dentro do relatório (fls. 2 e 3),
 * e a prova visual do relatório ficou implícita.
 */
export const ANCORA_DA_FIGURA = 'O campo Contexto no documento abre com a âncora com que a peça cita a imagem: "fls. N, Fotografia K", com o rótulo que o próprio documento dá a ela (na legenda ou no texto da folha; "Foto 3", "Figura 2", "Anexo fotográfico 1"); sem rótulo no documento, "fls. N, figura K". Na avulsa, o nome do arquivo.';
/** O rótulo que a legenda dá à figura ("Fotografia 1"), para o bloco integrado dizer como citá-la. */
const RE_ROTULO_DA_LEGENDA = /^\s*((?:Fotografia|Foto|Figura|Imagem|Print|Anexo fotogr[aá]fico)\s+(?:n[º°o.]\s*)?\d+)\b/i;
/** A descrição do contrato anterior (até a 0.9.74) tinha este campo no lugar de Contexto e Elementos de prova: continua valendo. */
const CAMPO_DO_CONTRATO_ANTERIOR = 'O que se vê';
export const SECAO_IMAGENS_RELEVANTES = 'Imagens relevantes';
/** A lista das imagens avulsas que o conversor grava (EXIF útil, cópia legível) e o Markdown delas. */
export const AVULSAS_JSON = '_imagens-avulsas.json';
export const AVULSAS_MD = '_imagens-avulsas.md';
const EXT_IMAGEM = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.gif', '.bmp', '.heic', '.heif']);
// Folha dos autos (`fls. N`, `e-fls. N`) ou página de documento de uma pasta pré-processual
// (`p. N`, `pág. N`, `Doc. 03, p. 2`): a pasta do cliente não tem folha, e o marcar recusava o
// sumário ancorado nas páginas, forçando `--sem-folhas` (medido em 3 dos 7 runs de 23-24/09/2026).
// Também valem o documento sozinho (`Doc. 03`, quando o documento tem uma página só) e o
// intervalo de páginas (`pp. 2-3`, `págs. 4-6`): as duas âncoras ainda eram recusadas (G23).
// E a forma do tribunal no PDF integral do PJe: `Num. 12345678 - Pág. 3` e `ID 12345678` (P2 do
// teste com autos reais de 27/09/2026), que a sentença e as partes usam.
const RE_FOLHAS = /\b(?:(?:e-)?fls?|p[áa]gs?|pp?|docs?)\.\s*\d+|\bnum\.\s*\d{5,}|\bid\.?\s*\d{5,}/gi;
const contarFolhas = (texto) => (texto.match(RE_FOLHAS) || []).length;
const RE_MARCADOR = /LEGALSQUAD:PREENCHER|\[PREENCHER/;
const RE_SECAO_IMAGENS = /^\s*(?:#{1,6}\s*|\*\*)Imagens relevantes\b/im;

const posix = (p) => p.split(sep).join('/');

// Onde estão os autos: cópia do bloco canônico de src/autos-path.js (honra `caso.json`,
// os autos por referência). Sem isto, `status squads/<nome>` saía 1 no desenho por referência.
// >>> autos-path:begin
/**
 * Pasta de autos de um squad: `squads/<nome>/autos/` (copiados para o squad) ou,
 * por referência, a pasta do caso que `squads/<nome>/caso.json` aponta
 * (`{"autos": "Processos/<caso>/autos"}` ou `{"pasta": "Processos/<caso>"}`,
 * relativo à raiz do projeto, a pasta acima de `squads/`). A cópia local com
 * `_index.yaml` vence a referência; sem `caso.json`, fica a do squad.
 */
function pastaDeAutos(squadDir) {
  const noSquad = join(squadDir, 'autos');
  if (existsSync(join(noSquad, '_index.yaml'))) return noSquad;
  try {
    const caso = JSON.parse(readFileSync(join(squadDir, 'caso.json'), 'utf8'));
    const raiz = dirname(dirname(squadDir));
    const autos = caso && typeof caso.autos === 'string' ? caso.autos : (caso && typeof caso.pasta === 'string' ? `${caso.pasta}/autos` : null);
    if (autos) return resolve(raiz, autos);
  } catch { /* sem caso.json, ou ilegível: fica o do squad */ }
  return noSquad;
}

/**
 * Aceita `squads/<nome>` (com `autos/` dentro ou `caso.json` apontando o caso), a
 * pasta do caso (com `autos/` dentro) ou o caminho direto de `autos/`.
 * Devolve `{ dir, erro }`; `dir` é absoluto.
 */
function resolverAutos(entrada) {
  const abs = resolve(entrada);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: null, erro: `pasta não encontrada: ${entrada}` };
  if (basename(abs) === 'autos') return { dir: abs, erro: null };
  const dir = pastaDeAutos(abs);
  if (existsSync(dir) && statSync(dir).isDirectory()) return { dir, erro: null };
  if (existsSync(join(abs, 'caso.json'))) return { dir: null, erro: `${entrada}/caso.json aponta ${dir}, que não existe: confira o caminho (relativo à raiz do projeto, a pasta acima de squads/)` };
  return { dir: null, erro: `${entrada} existe, mas não tem a pasta autos/; crie ${entrada}/autos/ e coloque nela os PDFs e documentos do caso, ou grave ${entrada}/caso.json apontando a pasta do caso` };
}
// <<< autos-path:end
export { pastaDeAutos, resolverAutos };

/**
 * Hash da LEITURA dos autos: o índice (o que existe) mais os manifestos de conversão em
 * `_md/<slug>/_manifesto.json` (o que foi lido, e como). Só o índice não basta: reconverter
 * os mesmos PDFs (OCR novo, folhas antes invisíveis) não muda o índice, e o sumário escrito
 * sobre a conversão velha continuava "em dia".
 *
 * Só CONTEÚDO entra no hash. Os carimbos de hora (`gerado_em` e `mtime` do índice,
 * `convertido_em` do manifesto) ficam de fora: o runner manda converter na fase zero
 * de todo squad, e uma reconversão idêntica dos mesmos autos trocava o hash e mandava
 * reler as 506 folhas a cada squad novo, o contrário do "uma vez por autos".
 *
 * Os campos do índice que dizem O QUE os autos são (o arquivo, o tamanho, as páginas, se tem
 * texto e onde está a conversão). O resto (`tipo`, `origem`, `datas`, `primeira_pagina`,
 * `numero_processo`) é leitura do indexador, e muda quando o indexador muda, sem mudar os autos.
 * Medido na medição de 24/09/2026 (motor 0.9.49): o sumário da negativação, marcado por outro
 * squad que aponta a mesma pasta do caso, saiu desatualizado depois de reindexar porque o
 * indexador novo gravou o campo `origem`; os autos eram os mesmos.
 */
const CAMPOS_DOS_AUTOS = ['arquivo', 'bytes', 'paginas', 'texto', 'markdown', 'paginas_sem_texto_n', 'paginas_sem_texto'];
/** Campos que o indexador passou a gravar depois do manifesto v1 do sumário (G17: `origem`). */
const CAMPOS_NOVOS_DO_INDEXADOR = ['origem', 'pje_documentos', 'pje_capa', 'pje_capa_documentos', 'pje_avisos'];
/** Linhas que o indexador passou a escrever depois do manifesto v1: o comentário e o bloco `pje:` (P1, 27/09/2026). */
const COMENTARIO_NOVO_DO_INDICE = '# PDF integral do PJe:';
/**
 * O comentário do cabeçalho do índice como o indexador o escrevia antes (até a 0.9.55, com
 * travessão). O manifesto v1 guardou o hash do texto inteiro do índice, comentário incluído, e a
 * troca do texto fixo do motor (0.9.56) deixou desatualizado todo sumário marcado antes, com os
 * autos intactos. Medido em 27/09/2026 (negativação, motor 0.9.61, L21): o sumário marcado em
 * 25/09 saiu "em_dia: false" com o índice inalterado. O comentário é texto do motor, não dos autos.
 */
const CABECALHOS_ANTERIORES_DO_INDICE = [['# Índice dos autos: GERADO', '# Índice dos autos \u2014 GERADO']];

/** Cada documento do índice, só com os campos dos autos: `{ arquivo: "bytes|paginas|..." }`. */
export function documentosDoIndice(dir) {
  const p = join(dir, '_index.yaml');
  if (!existsSync(p)) return null;
  const docs = {};
  let atual = null;
  let dentro = false;
  for (const linha of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^documentos:/.test(linha)) { dentro = true; continue; }
    if (dentro && /^\S/.test(linha)) dentro = false;
    if (!dentro) continue;
    const m = linha.match(/^\s*(?:-\s+)?([\w]+):\s*(.*)$/);
    if (!m) continue;
    if (/^\s*-\s/.test(linha)) atual = null;
    if (m[1] === 'arquivo') { atual = m[2].replace(/^"|"$/g, ''); docs[atual] = {}; continue; }
    if (atual && CAMPOS_DOS_AUTOS.includes(m[1])) docs[atual][m[1]] = m[2].trim();
  }
  return Object.fromEntries(Object.entries(docs).map(([arquivo, campos]) => [arquivo, CAMPOS_DOS_AUTOS.slice(1).map((c) => campos[c] ?? '').join('|')]));
}

/**
 * O conteúdo de um manifesto de conversão que conta como LEITURA dos autos: sem os carimbos de hora e
 * de motor e sem as figuras. As figuras (e `figuras_versao`) ficam de fora desde a passada de figuras
 * (`autos-md.mjs --figuras`): ela acrescenta fotos recortadas sobre autos já convertidos sem mudar o
 * texto de folha nenhuma, e o sumário escrito sobre esse texto continua valendo; a figura nova sai
 * como imagem pendente (status 4), não como autos mudados (status 3). Figura vista pela primeira vez
 * não muda o que foi lido; muda o que falta descrever.
 *
 * `formula: '0.9.75'` refaz o conteúdo como a 0.9.75 o media (com a lista de figuras que ela gravou,
 * que a passada guarda em `figuras_anteriores`), para o sumário marcado nela continuar em dia.
 */
function conteudoDaConversao(texto, { formula = 'atual' } = {}) {
  const resto = { ...JSON.parse(texto) };
  const anteriores = resto.figuras_anteriores;
  delete resto.convertido_em;
  delete resto.motor;
  delete resto.figuras_versao;
  delete resto.figuras_anteriores;
  if (formula === '0.9.75') {
    // A lista que a 0.9.75 gravou: guardada pela passada em `figuras_anteriores`; sem ela, o
    // manifesto ainda é o da 0.9.75, e `figuras` é essa lista.
    if (Array.isArray(anteriores)) resto.figuras = anteriores;
    if (!Array.isArray(resto.figuras) || resto.figuras.some((f) => f && f.origem)) return null;
  } else delete resto.figuras;
  return JSON.stringify(resto);
}

/** O hash de cada conversão em `_md/<slug>/_manifesto.json`, sem os carimbos de hora e de motor e sem as figuras. */
function conversoesDosAutos(dir, { formula = 'atual' } = {}) {
  const saida = {};
  const md = join(dir, '_md');
  if (!existsSync(md) || !statSync(md).isDirectory()) return saida;
  for (const slug of readdirSync(md).sort()) {
    const manifesto = join(md, slug, MANIFESTO_SUMARIO);
    if (!existsSync(manifesto)) continue;
    let conteudo;
    try {
      conteudo = conteudoDaConversao(readFileSync(manifesto, 'utf8'), { formula });
    } catch {
      conteudo = readFileSync(manifesto, 'utf8');
    }
    if (conteudo === null) continue;
    saida[slug] = createHash('sha256').update(conteudo).digest('hex').slice(0, 16);
  }
  return saida;
}

/**
 * Hash da LEITURA dos autos (versão 2 do manifesto do sumário): os documentos, só com os campos
 * dos autos (`CAMPOS_DOS_AUTOS`), e as conversões. O sumário é do CASO: qualquer squad que aponte
 * a mesma pasta (`caso.json`) lê o mesmo sumário, e reindexar com outro indexador não o invalida.
 */
export function hashDoIndice(dir, { formula = 'atual' } = {}) {
  const docs = documentosDoIndice(dir);
  if (!docs) return null;
  const h = createHash('sha256').update(JSON.stringify({ documentos: docs, conversoes: conversoesDosAutos(dir, { formula }) }));
  return `sha256:${h.digest('hex')}`;
}

/**
 * O hash da versão 1 do manifesto (o texto inteiro do índice, menos os carimbos, mais as
 * conversões), para o sumário marcado antes da 0.9.50 continuar valendo. `semCamposNovos`
 * tira do índice os campos que o indexador passou a gravar depois (`origem`): o sumário marcado
 * sobre o índice sem eles é o mesmo sumário sobre os mesmos autos.
 */
export function hashDoIndiceV1(dir, { semCamposNovos = false, cabecalhoAnterior = false } = {}) {
  const p = join(dir, '_index.yaml');
  if (!existsSync(p)) return null;
  const campoNovo = new RegExp(`^\\s+(?:${CAMPOS_NOVOS_DO_INDEXADOR.join('|')}):`);
  let noBlocoPje = false;
  const indice = readFileSync(p, 'utf8').split(/\r?\n/)
    .filter((l) => {
      if (/^\S/.test(l)) noBlocoPje = /^pje:/.test(l);
      return !noBlocoPje && !l.startsWith(COMENTARIO_NOVO_DO_INDICE);
    })
    .filter((l) => !/^gerado_em:|^\s+mtime:/.test(l) && !(semCamposNovos && campoNovo.test(l)))
    .map((l) => (cabecalhoAnterior && l.startsWith('#') ? CABECALHOS_ANTERIORES_DO_INDICE.reduce((t, [atual, antes]) => t.replace(atual, antes), l) : l))
    .join('\n');
  const h = createHash('sha256').update(indice);
  const md = join(dir, '_md');
  if (existsSync(md) && statSync(md).isDirectory()) {
    for (const slug of readdirSync(md).sort()) {
      const manifesto = join(md, slug, MANIFESTO_SUMARIO);
      if (!existsSync(manifesto)) continue;
      let conteudo;
      try {
        conteudo = conteudoDaConversao(readFileSync(manifesto, 'utf8'));
      } catch {
        conteudo = readFileSync(manifesto, 'utf8');
      }
      h.update(`\n${slug}\n`).update(conteudo);
    }
  }
  return `sha256:${h.digest('hex')}`;
}

/**
 * Os campos do índice que são MEDIÇÃO do indexador sobre a leitura, e não os autos: se a folha tem
 * texto (`texto`, `paginas_sem_texto_n`, `paginas_sem_texto`). A medição muda quando o indexador
 * muda a régua, com os mesmos PDFs e a mesma conversão. Medido no teste com autos reais de
 * 27/09/2026 (motor 0.9.62): o rodapé do PJe deixou de contar como texto útil e a folha de imagem
 * com legenda passou a contar como sem texto (7 para 10 folhas), e o sumário do caso, marcado sobre
 * os mesmos autos e a mesma conversão, saía desatualizado. Posições em `CAMPOS_DOS_AUTOS.slice(1)`.
 */
const CAMPOS_DE_MEDICAO = new Set(['texto', 'paginas_sem_texto_n', 'paginas_sem_texto']);
const semMedicao = (linha) => String(linha).split('|').filter((_, i) => !CAMPOS_DE_MEDICAO.has(CAMPOS_DOS_AUTOS.slice(1)[i])).join('|');

/** Só a medição do indexador mudou: mesmos documentos, mesmos bytes, páginas e conversão. */
function soMudouAMedicao(dir, manifesto) {
  if (manifesto.versao !== 2 || !manifesto.documentos || !manifesto.conversoes) return false;
  const agora = documentosDoIndice(dir) || {};
  const antes = manifesto.documentos;
  const chaves = Object.keys(agora);
  if (chaves.length !== Object.keys(antes).length || chaves.some((a) => !(a in antes) || semMedicao(antes[a]) !== semMedicao(agora[a]))) return false;
  return conversoesConferem(dir, manifesto);
}

/** Cada conversão é a que o sumário leu: pelo hash atual ou, no sumário marcado na 0.9.75, pelo dela. */
function conversoesConferem(dir, manifesto) {
  const conv = conversoesDosAutos(dir);
  const antiga = conversoesDosAutos(dir, { formula: '0.9.75' });
  const todas = new Set([...Object.keys(conv), ...Object.keys(manifesto.conversoes || {})]);
  return [...todas].every((k) => conv[k] === manifesto.conversoes[k] || (antiga[k] !== undefined && antiga[k] === manifesto.conversoes[k]));
}

/** Caminho da descrição de uma imagem (relativo a `autos/`): `_sumario/imagens/<caminho com "/" trocado por "--">.md`. */
export function caminhoDaDescricao(imagemRel) {
  return `${PASTA_SUMARIO}/${PASTA_DESCRICOES}/${posix(imagemRel).replace(/^\.?\//, '').replace(/\//g, '--')}.md`;
}

function listarImagensAvulsas(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const full = join(dir, e.name);
    let st = e;
    if (e.isSymbolicLink()) { try { st = statSync(full); } catch { continue; } }
    if (st.isDirectory()) listarImagensAvulsas(full, base, acc);
    else if (st.isFile() && EXT_IMAGEM.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())) acc.push(posix(relative(base, full)));
  }
  return acc;
}

function lerJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Todas as imagens que pedem leitura visual, descritas ou não, em ordem de prioridade:
 *
 * - `figura`: figura de uma folha (`figuras` do manifesto de conversão), em qualquer origem de
 *   folha: a foto de um laudo com texto é a lacuna que a classificação por folha não via. Em
 *   `figura_origem`, `embutida` (imagem própria dentro do PDF) ou `regiao_escaneada` (foto recortada
 *   de dentro da folha digitalizada, onde ela não é imagem separada);
 * - `imagem` e `vazia`: a folha inteira, quando ela não tem figura recortada (foto de página
 *   inteira, documento escaneado ilegível); com figuras, a unidade de descrição é a figura;
 * - `ocr`: a folha de OCR, só com `incluirOcr`;
 * - `avulsa`: imagem juntada à pasta, com o EXIF útil que o conversor anotou.
 *
 * Prioridade pela área: a figura vale a fração da folha que ocupa; folha de imagem e avulsa valem
 * 1; folha de OCR 0,1; folha `vazia` 0. Empate fica na ordem dos autos.
 */
export function itensDeImagem(dir, { incluirOcr = false } = {}) {
  const itens = [];
  const md = join(dir, '_md');
  if (existsSync(md) && statSync(md).isDirectory()) {
    for (const slug of readdirSync(md).sort()) {
      const m = lerJson(join(md, slug, MANIFESTO_SUMARIO));
      if (!m) continue;
      const figuras = Array.isArray(m.figuras) ? m.figuras.filter((f) => f && f.imagem && Number.isFinite(f.pagina)) : [];
      const comFigura = new Set(figuras.map((f) => f.pagina));
      const origemDa = new Map((Array.isArray(m.folhas) ? m.folhas : []).filter(Boolean).map((f) => [f.pagina, f.origem]));
      const documentoMd = posix(join('_md', slug, 'documento.md'));
      const base = { documento: m.arquivo || slug, slug, documento_md: documentoMd };
      for (const f of Array.isArray(m.folhas) ? m.folhas : []) {
        if (!f || !f.imagem) continue;
        const pagina = f.origem === 'vazia' || f.origem === 'imagem';
        if (!(pagina && !comFigura.has(f.pagina)) && !(incluirOcr && f.origem === 'ocr')) continue;
        const prioridade = f.origem === 'imagem' ? 1 : f.origem === 'ocr' ? 0.1 : 0;
        itens.push({ imagem: posix(join('_md', slug, f.imagem)), origem: f.origem, ...base, pagina: f.pagina ?? null, figura: 0, prioridade });
      }
      for (const f of figuras) {
        itens.push({
          imagem: posix(join('_md', slug, f.imagem)), origem: 'figura', ...base, pagina: f.pagina, figura: f.figura ?? 1,
          folha_origem: origemDa.get(f.pagina) ?? null, figura_origem: f.origem ?? 'embutida', fracao: f.fracao ?? null, largura: f.largura ?? null, altura: f.altura ?? null,
          legenda: f.legenda ?? null, ...(f.exif ? { exif: f.exif } : {}), prioridade: Number(f.fracao) || 0,
        });
      }
    }
  }
  const avulsas = new Map(((lerJson(join(md, AVULSAS_JSON)) || {}).imagens || []).filter((a) => a && a.imagem).map((a) => [a.imagem, a]));
  for (const img of listarImagensAvulsas(dir)) {
    const a = avulsas.get(img) || {};
    itens.push({
      imagem: img, origem: 'avulsa', documento: img, pagina: null, figura: null, prioridade: 1,
      ...(a.abrir !== undefined && a.abrir !== img ? { abrir: a.abrir } : {}),
      ...(a.exif ? { exif: a.exif } : {}), ...(a.erro ? { erro: a.erro } : {}),
    });
  }
  // `--` também é válido em nome de arquivo: `fotos/a--b.jpg` e `fotos/a/b.jpg` cairiam na
  // mesma descrição, e a segunda nasceria "descrita" com o que o modelo viu na primeira.
  // Só a colisão ganha sufixo (hash curto do caminho), para as descrições já gravadas
  // continuarem valendo. Na ordem dos autos, antes da prioridade: o sufixo não muda quando
  // a prioridade muda.
  const ocupados = new Set();
  for (const it of itens) {
    let descricao = caminhoDaDescricao(it.imagem);
    if (ocupados.has(descricao)) descricao = descricao.replace(/\.md$/, `.${createHash('sha256').update(it.imagem).digest('hex').slice(0, 8)}.md`);
    ocupados.add(descricao);
    it.descricao = descricao;
    it.descrita = existsSync(join(dir, it.descricao));
  }
  return itens.map((it, i) => [it, i]).sort((a, b) => (b[0].prioridade - a[0].prioridade) || (a[1] - b[1])).map(([it]) => it);
}

/**
 * A versão das figuras que o conversor atual grava: 1 era só as embutidas (0.9.75), 2 acrescenta as
 * fotos recortadas de dentro de folha escaneada. Mesma constante de `autos-para-md.py`.
 */
export const FIGURAS_VERSAO = 2;

/**
 * Conversões que pedem a passada de figuras: manifesto sem o campo `figuras` (convertido antes da
 * 0.9.75) ou com `figuras_versao` abaixo da atual. O runner roda `autos-md.mjs --figuras` antes do
 * inventário, em vez de reconverter (12 minutos e OCR de novo, num caso real de 561 folhas).
 */
export function conversoesSemFiguras(dir) {
  const md = join(dir, '_md');
  if (!existsSync(md) || !statSync(md).isDirectory()) return [];
  return readdirSync(md).sort().filter((slug) => {
    const m = lerJson(join(md, slug, MANIFESTO_SUMARIO));
    return m && Array.isArray(m.folhas) && (!Array.isArray(m.figuras) || !(Number(m.figuras_versao) >= FIGURAS_VERSAO));
  });
}

/**
 * Imagens que pedem descrição, com teto e lotes. Os lotes são fatias FIXAS da lista inteira
 * (descritas incluídas), na ordem de prioridade: o lote 3 é o mesmo antes e depois de o
 * descritor do lote 1 gravar as suas, e cinco descritores em paralelo não pegam a mesma imagem.
 * `lotes` lista só os que têm pendência, até o teto.
 */
export function inventarioDeImagens(dir, { incluirOcr = false, teto = TETO_DE_IMAGENS, lote = LOTE_DE_IMAGENS } = {}) {
  const itens = itensDeImagem(dir, { incluirOcr });
  const pendentes = itens.filter((i) => !i.descrita);
  const lotes = [];
  let cabem = teto;
  for (let k = 0; k * lote < itens.length && cabem > 0; k += 1) {
    const n = itens.slice(k * lote, (k + 1) * lote).filter((i) => !i.descrita).length;
    if (!n) continue;
    lotes.push({ parte: k + 1, pendentes: Math.min(n, cabem) });
    cabem -= n;
  }
  return {
    total: itens.length,
    descritas: itens.length - pendentes.length,
    pendentes: pendentes.slice(0, teto),
    alem_do_teto: Math.max(0, pendentes.length - teto),
    teto,
    lote,
    lotes,
    descritores_em_paralelo: DESCRITORES_EM_PARALELO,
    passada_de_figuras: conversoesSemFiguras(dir),
  };
}

/** Os itens pendentes de uma parte (1-based) da lista fixa de lotes. */
export function parteDoInventario(dir, parte, { incluirOcr = false, lote = LOTE_DE_IMAGENS } = {}) {
  const itens = itensDeImagem(dir, { incluirOcr });
  return itens.slice((parte - 1) * lote, parte * lote).filter((i) => !i.descrita);
}

// --- Descrição: contrato e integração ao documento.md ----------------------------

const normalizar = (t) => String(t).normalize('NFC').toLowerCase();

/** Os campos do contrato que faltam na descrição ([] quando está completa ou é do contrato anterior). */
export function camposFaltantes(texto) {
  const linhas = String(texto).split(/\r?\n/).map((l) => normalizar(l.replace(/[*_#>`]/g, '').trim()));
  const tem = (campo) => { const c = normalizar(campo); return linhas.some((l) => l === c || l.startsWith(`${c}:`) || l.startsWith(`${c} :`)); };
  if (tem(CAMPO_DO_CONTRATO_ANTERIOR)) return [];
  return CAMPOS_DESCRICAO.filter((c) => !tem(c));
}

// Sigilo: documento pessoal e placa não se transcrevem (a descrição diz "[placa não transcrita]").
// CPF só na forma pontuada, e placa só nos dois formatos que não se confundem com norma técnica
// ("NBR 5410"): Mercosul (letra na quinta posição) e o antigo com hífen.
const RE_SIGILO = [
  ['CPF', /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/],
  ['placa', /\b[A-Z]{3}\d[A-Z]\d{2}\b|\b[A-Z]{3}-\d{4}\b/],
];

/** O que a descrição transcreveu e não podia (CPF, placa). */
export function problemasDeSigilo(texto) {
  return RE_SIGILO.filter(([, re]) => re.test(String(texto))).map(([nome]) => nome);
}

/** O corpo da descrição, citado (`> `), sem o cabeçalho, sem comentário HTML e sem título Markdown. */
function corpoCitado(texto) {
  const linhas = String(texto).replace(/\r\n/g, '\n').split('\n')
    .filter((l) => l.trim() !== CABECALHO_DESCRICAO)
    .map((l) => l.replace(/<!--|-->/g, '').replace(/\s+$/, '').replace(/^\s*#{1,6}\s+(.+)$/, '**$1**'));
  while (linhas.length && !linhas[0].trim()) linhas.shift();
  while (linhas.length && !linhas[linhas.length - 1].trim()) linhas.pop();
  const out = [];
  for (const l of linhas) if (l.trim() || (out.length && out[out.length - 1] !== '>')) out.push(l.trim() ? `> ${l.replace(/^>\s?/, '')}` : '>');
  return out.join('\n');
}

const marcaDoBloco = (pagina, figura) => `<!-- figura:begin fls=${pagina} fig=${figura} -->`;
const FIM_DO_BLOCO = '<!-- figura:end -->';
const RE_BLOCO = /<!-- figura:begin fls=(\d+) fig=(\d+) -->\n[\s\S]*?\n<!-- figura:end -->\n?/g;

/** O bloco marcado de uma imagem descrita, no ponto da folha do documento.md. */
export function blocoDaDescricao(item, texto) {
  const rel = item.imagem.startsWith(`_md/${item.slug}/`) ? item.imagem.slice(`_md/${item.slug}/`.length) : item.imagem;
  const quem = item.figura ? `Figura ${item.figura} da fls. ${item.pagina}` : `Imagem da fls. ${item.pagina}`;
  const rotulo = String(item.legenda || '').match(RE_ROTULO_DA_LEGENDA)?.[1];
  const ancora = `fls. ${item.pagina}${rotulo ? `, ${rotulo}` : ', com o rótulo que o documento dá à imagem (a âncora no começo do Contexto)'}`;
  return [
    marcaDoBloco(item.pagina, item.figura || 0),
    `> **${quem}** (descrição por modelo de visão, conferir na imagem \`${rel}\` antes de citar; a peça cita a folha, nunca esta descrição: o Doc. do índice de anexos, ${ancora}):`,
    '>',
    corpoCitado(texto),
    FIM_DO_BLOCO,
  ].join('\n');
}

/** Troca, na seção de cada folha, os blocos das imagens descritas; o resto do texto fica como está. */
function reescreverDocumento(original, blocosPorFolha) {
  const partes = original.split(/(?=^<!-- fls\. \d+\/\d+)/m);
  const achadas = new Set();
  const saida = partes.map((secao, idx) => {
    const m = secao.match(/^<!-- fls\. (\d+)\//);
    if (!m) return secao;
    const pagina = Number(m[1]);
    const novos = blocosPorFolha.get(pagina);
    if (!novos) return secao;
    achadas.add(pagina);
    const existentes = new Map();
    const cabeca = secao.replace(RE_BLOCO, (bloco, _p, fig) => { existentes.set(Number(fig), bloco.replace(/\n$/, '')); return ''; });
    for (const [fig, bloco] of novos) existentes.set(fig, bloco);
    const ordenados = [...existentes.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const ultima = idx === partes.length - 1;
    return `${cabeca.replace(/\s+$/, '')}\n\n${ordenados.join('\n')}\n${ultima ? '' : '\n'}`;
  });
  return { texto: saida.join(''), achadas };
}

/**
 * O plano da integração: para cada documento.md, o texto com as descrições nos blocos marcados, e
 * o Markdown das imagens avulsas. Não grava nada; `integrarDescricoes` grava, e o `status` e o
 * `marcar` usam o plano para saber o que ainda não chegou ao documento.md.
 */
export function planoDeIntegracao(dir) {
  const itens = itensDeImagem(dir, { incluirOcr: true }).filter((i) => i.descrita);
  const recusadas = [];
  const semLugar = [];
  const porDocumento = new Map();
  const avulsas = [];
  for (const it of itens) {
    const texto = readFileSync(join(dir, it.descricao), 'utf8');
    const faltam = camposFaltantes(texto);
    const sigilo = problemasDeSigilo(texto);
    if (!texto.includes(CABECALHO_DESCRICAO)) { recusadas.push({ descricao: it.descricao, motivo: 'sem o cabeçalho de procedência' }); continue; }
    if (faltam.length) { recusadas.push({ descricao: it.descricao, motivo: `faltam os campos ${faltam.join(', ')}` }); continue; }
    if (sigilo.length) { recusadas.push({ descricao: it.descricao, motivo: `transcreve ${sigilo.join(' e ')}` }); continue; }
    if (it.origem === 'avulsa') { avulsas.push({ it, texto }); continue; }
    if (!it.slug || !Number.isFinite(it.pagina)) { semLugar.push(it.descricao); continue; }
    if (!porDocumento.has(it.documento_md)) porDocumento.set(it.documento_md, new Map());
    const porFolha = porDocumento.get(it.documento_md);
    if (!porFolha.has(it.pagina)) porFolha.set(it.pagina, new Map());
    porFolha.get(it.pagina).set(it.figura || 0, { it, bloco: blocoDaDescricao(it, texto), corpo: corpoCitado(texto) });
  }
  const arquivos = [];
  let integradas = 0;
  let pendentes = 0;
  for (const [rel, porFolha] of porDocumento) {
    const caminho = join(dir, rel);
    if (!existsSync(caminho)) { for (const f of porFolha.values()) for (const { it } of f.values()) semLugar.push(it.descricao); continue; }
    const original = readFileSync(caminho, 'utf8');
    const blocos = new Map([...porFolha].map(([p, f]) => [p, new Map([...f].map(([fig, v]) => [fig, v.bloco]))]));
    const { texto, achadas } = reescreverDocumento(original, blocos);
    for (const [p, f] of porFolha) {
      for (const { it, bloco, corpo } of f.values()) {
        // A linha de cabeçalho do bloco é orientação de leitura (como citar), não a descrição: o bloco
        // com a marca e o mesmo corpo está integrado, e o `integrar` só renova o cabeçalho.
        if (!achadas.has(p)) semLugar.push(it.descricao);
        else if (original.includes(bloco) || (original.includes(marcaDoBloco(p, it.figura || 0)) && original.includes(corpo))) integradas += 1;
        else pendentes += 1;
      }
    }
    if (texto !== original) arquivos.push({ rel, texto });
  }
  if (avulsas.length) {
    const rel = posix(join('_md', AVULSAS_MD));
    const texto = [
      '# Imagens avulsas dos autos',
      '',
      '> Fotos e prints juntados à pasta dos autos, fora de PDF. Cada bloco é descrição por modelo de visão: interpretação de máquina, não fato dos autos; confira na imagem antes de citar, e cite o arquivo, nunca a descrição.',
      '',
      ...avulsas.sort((a, b) => a.it.imagem.localeCompare(b.it.imagem)).flatMap(({ it, texto: t }) => [
        `## ${it.imagem}`, '',
        '<!-- figura:begin avulsa -->',
        `> **Imagem avulsa \`${it.imagem}\`** (descrição por modelo de visão, conferir na imagem antes de citar):`,
        '>',
        corpoCitado(t),
        FIM_DO_BLOCO, '',
      ]),
    ].join('\n');
    const caminho = join(dir, rel);
    const atual = existsSync(caminho) ? readFileSync(caminho, 'utf8') : null;
    if (atual === texto) integradas += avulsas.length;
    else {
      pendentes += avulsas.length;
      arquivos.push({ rel, texto });
    }
  }
  return { arquivos, integradas, nao_integradas: pendentes, sem_lugar: semLugar, recusadas };
}

/** Leva cada descrição ao documento.md (e as avulsas ao `_md/_imagens-avulsas.md`). Idempotente: reescreve só os blocos marcados. */
export function integrarDescricoes(dir) {
  const plano = planoDeIntegracao(dir);
  for (const { rel, texto } of plano.arquivos) writeFileSync(join(dir, rel), texto, 'utf8');
  return { ok: true, gravados: plano.arquivos.map((a) => a.rel), integradas: plano.integradas + plano.nao_integradas, novas: plano.nao_integradas, sem_lugar: plano.sem_lugar, recusadas: plano.recusadas };
}

/** A razão exata de o sumário não estar em dia: que documento entrou, saiu, mudou ou foi reconvertido. */
function motivoDaMudanca(dir, manifesto) {
  if (manifesto.versao !== 2 || !manifesto.documentos) {
    return 'os autos mudaram ou foram reconvertidos desde o sumário (manifesto da versão anterior, sem a lista de documentos para dizer qual): refaça o sumário e marque de novo';
  }
  const agora = documentosDoIndice(dir) || {};
  const antes = manifesto.documentos;
  const entraram = Object.keys(agora).filter((a) => !(a in antes));
  const sairam = Object.keys(antes).filter((a) => !(a in agora));
  const mudaram = Object.keys(agora).filter((a) => a in antes && antes[a] !== agora[a]);
  const conv = conversoesDosAutos(dir);
  const antiga = conversoesDosAutos(dir, { formula: '0.9.75' });
  const reconvertidos = Object.keys({ ...conv, ...(manifesto.conversoes || {}) }).filter((k) => (manifesto.conversoes || {})[k] !== conv[k] && (manifesto.conversoes || {})[k] !== antiga[k]);
  const partes = [
    entraram.length && `entrou ${entraram.join(', ')}`,
    sairam.length && `saiu ${sairam.join(', ')}`,
    mudaram.length && `mudou ${mudaram.join(', ')} (tamanho, páginas ou texto)`,
    reconvertidos.length && `reconvertido ${reconvertidos.join(', ')}`,
  ].filter(Boolean);
  return `os autos mudaram desde o sumário: ${partes.join('; ') || 'o índice mudou'}. Refaça o sumário e marque de novo`;
}

export function statusDoSumario(dir) {
  const sumario = join(dir, PASTA_SUMARIO, ARQUIVO_SUMARIO);
  const manifestoPath = join(dir, PASTA_SUMARIO, MANIFESTO_SUMARIO);
  const hash = hashDoIndice(dir);
  const existe = existsSync(sumario);
  let manifesto = null;
  if (existsSync(manifestoPath)) { try { manifesto = JSON.parse(readFileSync(manifestoPath, 'utf8')); } catch { manifesto = null; } }
  let motivo;
  let emDia = false;
  if (!hash) motivo = 'os autos não estão indexados: rode `node scripts/indexar-autos.mjs` (e `npm run autos:md`) antes do sumário';
  else if (!existe) motivo = 'não há sumário do caso: o agente escreve `_sumario/sumario-dos-autos.md` e o runner marca';
  else if (!manifesto) motivo = 'sumário sem manifesto: rode `sumario-autos marcar` depois de conferi-lo';
  else if (manifesto.indice_hash === hash) { emDia = true; motivo = 'em dia'; }
  else if (manifesto.indice_hash === hashDoIndice(dir, { formula: '0.9.75' })) {
    emDia = true;
    motivo = 'em dia (marcado com o hash que ainda contava as figuras embutidas; figura acrescentada não muda o texto lido)';
  }
  else if (manifesto.versao !== 2 && [false, true].flatMap((cabecalhoAnterior) => [false, true].map((semCamposNovos) => hashDoIndiceV1(dir, { semCamposNovos, cabecalhoAnterior }))).includes(manifesto.indice_hash)) {
    emDia = true;
    motivo = 'em dia (manifesto da versão anterior; os autos não mudaram, só o indexador mudou o texto do índice)';
  } else if (soMudouAMedicao(dir, manifesto)) {
    emDia = true;
    motivo = 'em dia (os autos e a conversão são os mesmos; só a medição do indexador mudou a contagem de folhas sem texto)';
  } else motivo = motivoDaMudanca(dir, manifesto);
  if (emDia && manifesto && manifesto.por) motivo += `; marcado por ${manifesto.por}: o sumário é do caso e vale para todo squad que aponta esta pasta`;
  const texto = existe ? readFileSync(sumario, 'utf8') : '';
  const folhas = contarFolhas(texto);
  const imagens = inventarioDeImagens(dir);
  const pendentes = imagens.total - imagens.descritas;
  const plano = planoDeIntegracao(dir);
  // Imagem sem descrição é pendência do sumário, não detalhe: o teto de 40 por rodada
  // deixava o resto para "a próxima rodada", que nunca vinha porque o status dizia
  // "em dia" e o runner só despacha o descritor quando o sumário está desatualizado.
  // Descrição gravada depois da marcação: o sumário vale, mas a seção "Imagens relevantes" não a
  // conhece. Manifesto sem a contagem (anterior à seção) não acusa nada.
  const novas = emDia && manifesto && Number.isFinite(manifesto.imagens_descritas) ? Math.max(0, imagens.descritas - manifesto.imagens_descritas) : 0;
  if (emDia && pendentes) motivo = `em dia, mas ${pendentes} imagem(ns) sem descrição: despache os descritores (${imagens.lotes.length} lote(s) de até ${imagens.lote}), integre e marque de novo`;
  else if (emDia && plano.nao_integradas) motivo = `em dia, mas ${plano.nao_integradas} descrição(ões) fora do documento.md: rode \`sumario-autos integrar\``;
  else if (novas) motivo = `em dia, mas ${novas} imagem(ns) descrita(s) depois da marcação: acrescente-as à seção "${SECAO_IMAGENS_RELEVANTES}" do sumário e marque de novo`;
  return {
    autos: dir, sumario: existe ? posix(relative(dir, sumario)) : null, existe, em_dia: emDia, motivo,
    imagens_pendentes: pendentes, imagens_novas: novas,
    indice_hash: hash, marcado: manifesto ? { em: manifesto.gerado_em, por: manifesto.por, folhas_citadas: manifesto.folhas_citadas } : null,
    folhas_citadas: folhas,
    imagens: { total: imagens.total, descritas: imagens.descritas, pendentes, lotes: imagens.lotes.length, nao_integradas: plano.nao_integradas, recusadas: plano.recusadas.length, passada_de_figuras: imagens.passada_de_figuras },
  };
}

/** Grava o manifesto do sumário. Recusa sumário sem folha citada (salvo `semFolhas`) ou com marcador de preenchimento. */
export function marcarSumario(dir, { por, semFolhas = false, indiceHash = null, agora = () => new Date().toISOString() } = {}) {
  const sumario = join(dir, PASTA_SUMARIO, ARQUIVO_SUMARIO);
  if (!existsSync(sumario)) return { ok: false, erro: `não há ${PASTA_SUMARIO}/${ARQUIVO_SUMARIO} em ${dir}: o agente escreve o sumário antes de marcar` };
  const hash = hashDoIndice(dir);
  if (!hash) return { ok: false, erro: 'os autos não estão indexados (sem _index.yaml): sumário sem índice não tem o que invalidar' };
  // O certificado é do que o agente LEU: `status --json` entrega o hash antes do despacho e
  // o runner o devolve aqui; se os autos foram reconvertidos ou reindexados no meio, o
  // sumário é de outra leitura e não pode sair "em dia".
  if (indiceHash && indiceHash !== hash) return { ok: false, erro: `os autos mudaram entre a leitura (${indiceHash.slice(0, 19)}…) e a marcação (${hash.slice(0, 19)}…): refaça o sumário sobre a leitura atual` };
  const texto = readFileSync(sumario, 'utf8');
  if (RE_MARCADOR.test(texto)) return { ok: false, erro: 'o sumário ainda tem marcador de preenchimento' };
  const folhas = contarFolhas(texto);
  if (!folhas && !semFolhas) return { ok: false, erro: 'o sumário não cita nenhuma folha (fls. N, p. N, pp. N-M, Doc. NN ou Num. X - Pág. Y do PJe): sumário sem folha é resumo de memória; se os autos não têm PDF paginado, passe --sem-folhas' };
  const imagens = inventarioDeImagens(dir);
  const descricoesSemCabecalho = [];
  const pastaDesc = join(dir, PASTA_SUMARIO, PASTA_DESCRICOES);
  if (existsSync(pastaDesc)) {
    for (const f of readdirSync(pastaDesc).filter((n) => n.endsWith('.md'))) {
      const t = readFileSync(join(pastaDesc, f), 'utf8');
      if (!t.includes(CABECALHO_DESCRICAO)) descricoesSemCabecalho.push(f);
    }
  }
  if (descricoesSemCabecalho.length) return { ok: false, erro: `${descricoesSemCabecalho.length} descrição(ões) de imagem sem o cabeçalho de procedência (${descricoesSemCabecalho.slice(0, 3).join(', ')}${descricoesSemCabecalho.length > 3 ? '…' : ''}): a descrição é interpretação de máquina e tem de dizer isso na primeira linha` };
  const lista = (xs) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? '…' : ''}`;
  const semCampos = [];
  const comSigilo = [];
  if (existsSync(pastaDesc)) {
    for (const f of readdirSync(pastaDesc).filter((n) => n.endsWith('.md')).sort()) {
      const t = readFileSync(join(pastaDesc, f), 'utf8');
      const faltam = camposFaltantes(t);
      if (faltam.length) semCampos.push(`${f} (${faltam.join(', ')})`);
      const sigilo = problemasDeSigilo(t);
      if (sigilo.length) comSigilo.push(`${f} (${sigilo.join(' e ')})`);
    }
  }
  if (semCampos.length) return { ok: false, erro: `${semCampos.length} descrição(ões) sem os campos do contrato (${CAMPOS_DESCRICAO.join(', ')}): ${lista(semCampos)}. A descrição é orientada a prova: cada campo, mesmo que seja "nada visível"` };
  if (comSigilo.length) return { ok: false, erro: `${comSigilo.length} descrição(ões) transcrevem documento pessoal ou placa: ${lista(comSigilo)}. Escreva "[CPF não transcrito]" ou "[placa não transcrita]"` };
  if (imagens.descritas && !RE_SECAO_IMAGENS.test(texto)) return { ok: false, erro: `há ${imagens.descritas} imagem(ns) descrita(s) e o sumário não tem a seção "${SECAO_IMAGENS_RELEVANTES}" (cada imagem que importa à controvérsia, com a folha e o que mostra, apontando a descrição)` };
  const plano = planoDeIntegracao(dir);
  if (plano.nao_integradas) return { ok: false, erro: `${plano.nao_integradas} descrição(ões) ainda fora do documento.md: rode \`node scripts/sumario-autos.mjs integrar\` antes de marcar (os leitores leem o documento.md, não _sumario/imagens/)` };
  const manifesto = { versao: 2, indice_hash: hash, documentos: documentosDoIndice(dir), conversoes: conversoesDosAutos(dir), gerado_em: agora(), por: por || null, folhas_citadas: folhas, imagens_descritas: imagens.descritas, imagens_pendentes: imagens.total - imagens.descritas, caracteres: texto.length };
  mkdirSync(join(dir, PASTA_SUMARIO), { recursive: true });
  writeFileSync(join(dir, PASTA_SUMARIO, MANIFESTO_SUMARIO), `${JSON.stringify(manifesto, null, 2)}\n`, 'utf8');
  return { ok: true, manifesto };
}

// --- CLI -----------------------------------------------------------------------

function uso() {
  return 'uso: node scripts/sumario-autos.mjs <status|imagens|integrar|marcar> <squads/<nome>|pasta-do-caso|autos/> [--json] [--teto N] [--lote N] [--parte K] [--lotes] [--incluir-ocr] [--por "<squad/run>"] [--sem-folhas] [--indice-hash <hash do status>]';
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: 'boolean' }, teto: { type: 'string' }, lote: { type: 'string' }, parte: { type: 'string' }, lotes: { type: 'boolean' }, 'incluir-ocr': { type: 'boolean' }, por: { type: 'string' }, 'sem-folhas': { type: 'boolean' }, 'indice-hash': { type: 'string' },
  } });
  const [comando, entrada] = positionals;
  if (!comando || !entrada) { console.error(uso()); return 2; }
  const { dir, erro } = resolverAutos(entrada);
  if (!dir) { console.error(`sumario-autos: ${erro}`); return 1; }
  const json = values.json === true;
  if (comando === 'status') {
    const s = statusDoSumario(dir);
    if (json) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(`Sumário do caso: ${s.em_dia ? (s.imagens_pendentes || s.imagens_novas ? 'EM DIA, IMAGENS PENDENTES' : 'EM DIA') : 'DESATUALIZADO'} (${s.motivo})`);
      if (s.existe) console.log(`  ${s.sumario} · ${s.folhas_citadas} citação(ões) de folha${s.marcado ? ` · marcado em ${s.marcado.em} por ${s.marcado.por || 'não informado'}` : ''}`);
      console.log(`  Imagens a ler: ${s.imagens.total} (${s.imagens.descritas} descritas, ${s.imagens.pendentes} pendentes em ${s.imagens.lotes} lote(s); ${s.imagens.nao_integradas} descrição(ões) fora do documento.md${s.imagens.recusadas ? `, ${s.imagens.recusadas} recusada(s)` : ''})`);
      if (s.imagens.passada_de_figuras.length) console.log(`  sem as figuras atuais (convertido por motor anterior): ${s.imagens.passada_de_figuras.join(', ')}; rode \`node scripts/autos-md.mjs ${entrada} --figuras\``);
    }
    // 0: em dia · 3: desatualizado (refazer o sumário) · 4: sumário vale, faltam descrições de
    // imagem ou a seção "Imagens relevantes" não tem as descritas depois da marcação
    return s.em_dia ? (s.imagens_pendentes || s.imagens_novas ? 4 : 0) : 3;
  }
  if (comando === 'imagens') {
    const inteiro = (v, padrao, min) => { const n = v === undefined ? padrao : Number(v); return Number.isInteger(n) && n >= min ? n : null; };
    const teto = inteiro(values.teto, TETO_DE_IMAGENS, 0);
    const lote = inteiro(values.lote, LOTE_DE_IMAGENS, 1);
    const parte = inteiro(values.parte, 0, 1);
    if (teto === null) { console.error('sumario-autos: --teto precisa ser inteiro >= 0'); return 2; }
    if (lote === null) { console.error('sumario-autos: --lote precisa ser inteiro >= 1'); return 2; }
    if (values.parte !== undefined && parte === null) { console.error('sumario-autos: --parte precisa ser inteiro >= 1 (o número do lote)'); return 2; }
    const incluirOcr = values['incluir-ocr'] === true;
    const contrato = { cabecalho_obrigatorio: CABECALHO_DESCRICAO, campos_obrigatorios: CAMPOS_DESCRICAO, ancora: ANCORA_DA_FIGURA, contexto_da_avulsa: CONTEXTO_DA_AVULSA };
    if (parte) {
      const itens = parteDoInventario(dir, parte, { incluirOcr, lote });
      if (json) console.log(JSON.stringify({ autos: dir, ...contrato, parte, lote, pendentes: itens }, null, 2));
      else {
        console.log(`Lote ${parte} (de até ${lote}): ${itens.length} imagem(ns) a descrever`);
        for (const it of itens) console.log(`  ${it.abrir || it.imagem}  →  ${it.descricao}${it.pagina ? `  (${it.documento}, fls. ${it.pagina}${it.figura ? `, figura ${it.figura}` : ''}, ${it.origem})` : `  (${it.origem})`}`);
      }
      return 0;
    }
    const inv = inventarioDeImagens(dir, { incluirOcr, teto, lote });
    const saida = values.lotes === true ? { ...inv, pendentes: undefined } : inv;
    if (json) console.log(JSON.stringify({ autos: dir, ...contrato, ...saida }, null, 2));
    else {
      console.log(`Imagens a ler: ${inv.total} (${inv.descritas} descritas, ${inv.pendentes.length} a descrever agora em ${inv.lotes.length} lote(s) de até ${lote}${inv.alem_do_teto ? `, ${inv.alem_do_teto} além do teto de ${teto}` : ''})`);
      if (inv.passada_de_figuras.length) console.log(`  convertido(s) por motor anterior, sem as figuras atuais: ${inv.passada_de_figuras.join(', ')}. Rode antes \`node scripts/autos-md.mjs ${entrada} --figuras\` (não refaz o OCR nem muda o texto das folhas)`);
      for (const l of inv.lotes) console.log(`  lote ${l.parte}: ${l.pendentes} pendente(s)  →  node scripts/sumario-autos.mjs imagens ${entrada} --parte ${l.parte} --json`);
      if (values.lotes !== true) for (const it of inv.pendentes) console.log(`  ${it.abrir || it.imagem}  →  ${it.descricao}${it.pagina ? `  (${it.documento}, fls. ${it.pagina}${it.figura ? `, figura ${it.figura}` : ''}, ${it.origem})` : `  (${it.origem})`}`);
    }
    return 0;
  }
  if (comando === 'integrar') {
    const r = integrarDescricoes(dir);
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`Descrições no documento.md: ${r.integradas} (${r.novas} nova(s) ou alterada(s)); ${r.gravados.length} arquivo(s) regravado(s)`);
      if (r.sem_lugar.length) console.log(`  sem folha marcada no documento.md (reconverta com o autos:md atual): ${r.sem_lugar.join(', ')}`);
      for (const x of r.recusadas) console.log(`  recusada: ${x.descricao} (${x.motivo})`);
    }
    return r.recusadas.length ? 1 : 0;
  }
  if (comando === 'marcar') {
    const r = marcarSumario(dir, { por: values.por, semFolhas: values['sem-folhas'] === true, indiceHash: values['indice-hash'] || null });
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (r.ok) console.log(`Sumário marcado: ${r.manifesto.folhas_citadas} citação(ões) de folha, ${r.manifesto.imagens_descritas} imagem(ns) descrita(s), ${r.manifesto.imagens_pendentes} pendente(s); índice ${r.manifesto.indice_hash.slice(0, 19)}…`);
    else console.error(`sumario-autos: ${r.erro}`);
    return r.ok ? 0 : 1;
  }
  console.error(uso());
  return 2;
}

// Guarda de entrada por caminho real: `import.meta.url === file://argv[1]` falha com espaço ou
// acento no caminho do projeto (achado no run de 19/09 na calculadora de prazo).
function chamadoDiretamente() {
  try { return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1])); } catch { return false; }
}
if (chamadoDiretamente()) process.exit(main());
