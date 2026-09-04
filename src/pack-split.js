// Corte `transversal` × `area.*` (SPEC §6.3).
//
// O empacotador é cego: ele não pode ADIVINHAR que uma skill serve qualquer
// área. Quem sabe é o curador, e ele declara num `_packs.yaml` na raiz do
// conteúdo — um lugar só, auditável de uma vez. O corte tem consequência: uma
// skill presente nos dois pacotes é erro de build, e uma skill transversal que
// cai na área vira duplicação em TODA área, que é exatamente o que a migração
// existe para eliminar.
//
// O arquivo é YAML PLANO de propósito, para reusar `parseScalar`/`parseList` do
// frontmatter — parser já testado, incluindo os casos de comentário que já
// custaram bug. Sem dependência nova para ler cinco chaves.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseList, parseScalar } from './frontmatter.js';

const ARQUIVO = '_packs.yaml';

/** Skills e best-practices viajam no corte; squads são de área por definição. */
const PREFIXO_SKILLS = 'skills/';
const PREFIXO_BEST_PRACTICES = 'core/best-practices/';

function chavePresente(bruto, chave) {
  return new RegExp(`^\\s*${chave}\\s*:`, 'm').test(bruto);
}

/**
 * Lê o corte declarado na raiz do conteúdo.
 * Fail-closed: sem o arquivo, ou sem a chave `transversal_skills`, o build para.
 */
export function lerCorteDePacotes(raizConteudo) {
  const caminho = join(raizConteudo, ARQUIVO);
  if (!existsSync(caminho)) {
    throw new Error(
      `pack-split: ${ARQUIVO} ausente em ${raizConteudo} — o empacotador não adivinha o corte ` +
        'transversal × área. Sem ele, skills transversais iriam para o pacote de área e ' +
        'apareceriam duplicadas em toda área instalada.'
    );
  }

  const bruto = readFileSync(caminho, 'utf8');
  if (!chavePresente(bruto, 'transversal_skills')) {
    throw new Error(
      `pack-split: ${ARQUIVO} sem a chave \`transversal_skills\` — chave ausente não significa ` +
        'lista vazia. "Nenhuma skill transversal" é decisão de curadoria e precisa estar escrita ' +
        '(`transversal_skills: []`).'
    );
  }

  return {
    areaId: parseScalar(bruto, 'area_id') || null,
    titulo: parseScalar(bruto, 'area_titulo') || null,
    curador: parseScalar(bruto, 'area_curador') || null,
    ramos: parseList(bruto, 'area_ramos'),
    transversalSkills: new Set(parseList(bruto, 'transversal_skills')),
    // OPCIONAL, diferente de `transversal_skills`. Aquela nasceu com o formato,
    // e a sua ausência esconderia skill transversal duplicada em toda área —
    // por isso é fail-closed. Esta chegou depois: exigi-la invalidaria de uma
    // vez todo `_packs.yaml` já autorado, trocando um defeito silencioso por
    // uma quebra ruidosa em conteúdo que está correto. Omitir = "nenhuma", que
    // é exatamente o comportamento anterior.
    transversalBestPractices: new Set(parseList(bruto, 'transversal_best_practices')),
  };
}

/** `skills/_evals/*.json` na raiz de `_evals/` — o catálogo de casos, não a evidência local. */
function ehCatalogoDeEvals(caminho) {
  return /^skills\/_evals\/[^/]+\.json$/.test(caminho);
}

/** `_catalog.yaml` / `_catalog.<area>.yaml` na raiz da pasta de best-practices. */
function ehCatalogoDeBestPractices(caminho) {
  if (!caminho.startsWith(PREFIXO_BEST_PRACTICES)) return false;
  const resto = caminho.slice(PREFIXO_BEST_PRACTICES.length);
  return !resto.includes('/') && /^_catalog(\.[^/]+)?\.yaml$/.test(resto);
}

/** O id da best-practice é o nome do arquivo, sem `.md`. Só na raiz da pasta. */
function idDaBestPractice(caminho) {
  if (!caminho.startsWith(PREFIXO_BEST_PRACTICES)) return null;
  const resto = caminho.slice(PREFIXO_BEST_PRACTICES.length);
  if (resto.includes('/') || !resto.endsWith('.md')) return null;
  return resto.slice(0, -3);
}

