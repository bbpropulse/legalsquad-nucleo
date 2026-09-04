#!/usr/bin/env node
// Consolida a carteira: varre acervo/casos/*/carteira-row.json (uma linha-plana
// por caso, emitida pela skill `carteira-lote`) e produz o dataset da carteira
// em acervo/casos/_carteira/carteira.{json,csv} — a TABELA normalizada que o
// dashboard, o relatório executivo e o mail-merge consomem.
//
// Determinístico e sem dependência de YAML: cada carteira-row.json é JSON plano
// (JSON.parse basta). Linhas malformadas são puladas com aviso, nunca derrubam a
// consolidação. acervo/casos/ é sigiloso (gitignored) — o dataset nunca sai da máquina.
//
// O esquema é NEUTRO quanto à matéria: o motor não sabe qual área do Direito está
// instalada. `partes` e `classificacao` são genéricos; `reu`/`tipos_penais` (esquema
// criminal antigo) continuam sendo LIDOS como entrada legada e mapeados para eles.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Colunas canônicas do dataset (alinhadas ao contrato do dashboard e ao dossie.yaml).
export const CARTEIRA_COLUNAS = [
  'processo', 'polo', 'partes', 'classificacao', 'data_fato', 'valor',
  'fase', 'proximo_ato', 'prazo_fatal', 'riscos_n', 'o_que_falta_n',
  'confianca', 'atualizado_em',
];

function toCell(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  return String(value);
}

