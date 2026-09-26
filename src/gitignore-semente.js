// O `.gitignore` do projeto: a semente do motor mais as pastas de autos que os
// `caso.json` dos squads apontam.
//
// Medição dos moldes de 24/09/2026 (G13): a semente cobria só `squads/*/autos/`.
// No desenho de autos por referência (uma pasta por escritório, casos dentro), os
// autos moram em `casos/<caso>/autos/` (com `_texto/`, `_md/` e `_sumario/`) ou em
// qualquer pasta que o `caso.json` do squad aponte, e iam para o git do escritório
// junto com `identificacao.json` (peça, polo, fase, última folha) e o próprio
// `caso.json`. O `update` também nunca mexia no `.gitignore`: projeto criado antes
// de uma linha nova na semente ficava sem ela para sempre.
//
// Regra de mescla, igual à do `init` de antes: nada do usuário sai, linha que já
// existe não se repete, e o que falta entra no fim, sob `# LegalSquad`.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMENTE = join(dirname(fileURLToPath(import.meta.url)), '..', '_legalsquad', 'core', 'seeds', 'gitignore');

/** Linhas de regra da semente (sem comentário nem linha vazia). */
export function linhasDaSemente(conteudo = readFileSync(SEMENTE, 'utf8')) {
  return conteudo.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/**
 * Pastas de autos que os `squads/*\/caso.json` apontam, como linha de `.gitignore`
 * ancorada na raiz (`/Processos/Cliente A/autos/`). Caminho absoluto ou que sai da
 * raiz não vira linha: o `.gitignore` da raiz não alcança fora dela.
 */
export function autosPorReferencia(raiz) {
  const squads = join(raiz, 'squads');
  let nomes;
  try { nomes = readdirSync(squads, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const linhas = [];
  for (const nome of nomes.sort()) {
    let caso;
    try { caso = JSON.parse(readFileSync(join(squads, nome, 'caso.json'), 'utf8')); } catch { continue; }
    const autos = caso && typeof caso.autos === 'string' ? caso.autos : (caso && typeof caso.pasta === 'string' ? `${caso.pasta}/autos` : null);
    if (!autos || isAbsolute(autos)) continue;
    const rel = relative(raiz, resolve(raiz, normalize(autos)));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const linha = `/${rel.split(sep).join('/')}/`;
    if (!linhas.includes(linha)) linhas.push(linha);
  }
  return linhas;
}

/**
 * Garante no `.gitignore` de `raiz` as linhas da semente e as dos autos por referência.
 * `criar: false` só acrescenta num `.gitignore` que já existe (quem cria é o `init`).
 * Devolve `{ acao: 'criado'|'atualizado'|'intacto'|'ausente', acrescentadas: [] }`.
 */
export function mesclarGitignore(raiz, { criar = true, semente = null } = {}) {
  const caminho = join(raiz, '.gitignore');
  const conteudoSemente = semente ?? (existsSync(SEMENTE) ? readFileSync(SEMENTE, 'utf8') : '');
  const extras = autosPorReferencia(raiz);
  if (!existsSync(caminho)) {
    if (!criar) return { acao: 'ausente', acrescentadas: [] };
    const bloco = extras.length ? `\n# Autos por referência (squads/*/caso.json)\n${extras.join('\n')}\n` : '';
    writeFileSync(caminho, `${conteudoSemente}${conteudoSemente.endsWith('\n') || !conteudoSemente ? '' : '\n'}${bloco}`, 'utf8');
    return { acao: 'criado', acrescentadas: [...linhasDaSemente(conteudoSemente), ...extras] };
  }
  const existente = readFileSync(caminho, 'utf8');
  const tem = new Set(existente.split(/\r?\n/).map((l) => l.trim()));
  const faltam = [...linhasDaSemente(conteudoSemente), ...extras].filter((l, i, arr) => !tem.has(l) && arr.indexOf(l) === i);
  if (!faltam.length) return { acao: 'intacto', acrescentadas: [] };
  const eol = existente.includes('\r\n') ? '\r\n' : '\n';
  const sepFinal = existente.endsWith('\n') ? '' : eol;
  writeFileSync(caminho, `${existente}${sepFinal}${eol}# LegalSquad${eol}${faltam.join(eol)}${eol}`, 'utf8');
  return { acao: 'atualizado', acrescentadas: faltam };
}
