// Varredura de dado do caso no que vai para um modelo do escritório (LGPD).
//
// O modelo do escritório serve a outros clientes: nada do caso que o originou pode ir nele. A
// primeira versão (0.9.42) deixava passar a maior parte do dado real e barrava o dado fictício do
// próprio pacote (revisão por execução de 24/09/2026, D5, D6 e D19):
//
// - comparava com caixa e acento ("MARTA REGINA PIRES" nos autos não casava "Marta Regina Pires");
// - só pegava identificador com máscara (CPF de 11 dígitos, CNJ de 20, telefone sem parênteses,
//   CEP, RG e placa passavam);
// - lia só `autos/` em .md/.txt, parava em 4 MB e não avisava de PDF sem texto nem de pasta
//   inexistente; o relato do profissional, que mais concentra dado do cliente, ficava de fora;
// - o texto de outro modelo do escritório liberava o trecho ("lavagem": aceito uma vez, passava
//   sempre), e o identificador fictício do modelo de pacote barrava a exportação para sempre.
//
// Aqui: padrões com e sem máscara, comparação sem caixa e sem acento, nomes cruzados por palavra
// rara (palavra que está num nome do caso e não está no vocabulário dos modelos de pacote), a
// pasta do caso inteira (autos, relato, identificacao.json, caso.json, o que o run gravou) com aviso
// do que não foi lido, e "conhecido" só com o texto dos modelos de pacote e o perfil do escritório.
// Achado barra; o dado aceito pelo advogado nunca vira conhecido.

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pastaDeAutos } from './autos-path.js';

/** Minúsculas, sem acento, espaço simples: a forma em que caso e modelo se comparam. */
export const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const soDigitos = (t) => String(t ?? '').replace(/\D/g, '');

const MESES = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };

/**
 * Identificadores que são dado de pessoa onde quer que apareçam. Cada um devolve a forma
 * canônica (só dígitos, ou minúsculas), que é o que se compara com o conhecido.
 */
const IDENTIFICADORES = [
  { motivo: 'número de processo', re: /\b\d{7}[-.\s]?\d{2}[.\s]?\d{4}[.\s]?\d[.\s]?\d{2}[.\s]?\d{4}\b/g, forma: soDigitos },
  { motivo: 'CNPJ', re: /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-.\s]?\d{2}\b/g, forma: soDigitos },
  { motivo: 'CPF', re: /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}\b/g, forma: soDigitos },
  { motivo: 'e-mail', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, forma: semAcento },
  { motivo: 'telefone', re: /(?:\+?55[\s.-]?)?(?:\(\d{2}\)|\b\d{2})[\s.-]?9?\d{4}[\s.-]?\d{4}\b|\b0[38]00[\s.-]?\d{3}[\s.-]?\d{4}\b/g, forma: (t) => soDigitos(t).replace(/^55(?=\d{10,11}$)/, '') },
  { motivo: 'inscrição na OAB', re: /\bOAB\b[^\n\d]{0,40}?\d[\d.]*\d/gi, forma: (t) => soDigitos(t), filtro: (t) => !/\bOAB\s*\/?\s*(?:UF|XX)\b/i.test(t) },
  { motivo: 'CEP', re: /\bCEP[:\s]*\d{2}\.?\d{3}-?\d{3}\b|\b\d{5}-\d{3}\b/gi, forma: soDigitos },
  { motivo: 'RG', re: /\bRG\b[^\n\d]{0,12}\d[\d.]{4,}-?[\dXx]?|\b\d{1,2}\.\d{3}\.\d{3}-[\dXx]\b/g, forma: (t) => soDigitos(t) },
  { motivo: 'placa de veículo', re: /\b[A-Z]{3}-?\d[A-Z0-9]\d{2}\b/g, forma: (t) => t.replace(/-/g, '').toUpperCase() },
  // Em minúsculas ("qrt-4e56") só barra quando está no caso: "iso9001" e afins não são placa (N12).
  { motivo: 'placa de veículo', re: /\b[a-z]{3}-?\d[a-z0-9]\d{2}\b/g, forma: (t) => t.replace(/-/g, '').toUpperCase(), soNoCaso: true },
];

