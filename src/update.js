import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocale, t } from './i18n.js';
import { getTemplateEntries, loadSavedLocale, copyCanonicalSources, readPreferences, filesIdentical, isMergedIdeSettings, mergeIdeSettings, syncSkillCatalogArtifacts } from './init.js';
import { listAvailable as listAvailableSkills, listInstalled as listInstalledSkills, installSkill, getSkillMeta, isSkillAutoInstallable } from './skills.js';
import { logEvent } from './logger.js';

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
  let atual;
  try {
    atual = await readFile(destPath, 'utf8');
  } catch {
    return null; // nada a preservar
  }

  const candidatos = [`${destPath}.bak`];
  for (let i = 2; i <= 50; i++) candidatos.push(`${destPath}.bak.${i}`);

  for (const candidato of candidatos) {
    let existente;
    try {
      existente = await readFile(candidato, 'utf8');
    } catch {
      // Slot livre: é aqui que o conteúdo atual entra.
      await cp(destPath, candidato);
      return candidato;
    }
    // Já preservado num backup anterior — não duplica.
    if (existente === atual) return candidato;
  }

  // 50 backups do mesmo arquivo é sinal de algo errado no fluxo, não caso real.
  // Preservar é mais importante que a estética do nome.
  const fallback = `${destPath}.bak.${Date.now()}`;
  await cp(destPath, fallback);
  return fallback;
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

export async function update(targetDir, options = {}) {
  // `_skillsBundle`: override de teste — ver o comentário homônimo em init().
  const bundle = options._skillsBundle;
  console.log('\n  🔄 LegalSquad — Update\n');

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

  // 6. Copy IDE-specific templates based on saved preferences
  const ides = await loadSavedIdes(targetDir);
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

  // Refresh the catalogue after active and discoverable pilot skills are
  // present. Preview, deprecated and quarantined sources remain bundled only.
  count += await syncSkillCatalogArtifacts(targetDir, {
    overwriteManifest: true,
    backupFn: backupIfExists,
    bundle,
  });

  // 7. Summary
  console.log(`\n  ${t('updateFileCount', { count })}`);
  console.log(`  ${t('updatePreserved')}`);
  console.log(`  ${t('updateSuccess', { version: `v${newVersion}` })}`);
  console.log(`\n  ${t('updateLatestHint')}\n`);

  await logEvent('update', { from: currentVersion || 'unknown', to: newVersion }, targetDir);

  return { success: true };
}
