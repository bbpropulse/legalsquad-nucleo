import { createInterface } from 'node:readline';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadLocale, t, getLocaleCode } from './i18n.js';
import { loadSavedLocale } from './init.js';
import { backupIfExists } from './update.js';
import { logEvent } from './logger.js';

// Entradas iniciadas por `_` no diretório de instalação são artefatos do
// CATÁLOGO (`_evals/`, `_index.yaml`, `_<area>-integration.yaml`), gerados por
// syncSkillCatalogArtifacts — não são recursos instaláveis. Listá-las como
// recurso fazia o `update` chamar install('_evals'), que o validateId do
// registry rejeita: uma exceção que abortava o loop INTEIRO e derrubava o
// comando em toda instalação limpa, antes mesmo de atualizar a primeira skill.
const ehArtefatoDeCatalogo = (id) => id.startsWith('_');

/** Todos os arquivos de `raiz`, em caminhos relativos. */
async function listarArquivos(raiz, prefixo = '') {
  const entradas = await readdir(join(raiz, prefixo), { withFileTypes: true });
  const arquivos = [];
  for (const entrada of entradas) {
    const rel = prefixo ? join(prefixo, entrada.name) : entrada.name;
    if (entrada.isDirectory()) arquivos.push(...(await listarArquivos(raiz, rel)));
    else if (entrada.isFile()) arquivos.push(rel);
  }
  return arquivos;
}

/**
 * Guarda em `.bak` o que o usuário editou antes de o update sobrescrever.
 *
 * `install` confirmava a reinstalação; `update` sobrescrevia TUDO calado. Quem
 * ajustou um SKILL.md ao jeito do escritório perdia a edição no primeiro
 * update, sem aviso e sem recuperação.
 *
 * O recurso é instalado antes num diretório temporário para obter a cópia
 * PRISTINA do pacote. É de propósito que a comparação passe por aí em vez de
 * calcular caminhos: só `resource.install` sabe onde cada tipo de recurso mora
 * (skills em `skills/<id>/`, agentes em `.claude/agents/<id>.md`), e replicar
 * esse conhecimento aqui criaria uma segunda fonte de verdade que sai de
 * sincronia em silêncio.
 *
 * Arquivos que só existem localmente não aparecem na cópia pristina e por isso
 * não são tocados — nem sobrescritos, nem copiados para backup.
 *
 * Devolve os caminhos (relativos a `targetDir`) dos backups que contêm as
 * edições, para o CLI dizer ao usuário onde elas foram parar. Mesma escada de
 * slots do update do motor (`.bak`, `.bak.2`…): nada é perdido.
 */