/** Valor em reais e datas: só barram quando também estão no caso (um valor de alçada é do modelo). */
const RE_VALOR = /R\$\s?\d[\d.]*(?:,\d{2})?|\b\d{1,3}(?:\.\d{3})+,\d{2}\b|\b\d{3,},\d{2}\b/g;
const RE_DATA = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}\.\d{1,2}\.\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}º?\s+de\s+(?:janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+\d{4}\b/gi;
const RE_CONTEXTO_DE_NORMA = /\b(?:lei|decreto|medida provis[óo]ria|emenda|resolu[çc][ãa]o|portaria|s[úu]mula|provimento|instru[çc][ãa]o normativa|ato normativo)\b(?:[^.\n]|\.(?=\d)){0,60}$/i;

function dataCanonica(t) {
  const s = semAcento(t);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})o?\s+de\s+([a-z]+)\s+de\s+(\d{4})$/.exec(s.replace('º', 'o'));
  if (m && MESES[m[2]]) return `${m[3]}-${String(MESES[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}
const valorCanonico = (t) => soDigitos(t).replace(/^0+/, '');

// Nome próprio no texto do caso: duas ou mais palavras em Maiúscula ou CAIXA ALTA, com os
// conectivos de nome no meio. É daqui que saem as palavras que identificam pessoas e empresas.
const MAIUSCULA = 'A-ZÁÉÍÓÚÂÊÔÃÕÇÀÜ';
const MINUSCULA = 'a-záéíóúâêôãõçàü';
const PALAVRA_DE_NOME = `[${MAIUSCULA}](?:[${MINUSCULA}]+|[${MAIUSCULA}]+)`;
const RE_NOME = new RegExp(`${PALAVRA_DE_NOME}(?:[ \t]+(?:(?:d[aeo]s?|D[AEO]S?|e|E)[ \t]+)?${PALAVRA_DE_NOME})+`, 'g');
const CONECTIVOS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const tokensDe = (t) => semAcento(t).match(/[a-z0-9]+/g) || [];

/** Vocabulário (palavras sem acento) de um texto: o que o modelo pode usar sem ser nome do caso. */
export function vocabularioDe(texto) {
  return new Set(tokensDe(texto));
}

// ───────────────────────── o que se lê do caso ─────────────────────────

/** Mesma regra do `slug` de `autos-para-md.py` e do `slugDeArquivo` do indexador. */
const slugDoDocumento = (rel) => String(rel).replace(/\.[^./\\]+$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80);

const TEXTO_LEGIVEL = /\.(md|txt|json|yaml|yml|csv|html?|xml)$/i;
const MAX_POR_ARQUIVO = 20_000_000;
const MAX_TOTAL = 150_000_000;

/**
 * Texto de um .docx ou .odt, sem dependência: o zip é lido pelo diretório central e o XML do corpo
 * sai sem as marcas. Contrato, proposta e parecer chegam ao escritório em .docx; sem isto, a
 * varredura dos squads sem autos (contrato, parecer, notificação, acordo) não lia o documento do
 * cliente e só avisava "formato que a varredura não lê" (pedido do dono de 25/09/2026: o squad
 * também trabalha peça extrajudicial).
 */
function arquivoDoZip(buf, nome) {
  const fim = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (fim < 0 || fim + 22 > buf.length) return null;
  const n = buf.readUInt16LE(fim + 10);
  let off = buf.readUInt32LE(fim + 16);
  for (let i = 0; i < n && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const metodo = buf.readUInt16LE(off + 10);
    const tamanho = buf.readUInt32LE(off + 20);
    const lenNome = buf.readUInt16LE(off + 28);
    const lenExtra = buf.readUInt16LE(off + 30);
    const lenComentario = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    if (buf.toString('utf8', off + 46, off + 46 + lenNome) === nome && local + 30 <= buf.length) {
      const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const dados = buf.subarray(ini, ini + tamanho);
      if (metodo === 0) return dados;
      if (metodo === 8) return inflateRawSync(dados, { maxOutputLength: MAX_POR_ARQUIVO });
      return null;
    }
    off += 46 + lenNome + lenExtra + lenComentario;
  }
  return null;
}
export function textoDeDocumento(arquivo, buf) {
  let xml;
  try { xml = arquivoDoZip(buf, /\.docx$/i.test(arquivo) ? 'word/document.xml' : 'content.xml'); } catch { return null; }
  if (!xml) return null;
  return xml.toString('utf8')
    .replace(/<\/w:p>|<\/text:p>|<\/text:h>|<w:br\/>|<text:line-break\/>/g, '\n')
    .replace(/<w:tab\/>|<text:tab\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Quem lê uma pasta do caso: junta o texto, anota o que não leu e não lê o mesmo arquivo duas vezes. */
function leitorDoCaso(raiz) {
  const partes = [];
  const naoLidos = [];
  const lidos = new Set();
  let total = 0;
  const rel = (p) => relative(raiz, p).split('\\').join('/') || p;
  const estado = { avisar: true };
  const naoLeu = (x) => { if (estado.avisar) naoLidos.push(x); };
  const ler = (arquivo, base = dirname(arquivo)) => {
    if (lidos.has(arquivo)) return;
    lidos.add(arquivo);
    let st;
    try { st = lstatSync(arquivo); } catch { return; }
    if (st.isSymbolicLink()) { naoLeu({ arquivo: rel(arquivo), motivo: 'atalho (link simbólico), não seguido' }); return; }
    if (!st.isFile()) return;
    if (/\.pdf$/i.test(arquivo)) {
      // O conversor (`autos-para-md`) grava o texto em `<pasta>/<slug do caminho>/documento.md`; o
      // texto ao lado (`.md`, `.txt`) também vale. Sem nenhum dos dois, o PDF não foi lido.
      const sem = arquivo.replace(/\.pdf$/i, '');
      const candidatos = [`${sem}.md`, `${sem}.txt`, join(base, slugDoDocumento(relative(base, arquivo)), 'documento.md'), join(dirname(arquivo), slugDoDocumento(basename(arquivo)), 'documento.md')];
      if (!candidatos.some((c) => existsSync(c))) naoLeu({ arquivo: rel(arquivo), motivo: 'PDF sem texto convertido' });
      return;
    }
    if (/\.(docx|odt)$/i.test(arquivo)) {
      if (st.size > MAX_POR_ARQUIVO || total + st.size > MAX_TOTAL) { naoLeu({ arquivo: rel(arquivo), motivo: 'arquivo grande demais para a varredura' }); return; }
      let t;
      try { t = textoDeDocumento(arquivo, readFileSync(arquivo)); } catch { t = null; }
      if (t === null) { naoLeu({ arquivo: rel(arquivo), motivo: 'documento que a varredura não conseguiu abrir' }); return; }
      partes.push(t);
      total += st.size;
      return;
    }
    if (!TEXTO_LEGIVEL.test(arquivo)) {
      if (/\.(doc|rtf|jpe?g|png|tiff?|heic)$/i.test(arquivo)) naoLeu({ arquivo: rel(arquivo), motivo: 'formato que a varredura não lê' });
      return;
    }
    if (st.size > MAX_POR_ARQUIVO || total + st.size > MAX_TOTAL) { naoLeu({ arquivo: rel(arquivo), motivo: 'arquivo grande demais para a varredura' }); return; }
    try { partes.push(readFileSync(arquivo, 'utf8')); total += st.size; } catch { naoLeu({ arquivo: rel(arquivo), motivo: 'ilegível' }); }
  };
  const andar = (dir, profundidade = 0, base = dir) => {
    let entradas;
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const alvo = join(dir, e.name);
      if (e.isSymbolicLink()) { naoLeu({ arquivo: rel(alvo), motivo: 'atalho (link simbólico), não seguido' }); continue; }
      if (e.isDirectory()) { if (profundidade < 12) andar(alvo, profundidade + 1, base); } else ler(alvo, base);
    }
  };
  return { partes, naoLidos, ler, andar, rel, estado };
}

// Pasta da raiz do projeto que não é do caso: o que o motor, o pacote e os squads guardam.
const PASTA_DO_PROJETO = /^(?:squads|skills|acervo|_legalsquad|\.claude|\.git|node_modules|scripts|dashboard|plugin|templates)(?:\/|$)/;

/**
 * Pastas do projeto citadas no que o run gravou: o squad sem autos (contrato, parecer, notificação,
 * acordo, ato de cartório) recebe no intake "a pasta com a proposta e os documentos"
 * (`casos/<cliente>/<assunto>/`), e é lá que está o documento do cliente. Só pasta que existe,
 * dentro do projeto e fora do que é do motor ou do pacote; no máximo dez.
 */
function pastasCitadas(texto, raiz) {
  const saida = [];
  const raizAbs = resolve(raiz);
  for (const m of String(texto).matchAll(/(?:^|[\s`'"(«:])((?:\.\/)?[^\s`'"()«»<>*|]+\/[^\s`'"()«»<>*|]*)/g)) {
    const bruto = m[1].replace(/[.,;:)]+$/, '').replace(/\/+$/, '');
    if (!bruto || /^[a-z]+:\/\//i.test(bruto)) continue;
    const abs = resolve(raizAbs, bruto);
    if (abs === raizAbs || !abs.startsWith(`${raizAbs}/`)) continue;
    const r = relative(raizAbs, abs).split('\\').join('/');
    if (PASTA_DO_PROJETO.test(r) || saida.includes(abs)) continue;
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    saida.push(abs);
    if (saida.length >= 10) break;
  }
  return saida;
}