function csvEscape(cell) {
  let text = String(cell);
  // Neutraliza injeção de fórmula (OWASP CSV Injection / CWE-1236): planilhas
  // interpretam células iniciadas por = + - @ (ou tab/CR) como fórmula executável.
  // Campos como partes/proximo_ato vêm de OCR/DJEN (conteúdo de terceiros) — prefixa
  // com apóstrofo para forçar leitura como texto antes de aplicar o quoting.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Normaliza texto para comparação (remove acento, minúsculo, trim): 'Execução' -> 'execucao'.
function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Converte o `valor` do caso num número (reais) ou null. Aceita number puro e
// string em formato BR (R$, ponto de milhar, vírgula decimal). O que não for um
// número limpo vira null — nunca uma soma parcial silenciosa (ex.: parseFloat
// de "50.000" daria 50). Ex.: "R$ 1.500.000,00" -> 1500000; "50.000" -> 50000.
function parseValor(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/r\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) {
    // vírgula = decimal (BR); pontos são separador de milhar.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    // só pontos formando grupos de 3 -> separador de milhar (ex.: 50.000).
    s = s.replace(/\./g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function normalizeRow(raw) {
  return {
    processo: toCell(raw.processo),
    polo: toCell(raw.polo),
    // `reu` é entrada legada do esquema criminal — vira `partes` sem perder o dado.
    partes: toCell(raw.partes ?? raw.reu),
    // idem para `tipos_penais`: a classificação da causa é definida pela área instalada.
    classificacao: toList(raw.classificacao ?? raw.tipos_penais),
    data_fato: toCell(raw.data_fato),
    valor: parseValor(raw.valor),
    fase: toCell(raw.fase),
    proximo_ato: toCell(raw.proximo_ato),
    prazo_fatal: toCell(raw.prazo_fatal),
    riscos_n: Number.isFinite(raw.riscos_n) ? raw.riscos_n : (Array.isArray(raw.riscos) ? raw.riscos.length : 0),
    o_que_falta_n: Number.isFinite(raw.o_que_falta_n) ? raw.o_que_falta_n : (Array.isArray(raw.o_que_falta) ? raw.o_que_falta.length : 0),
    confianca: toCell(raw.confianca),
    atualizado_em: toCell(raw.atualizado_em),
  };
}

// Ordena por prazo fatal ascendente; casos sem prazo vão para o fim.
function byPrazo(a, b) {
  if (!a.prazo_fatal && !b.prazo_fatal) return a.processo.localeCompare(b.processo);
  if (!a.prazo_fatal) return 1;
  if (!b.prazo_fatal) return -1;
  return a.prazo_fatal.localeCompare(b.prazo_fatal) || a.processo.localeCompare(b.processo);
}

// Lê acervo/casos/*/carteira-row.json e devolve { rows, skipped, diretorio_ausente }.
// `diretorio_ausente` distingue "não há casos" de "não achei o diretório": os números
// da carteira alimentam relatório executivo e não podem virar um 0 apresentado como fato.
export function consolidarCarteira(casosDir) {
  const rows = [];
  const skipped = [];
  if (!existsSync(casosDir)) return { rows, skipped, diretorio_ausente: true };
  for (const entry of readdirSync(casosDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const rowPath = join(casosDir, entry.name, 'carteira-row.json');
    if (!existsSync(rowPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(rowPath, 'utf8'));
      const row = normalizeRow(parsed);
      if (!row.processo) { skipped.push({ dir: entry.name, motivo: 'sem processo' }); continue; }
      rows.push(row);
    } catch (error) {
      skipped.push({ dir: entry.name, motivo: `json inválido: ${error.message}` });
    }
  }
  rows.sort(byPrazo);
  return { rows, skipped, diretorio_ausente: false };
}

export function toCsv(rows) {
  const header = CARTEIRA_COLUNAS.join(',');
  // Normaliza antes de serializar para aceitar tanto rows já consolidadas quanto
  // linhas cruas com os nomes legados (reu/tipos_penais).
  const lines = rows.map(normalizeRow).map((row) => CARTEIRA_COLUNAS
    .map((col) => csvEscape(toCell(row[col])))
    .join(','));
  return [header, ...lines].join('\n');
}

// Consolida e grava acervo/casos/_carteira/carteira.{json,csv}. Retorna o resumo.
// Diretório ausente NÃO grava dataset: um carteira.json vazio seria lido depois
// como "carteira sem casos" — mentira com cara de fato.
export function writeCarteira(casosDir) {
  const { rows, skipped, diretorio_ausente } = consolidarCarteira(casosDir);
  if (diretorio_ausente) return { total: null, skipped, outDir: null, diretorio_ausente: true, casosDir };
  const outDir = join(casosDir, '_carteira');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'carteira.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'carteira.csv'), `${toCsv(rows)}\n`, 'utf8');
  return { total: rows.length, skipped, outDir, diretorio_ausente: false };
}

// Fases neutras que o relatório sempre exibe (zeradas quando não ocorrem). Não são
// uma taxonomia fechada: qualquer outra fase declarada pela área instalada entra
// no agregado com a própria chave — o motor não presume o rito de nenhuma matéria.
export const FASES = ['pre_processual', 'inicial', 'instrucao', 'recurso', 'execucao', 'arquivado'];

// Agrega o dataset em métricas determinísticas para o relatório executivo:
// contagem por fase, casos em risco (riscos_n > 0), com pendência (o_que_falta_n > 0),
// com/sem prazo fatal, por nível de confiança e valor total (soma dos valores numéricos).
export function metricasCarteira(casosDir) {
  const { rows, skipped, diretorio_ausente } = consolidarCarteira(casosDir);
  const por_fase = { sem_fase: 0 };
  for (const fase of FASES) por_fase[fase] = 0;
  if (diretorio_ausente) {
    // total null (e não 0): "não achei o diretório" ≠ "não há casos".
    return {
      total: null, por_fase, por_confianca: { alta: 0, media: 0, baixa: 0, sem: 0 },
      em_risco: null, com_pendencia: null, com_prazo: null, sem_prazo: null,
      valor_total: null, pulados: 0, diretorio_ausente: true, casosDir,
    };
  }
  const por_confianca = { alta: 0, media: 0, baixa: 0, sem: 0 };
  let em_risco = 0;
  let com_pendencia = 0;
  let com_prazo = 0;
  let valor_total = 0;
  for (const row of rows) {
    const fase = norm(row.fase);
    if (!fase) por_fase.sem_fase += 1;
    else por_fase[fase] = (por_fase[fase] || 0) + 1;
    const conf = norm(row.confianca);
    por_confianca[conf === 'alta' || conf === 'media' || conf === 'baixa' ? conf : 'sem'] += 1;
    if (Number(row.riscos_n) > 0) em_risco += 1;
    if (Number(row.o_que_falta_n) > 0) com_pendencia += 1;
    if (row.prazo_fatal) com_prazo += 1;
    // valor já foi normalizado (número ou null) em normalizeRow — soma só número finito.
    if (typeof row.valor === 'number' && Number.isFinite(row.valor)) valor_total += row.valor;
  }
  return {
    total: rows.length,
    por_fase,
    por_confianca,
    em_risco,
    com_pendencia,
    com_prazo,
    sem_prazo: rows.length - com_prazo,
    valor_total,
    pulados: skipped.length,
    diretorio_ausente: false,
  };
}

function isMain() {
  if (!process.argv[1]) return false;
  // O loader ESM resolve import.meta.url para o caminho REAL do arquivo, mas
  // process.argv[1] chega literal: num root acessado via symlink (ex.: /tmp ->
  // /private/tmp no macOS) os dois divergiam e o script rodava MUDO, saindo 0
  // sem emitir JSON -- e a carteira falhava no briefing como "não emitiu JSON
  // válido", sem pista. Realpath dos DOIS lados; caminho que não resolve
  // (arquivo removido no meio) cai para o literal em vez de quebrar.
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
}

if (isMain()) {
  const asJson = process.argv.includes('--json');
  const casosDir = join(process.cwd(), 'acervo', 'casos');
  const summary = writeCarteira(casosDir);
  if (summary.diretorio_ausente) {
    // Fail-closed: sem o diretório não há número verdadeiro a reportar.
    const msg = `CARTEIRA: diretório de casos não encontrado (${casosDir}) — nada foi consolidado. Isto NÃO significa carteira vazia.`;
    if (asJson) console.log(JSON.stringify(summary));
    console.error(msg);
    process.exit(1);
  }
  if (asJson) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(`CARTEIRA:${summary.total} casos consolidados em ${summary.outDir}`);
    if (summary.skipped.length) {
      console.log(`  pulados: ${summary.skipped.length}`);
      for (const s of summary.skipped) console.log(`   - ${s.dir}: ${s.motivo}`);
    }
  }
}
