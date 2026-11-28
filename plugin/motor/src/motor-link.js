import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesIdentical } from './fs-utils.js';
import { compararVersoes, versaoDoMotor } from '../templates/_legalsquad/motor/cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..');

// Atalho local do motor: faz `npx legalsquad …` funcionar dentro do projeto sem
// depender de o prefixo global do npm estar no PATH do shell que a IDE abre.
//
// O problema medido (14/09/2026): no Windows o comando `legalsquad` nunca
// entra no PATH do shell do Claude Code, e o `npx legalsquad` que o runner, os
// prompts e o package.json do projeto usam tenta o registro e falha (o motor
// não é publicado no npm). O Claude concluía "não está instalado" e reinstalava
// do GitHub a cada chamada.
//
// A solução é mecanismo, não prosa: o projeto ganha um pacote-atalho em
// `_legalsquad/motor/` (package.json + cli.mjs, vindos de templates/), que o
// `npx` encontra por `node_modules/.bin/legalsquad` e que localiza e executa o
// motor instalado (LEGALSQUAD_BIN › motor.json › prefixos conhecidos › `npm
// root -g`). O `package.json` do projeto declara `"legalsquad":
// "file:_legalsquad/motor"` para o `npm install` manter o link em vez de
// podá-lo; e este módulo escreve os shims de `.bin` por conta própria, para o
// atalho valer já no `init --skip-deps` e no `update` (que não roda `npm
// install`). Quando o npm roda, ele troca a cópia por symlink e regrava os
// shims no formato dele; o resultado é o mesmo.
//
// `motor.json` guarda o caminho absoluto do motor que rodou o init/update. É
// deste arquivo que o cli.mjs parte; os prefixos conhecidos só entram se ele
// apontar para algo que não existe mais (o aluno trocou de Node, por exemplo).

const STUB_FILES = ['package.json', 'cli.mjs'];

const SHIM_SH = `#!/bin/sh
# LegalSquad: atalho local do motor (gerado por \`legalsquad init\`/\`update\`).
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec node "$basedir/../legalsquad/cli.mjs" "$@"
`;

const SHIM_CMD = `@ECHO off\r
SETLOCAL\r
node "%~dp0\\..\\legalsquad\\cli.mjs" %*\r
ENDLOCAL & EXIT /b %errorlevel%\r
`;