/**
 * Texto de tudo que é do caso: a pasta dos autos (pelo `caso.json`, nas duas formas, ou a do squad),
 * a pasta do caso acima dela (relato do profissional), `identificacao.json`, `caso.json`, o que o
 * run gravou (a saída e o estado) e as pastas que o run cita (os documentos do cliente de um squad
 * sem autos). Devolve também o que não pôde ser lido, com o motivo, para o chefe dizer ao
 * advogado que a conferência de nomes foi parcial.
 */
export function textoDoCaso(squadDir, { raiz = resolve(squadDir, '..', '..') } = {}) {
  const L = leitorDoCaso(raiz);
  const { partes, naoLidos, ler, andar, rel } = L;
  const autos = pastaDeAutos(squadDir);
  let casoRef = null;
  try { casoRef = JSON.parse(readFileSync(join(squadDir, 'caso.json'), 'utf8')); } catch { /* sem caso.json */ }
  const engloba = (p) => Boolean(p) && (resolve(raiz) === p || resolve(raiz).startsWith(`${p}/`));
  // A pasta do caso acima de `autos/` (onde mora o relato do profissional), só quando ela é do caso:
  // pela chave `pasta` do caso.json, ou a mãe de uma pasta `autos` apontada por referência.
  const pastaDoCaso = casoRef && typeof casoRef.pasta === 'string' ? resolve(raiz, casoRef.pasta)
    : casoRef && typeof casoRef.autos === 'string' && basename(resolve(raiz, casoRef.autos)) === 'autos' ? dirname(resolve(raiz, casoRef.autos)) : null;
  if (engloba(autos)) naoLidos.push({ arquivo: rel(autos) || '.', motivo: 'o caso.json aponta a pasta do projeto inteiro, não a de um caso' });
  else if (existsSync(autos)) andar(autos);
  // Squad sem autos (contrato, parecer): o `caso.json` aponta a pasta do cliente, sem `autos/`
  // dentro. Não é "pasta que não existe": os documentos estão na própria pasta, lida abaixo.
  else if (casoRef && !(pastaDoCaso && existsSync(pastaDoCaso))) naoLidos.push({ arquivo: rel(autos), motivo: 'a pasta do caso que o caso.json aponta não existe' });
  // `caso.json` apontando a raiz do projeto (ou acima) faria a varredura ler skills, acervo e os
  // outros casos como se fossem deste: fica de fora, dito.
  const englobaOProjeto = engloba(pastaDoCaso);
  if (englobaOProjeto) naoLidos.push({ arquivo: rel(pastaDoCaso) || '.', motivo: 'o caso.json aponta a pasta do projeto inteiro, não a de um caso' });
  else if (pastaDoCaso && existsSync(pastaDoCaso)) andar(pastaDoCaso);
  if (existsSync(join(squadDir, 'autos'))) andar(join(squadDir, 'autos'));
  // O que o run gravou reforça o índice (a peça tem os nomes), mas não é o caso: o .docx e o PDF
  // do pacote são a própria peça em outro formato, e não viram aviso de "não lido".
  L.estado.avisar = false;
  const antesDoRun = partes.length;
  for (const nome of ['identificacao.json', 'caso.json', 'run-state.json', 'state.json', 'review-state.json']) ler(join(squadDir, nome));
  // `_memory` e `_evals` são do squad (texto do compilador e do caso fictício), não do cliente.
  if (existsSync(join(squadDir, 'output'))) andar(join(squadDir, 'output'));
  L.estado.avisar = true;
  const citadas = pastasCitadas(partes.slice(antesDoRun).join('\n'), raiz).filter((p) => !engloba(p));
  for (const p of citadas) andar(p);
  if (!existsSync(autos) && !casoRef && !existsSync(join(squadDir, 'autos')) && !citadas.length) naoLidos.push({ arquivo: rel(join(squadDir, 'autos')), motivo: 'o squad não tem autos, caso.json nem pasta de documentos citada no run: a varredura cruzou só o que o run gravou' });
  return { texto: partes.join('\n'), naoLidos, pastas: citadas.map(rel) };
}

