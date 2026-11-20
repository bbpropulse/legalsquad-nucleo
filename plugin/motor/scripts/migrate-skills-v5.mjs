#!/usr/bin/env node
// Package-root CLI over the shared v5 contract layer. Applies (or dry-runs) the
// high-performance contract to the repository's own skills/ library. The cwd-aware
// twin used inside a mentee's project is `npx legalsquad contract-skills`.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractSkillCatalog } from '../src/skill-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const summary = contractSkillCatalog({
  root: ROOT,
  force: process.argv.includes('--force'),
  dryRun: process.argv.includes('--dry-run'),
});

console.log(JSON.stringify(summary, null, 2));
