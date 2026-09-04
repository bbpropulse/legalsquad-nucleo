#!/usr/bin/env node
// Builds the public distribution tree: exactly the npm-packable set (package.json
// `files[]`) plus package.json and the mentee-facing docs. This is what goes into
// the PUBLIC bbpropulse/legalsquad-nucleo repo — no dev history, no tests, no
// dev-only dirs, no commercial staging, and nothing gitignored (real cases,
// _memory, .env are never referenced here). Re-run on each release, then commit
// and push the output dir to the dist repo.
//
// Usage: node scripts/build-dist.mjs <output-dir>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = process.argv[2];
if (!OUT) {
  console.error('Uso: node scripts/build-dist.mjs <diretório-de-saída>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// files[] is the authoritative distributable set. Extra root files the mentee reads.
const DOCS = ['README.md', 'INSTALL.md', 'GUIA-ALUNO.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md'];
// O plugin do Claude Code e o marketplace que o serve NÃO pertencem ao pacote
// npm (quem instala via `npm install -g` não precisa deles localmente) mas
// PRECISAM chegar a este mesmo repositório de qualquer forma: o marketplace
// (.claude-plugin/marketplace.json) aponta o plugin por CAMINHO RELATIVO
// ("./plugin"), e `claude plugin marketplace add` resolve os dois como
// irmãos dentro de UM único repositório publicado. Por isso entram aqui, ao
// lado de DOCS, e não em pkg.files — mesma razão, alvo diferente: DOCS é
// para quem lê, isto é para quem instala o plugin.
//
// Achado real, não hipotético: antes desta linha, nenhum dos dois chegava
// aqui, desde o commit que introduziu o plugin — `claude plugin marketplace
// add bbpropulse/legalsquad-nucleo`, o comando que a doc do próprio plugin
// documenta, nunca teve o que resolver no repo público. Confirmado clonando
// bbpropulse/legalsquad-nucleo antes deste fix: nem .claude-plugin/ nem
// plugin/ existiam na raiz.
const PLUGIN_MARKETPLACE = ['.claude-plugin/', 'plugin/'];
const entries = [...(pkg.files || []), 'package.json', ...DOCS, ...PLUGIN_MARKETPLACE];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let copied = 0;
let skipped = 0;
for (const entry of entries) {
  const src = join(ROOT, entry.replace(/\/$/, ''));
  if (!existsSync(src)) { skipped++; continue; }
  const dest = join(OUT, entry.replace(/\/$/, ''));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => !/(^|\/)node_modules(\/|$)|(^|\/)\.git(\/|$)|(^|\/)__pycache__(\/|$)|\.pyc$|tsconfig\.tsbuildinfo$/.test(p),
  });
  copied++;
}

// ---------------------------------------------------------------------------
// O README público não pode linkar o que a árvore pública não tem.
//
// `docs/specs/` é doc de desenvolvimento e não entra em `files[]`, então não é
// copiada — mas o README linka as specs por caminho relativo (que funciona no
// repo de desenvolvimento). Publicado como está, o aluno abre o README no
// GitHub e bate em link morto; com o repo de desenvolvimento privado, uma URL
// absoluta seria pior: 404 sem explicação. A seção é substituída por uma linha
// honesta sobre onde a arquitetura vive, e o que sobrar de link para caminho
// não-copiado REPROVA o build — link morto no README do aluno é defeito.
// ---------------------------------------------------------------------------
const README = join(OUT, 'README.md');
const SECAO_DOC = /^## Documentação\n[\s\S]*?(?=^## )/m;
// "Estado: F0 (scaffold)" é status de DESENVOLVIMENTO: dívida da suíte, gate de
// release vermelho, plano de fases. Publicado, desinforma quem instalou — o
// aluno leria "scaffold" e "verify vermelho" sobre um produto que funciona — e
// é a outra origem de link para caminho não-copiado. Sai inteira.
const SECAO_ESTADO = /^## Estado: [^\n]*\n[\s\S]*?(?=^## )/m;
const DOC_PUBLICA = [
  '## Documentação',
  '',
  'A doc do dia a dia é o [`GUIA-ALUNO.md`](GUIA-ALUNO.md), e o [`INSTALL.md`](INSTALL.md) cobre a',
  'instalação. As especificações de arquitetura — o corte núcleo × pacote, o formato de pacote,',
  'assinatura e sync — são documentos de desenvolvimento e vivem no repositório de desenvolvimento,',
  'não nesta árvore de distribuição.',
  '',
  '',
].join('\n');
if (existsSync(README)) {
  const original = readFileSync(README, 'utf8');
  const ajustado = original.replace(SECAO_DOC, DOC_PUBLICA).replace(SECAO_ESTADO, '');
  if (ajustado !== original) {
    writeFileSync(README, ajustado);
    console.log('README ajustado: Documentação aponta só o que a árvore pública tem; status de desenvolvimento removido.');
  }
  const orfaos = [...ajustado.matchAll(/\]\((docs\/[^)]+|tests\/[^)]+)\)/g)].map((m) => m[1]);
  if (orfaos.length) {
    console.error(`build-dist: o README público linka ${orfaos.length} caminho(s) fora da árvore: ${orfaos.slice(0, 6).join(', ')}`);
    process.exit(1);
  }
}

// A minimal .gitignore for the dist repo (only matters if someone works inside it).
writeFileSync(join(OUT, '.gitignore'), [
  'node_modules/',
  '_legalsquad/_memory/',
  '_legalsquad/_browser_profile/',
  '_legalsquad/logs/',
  'acervo/casos/',
  'squads/*/_memory/',
  '.env',
  '',
].join('\n'), 'utf8');

console.log(`Dist construído em ${OUT}: ${copied} entradas copiadas, ${skipped} ausentes.`);
console.log(`Pacote: ${pkg.name}@${pkg.version}`);