/**
 * O texto de todos os casos desta pasta: o de cada squad (pelo `textoDoCaso`) e as pastas de caso
 * da raiz (`casos/`, `clientes/`, `autos/`, `processos/`). A skill e a best-practice são da pasta,
 * não do squad: o nome do cliente de outro caso posto numa skill passava na varredura do squad
 * guardado (revisão v3, A3).
 */
export function textoDeTodosOsCasos(raiz) {
  const partes = [];
  let entradas = [];
  try { entradas = readdirSync(join(raiz, 'squads'), { withFileTypes: true }); } catch { /* sem squads */ }
  for (const e of entradas) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    partes.push(textoDoCaso(join(raiz, 'squads', e.name), { raiz }).texto);
  }
  const L = leitorDoCaso(raiz);
  for (const nome of ['casos', 'Casos', 'clientes', 'Clientes', 'autos', 'processos', 'Processos']) if (existsSync(join(raiz, nome))) L.andar(join(raiz, nome));
  partes.push(...L.partes);
  return { texto: partes.join('\n'), naoLidos: L.naoLidos };
}

// ───────────────────────── o índice do caso ─────────────────────────

/**
 * O que do caso se procura no modelo: os identificadores (forma canônica), os valores, as datas e
 * as palavras de nome. Palavra de nome é a que aparece num nome próprio do caso e NÃO está no
 * vocabulário dos modelos de pacote (que é português jurídico): "Pires", "Aurora", "Paineiras"
 * entram; "Banco", "Tribunal", "Maria" (que os casos fictícios dos modelos usam) não.
 */