/** O id da skill é o primeiro segmento depois de `skills/`. */
function idDaSkill(caminho) {
  if (!caminho.startsWith(PREFIXO_SKILLS)) return null;
  const resto = caminho.slice(PREFIXO_SKILLS.length);
  const barra = resto.indexOf('/');
  return barra === -1 ? null : resto.slice(0, barra);
}

/**
 * Roteia cada entidade-arquivo para `transversal` ou `area`.
 * A skill inteira viaja junta — `references/`, `agents/`, tudo.
 */
export function separarEntidades(entidades, transversalSkills, transversalBestPractices = new Set()) {
  const transversal = [];
  const area = [];
  const casados = new Set();
  const casadasBp = new Set();

  for (const entidade of entidades) {
    const id = idDaSkill(entidade.path);
    if (id && transversalSkills.has(id)) {
      casados.add(id);
      transversal.push(entidade);
      continue;
    }
    const bp = idDaBestPractice(entidade.path);
    if (bp && transversalBestPractices.has(bp)) {
      casadasBp.add(bp);
      transversal.push(entidade);
      continue;
    }
    area.push(entidade);
  }

  // O catálogo ACOMPANHA a best-practice — nos dois pacotes, quando há
  // transversais. Ele é quem carrega `whenToUse` e `obrigatoria`; deixá-lo só
  // de um lado faz o outro cair no título do markdown e perder a
  // obrigatoriedade, em silêncio (best-practice órfã cair no título é
  // comportamento legítimo, então nada grita).
  //
  // Duplicar custa alguns KB e é inócuo: o leitor da instalação já funde vários
  // `_catalog*.yaml` com "primeiro id vence", e entrada que aponta para arquivo
  // ausente já é tolerada. A alternativa — particionar as entradas por pacote —
  // exigiria o build REESCREVER o YAML do curador, trocando um problema de
  // bytes duplicados por um de bytes fabricados.
  if (casadasBp.size) {
    for (const entidade of area) {
      if (ehCatalogoDeBestPractices(entidade.path)) transversal.push(entidade);
    }
  }
  // O catálogo de EVALS acompanha a skill, pela mesma razão e com consequência
  // maior: ele carrega os casos que `eval_linked` exige, e skill sem caso cai em
  // hard fail — o resolvedor a BLOQUEIA, não é degradação silenciosa. O arquivo
  // não mora sob nenhum id de skill (`skills/_evals/`), então caía inteiro no
  // balde da área; num pacote 100% transversal a área nem é emitida e o
  // catálogo sumia. Medido em 03/09/2026 ao recontratar o `transversal`: 70
  // skills publicadas com contrato e sem um único caso, todas recusadas.
  // Duplicar é inócuo: mesmos bytes, mesmo caminho, e o leitor
  // (`loadSkillEvalCases`) já funde todo `.json` de `_evals/`.
  if (casados.size) {
    for (const entidade of area) {
      if (ehCatalogoDeEvals(entidade.path)) transversal.push(entidade);
    }
  }

  // Declaração que aponta para o vazio é sintoma de arquivo renomeado ou
  // removido. Aceitar em silêncio produziria um `transversal` menor do que o
  // curador pensa que produziu — e ninguém descobre até faltar numa área.
  const fantasmas = [...transversalSkills].filter((id) => !casados.has(id)).sort();
  if (fantasmas.length) {
    throw new Error(
      `pack-split: ${ARQUIVO} declara skill(s) transversal(is) que não existem no conteúdo — ` +
        `${fantasmas.join(', ')}. Renomeada, removida, ou erro de digitação.`
    );
  }

  const fantasmasBp = [...transversalBestPractices].filter((id) => !casadasBp.has(id)).sort();
  if (fantasmasBp.length) {
    throw new Error(
      `pack-split: ${ARQUIVO} declara best-practice(s) transversal(is) que não existem no ` +
        `conteúdo — ${fantasmasBp.join(', ')}. Renomeada, removida, ou erro de digitação.`
    );
  }

  return { transversal, area };
}
