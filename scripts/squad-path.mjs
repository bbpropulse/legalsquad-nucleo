#!/usr/bin/env node
// Resolve o caminho final de um artefato do run — a conta que o runner fazia de
// cabeça a cada arquivo, a cada step.
//
//   node scripts/squad-path.mjs resolve <caminho> --run <run_id> [--modo escrita|leitura|checkpoint]
//
// Devolve JSON numa linha: {"caminho":"...","grupo":"...","versao":"v2"}.
// `escrita` responde "onde gravo agora?"; `leitura`, "onde está o que o step
// anterior gravou?" — confundir os dois é o erro que trava o pipeline inteiro.

import { existsSync, readdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Resolução de caminho — cópia VERBATIM de src/squad-path.js.
// Este script é distribuído ao usuário (templates/scripts/) e roda num projeto
// que NÃO tem src/ — por isso a lógica é embutida em vez de importada. A cópia
// é guardada por tests/squad-path.test.js: se divergir, a suíte quebra.
// ---------------------------------------------------------------------------
// >>> squad-path:begin
/** Modos de resolução. Cada um responde a uma pergunta diferente. */
const MODOS_CAMINHO = Object.freeze({
  ESCRITA: 'escrita', // "onde eu GRAVO agora?" → próxima versão
  LEITURA: 'leitura', // "onde está o que já foi gravado?" → versão vigente
  CHECKPOINT: 'checkpoint', // captura da resposta do usuário → nunca versionada
});

/** Pasta de versão: `v` seguido só de dígitos. `v2x` e `v` não são versão. */
const PADRAO_VERSAO = /^v(\d+)$/;

/** Só caminho sob `squads/<nome>/output/` é transformado. O resto passa reto. */
const RAIZ_OUTPUT = /^(squads\/[^/]+\/output)\/(.+)$/;

function sobOutput(caminho) {
  return RAIZ_OUTPUT.test(String(caminho || ''));
}

/**
 * Step 1 — injeta o `run_id` logo depois de `output/`.
 *
 * IDEMPOTENTE de propósito: o runner às vezes já tem em mãos o caminho
 * transformado, e injetar de novo produziria `output/<run>/<run>/arquivo` —
 * pasta que ninguém procura e onde o artefato some sem erro nenhum.
 */
function injetarRunId(caminho, runId) {
  const m = String(caminho || '').match(RAIZ_OUTPUT);
  if (!m) return caminho;
  const [, raiz, resto] = m;
  if (resto.split('/')[0] === runId) return caminho;
  return `${raiz}/${runId}/${resto}`;
}

/** Números das pastas de versão presentes no grupo, ignorando o resto. */
function numerosDeVersao(entradas) {
  return (Array.isArray(entradas) ? entradas : [])
    .map((entrada) => (typeof entrada === 'string' ? entrada.match(PADRAO_VERSAO) : null))
    .filter(Boolean)
    .map((m) => Number(m[1]));
}

/**
 * A maior versão existente — a que o step ANTERIOR gravou.
 *
 * Compara por NÚMERO. Ordenação de texto poria `v9` acima de `v10`, e o
 * validador de input do step seguinte passaria a procurar numa versão velha
 * (ou a acusar ausência de um arquivo que existe).
 */
function versaoVigente(entradas) {
  const nums = numerosDeVersao(entradas);
  return nums.length ? `v${Math.max(...nums)}` : null;
}

/**
 * A versão onde gravar agora: sempre uma acima da MAIOR existente.
 *
 * Buraco na sequência (v1 e v3, sem v2) não é reaproveitado — reusar `v2` faria
 * o artefato novo parecer mais antigo que a `v3` que já está lá.
 */
function proximaVersao(entradas) {
  const nums = numerosDeVersao(entradas);
  return nums.length ? `v${Math.max(...nums) + 1}` : 'v1';
}

/** Diretório onde as pastas de versão vivem — é o que o chamador vai listar. */
function grupoDe(caminho, runId) {
  if (!sobOutput(caminho)) return null;
  const partes = injetarRunId(caminho, runId).split('/');
  partes.pop();
  return partes.join('/');
}

/**
 * Resolve o caminho final de um artefato do run.
 *
 * Fail-closed nas duas portas: modo desconhecido e `run_id` ausente LANÇAM, em
 * vez de adivinhar. Um `run_id` vazio faria execuções diferentes gravarem por
 * cima uma da outra — perda silenciosa, o pior modo de falha deste pipeline.
 */
function resolverCaminho({ caminho, runId, entradas = [], modo = MODOS_CAMINHO.ESCRITA } = {}) {
  if (!Object.values(MODOS_CAMINHO).includes(modo)) {
    throw new Error(`modo de caminho inválido: "${modo}" (use escrita, leitura ou checkpoint)`);
  }
  if (typeof runId !== 'string' || !runId.trim()) {
    throw new Error('run_id é obrigatório: sem ele os artefatos de execuções diferentes colidem');
  }
  if (!sobOutput(caminho)) return { caminho, grupo: null, versao: null };

  const comRun = injetarRunId(caminho, runId);
  const grupo = grupoDe(caminho, runId);
  if (modo === MODOS_CAMINHO.CHECKPOINT) return { caminho: comRun, grupo, versao: null };

  const versao = modo === MODOS_CAMINHO.ESCRITA ? proximaVersao(entradas) : versaoVigente(entradas);
  if (!versao) return { caminho: comRun, grupo, versao: null };

  const partes = comRun.split('/');
  const arquivo = partes.pop();
  return { caminho: [...partes, versao, arquivo].join('/'), grupo, versao };
}
// <<< squad-path:end

const USO =
  'uso: squad-path resolve <caminho> --run <run_id> [--modo escrita|leitura|checkpoint] [--print caminho|grupo|versao]';

/** Campos que `--print` pode imprimir cru, para uso direto em bash. */
const CAMPOS_PRINT = ['caminho', 'grupo', 'versao'];

function die(mensagem) {
  console.error(`squad-path: ${mensagem}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const chave = arg.slice(2);
    const proximo = argv[i + 1];
    if (proximo === undefined || proximo.startsWith('--')) {
      flags[chave] = true;
    } else {
      flags[chave] = proximo;
      i += 1;
    }
  }
  return { positionals, flags };
}

/** Só diretórios contam como versão — um arquivo `v1` solto não é uma versão. */
function entradasDoGrupo(grupo) {
  if (!grupo || !existsSync(grupo)) return [];
  return readdirSync(grupo, { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory())
    .map((entrada) => entrada.name);
}

const { positionals, flags } = parseArgs(process.argv.slice(2));
const [comando, caminho] = positionals;

if (comando !== 'resolve') die(USO);
if (!caminho) die(`resolve requer o caminho do artefato.\n${USO}`);
if (typeof flags.run !== 'string' || !flags.run.trim()) die(`resolve requer --run <run_id>.\n${USO}`);

const modo = typeof flags.modo === 'string' ? flags.modo : MODOS_CAMINHO.ESCRITA;

try {
  const grupo = grupoDe(caminho, flags.run);
  const resolvido = resolverCaminho({ caminho, runId: flags.run, entradas: entradasDoGrupo(grupo), modo });

  if (flags.print === undefined) {
    console.log(JSON.stringify(resolvido));
  } else {
    // Campo desconhecido FALHA em vez de imprimir vazio: uma linha em branco
    // vira `test -s ""` mais adiante, que reprova sem explicar por quê.
    const campo = typeof flags.print === 'string' ? flags.print : '';
    if (!CAMPOS_PRINT.includes(campo)) die(`--print aceita ${CAMPOS_PRINT.join(', ')} — recebi "${campo}"`);
    console.log(resolvido[campo] === null ? '' : resolvido[campo]);
  }
} catch (erro) {
  die(erro.message);
}
