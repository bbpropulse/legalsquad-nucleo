import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocale, t } from './i18n.js';
import { getTemplateEntries, loadSavedLocale, copyCanonicalSources, readPreferences, filesIdentical, isMergedIdeSettings, mergeIdeSettings, syncSkillCatalogArtifacts, ligarBibliotecaDaMaquina } from './init.js';
import { listAvailable as listAvailableSkills, listInstalled as listInstalledSkills, installSkill, getSkillMeta, isSkillAutoInstallable } from './skills.js';
import { logEvent } from './logger.js';
import { backupSync } from './fs-utils.js';
import { ligarMotor } from './motor-link.js';
import { mesclarGitignore } from './gitignore-semente.js';
import { dispararEmSegundoPlano } from './contribuicao.js';

async function loadSavedIdes(targetDir) {
  const prefs = await readPreferences(targetDir);
  if (Array.isArray(prefs?.ides) && prefs.ides.length > 0) return prefs.ides;
  return ['claude-code'];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

const PROTECTED_PATHS = [
  '_legalsquad/_memory',
  'acervo', // dados do usuário (materiais + índice + casos sigilosos) — semeado no init, nunca sobrescrito no update
  'agents',
  'squads',
];

function isProtected(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  return PROTECTED_PATHS.some(
    (p) => normalized === p || normalized.startsWith(p + '/')
  );
}

// package.json is the mentee's OWN project manifest (their scripts/deps live here).
// A wholesale copy would wipe their additions, so we MERGE: keep everything the user
// has, and ensure the LegalSquad scripts/dependencies are present/current.
// Returns true if the file changed (for the update count).
async function mergePackageJson(templatePath, destPath, backupFn) {
  const templateObj = JSON.parse(await readFile(templatePath, 'utf-8'));

  let userRaw = null;
  try {
    userRaw = await readFile(destPath, 'utf-8');
  } catch {
    // not present yet — place the template as-is
  }
  if (userRaw === null) {
    await mkdir(dirname(destPath), { recursive: true });
    await cp(templatePath, destPath);
    return true;
  }

  let userObj;
  try {
    userObj = JSON.parse(userRaw);
  } catch {
    return false; // invalid user JSON — never risk clobbering it
  }

  const merged = {
    ...userObj,
    scripts: { ...(userObj.scripts || {}), ...(templateObj.scripts || {}) },
    dependencies: { ...(userObj.dependencies || {}), ...(templateObj.dependencies || {}) },
  };
  const next = JSON.stringify(merged, null, 2) + '\n';
  if (next === userRaw) return false; // already current

  await backupFn(destPath);
  await writeFile(destPath, next, 'utf-8');
  return true;
}

/**
 * Guarda uma cópia do arquivo antes de o update sobrescrevê-lo.
 *
 * Preservar o `.bak` original é a intenção certa — ele guarda o que o usuário
 * tinha antes da PRIMEIRA atualização. Mas a versão anterior parava aí: se o
 * `.bak` existia, ela não copiava nada e ainda devolvia `true`, fazendo o
 * update anunciar "(backup: X.bak)" enquanto sobrescrevia, sem cópia, uma
 * edição que o usuário fizera DEPOIS. Perda de dados irrecuperável, com
 * mensagem afirmando o contrário.
 *
 * Agora: só não há o que preservar quando o conteúdo atual já está idêntico a
 * algum backup. Havendo conteúdo novo, ele ganha o próximo slot livre
 * (`.bak`, `.bak.2`, `.bak.3`…) — o original nunca é perdido e as edições
 * posteriores também não.
 *
 * Devolve o caminho do backup que contém o conteúdo atual, ou `null` quando
 * não havia arquivo. Quem chama usa isso para dizer a VERDADE ao usuário.
 */
export async function backupIfExists(destPath) {
  return backupSync(destPath);
}

async function semearSquadsDoMotor(targetDir) {
  const seeds = join(TEMPLATES_DIR, 'squads');
  let count = 0;
  let nomes;
  try {
    nomes = (await readdir(seeds, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return 0; // pacote sem seeds de squad
  }
  for (const nome of nomes) {
    const destino = join(targetDir, 'squads', nome);
    const squadYaml = join(destino, 'squad.yaml');
    let atual = null;
    try {
      atual = await readFile(squadYaml, 'utf8');
    } catch {
      // ausente: entra inteiro (abaixo)
    }
    if (atual !== null && !/^status:\s*["']?placeholder["']?\s*$/m.test(atual)) continue; // squad do usuário
    const backup = atual === null ? null : await backupIfExists(squadYaml);
    for (const arquivo of await getTemplateEntries(join(seeds, nome))) {
      const rel = relative(join(seeds, nome), arquivo);
      const alvo = join(destino, rel);
      if (rel !== 'squad.yaml') {
        try {
          await stat(alvo);
          continue; // arquivo que o usuário já tem: nunca sobrescrito
        } catch {
          // não existe — entra
        }
      }
      await mkdir(dirname(alvo), { recursive: true });
      await cp(arquivo, alvo);
      count++;
    }
    const nomeBackup = backup ? ` (backup do placeholder: squads/${nome}/${backup.slice(dirname(backup).length + 1)})` : '';
    console.log(`  ${t('updatedFile', { path: `squads/${nome}/` })}${nomeBackup}`);
  }
  return count;
}

// Até a 0.9.48 o motor criava a pasta do Codex como `.Codex`; o Codex lê `<repo>/.codex/`.
// No macOS (sem diferença de maiúsculas) as duas são a mesma pasta e funcionava; no Linux
// o Codex não achava nem o hooks.json nem o config.toml do projeto. A migração compara o
// NOME gravado no diretório (readdir), não a existência, e renomeia por um nome
// temporário, porque `rename('.Codex', '.codex')` direto não muda nada num sistema que
// não diferencia maiúsculas. Com as duas pastas presentes (só possível no Linux), não
// mexe: avisa e deixa a escolha ao usuário.
export async function migrarPastaCodex(targetDir) {
  let nomes;
  try {
    nomes = await readdir(targetDir);
  } catch {
    return 'sem-pasta';
  }
  if (!nomes.includes('.Codex')) return 'nada';
  if (nomes.includes('.codex')) {
    console.log('  ⚠️  Há `.Codex` e `.codex` nesta pasta. O Codex só lê `.codex`: confira se algo seu ficou em `.Codex` e apague essa pasta depois.');
    return 'as-duas';
  }
  const temporario = join(targetDir, `.codex-migracao-${process.pid}`);
  await rename(join(targetDir, '.Codex'), temporario);
  await rename(temporario, join(targetDir, '.codex'));
  console.log('  ✓ Pasta do Codex renomeada de `.Codex` para `.codex`, o nome que o Codex lê.');
  return 'renomeada';
}

export async function update(targetDir, options = {}) {
  // `_skillsBundle`: override de teste — ver o comentário homônimo em init().
  const bundle = options._skillsBundle;
  console.log('\n  🔄 LegalSquad: Update\n');

  // 1. Check initialized
  try {
    await stat(join(targetDir, '_legalsquad'));
  } catch {
    await loadLocale('English');
    console.log(`  ${t('updateNotInitialized')}`);
    return { success: false };
  }

  // 2. Load user's locale
  await loadSavedLocale(targetDir);

  // 3. Read versions
  let currentVersion = null;
  try {
    currentVersion = (
      await readFile(join(targetDir, '_legalsquad', '.legalsquad-version'), 'utf-8')
    ).trim();
  } catch {
    // Legacy install — no version file
  }

  const newVersion = (
    await readFile(join(TEMPLATES_DIR, '_legalsquad', '.legalsquad-version'), 'utf-8')
  ).trim();

  // 4. Announce
  if (currentVersion) {
    console.log(
      `  ${t('updateStarting', { old: `v${currentVersion}`, new: `v${newVersion}` })}`
    );
  } else {
    console.log(`  ${t('updateStartingUnknown', { new: `v${newVersion}` })}`);
  }

  // 5. Copy common templates, skipping protected paths and ide-templates/
  const entries = await getTemplateEntries(TEMPLATES_DIR);
  let count = 0;

  for (const entry of entries) {
    const relativePath = relative(TEMPLATES_DIR, entry);
    const normalizedRel = relativePath.replaceAll('\\', '/');
    if (isProtected(relativePath)) continue;
    // Skip ide-templates (handled below) and ide-assets (build-time source).
    if (normalizedRel.startsWith('ide-templates/') || normalizedRel.startsWith('ide-assets/')) continue;
    // O atalho do motor é de ligarMotor() (6c): regravado sem .bak, é nosso.
    if (normalizedRel.startsWith('_legalsquad/motor/')) continue;

    const destPath = join(targetDir, relativePath);
    // package.json belongs to the user — merge instead of overwriting (preserves
    // their scripts/deps while delivering new LegalSquad scripts).
    if (normalizedRel === 'package.json') {
      if (await mergePackageJson(entry, destPath, backupIfExists)) {
        console.log(`  ${t('updatedFile', { path: normalizedRel })}`);
        count++;
      }
      continue;
    }
    await mkdir(dirname(destPath), { recursive: true });
    if (await filesIdentical(entry, destPath)) continue;
    const backed = await backupIfExists(destPath);
    await cp(entry, destPath);
    const displayPath = relativePath.replaceAll('\\', '/');
    if (backed) {
      // Nomeia o backup REAL: pode ser .bak, .bak.2… Anunciar sempre ".bak"
      // mandava o usuário procurar o conteúdo dele no arquivo errado.
      const nomeBackup = displayPath + backed.slice(destPath.length);
      console.log(`  ${t('updatedFile', { path: displayPath })} (backup: ${nomeBackup})`);
    } else {
      console.log(`  ${t('updatedFile', { path: displayPath })}`);
    }
    count++;
  }

  // 5b. Os squads-exemplo do motor chegam também a quem já instalou.
  // `squads/` é protegido (é do usuário), então o update nunca toca squad
  // nenhum — e por isso toda instalação anterior a 0.5.2 ficaria para sempre
  // com o `demo-squad` de um arquivo só (quatro erros no check-squad) e sem o
  // `peca-modelo`. Dois casos, os dois do MOTOR e não do usuário: seed AUSENTE
  // entra inteiro; seed marcado `status: "placeholder"` é substituído, com backup
  // do squad.yaml e sem sobrescrever arquivo que já exista. Squad com qualquer
  // outro squad.yaml é do usuário e não é tocado.
  count += await semearSquadsDoMotor(targetDir);

  // 5c. `.Codex` antiga vira `.codex` antes da cópia dos templates do Codex, para o
  // template novo cair por cima da pasta migrada, e não ao lado dela.
  await migrarPastaCodex(targetDir);

  // 6. Copy IDE-specific templates based on saved preferences
  const ides = await loadSavedIdes(targetDir);
  // Agente trocado no disco não chega à sessão aberta: a IDE carrega a definição ao abrir a sessão.
  // Medido em 26/09/2026 (mandado de segurança, motor 0.9.54): a medição rodou numa sessão aberta
  // antes da 0.9.46, e o avaliador da meta seguia o formato antigo, com o arquivo já atualizado.
  let agentesAtualizados = 0;
  for (const ide of ides) {
    const ideSrcDir = join(TEMPLATES_DIR, 'ide-templates', ide);
    let ideEntries;
    try {
      ideEntries = await getTemplateEntries(ideSrcDir);
    } catch {
      continue; // no template dir for this IDE
    }
    for (const entry of ideEntries) {
      const relPath = relative(ideSrcDir, entry);
      if (isProtected(relPath)) continue;
      // settings.json (vscode/qwen/gemini) is merged below to preserve user keys — never overwrite it
      if (isMergedIdeSettings(ide, relPath)) continue;

      const destPath = join(targetDir, relPath);
      await mkdir(dirname(destPath), { recursive: true });
      if (await filesIdentical(entry, destPath)) continue;
      const backed = await backupIfExists(destPath);
      await cp(entry, destPath);
      const displayPath = relPath.replaceAll('\\', '/');
      if (/(?:^|\/)agents\//.test(displayPath)) agentesAtualizados += 1;
      if (backed) {
        const nomeBackup = displayPath + backed.slice(destPath.length);
        console.log(`  ${t('updatedFile', { path: displayPath })} (backup: ${nomeBackup})`);
      } else {
        console.log(`  ${t('updatedFile', { path: displayPath })}`);
      }
      count++;
    }
  }

  // 6-merge. Merge IDE settings.json (preserves user keys; matches init behavior)
  await mergeIdeSettings(ides, targetDir);

  // 6a. Copy canonical sources (core, config, dashboard)
  count += await copyCanonicalSources(targetDir, {
    overwrite: true,
    backupFn: backupIfExists,
    protectedFn: isProtected,
  });

  // 6b. Install new non-MCP, non-hybrid bundled skills not already present
  const availableSkills = await listAvailableSkills(bundle);
  const installedSkills = await listInstalledSkills(targetDir);
  for (const id of availableSkills) {
    if (id === 'legalsquad-skill-creator') continue;
    if (installedSkills.includes(id)) continue;
    const meta = await getSkillMeta(id, bundle);
    if (!meta) continue;
    if (!isSkillAutoInstallable(meta)) continue;
    if (meta.type === 'mcp' || meta.type === 'hybrid') continue;
    await installSkill(id, targetDir, bundle);
    console.log(`  ${t('createdFile', { path: `skills/${id}/SKILL.md` })}`);
    count++;
  }

  // 6b'. A biblioteca da máquina (depósito) entra por hard link antes do
  // índice; projetos que ainda têm cópia própria dos pacotes trocam a cópia
  // pelo link aqui (o disco volta).
  const biblioteca = ligarBibliotecaDaMaquina(targetDir, { deposito: options.deposito });
  if (biblioteca) count += biblioteca.ligados + biblioteca.copiados + biblioteca.atualizados;

  // Refresh the catalogue after active and discoverable pilot skills are
  // present. Preview, deprecated and quarantined sources remain bundled only.
  count += await syncSkillCatalogArtifacts(targetDir, {
    overwriteManifest: true,
    backupFn: backupIfExists,
    bundle,
  });

  // 6c. Religa o projeto ao motor que está rodando este update: o atalho
  // `npx legalsquad` (_legalsquad/motor/ + node_modules/.bin) e o caminho
  // absoluto em motor.json. Projetos anteriores a esta versão ganham o atalho
  // aqui, sem `npm install`.
  const motor = await ligarMotor(targetDir);
  if (motor.escritos > 0) {
    console.log(`  ✓ npx legalsquad → node "${motor.bin}" (motor ${motor.version})`);
    count += motor.escritos;
  }

  // 6d. O .gitignore do projeto recebe as linhas novas da semente e as pastas de autos
  // que os caso.json apontam, sem apagar nada do usuário. Medição de 24/09/2026 (G13):
  // o update nunca tocava o .gitignore, e projeto criado antes de uma linha nova de
  // sigilo ficava sem ela para sempre.
  try {
    const gi = mesclarGitignore(targetDir);
    if (gi.acao === 'criado' || gi.acao === 'atualizado') {
      console.log(`  ${t(gi.acao === 'criado' ? 'createdFile' : 'updatedFile', { path: '.gitignore' })} (+${gi.acrescentadas.length}: ${gi.acrescentadas.slice(0, 4).join(', ')}${gi.acrescentadas.length > 4 ? ', …' : ''})`);
      count++;
    }
  } catch {
    // .gitignore ilegível: fica como está
  }

  // 7. Summary
  console.log(`\n  ${t('updateFileCount', { count })}`);
  console.log(`  ${t('updatePreserved')}`);
  console.log(`  ${t('updateSuccess', { version: `v${newVersion}` })}`);
  if (agentesAtualizados) console.log(`  ${t('updateAgentsReload', { count: agentesAtualizados })}`);
  console.log(`\n  ${t('updateLatestHint')}\n`);

  await logEvent('update', { from: currentVersion || 'unknown', to: newVersion }, targetDir);

  // 8. Momento seguro para a contribuição à comunidade (src/contribuicao.js): em segundo plano,
  // sem saída e sem esperar rede. O update nunca depende dela.
  dispararEmSegundoPlano(targetDir);

  return { success: true };
}