const SHIM_PS1 = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
& node "$basedir/../legalsquad/cli.mjs" $args
exit $LASTEXITCODE
`;

/**
 * Um caminho que o npm já transformou em symlink é do npm: `node_modules/
 * legalsquad` aponta para `_legalsquad/motor` (o link do `file:`) e
 * `node_modules/.bin/legalsquad` para o `cli.mjs`. Gravar "através" deles
 * sobrescreveria o próprio stub com o texto do shim (medido em 14/09/2026:
 * `npx legalsquad` morria com SyntaxError depois de init + update) ou, com
 * `npm link`, o package.json de um checkout real do motor. Symlink fica.
 */
async function ehSymlink(path) {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function writeIfDifferent(path, content) {
  if (await ehSymlink(path)) return false;
  let atual = null;
  try {
    atual = await readFile(path, 'utf-8');
  } catch {
    // não existe ainda
  }
  if (atual === content) return false;
  await writeFile(path, content, 'utf-8');
  return true;
}

/** Barras normais mesmo no Windows: node aceita, e o modelo não precisa escapar. */
export function caminhoLegivel(caminho) {
  return String(caminho).split('\\').join('/');
}

/** A entrada do motor (o que o `bin` do package.json aponta), com barras normais. */
export function binDoMotor(packageRoot = PACKAGE_ROOT) {
  return caminhoLegivel(join(packageRoot, 'bin', 'legalsquad.js'));
}

/**
 * O motor está embutido no plugin do Claude Code? O build do plugin
 * (scripts/build-plugin.mjs) o põe em `<plugin>/motor/`, ao lado de
 * `<plugin>/.claude-plugin/plugin.json`; devolve a raiz do plugin, ou null.
 *
 * Importa porque o caminho do plugin MUDA a cada versão: o Claude Code guarda
 * cada versão em `~/.claude/plugins/cache/<marketplace>/<plugin>/<versão>/` e
 * apaga a anterior 14 dias depois da atualização (doc: Plugin loading
 * reference, "Cleanup of previous versions"). Um projeto criado por esse motor
 * não pode depender do caminho que ele tinha no dia do `init`.
 */
export function raizDoPlugin(packageRoot = PACKAGE_ROOT) {
  if (basename(packageRoot) !== 'motor') return null;
  const raiz = dirname(packageRoot);
  return existsSync(join(raiz, '.claude-plugin', 'plugin.json')) ? raiz : null;
}

// Sem dado nenhum além do caminho do motor e da versão: o registro é lido por
// todo projeto da máquina e não tem por que saber de quem é a máquina.
function conteudoDoRegistro({ bin, version, registradoPor }) {
  return JSON.stringify({ bin: caminhoLegivel(bin), version, registrado_por: registradoPor }, null, 2) + '\n';
}

/**
 * Grava o registro da máquina, `~/.legalsquad/motor.json`, que o atalho
 * `npx legalsquad` de TODOS os projetos lê (templates/_legalsquad/motor/cli.mjs).
 *
 * Dois caminhos gravam aqui: o `install-global` (motor do npm) e o SessionStart
 * do plugin do Claude Code (motor embutido no plugin). Coexistem, e a regra é
 * uma só, a mesma do atalho: **vale o motor de versão mais nova**.
 *
 * - registro ausente, ilegível ou apontando para um motor que não existe mais:
 *   grava;
 * - registro que já aponta para este motor: regrava só se o conteúdo mudou;
 * - outro motor que ainda existe: grava se este for mais novo, e nunca se for
 *   mais velho (nem do mesmo gravador: uma sessão aberta na versão anterior do
 *   plugin, que o Claude Code ainda guarda por 14 dias, não rebaixa o registro).
 *   No empate, grava se o registro é do mesmo gravador (a mesma instalação que
 *   mudou de lugar) ou com `empateVence` (o `install-global`, escolha explícita
 *   de quem opera). O SessionStart roda em toda conversa e, no empate com o
 *   npm, deixa como está: sem isso, o registro viraria uma gangorra entre os
 *   dois caminhos.
 *
 * Devolve { acao: 'gravado'|'igual'|'mantido', caminho, bin, version,
 * registradoPor, proprio } descrevendo o registro que ficou.
 */
export async function registrarMotorNaMaquina(home, {
  bin,
  version,
  registradoPor,
  empateVence = false,
  existe = existsSync,
  versaoDe = versaoDoMotor,
} = {}) {
  const dir = join(home, '.legalsquad');
  const caminho = join(dir, 'motor.json');
  const novo = conteudoDoRegistro({ bin, version, registradoPor });
  const binNovo = caminhoLegivel(bin);

  let bruto = null;
  let atual = null;
  try {
    bruto = await readFile(caminho, 'utf-8');
    const lido = JSON.parse(bruto);
    if (lido && typeof lido === 'object' && typeof lido.bin === 'string' && lido.bin) atual = lido;
  } catch {
    // ausente ou ilegível: grava
  }

  let gravar = true;
  if (atual && caminhoLegivel(atual.bin) === binNovo) {
    gravar = bruto !== novo;
  } else if (atual && existe(atual.bin)) {
    // A versão de verdade é a do package.json ao lado do motor; o campo do
    // registro é só o que o gravador disse na hora.
    const versaoAtual = versaoDe(atual.bin) || atual.version || null;
    const ordem = versaoAtual ? compararVersoes(version, versaoAtual) : 1;
    const mesmoGravador = atual.registrado_por === registradoPor;
    gravar = ordem > 0 || (ordem === 0 && (empateVence || mesmoGravador));
    if (!gravar) {
      return { acao: 'mantido', caminho, bin: caminhoLegivel(atual.bin), version: versaoAtual, registradoPor: atual.registrado_por || null, proprio: false };
    }
  }

  if (!gravar) {
    return { acao: 'igual', caminho, bin: binNovo, version, registradoPor, proprio: true };
  }
  await mkdir(dir, { recursive: true });
  // Troca atômica: o atalho de um projeto pode estar lendo o registro agora.
  const temporario = `${caminho}.${process.pid}.tmp`;
  await writeFile(temporario, novo, 'utf-8');
  await rename(temporario, caminho);
  return { acao: 'gravado', caminho, bin: binNovo, version, registradoPor, proprio: true };
}

// Liga o projeto em `targetDir` ao motor em `packageRoot` (por padrão, o pacote
// que está rodando). Idempotente; devolve { bin, version, escritos } onde
// `escritos` conta os arquivos que mudaram.
export async function ligarMotor(targetDir, { packageRoot = PACKAGE_ROOT } = {}) {
  const origem = join(packageRoot, 'templates', '_legalsquad', 'motor');
  const atalho = join(targetDir, '_legalsquad', 'motor');
  const bin = join(packageRoot, 'bin', 'legalsquad.js');
  const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8'));
  let escritos = 0;

  // 1. O pacote-atalho no projeto (fonte: templates/_legalsquad/motor/).
  await mkdir(atalho, { recursive: true });
  for (const nome of STUB_FILES) {
    if (await filesIdentical(join(origem, nome), join(atalho, nome))) continue;
    await cp(join(origem, nome), join(atalho, nome));
    escritos++;
  }
  await chmod(join(atalho, 'cli.mjs'), 0o755).catch(() => {});

  // 2. Onde o motor está NESTA máquina (sem carimbo de hora: o arquivo só muda
  //    quando o motor muda, e `escritos` diz a verdade sobre o que foi feito).
  //    Motor do plugin do Claude Code: o caminho vale até o plugin atualizar (a
  //    pasta do cache tem a versão no nome), então o projeto marca a origem e o
  //    atalho passa a preferir o registro da máquina, que o SessionStart do
  //    plugin mantém apontando para a versão em uso. O caminho fica como rede
  //    para a máquina sem registro.
  const doPlugin = raizDoPlugin(packageRoot) ? { origem: 'plugin' } : {};
  const motorJson = JSON.stringify({ bin: caminhoLegivel(bin), version, ...doPlugin }, null, 2) + '\n';
  if (await writeIfDifferent(join(atalho, 'motor.json'), motorJson)) escritos++;

  // 3. O que o `npx` procura: node_modules/legalsquad (cópia; o npm troca por
  //    symlink quando rodar, e aí é dele) e node_modules/.bin/legalsquad (sh, cmd, ps1).
  const nm = join(targetDir, 'node_modules', 'legalsquad');
  if (!(await ehSymlink(nm))) {
    await mkdir(nm, { recursive: true });
    for (const nome of STUB_FILES) {
      if (await filesIdentical(join(origem, nome), join(nm, nome))) continue;
      await cp(join(origem, nome), join(nm, nome));
      escritos++;
    }
    await chmod(join(nm, 'cli.mjs'), 0o755).catch(() => {});
  }

  const binDir = join(targetDir, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  if (await writeIfDifferent(join(binDir, 'legalsquad'), SHIM_SH)) escritos++;
  await chmod(join(binDir, 'legalsquad'), 0o755).catch(() => {});
  if (await writeIfDifferent(join(binDir, 'legalsquad.cmd'), SHIM_CMD)) escritos++;
  if (await writeIfDifferent(join(binDir, 'legalsquad.ps1'), SHIM_PS1)) escritos++;

  return { bin: caminhoLegivel(bin), version, escritos };
}
