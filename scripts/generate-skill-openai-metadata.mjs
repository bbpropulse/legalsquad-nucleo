#!/usr/bin/env node
// Package-root CLI over the shared v5 contract layer. Regenerates every skill's
// agents/openai.yaml for the repository's own skills/ library. The cwd-aware twin
// used inside a mentee's project runs as part of `npx legalsquad contract-skills`.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSkillOpenAiMetadata } from '../src/skill-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const { generated } = generateSkillOpenAiMetadata({ root: ROOT, dryRun });

console.log(`Metadados OpenAI: ${generated} skills${dryRun ? ' (dry-run)' : ''}.`);
