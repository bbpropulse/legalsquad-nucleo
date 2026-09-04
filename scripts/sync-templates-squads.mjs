#!/usr/bin/env node
// Gera `templates/squads/` — os squads que TODA instalação recebe no init — a
// partir das fixtures sintéticas de `tests/fixtures/area-demo/squads/`.
//
// Antes, o motor distribuía um `demo-squad` placeholder: só o squad.yaml, sem
// pipeline nem agentes, "para não distribuir uma referência pendurada". O aluno
// rodava `check-squad` no exemplo que o próprio motor instalou e via quatro
// erros. Aqui vai a fixture inteira — e vai também o `peca-modelo`, o squad de
// referência do caminho canônico (MIGRACAO-SQUADS-0.5.md), que até então só
// existia dentro dos testes, invisível para quem devia copiá-lo.
//
// A transformação existe porque a fixture declara conteúdo que só existe na
// área-demo dos testes: as skills `demo-*` e as best-practices
// `fluxo-demo-basico`/`revisao-dupla-demo`. Numa instalação real elas não
// estão lá, e `check-squad` acusaria `skill-declarada-inexistente` (erro) e
// `format-declarado-inexistente` (erro). Então: `skills:` esvazia, `data:` perde
// as best-practices, o `format:` de step sai. O que sobra é o que o exemplo
// existe para mostrar — estrutura, paradas, loop de revisão, harness de eval.
//
// `tests/templates-squads.test.js` prende as duas pontas: o que está em
// `templates/squads/` é byte a byte o que este script gera (sem deriva
// silenciosa), e cada template passa no `check-squad` sem área instalada.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'tests', 'fixtures', 'area-demo', 'squads');
export const SQUADS_DISTRIBUIDOS = ['demo-squad', 'peca-modelo'];

const CABECALHO = `# Squad de exemplo — sintético, sem matéria jurídica. Instalado em toda instalação
# nova do motor para mostrar a estrutura (paradas, loop de revisão, harness de eval).
# Não é conteúdo jurídico e não deve ser usado em caso real.
# GERADO por scripts/sync-templates-squads.mjs a partir de tests/fixtures/area-demo —
# não edite aqui; edite a fixture e rode \`node scripts/sync-templates-squads.mjs\`.
`;

/** squad.yaml: skills esvaziadas, best-practices fora de data:, cabeçalho de origem. */
export function transformarSquadYaml(texto) {
  let s = texto;
  // skills:\n  - a\n  - b  →  skills: []
  s = s.replace(/^skills:[ \t]*\n((?: {2}- .*\n)+)/m, 'skills: []\n');
  s = s.replace(/^skills:[ \t]*\[[^\]]*\]/m, 'skills: []');
  // linhas de data: que apontam best-practices
  s = s.replace(/^ {2}- _legalsquad\/core\/best-practices\/.*\n/gm, '');
  // data: que ficou vazio some
  s = s.replace(/^data:[ \t]*\n(?! {2}- )/m, '');
  return CABECALHO + s;
}

/** pipeline.yaml: `format:` de step sai (a best-practice não viaja). */
export function transformarPipelineYaml(texto) {
  return texto.replace(/^ {4}format: .*\n/gm, '');
}

/**
 * `.agent.md`: `skills:` do frontmatter esvaziada, pelo mesmo motivo do
 * `squad.yaml` — a instalação nova não tem as skills `demo-*`, e declará-las lá
 * vira `skill-declarada-inexistente` (erro) no primeiro `check-squad` do
 * usuário. O agente demonstra o CAMPO; o conteúdo é do projeto dele.
 */
export function transformarAgente(texto) {
  const m = texto.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return texto;
  let fm = m[1];
  fm = fm.replace(/^skills:[ \t]*\n((?: {2}- .*\n)+)/m, 'skills: []\n');
  fm = fm.replace(/^skills:[ \t]*\[[^\]]*\]/m, 'skills: []');
  return `---\n${fm}\n---\n${texto.slice(m[0].length)}`;
}

export function gerar(destinoBase) {
  const gerados = [];
  for (const nome of SQUADS_DISTRIBUIDOS) {
    const origem = join(FIXTURES, nome);
    const destino = join(destinoBase, nome);
    if (!existsSync(origem)) throw new Error(`fixture ausente: ${origem}`);
    rmSync(destino, { recursive: true, force: true });
    cpSync(origem, destino, {
      recursive: true,
      // evidência local de eval nunca é semente de distribuição
      filter: (p) => !/(^|\/)_evals\/results(\/|$)/.test(p) && !/(^|\/)_build(\/|$)/.test(p),
    });
    const squadYaml = join(destino, 'squad.yaml');
    writeFileSync(squadYaml, transformarSquadYaml(readFileSync(squadYaml, 'utf8')));
    const pipelineYaml = join(destino, 'pipeline', 'pipeline.yaml');
    if (existsSync(pipelineYaml)) writeFileSync(pipelineYaml, transformarPipelineYaml(readFileSync(pipelineYaml, 'utf8')));
    const agentsDir = join(destino, 'agents');
    if (existsSync(agentsDir)) {
      for (const nome of readdirSync(agentsDir).filter((n) => n.endsWith('.agent.md'))) {
        const alvo = join(agentsDir, nome);
        writeFileSync(alvo, transformarAgente(readFileSync(alvo, 'utf8')));
      }
    }
    gerados.push(nome);
  }
  return gerados;
}

/** Lista relativa de arquivos, para o teste comparar árvores. */
export function arquivosDe(raiz, prefixo = '') {
  const out = [];
  for (const nome of readdirSync(join(raiz, prefixo)).sort()) {
    const rel = prefixo ? `${prefixo}/${nome}` : nome;
    if (statSync(join(raiz, rel)).isDirectory()) out.push(...arquivosDe(raiz, rel));
    else out.push(rel);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = process.argv[2] || join(ROOT, 'templates', 'squads');
  mkdirSync(destino, { recursive: true });
  // o placeholder antigo (ou qualquer squad que não seja gerado daqui) sai
  for (const nome of readdirSync(destino)) {
    if (!SQUADS_DISTRIBUIDOS.includes(nome)) rmSync(join(destino, nome), { recursive: true, force: true });
  }
  const gerados = gerar(destino);
  console.log(`templates/squads: ${gerados.join(', ')} gerados de tests/fixtures/area-demo/squads`);
}
