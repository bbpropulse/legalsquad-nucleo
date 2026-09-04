#!/usr/bin/env node
// Indexador do acervo do LegalSquad.
// Varre acervo/ e (re)gera acervo/_index.yaml — o catálogo que os agentes de
// pesquisa consultam ANTES da web (best-practice `pesquisa-jurisprudencial`).
// Uso: npm run indexar-acervo
//      node scripts/indexar-acervo.js --root /caminho/do/projeto [--strict]
// A pasta acervo/casos/ é IGNORADA (dados sensíveis de cliente — LGPD/sigilo).
//
// A raiz é parametrizável porque o pack-apply (F3) instala o pacote de área no
// projeto do USUÁRIO e precisa reindexar lá, não dentro do pacote. Sem `--root`
// o default é a pasta que contém este script — o comportamento antigo, intacto.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `--root DIR`, `--root=DIR` ou o primeiro argumento posicional. Flags conhecidas
// (--strict) nunca são confundidas com raiz.
function raizDosArgumentos(argv, padrao) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) {
        console.error('--root exige um diretório.');
        process.exit(1);
      }
      return resolve(argv[i + 1]);
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (!value) {
        console.error('--root exige um diretório.');
        process.exit(1);
      }
      return resolve(value);
    }
    if (!arg.startsWith('-')) return resolve(arg);
  }
  return padrao;
}

const PROJETO = raizDosArgumentos(process.argv.slice(2), join(__dirname, '..'));
const ROOT = join(PROJETO, 'acervo');
const VAULT_MAP = join(PROJETO, '_legalsquad', '_memory', 'vault-map.yaml');

const STRICT = process.argv.includes('--strict'); // CI: falha (exit 1) se houver wikilink quebrado

// Fail-closed com diagnóstico: raiz errada é o erro mais provável de quem passa
// `--root`, e um stack de ENOENT não diz qual pasta faltou.
if (!existsSync(ROOT)) {
  console.error(`Pasta de acervo não existe: ${ROOT}`);
  console.error('Passe --root <diretório do projeto> ou crie o acervo antes de indexar.');
  process.exit(1);
}

const SKIP_DIRS = new Set(['casos']); // sigilo de cliente — nunca indexar
const TIPO_POR_PASTA = {
  jurisprudencia: 'jurisprudencia',
  doutrina: 'doutrina',
  legislacao: 'legislacao',
  sumulas: 'sumula',
  teses: 'tese',
  'teses-modelos': 'modelo',
};
const EXT_OK = new Set(['.md', '.pdf', '.txt', '.docx', '.rtf']);
// Formatos binários: se houver um .md irmão (mesmo nome), indexa só o .md legível
// (os agentes leem markdown; o .docx fica como fonte original não indexada).
const PREFER_MD_OVER = new Set(['.docx', '.rtf']);
// Packs de acervo do SPEC (docs/specs/acervo-server/SPEC.md) chegam como
// `.jsonl.zst` — um contêiner comprimido de N documentos, não um documento.
// Este indexador ainda NÃO sabe abri-los (é trabalho do F3). Até lá eles são
// reportados, nunca silenciados: "não sei ler" ≠ "não existe".
const EXT_PACK = ['.jsonl.zst'];
const ehPack = (nome) => EXT_PACK.some((suf) => nome.toLowerCase().endsWith(suf));
const packsEncontrados = [];
const CONFIANCA_VALIDA = new Set(['VERIFIED_OFFICIAL', 'DISCOVERY_ONLY', 'QUARANTINED']);