export function indiceDoCaso(textoCaso, { vocabulario = new Set() } = {}) {
  const caso = String(textoCaso || '');
  const idsDoCaso = new Set();
  for (const p of IDENTIFICADORES) for (const m of caso.matchAll(p.re)) idsDoCaso.add(`${p.motivo}|${p.forma(m[0])}`);
  const valores = new Set([...caso.matchAll(RE_VALOR)].map((m) => valorCanonico(m[0])).filter((v) => v.length >= 4));
  const datas = new Set([...caso.matchAll(RE_DATA)].map((m) => dataCanonica(m[0])));
  const palavrasDeNome = new Set();
  // Pares de palavras de um mesmo nome ("joao silva" de "João Carlos da Silva"): pegam o nome comum,
  // cujas palavras soltas também estão nos casos fictícios dos modelos e por isso não são raras.
  const paresDeNome = new Set();
  for (const m of caso.matchAll(RE_NOME)) {
    const toks = tokensDe(m[0]).filter((t) => !CONECTIVOS.has(t) && !/^\d+$/.test(t));
    if (toks.length < 2) continue;
    for (const t of toks) if (t.length >= 3 && !vocabulario.has(t)) palavrasDeNome.add(t);
    if (toks.length > 6) continue;
    for (let i = 0; i < toks.length; i++) for (let j = i + 1; j < toks.length; j++) if (toks[i].length >= 3 && toks[j].length >= 3) paresDeNome.add(`${toks[i]} ${toks[j]}`);
  }
  // Número do caso que nenhum padrão nomeia (contrato, conta, cartão, telefone sem DDD): toda
  // sequência de 5 ou mais dígitos, com os finais de 4, 8 e 9 dígitos das longas, para o "cartão
  // final 2291" e o celular sem DDD (revisão v2, N12).
  const numeros = new Set();
  const finais = new Set();
  for (const m of caso.matchAll(RE_NUMERO)) {
    const d = soDigitos(m[0]);
    if (d.length < 5) continue;
    numeros.add(d);
    if (d.length >= 8) for (const n of [4, 8, 9]) if (d.length > n) finais.add(d.slice(-n));
  }
  // Prenome da parte ("Josefa" de "JOSEFA CARVALHO BRITTO"): conta mesmo sendo comum, quando o modelo
  // o usa junto de "cliente", "autora", "dona" (N12).
  const prenomes = new Set();
  for (const m of caso.matchAll(RE_NOME)) { const t = tokensDe(m[0])[0]; if (t && t.length >= 3 && !CONECTIVOS.has(t)) prenomes.add(t); }
  return { idsDoCaso, valores, datas, palavrasDeNome, paresDeNome, numeros, finais, prenomes, vazio: !caso.trim() };
}

