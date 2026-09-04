#!/usr/bin/env node
/**
 * Citation Gate v2 — sentinela determinística para artefatos jurídicos finais.
 *
 * FAZ (fail-closed no escopo):
 * - identifica arquivos jurídicos finais em squads/<squad>/output/;
 * - bloqueia marcadores de pendência;
 * - exige um manifesto <artefato>.citation-gate.json aprovado;
 * - confere a estrutura do manifesto e seu vínculo SHA-256 com o arquivo exato.
 *
 * NÃO FAZ (verificação material):
 * - não acessa tribunais, diários ou bases oficiais;
 * - não confirma existência, vigência, teor, pertinência ou oficialidade da fonte;
 * - não substitui o verificador de citações nem a revisão humana.
 *
 * O manifesto é uma ATESTAÇÃO do trabalho material já realizado, não prova de que
 * a fonte existe. URL bem-formada e status "verificada" são apenas dados locais.
 * Entrada inesperada fora do escopo é ignorada; depois que um artefato final é
 * identificado, erro de leitura, manifesto ausente/inválido ou hash divergente
 * sempre bloqueia (exit 2).
 */
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const EXIT_BLOCKED = 2;
const MANIFEST_SUFFIX = '.citation-gate.json';
const FINAL_MARKER = /<!--\s*LEGALSQUAD:CITATION-GATE:FINAL\s*-->/i;
const FINAL_FRONTMATTER = /^---\s*[\s\S]*?^citation_gate:\s*["']?final["']?\s*$[\s\S]*?^---\s*$/im;
const DRAFT_FRONTMATTER = /^---\s*[\s\S]*?^citation_gate:\s*["']?(?:draft|internal|rascunho)["']?\s*$[\s\S]*?^---\s*$/im;
const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O)\]/gi;
const MATERIAL_CITATION = /(?:\b(?:REsp|AREsp|RHC|HC|AgRg|EDcl|ARE|RE|ADPF|ADI|ADC)\s*(?:n[º°o.]?\s*)?[\d.]|\bS[úu]mula(?:\s+Vinculante)?\s*(?:n[º°o.]?\s*)?\d+|\bTema\s+(?:repetitivo\s+|de\s+repercuss[ãa]o\s+geral\s+)?(?:n[º°o.]?\s*)?\d+|\bart(?:igo)?[.]?\s*\d+[A-Za-z-]*(?:\s*,?\s*(?:§|inciso|[IVXLCDM]+))?[^\n]{0,100}\b(?:CP|CPP|CF|LEP|Lei|Decreto|Resolu[çc][ãa]o)\b)/i;
const LEGAL_NAME = /(?:^|[-_.])(?:peti[çc][ãa]o|peticao|pe[çc]a|peca|recurso|apela[çc][ãa]o|apelacao|agravo|habeas[-_]?corpus|hc|resposta[-_]?acusa[çc][ãa]o|memoriais|alega[çc][õo]es|contrarraz[õo]es|raz[õo]es|queixa[-_]?crime|den[úu]ncia|parecer|decis[ãa]o|acordo)(?:[-_.]|$)/i;
const FINAL_NAME = /(?:^|[-_.])final(?:[-_.]|$)/i;
const DRAFT_NAME = /(?:^|[-_.])(?:minuta|rascunho|draft|intern[oa])(?:[-_.]|$)/i;
const INTERNAL_NAME = /^(?:revis[ãa]o|aprova[çc][ãa]o|checklist|relat[óo]rio|pesquisa|resumo|diagn[óo]stico|bloqueio|precedentes|cabimento|fatos|teses|estrat[ée]gia|c[áa]lculo|intake|onboarding|publish[-_]?report)(?:[-_.]|$)/i;
const SUPPORTED_EXT = /\.(?:md|txt|rtf|docx|odt|pdf)$/i;

function normalizePath(value = '') {
  return String(value).replace(/\\/g, '/');
}

function inSquadOutput(filePath) {
  return /(?:^|\/)squads\/[^/]+\/output\//i.test(normalizePath(filePath));
}

function isInternalDraft(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const name = basename(normalizedPath);
  return name.startsWith('_')
    || name.startsWith('.')
    || /\/(?:_?drafts?|_?rascunhos?|_internal|revis(?:ao|ão)(?:[-_/]|$))\//i.test(normalizedPath)
    || DRAFT_NAME.test(name)
    || INTERNAL_NAME.test(name)
    || DRAFT_FRONTMATTER.test(text);
}

