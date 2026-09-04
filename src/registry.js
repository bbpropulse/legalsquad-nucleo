import { cp, copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateId, isPathInsideOrEqual } from './path-safe.js';
import { extractFrontMatter, parseScalar, parseList, parseLocalizedDescriptions } from './frontmatter.js';

const LOCALE_CODES = ['pt-BR', 'es'];

// Builds a resource registry for a bundled-then-installed asset type (skills,
// agents, ...). skills.js and agents.js were ~90% identical; this factory keeps
// the single shared implementation and parametrizes only the real differences.
//
// config:
//   bundleDir       absolute path to the bundled source ({id}/<sourceFile>)
//   resourceName    'skill' | 'agent' — used in error messages
//   sourceFile      'SKILL.md' | 'AGENT.md' — used when sourceLayout is 'dir'
//   sourceLayout    'dir'  → bundle holds {id}/<sourceFile> (skills)
//                   'flat' → bundle holds flat {id}.md files (agents)
//   installedDir    'skills' | '.claude/agents' — relative to targetDir
//   installLayout   'dir'  → copy the whole {id}/ directory recursively
//                   'file' → copy the source file to {id}<installedExt>
//   installedExt    required for 'file' layout (e.g. '.md')
//   excludeInstalled ids hidden from listInstalled (dir layout only)
//   metaFields      extra frontmatter fields:
//                   [{ key, kind, sourceKeys?, defaultValue? }]
export function createRegistry(config) {
  const {
    bundleDir,
    resourceName,
    sourceFile,
    sourceLayout = 'dir',
    installedDir,
    installLayout,
    installedExt = '',
    excludeInstalled = [],
    metaFields = [],
  } = config;

  const idLabel = `${resourceName} id`;
  const notFound = `${resourceName[0].toUpperCase()}${resourceName.slice(1)}`;
  const metaCache = new Map();

  // Path of an installed resource's frontmatter-bearing file.
  function installedSourcePath(id, targetDir) {
    return installLayout === 'dir'
      ? join(targetDir, installedDir, id, sourceFile)
      : join(targetDir, installedDir, id + installedExt);
  }

  // Path of the resource's source file in the bundle ({id}/<sourceFile> for the
  // 'dir' layout, flat {id}.md for the 'flat' layout used by agents).
  //
  // `bundle` is an optional per-call override of the bundle directory, used
  // only by tests that need to point the registry at a fixture instead of the
  // real package bundle. Production call sites never pass it, so the closed-over
  // `bundleDir` remains the sole source of truth outside tests.
  function bundleSourcePath(id, bundle = bundleDir) {
    return sourceLayout === 'flat'
      ? join(bundle, id + '.md')
      : join(bundle, id, sourceFile);
  }

  function cacheKey(id, bundle) {
    return bundle && bundle !== bundleDir ? `${bundle}\0${id}` : id;
  }

  function defaultMeta(id) {
    const meta = { name: id, description: '', descriptions: {} };
    for (const field of metaFields) {
      meta[field.key] = field.defaultValue ?? (field.kind === 'list' ? [] : '');
    }
    return meta;
  }

  async function listInstalled(targetDir) {
    try {
      const entries = await readdir(join(targetDir, installedDir), { withFileTypes: true });
      if (installLayout === 'dir') {
        return entries
          .filter((e) => e.isDirectory() && !excludeInstalled.includes(e.name))
          .map((e) => e.name);
      }
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(installedExt))
        .map((e) => e.name.slice(0, -installedExt.length))
        .filter((id) => !excludeInstalled.includes(id));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async function listAvailable(bundle = bundleDir) {
    try {
      const entries = await readdir(bundle, { withFileTypes: true });
      if (sourceLayout === 'flat') {
        return entries
          .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
          .map((e) => e.name.slice(0, -'.md'.length));
      }
      const directories = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const available = await Promise.all(directories.map(async (id) => {
        try {
          await readFile(bundleSourcePath(id, bundle));
          return id;
        } catch {
          return null;
        }
      }));
      return available.filter(Boolean);
    } catch {
      return [];
    }
  }

  async function getMeta(id, bundle = bundleDir) {
    const key = cacheKey(id, bundle);
    if (metaCache.has(key)) return metaCache.get(key);
    try {
      const raw = await readFile(bundleSourcePath(id, bundle), 'utf-8');
      const fm = extractFrontMatter(raw);
      if (!fm) return defaultMeta(id);

      const meta = {
        name: parseScalar(fm, 'name') || id,
        description: parseScalar(fm, 'description') || '',
        descriptions: parseLocalizedDescriptions(fm, LOCALE_CODES),
      };
      for (const field of metaFields) {
        const sourceKeys = field.sourceKeys || [field.key];
        let value = null;
        for (const sourceKey of sourceKeys) {
          const parsed = field.kind === 'list'
            ? parseList(fm, sourceKey)
            : parseScalar(fm, sourceKey);
          if ((field.kind === 'list' && parsed.length) || (field.kind !== 'list' && parsed !== null && parsed !== '')) {
            value = parsed;
            break;
          }
        }
        meta[field.key] = value ?? field.defaultValue ?? (field.kind === 'list' ? [] : '');
      }

      metaCache.set(key, meta);
      return meta;
    } catch (err) {
      if (err.code === 'ENOENT') {
        metaCache.set(key, null);
        return null;
      }
      throw err;
    }
  }

  async function install(id, targetDir, bundle = bundleDir) {
    validateId(id, idLabel);
    if (installLayout === 'dir') {
      const srcDir = join(bundle, id);
      try {
        await stat(srcDir);
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`${notFound} '${id}' not found in registry`, { cause: err });
        throw err;
      }
      const destDir = join(targetDir, installedDir, id);
      // Skip self-copy (e.g. running init from inside the repo).
      if (isPathInsideOrEqual(destDir, srcDir)) return;
      await cp(srcDir, destDir, { recursive: true });
    } else {
      const srcFile = bundleSourcePath(id, bundle);
      try {
        await readFile(srcFile);
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`${notFound} '${id}' not found in registry`, { cause: err });
        throw err;
      }
      const destDir = join(targetDir, installedDir);
      await mkdir(destDir, { recursive: true });
      await copyFile(srcFile, join(destDir, id + installedExt));
    }
    metaCache.delete(cacheKey(id, bundle));
  }

  async function remove(id, targetDir, bundle = bundleDir) {
    validateId(id, idLabel);
    if (installLayout === 'dir') {
      await rm(join(targetDir, installedDir, id), { recursive: true, force: true });
    } else {
      await rm(join(targetDir, installedDir, id + installedExt), { force: true });
    }
    metaCache.delete(cacheKey(id, bundle));
  }

  async function getVersion(id, targetDir) {
    try {
      const content = await readFile(installedSourcePath(id, targetDir), 'utf-8');
      const fm = extractFrontMatter(content);
      if (!fm) return null;
      return parseScalar(fm, 'version');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  function clearMetaCache() {
    metaCache.clear();
  }

  function getLocalizedDescription(meta, localeCode) {
    if (localeCode && localeCode !== 'en' && meta.descriptions?.[localeCode]) {
      return meta.descriptions[localeCode];
    }
    return meta.description;
  }

  return {
    listInstalled,
    listAvailable,
    getMeta,
    install,
    remove,
    getVersion,
    clearMetaCache,
    getLocalizedDescription,
  };
}