const RE_NUMERO = /\b\d[\d]*(?:[ .\-/]\d+)*\b/g;
const RE_PAPEL_DA_PARTE = /\b(?:cliente|autora?|r[ée]u|r[ée]|dona|senhora?|sra?\.?|requerente|reclamante|paciente|assistid[oa])\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+)/g;

// ───────────────────────── a varredura ─────────────────────────

/**
 * Achados de dado do caso em `textos` (`{ rotulo: texto }`): identificador em qualquer lugar (a
 * menos que esteja no conhecido: o texto dos modelos de pacote e o perfil do escritório), e valor,
 * data e palavra de nome que também estão no caso. O mesmo trecho repetido sai uma vez.
 */
export function achadosDeCaso(textos, { caso = null, conhecido = '' } = {}) {
  const achados = [];
  const vistos = new Set();
  const conhecidoNorm = semAcento(conhecido);
  const conhecidoDigitos = new Set((conhecido.match(/\d[\d.\-/\s()]{5,}\d/g) || []).map(soDigitos).filter((d) => d.length >= 7));
  const idsConhecidos = new Set();
  for (const p of IDENTIFICADORES) for (const m of String(conhecido).matchAll(p.re)) idsConhecidos.add(`${p.motivo}|${p.forma(m[0])}`);
  // Data e valor se comparam pela forma canônica: "14/01/2026" no modelo de pacote libera "14 de
  // janeiro de 2026" também (e o inverso), como no caso.
  const datasConhecidas = new Set([...String(conhecido).matchAll(RE_DATA)].map((m) => dataCanonica(m[0])));
  const valoresConhecidos = new Set([...String(conhecido).matchAll(RE_VALOR)].map((m) => valorCanonico(m[0])));
  const anotar = (arquivo, trecho, motivo, dado = trecho, exato = dado) => {
    const chave = `${motivo.replace(/ que aparece no caso.*$/, '')}|${semAcento(dado).replace(/\s+/g, ' ').trim()}`;
    if (vistos.has(chave) || achados.length >= 80) return;
    vistos.add(chave);
    // `dado`: o que trocar com `--substituir` (o trecho vem com a vizinhança e as reticências).
    achados.push({ arquivo, trecho: trecho.trim(), motivo, chave, dado: String(exato).trim() });
  };
  for (const [arquivo, bruto] of Object.entries(textos)) {
    const texto = String(bruto ?? '');
    const ocupado = [];
    const sobrepoe = (i, f) => ocupado.some(([a, b]) => i < b && f > a);
    for (const p of IDENTIFICADORES) {
      for (const m of texto.matchAll(p.re)) {
        const trecho = m[0].replace(/[.\s]+$/, '');
        const i = m.index;
        const f = i + m[0].length;
        if (sobrepoe(i, f)) continue;
        if (p.filtro && !p.filtro(trecho)) continue;
        const forma = p.forma(trecho);
        const chave = `${p.motivo}|${forma}`;
        if (p.soNoCaso && !caso?.idsDoCaso?.has(chave)) continue;
        const dig = soDigitos(trecho);
        if (idsConhecidos.has(chave) || (dig.length >= 7 && conhecidoDigitos.has(dig)) || (p.motivo === 'e-mail' && conhecidoNorm.includes(forma))) { ocupado.push([i, f]); continue; }
        // Telefone de 10 dígitos que é pedaço de um número maior (CNJ, conta) não é telefone.
        if (p.motivo === 'telefone' && dig.length < 10) continue;
        ocupado.push([i, f]);
        anotar(arquivo, trecho, caso?.idsDoCaso?.has(chave) ? `${p.motivo} que aparece no caso` : p.motivo);
      }
    }
    if (!caso || caso.vazio) continue;
    for (const m of texto.matchAll(RE_NUMERO)) {
      if (sobrepoe(m.index, m.index + m[0].length)) continue;
      // Data e valor têm a régua deles (e dariam o mesmo achado duas vezes).
      if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(m[0]) || /^,\d{2}/.test(texto.slice(m.index + m[0].length))) continue;
      const d = soDigitos(m[0]);
      const antes = texto.slice(Math.max(0, m.index - 30), m.index);
      const final = d.length === 4 && /\b(?:final|terminad[oa] em|finais)\s*$/i.test(antes) && caso.finais?.has(d);
      const doCaso = caso.numeros?.has(d) || (d.length >= 8 && (caso.finais?.has(d) || [8, 9].some((n) => d.length > n && caso.numeros?.has(d.slice(-n)))));
      if (!final && (d.length < 5 || !doCaso)) continue;
      if (conhecidoDigitos.has(d) || RE_CONTEXTO_DE_NORMA.test(antes)) continue;
      ocupado.push([m.index, m.index + m[0].length]);
      anotar(arquivo, m[0], 'número que aparece no caso');
    }
    for (const m of texto.matchAll(RE_PAPEL_DA_PARTE)) {
      const t = semAcento(m[1]);
      if (caso.prenomes?.has(t)) anotar(arquivo, m[0], `nome de parte do caso («${m[1]}»)`, t, m[1]);
    }
    for (const m of texto.matchAll(RE_VALOR)) {
      if (sobrepoe(m.index, m.index + m[0].length)) continue;
      const v = valorCanonico(m[0]);
      if (v.length >= 4 && caso.valores.has(v) && !valoresConhecidos.has(v)) anotar(arquivo, m[0], 'valor que aparece no caso');
    }
    for (const m of texto.matchAll(RE_DATA)) {
      const d = dataCanonica(m[0]);
      if (!caso.datas.has(d)) continue;
      // Data de norma ("Lei 13.964, de 24 de dezembro de 2019") é do direito, não do caso (D19).
      if (RE_CONTEXTO_DE_NORMA.test(texto.slice(Math.max(0, m.index - 80), m.index))) continue;
      if (datasConhecidas.has(d)) continue;
      anotar(arquivo, m[0], 'data que aparece no caso', d);
    }
    // Nome: palavra rara de um nome do caso, ou duas palavras de um mesmo nome em sequência (com
    // "da", "de", "e" no meio), com a vizinhança para o advogado ler. `semAcento` preserva o
    // comprimento do texto (só tira os diacríticos combinados), então o índice vale nos dois.
    const norm = semAcento(texto.normalize('NFC'));
    const original = texto.normalize('NFC');
    const toks = [...norm.matchAll(/[a-z0-9]+/g)].map((m) => ({ t: m[0], i: m.index }));
    const trechoEm = (i, f) => `…${original.slice(Math.max(0, i - 30), Math.min(original.length, f + 30)).replace(/\s+/g, ' ')}…`;
    const noConhecido = (re) => conhecidoNorm && re.test(conhecidoNorm);
    for (let k = 0; k < toks.length; k++) {
      const { t, i } = toks[k];
      if (CONECTIVOS.has(t)) continue;
      if (caso.palavrasDeNome.has(t) && !noConhecido(new RegExp(`\\b${t}\\b`))) {
        anotar(arquivo, trechoEm(i, i + t.length), `nome que aparece no caso («${original.slice(i, i + t.length)}»)`, t, original.slice(i, i + t.length));
        continue;
      }
      let prox = k + 1;
      while (prox < toks.length && CONECTIVOS.has(toks[prox].t) && prox - k <= 2) prox++;
      if (prox >= toks.length) continue;
      const par = `${t} ${toks[prox].t}`;
      if (!caso.paresDeNome.has(par)) continue;
      if (noConhecido(new RegExp(`\\b${t}(?:\\s+(?:d[aeo]s?|e))?\\s+${toks[prox].t}\\b`))) continue;
      const fimPar = toks[prox].i + toks[prox].t.length;
      anotar(arquivo, trechoEm(i, fimPar), `nome que aparece no caso («${original.slice(i, fimPar)}»)`, par, original.slice(i, fimPar));
    }
  }
  return achados;
}