function isFinalLegalArtifact(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const name = basename(normalizedPath);
  if (!inSquadOutput(normalizedPath) || name.endsWith(MANIFEST_SUFFIX)) return false;
  if (!SUPPORTED_EXT.test(name) || isInternalDraft(normalizedPath, text)) return false;
  return /\/output\/final\//i.test(normalizedPath)
    || FINAL_NAME.test(name)
    || LEGAL_NAME.test(name)
    || FINAL_MARKER.test(text)
    || FINAL_FRONTMATTER.test(text);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function block(message) {
  process.stderr.write(`CITATION GATE — BLOQUEADO: ${message}\n`);
  process.stderr.write(
    'Esta sentinela só valida pendências, manifesto e integridade local. '
      + 'Ela NÃO consulta nem confirma fontes. Faça a verificação material em fonte primária, '
      + 'registre-a no manifesto e mantenha a revisão humana obrigatória.\n',
  );
  process.exit(EXIT_BLOCKED);
}

function cleanHash(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value || ''))) return false;
  return !Number.isNaN(Date.parse(value));
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function validateManifest(manifest, artifactPath, artifactBuffer, artifactText) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifesto deve ser objeto JSON'];
  if (manifest.schema_version !== '1') errors.push('schema_version deve ser "1"');
  if (manifest.kind !== 'legalsquad.citation-gate-attestation') errors.push('kind inválido');
  if (manifest.artifact !== basename(artifactPath)) errors.push(`artifact deve ser "${basename(artifactPath)}"`);
  if (!/^[a-f0-9]{64}$/.test(cleanHash(manifest.artifact_sha256))) errors.push('artifact_sha256 deve ser SHA-256 hexadecimal');
  if (cleanHash(manifest.artifact_sha256) !== sha256(artifactBuffer)) errors.push('artifact_sha256 não corresponde ao artefato atual');
  if (manifest.gate_status !== 'aprovado') errors.push('gate_status deve ser "aprovado"');
  if (manifest.verification_type !== 'material') errors.push('verification_type deve ser "material"');
  if (!['citacoes_materiais', 'sem_citacoes_materiais'].includes(manifest.scope)) errors.push('scope inválido');
  if (typeof manifest.verified_by !== 'string' || !manifest.verified_by.trim()) errors.push('verified_by é obrigatório');
  if (!isIsoDate(manifest.verified_at)) errors.push('verified_at deve ser data/hora ISO 8601 válida');
  if (!Array.isArray(manifest.citations)) errors.push('citations deve ser array');

  const citations = Array.isArray(manifest.citations) ? manifest.citations : [];
  if (manifest.scope === 'citacoes_materiais' && citations.length === 0) errors.push('scope citacoes_materiais exige ao menos uma citação');
  if (manifest.scope === 'sem_citacoes_materiais' && citations.length > 0) errors.push('scope sem_citacoes_materiais exige citations vazio');
  if (MATERIAL_CITATION.test(artifactText) && manifest.scope !== 'citacoes_materiais') {
    errors.push('o artefato aparenta conter citação material; scope não pode declarar ausência');
  }
  citations.forEach((citation, index) => {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) {
      errors.push(`citations[${index}] deve ser objeto`);
      return;
    }
    if (typeof citation.title !== 'string' || !citation.title.trim()) errors.push(`citations[${index}].title é obrigatório`);
    if (citation.status !== 'verificada') errors.push(`citations[${index}].status deve ser "verificada"`);
    if (!isHttpsUrl(citation.source_url)) errors.push(`citations[${index}].source_url deve ser URL HTTPS`);
    if (!isIsoDate(citation.consulted_at)) errors.push(`citations[${index}].consulted_at deve ser data/hora ISO 8601 válida`);
  });

  const pending = `${artifactText}\n${JSON.stringify(manifest)}`.match(PENDING_MARKER) || [];
  if (pending.length) errors.push(`há ${pending.length} marcador(es) de pendência`);
  return errors;
}

function readArtifact(filePath) {
  try {
    const buffer = readFileSync(filePath);
    const isText = /\.(?:md|txt|rtf)$/i.test(filePath);
    return { buffer, text: isText ? buffer.toString('utf8') : '' };
  } catch (error) {
    block(`não foi possível ler o artefato final ${filePath}: ${error.message}`);
  }
}

function validateArtifact(filePath) {
  const { buffer, text } = readArtifact(filePath);
  if (!isFinalLegalArtifact(filePath, text)) return;

  const pending = text.match(PENDING_MARKER) || [];
  if (pending.length) {
    const kinds = [...new Set(pending.map((item) => item.toUpperCase()))].join(', ');
    block(`${basename(filePath)} contém ${pending.length} marcador(es) de pendência (${kinds})`);
  }

  const manifestPath = `${filePath}${MANIFEST_SUFFIX}`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    block(
      `manifesto ausente ou inválido para ${basename(filePath)}. `
        + `Crie ${basename(manifestPath)} conforme scripts/citation-gate-manifest.schema.json (${error.message})`,
    );
  }
  const errors = validateManifest(manifest, filePath, buffer, text);
  if (errors.length) block(`${basename(manifestPath)} inválido: ${errors.join('; ')}`);
}

function artifactFromManifest(manifestPath) {
  const name = basename(manifestPath);
  const artifactName = name.slice(0, -MANIFEST_SUFFIX.length);
  if (!artifactName || artifactName.includes('/') || artifactName.includes('\\')) block('nome de manifesto inválido');
  return join(dirname(manifestPath), artifactName);
}

function runForPath(inputPath) {
  const filePath = normalize(inputPath);
  if (!inSquadOutput(filePath)) return;
  if (filePath.endsWith(MANIFEST_SUFFIX)) {
    const artifactPath = artifactFromManifest(filePath);
    validateArtifact(artifactPath);
    return;
  }
  let text = '';
  try {
    if (/\.(?:md|txt|rtf)$/i.test(filePath)) text = readFileSync(filePath, 'utf8');
  } catch {
    // Só a classificação usa esta leitura; artefato final identificado por nome
    // será relido de modo fail-closed em validateArtifact.
  }
  if (isFinalLegalArtifact(filePath, text)) validateArtifact(filePath);
}

function pathFromHookInput(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return '';
  }
  const toolInput = data && typeof data === 'object' ? (data.tool_input || {}) : {};
  return toolInput.file_path || toolInput.path || '';
}

const checkIndex = process.argv.indexOf('--check');
if (checkIndex >= 0) {
  const requestedPath = process.argv[checkIndex + 1];
  if (!requestedPath) block('uso: verifica-citacoes.mjs --check <artefato-ou-manifesto>');
  runForPath(isAbsolute(requestedPath) ? normalize(requestedPath) : normalize(resolve(requestedPath)));
  process.exit(0);
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
const hookPath = pathFromHookInput(raw);
if (!hookPath) process.exit(0);
runForPath(normalize(hookPath));
process.exit(0);