async function preservarEdicoesLocais(resource, id, targetDir) {
  const tmp = await mkdtemp(join(tmpdir(), 'legalsquad-update-'));
  try {
    await resource.install(id, tmp);
    const backups = [];
    for (const rel of await listarArquivos(tmp)) {
      const instalado = join(targetDir, rel);
      let atual;
      try {
        atual = await readFile(instalado);
      } catch {
        continue; // arquivo novo do pacote: não há edição local a preservar
      }
      if (atual.equals(await readFile(join(tmp, rel)))) continue;
      const backup = await backupIfExists(instalado);
      if (backup) backups.push(relative(targetDir, backup));
    }
    return backups;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// Builds the install/remove/list/update CLI for a resource type. skills-cli.js
// and agents-cli.js were ~95% identical; this keeps one implementation and
// parametrizes the i18n prefix, list rendering, log names and usage strings.
//
// config:
//   resource    { listInstalled, install, remove, getMeta, getLocalizedDescription }
//   i18nPrefix  'skills' | 'agents' — prefixes every translation key
//   header      title printed by `list`
//   browseLine  trailing "Browse available ... at: <url>" line
//   formatListItem (meta, desc) => string — renders one installed entry
//   logResource 'skill' | 'agent' — logEvent name prefix
//   usage       { install, remove, updateOne } — usage strings per subcommand
//
// Returns an async `(subcommand, args, targetDir) => { success }` handler.
export function createResourceCli(config) {
  const { resource, i18nPrefix, header, browseLine, formatListItem, logResource, usage } = config;

  const tp = (suffix, vars) => t(`${i18nPrefix}${suffix}`, vars);

  const listarInstalados = async (targetDir) =>
    (await resource.listInstalled(targetDir)).filter((id) => !ehArtefatoDeCatalogo(id));

  async function runList(targetDir) {
    console.log(`\n  ${header}\n`);

    const installed = await listarInstalados(targetDir);

    if (installed.length > 0) {
      console.log(`  ${tp('InstalledHeader')}`);
      for (const id of installed) {
        const meta = await resource.getMeta(id);
        if (meta) {
          const desc = resource.getLocalizedDescription(meta, getLocaleCode());
          console.log(`    ${formatListItem(meta, desc)}`);
        } else {
          console.log(`    ${id}`);
        }
      }
    } else {
      console.log(`  ${tp('NoneInstalled')}`);
    }

    console.log(`\n  ${browseLine}\n`);
  }

  async function runInstall(id, targetDir, bundle) {
    if (!id) {
      console.log(usage.install);
      return false;
    }

    const installed = await listarInstalados(targetDir);
    if (installed.includes(id)) {
      const answer = await confirm(`\n  ${tp('AlreadyInstalled', { id })}`);
      // Accept 'y' (English) or 's' (Portuguese "sim") as affirmative answers
      // Declining a reinstall is the user's choice, NOT a failure — return
      // (undefined = success) so the CLI doesn't exit 1 and break `&&` chains/CI.
      if (answer !== 'y' && answer !== 's') return;
      console.log(`  ${tp('Installing', { id })}`);
      await resource.install(id, targetDir, bundle);
      console.log(`  ${tp('Reinstalled', { id })}\n`);
      await logEvent(`${logResource}:install`, { name: id, reinstall: true }, targetDir);
      return;
    }

    console.log(`\n  ${tp('Installing', { id })}`);
    await resource.install(id, targetDir, bundle);
    console.log(`  ${tp('Installed', { id })}\n`);
    await logEvent(`${logResource}:install`, { name: id }, targetDir);
  }

  async function runRemove(id, targetDir) {
    if (!id) {
      console.log(usage.remove);
      return false;
    }

    const installed = await listarInstalados(targetDir);
    if (!installed.includes(id)) {
      console.log(`\n  ${tp('NotInstalled', { id })}\n`);
      return;
    }

    console.log(`\n  ${tp('Removing', { id })}`);
    await resource.remove(id, targetDir);
    await logEvent(`${logResource}:remove`, { name: id }, targetDir);
    console.log(`  ${tp('Removed', { id })}\n`);
  }

  // O update anuncia o backup REAL, como faz o update do motor (src/update.js):
  // dizer ".bak" quando o conteúdo foi para ".bak.2" manda o usuário procurar
  // sua edição no arquivo errado.
  function sufixoDeBackup(backups) {
    return backups.length ? ` (backup: ${backups.join(', ')})` : '';
  }

  async function runUpdate(targetDir) {
    const installed = await listarInstalados(targetDir);
    if (installed.length === 0) {
      console.log(`\n  ${tp('UpdateNone')}\n`);
      return;
    }

    console.log(`\n  ${tp('Updating')}`);
    for (const id of installed) {
      console.log(`  ${tp('Installing', { id })}`);
      const backups = await preservarEdicoesLocais(resource, id, targetDir);
      await resource.install(id, targetDir);
      console.log(`  ${tp('Installed', { id })}${sufixoDeBackup(backups)}`);
    }
    await logEvent(`${logResource}:update`, { count: installed.length }, targetDir);
    console.log(`\n  ${tp('UpdateDone', { count: installed.length })}\n`);
  }

  async function runUpdateOne(id, targetDir) {
    if (!id) {
      console.log(usage.updateOne);
      return;
    }

    const installed = await listarInstalados(targetDir);
    if (!installed.includes(id)) {
      console.log(`\n  ${tp('NotInstalled', { id })}\n`);
      return;
    }

    console.log(`\n  ${tp('Installing', { id })}`);
    const backups = await preservarEdicoesLocais(resource, id, targetDir);
    await resource.install(id, targetDir);
    await logEvent(`${logResource}:update`, { name: id }, targetDir);
    console.log(`  ${tp('Installed', { id })}${sufixoDeBackup(backups)}\n`);
  }

  // `bundle` é o override aditivo de src/registry.js, repassado só ao install:
  // produção nunca o passa (o registry lê o bundle do pacote); testes apontam
  // a fixture sintética. Um argumento a mais na cauda — nada muda para list/remove.
  return async function run(subcommand, args, targetDir, { bundle } = {}) {
    // Require initialized project
    try {
      await stat(join(targetDir, '_legalsquad'));
    } catch {
      await loadLocale('English');
      console.log(`\n  ${tp('NotInitialized')}\n`);
      return { success: false };
    }

    await loadSavedLocale(targetDir);

    try {
      if (subcommand === 'list' || !subcommand) {
        await runList(targetDir);
      } else if (subcommand === 'install') {
        const installed = await runInstall(args[0], targetDir, bundle);
        if (installed === false) return { success: false };
      } else if (subcommand === 'remove') {
        const removed = await runRemove(args[0], targetDir);
        if (removed === false) return { success: false };
      } else if (subcommand === 'update') {
        await runUpdate(targetDir);
      } else if (subcommand === 'update-one') {
        await runUpdateOne(args[0], targetDir);
      } else {
        console.log(`\n  ${tp('UnknownCommand', { cmd: subcommand })}\n`);
        return { success: false };
      }
    } catch (err) {
      console.log(`\n  ${tp('Error', { message: err.message })}\n`);
      return { success: false };
    }

    return { success: true };
  };
}