function frontmatterDe(full) {
  if (extname(full).toLowerCase() !== '.md') return {};
  let raw;
  try { raw = readFileSync(full, 'utf8'); } catch { return {}; }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const value = (key) => {
    const found = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return found ? found[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  return {
    confianca: value('confianca'),
    urlOficial: value('url_oficial'),
    consultadoEm: value('consultado_em'),
    proximaRevalidacao: value('proxima_revalidacao'),
  };
}

function provenienciaDe(full) {
  const fm = frontmatterDe(full);
  const declarada = fm.confianca;
  return {
    confianca: CONFIANCA_VALIDA.has(declarada) ? declarada : (declarada ? 'QUARANTINED' : 'DISCOVERY_ONLY'),
    urlOficial: fm.urlOficial,
    consultadoEm: fm.consultadoEm,
    proximaRevalidacao: fm.proximaRevalidacao,
    classificacaoInvalida: declarada && !CONFIANCA_VALIDA.has(declarada) ? declarada : null,
  };
}

/**
 * Tipo pelo nome da pasta — pulando o prefixo do pacote sincronizado.
 *
 * `acervo/` é do usuário; a única subárvore que o sync pode gravar é
 * `acervo/_packs/<pack_id>/` (ver `EXCECOES_GERENCIADAS` em pack-format). Lá
 * dentro a estrutura se REPETE — `jurisprudencia/`, `legislacao/`, `sumulas/` —,
 * então classificar pelo primeiro segmento devolvia `outro` para todo julgado
 * baixado. Ele existiria no disco e ficaria invisível para quem busca
 * jurisprudência: o `verificador-citacoes` consulta por tipo, e "não achei"
 * viraria "não existe" sobre conteúdo recém-instalado.
 */
function tipoDe(rel) {
  const partes = rel.split('/');
  // `_packs/<pack_id>/<tipo>/...` — dois segmentos de prefixo gerenciado.
  const inicio = partes[0] === '_packs' && partes.length > 2 ? 2 : 0;
  return TIPO_POR_PASTA[partes[inicio]] || 'outro';
}

function temaDe(full, rel) {
  if (extname(full).toLowerCase() === '.md') {
    try {
      const c = readFileSync(full, 'utf8');
      const h = c.match(/^#\s+(.+)$/m);
      if (h) return h[1].trim().replace(/\s+/g, ' ').slice(0, 140);
    } catch { /* ignore */ }
  }
  return basename(rel).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
}

function tagsDe(rel) {
  const stop = new Set(['crime', 'transversal', 'as', 'de', 'da', 'do', 'e', 'em', 'os', 'principais']);
  return [...new Set(
    basename(rel).replace(/\.[^.]+$/, '').toLowerCase().split(/[-_\s]+/)
      .filter((w) => w.length > 2 && !stop.has(w)),
  )].slice(0, 8);
}

// Extrai os alvos de wikilinks [[Nota]], [[Nota|alias]], [[Nota#trecho]],
// [[pasta/Nota]] de um arquivo .md. O lookbehind (?<!!) ignora embeds de mídia
// ![[arquivo.png]], que apontam para anexos e não para notas.
const WIKILINK_RE = /(?<!!)\[\[([^\]]+)\]\]/g;
function wikilinksDe(full) {
  let raw;
  try { raw = readFileSync(full, 'utf8'); } catch { return []; }
  const out = [];
  for (const m of raw.matchAll(WIKILINK_RE)) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

// True se há um vault Obsidian configurado (vault-map.yaml com vault_root não-vazio).
// Quando há, wikilinks não encontrados no acervo podem viver no vault (privado),
// então não são tratados como quebrados — apenas informados.
function vaultConfigured() {
  try {
    const m = readFileSync(VAULT_MAP, 'utf8').match(/^\s*vault_root:\s*["']?([^"'\n]*)/m);
    return !!(m && m[1].trim());
  } catch {
    return false;
  }
}

function walk(dir, acc) {
  const entries = readdirSync(dir, { withFileTypes: true });
  // Nomes-base que já têm versão .md neste diretório (para preferir o legível).
  const temMd = new Set(
    entries
      .filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.md')
      .map((e) => e.name.slice(0, -3)),
  );
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    const rel = relative(ROOT, full).split(/[/\\]/).join('/');
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, acc);
      continue;
    }
    if (ehPack(e.name)) {
      packsEncontrados.push(rel);
      continue;
    }
    const ext = extname(e.name).toLowerCase();
    if (!EXT_OK.has(ext) || e.name === '_index.yaml' || e.name === 'README.md') continue;
    // .docx/.rtf com .md irmão → pula o binário, indexa só o .md.
    if (PREFER_MD_OVER.has(ext) && temMd.has(e.name.slice(0, -ext.length))) continue;
    acc.push({
      path: rel,
      tipo: tipoDe(rel),
      tema: temaDe(full, rel),
      tags: tagsDe(rel),
      links: ext === '.md' ? wikilinksDe(full) : [],
      ...provenienciaDe(full),
    });
  }
}

const entries = [];
walk(ROOT, entries);
entries.sort((a, b) => a.path.localeCompare(b.path));

let y = '# Índice do Acervo — GERADO por `npm run indexar-acervo` (não editar à mão; será sobrescrito).\n';
y += '# Os agentes de pesquisa consultam este índice ANTES da web. Pasta casos/ é omitida (sigilo).\n';
y += '# Confiança: VERIFIED_OFFICIAL exige declaração explícita; ausência = DISCOVERY_ONLY.\n';
y += `# Última indexação: ${entries.length} arquivos.\n\n`;
y += 'acervo:\n';
for (const it of entries) {
  y += `  - path: ${it.path}\n`;
  y += `    tipo: ${it.tipo}\n`;
  y += `    tema: ${JSON.stringify(it.tema)}\n`;
  y += `    tags: [${it.tags.join(', ')}]\n`;
  y += `    confianca: ${it.confianca}\n`;
  if (it.urlOficial) y += `    url_oficial: ${JSON.stringify(it.urlOficial)}\n`;
  if (it.consultadoEm) y += `    consultado_em: ${JSON.stringify(it.consultadoEm)}\n`;
  if (it.proximaRevalidacao) y += `    proxima_revalidacao: ${JSON.stringify(it.proximaRevalidacao)}\n`;
}
writeFileSync(join(ROOT, '_index.yaml'), y, 'utf8');
console.log(`Indexados ${entries.length} arquivos em acervo/_index.yaml`);
if (packsEncontrados.length) {
  console.warn(
    `Atenção: ${packsEncontrados.length} pack(s) de acervo (.jsonl.zst) NÃO foram indexados — o indexador ainda não abre packs:`,
  );
  for (const p of packsEncontrados) console.warn(`  - ${p}`);
  console.warn('O conteúdo deles existe, mas está invisível para a busca. Não trate como acervo vazio.');
}
const classificacoesInvalidas = entries.filter((it) => it.classificacaoInvalida);
if (classificacoesInvalidas.length) {
  console.error('Classificações de confiança inválidas foram colocadas em QUARANTINED:');
  for (const it of classificacoesInvalidas) console.error(`  - ${it.path}: ${it.classificacaoInvalida}`);
  process.exitCode = 1;
}

// --- Validação de wikilinks (saúde do grafo de conhecimento) ---
// Confere cada [[link]] do acervo contra as notas existentes. Links não
// resolvidos são "quebrados" — exceto quando há vault Obsidian configurado,
// caso em que podem viver no vault (privado, não indexado).
// Normaliza p/ comparação: minúsculas + remove SÓ extensões conhecidas (não um
// ponto qualquer — nomes jurídicos têm pontos: "Lei 11.343", "HC 126.292").
const norm = (s) => {
  const lower = s.toLowerCase();
  const ext = extname(lower);
  return EXT_OK.has(ext) ? lower.slice(0, -ext.length) : lower;
};
const known = new Set();
for (const it of entries) {
  known.add(norm(basename(it.path))); // por nome de nota
  known.add(norm(it.path)); // por caminho relativo
}
const broken = [];
let totalLinks = 0;
for (const it of entries) {
  for (const link of it.links || []) {
    totalLinks++;
    const byName = norm(link.split(/[/\\]/).pop());
    const byPath = norm(link);
    if (!known.has(byName) && !known.has(byPath)) broken.push({ from: it.path, link });
  }
}

if (totalLinks > 0) {
  if (broken.length === 0) {
    console.log(`Wikilinks: ${totalLinks} verificados, 0 quebrados.`);
  } else if (vaultConfigured()) {
    console.log(`Wikilinks: ${totalLinks} verificados, ${broken.length} fora do acervo (vault configurado — podem estar no vault):`);
    for (const b of broken) console.log(`  - ${b.from} → [[${b.link}]]`);
  } else {
    console.log(`Wikilinks: ${totalLinks} verificados, ${broken.length} QUEBRADOS:`);
    for (const b of broken) console.log(`  - ${b.from} → [[${b.link}]]`);
    if (STRICT) process.exitCode = 1;
  }
}
