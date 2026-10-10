// Semeia o harness de eval de um squad que nasceu antes de a regra existir.
//
// O `check-squad` exige `_evals/scores.md` e ao menos um caso em `_evals/casos/`.
// A exigência é boa: sem log não há regressão a detectar, e sem caso-ouro a
// avaliação não é repetível. Mas ela chegou depois de muita gente já ter squads
// escritos — e o `update` preserva `squads/`, corretamente, porque aquilo é
// conteúdo do usuário. Resultado: dois erros por squad antigo, sem caminho de
// migração. Um gate que reprova sem dar saída ensina a conviver com vermelho.
//
// **O que este módulo faz e o que se recusa a fazer.** A RUBRICA ele deriva do
// que o squad já declara — `goal` e `success_criteria` estão no `squad.yaml` e
// são exatamente os critérios que o `avaliador-squad` usa. Já o INPUT do caso
// ficcional é trabalho humano, e fica marcado como tal: caso-ouro com fatos
// inventados por máquina é pior que caso-ouro nenhum, porque dá a impressão de
// que a avaliação mede alguma coisa.
//
// Idempotente: nunca sobrescreve arquivo existente.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const semAspas = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '').trim();

/** Escalar de topo em YAML plano. */
function escalarDeTopo(texto, chave) {
  const m = texto.match(new RegExp(`^${chave}:[ \\t]*(.+)$`, 'm'));
  return m ? semAspas(m[1].replace(/\s+#.*$/, '')) : null;
}

/**
 * Lista de topo: bloco `- a` com QUALQUER indentação, ou inline `[a, b]`.
 * A indentação livre é deliberada — exigir dois espaços foi um defeito real do
 * validador, que acusava "0 critério(s)" de quem escrevera a rubrica com quatro.
 */
function listaDeTopo(texto, chave) {
  const inline = texto.match(new RegExp(`^${chave}:[ \\t]*\\[([^\\]]*)\\]`, 'm'));
  if (inline) return inline[1].split(',').map(semAspas).filter(Boolean);
  const bloco = texto.match(new RegExp(`^${chave}:[ \\t]*\\n((?:[ \\t]+- .*\\n?)*)`, 'm'));
  if (!bloco) return [];
  return [...bloco[1].matchAll(/^[ \t]+- (.+)$/gm)]
    .map((m) => semAspas(m[1].replace(/\s+#.*$/, '')))
    .filter(Boolean);
}

function cabecalhoDeScores(code, hoje) {
  return `# Scores de eval: ${code}

Log de regressão do squad. Uma linha por avaliação; \`npm run eval:resumo\` lê
esta tabela e calcula média, faixa e tendência. Preenchido pelo
\`/legalsquad eval ${code}\`, que pontua o output contra os \`success_criteria\`
do \`squad.yaml\`.

Tabela semeada em ${hoje} por \`legalsquad eval-init\`. Ainda sem avaliação: a
primeira linha aparece quando você rodar o primeiro eval.

| Data | Run/Caso | Nota | Verdict | Observações |
|------|----------|------|---------|-------------|
`;
}

function casoOuro(code, goal, criterios, hoje) {
  const rubrica = criterios.length
    ? criterios.map((c, i) => `${i + 1}. **${c}**\n   \`[COMO SE VERIFICA]\`: o que, no output, mostra que este critério foi atendido.`).join('\n\n')
    : '`[PREENCHER]`: o `squad.yaml` não declara `success_criteria`. Declare-os primeiro:\n   eles são a rubrica, e sem eles não há o que medir.';

  return `# Caso-ouro: ${code}

> **ESQUELETO SEMEADO EM ${hoje}, AINDA NÃO UTILIZÁVEL.** A rubrica abaixo veio
> do \`squad.yaml\` e está correta. O **input fictício** está por escrever, e é
> trabalho humano: um caso-ouro com fatos inventados por máquina é pior que
> caso-ouro nenhum, porque dá a impressão de que a avaliação mede alguma coisa.
> Enquanto houver \`[PREENCHER]\` neste arquivo, o eval não é confiável.

> **Fictício por construção.** Nomes, números, datas e valores têm de ser
> inventados. Não se versiona dado de cliente numa fixture de avaliação.

## Objetivo do squad

${goal || '`[PREENCHER]`: o `squad.yaml` não declara `goal`.'}

## Input fictício

\`[PREENCHER]\`: descreva aqui o caso que o squad receberia: partes, datas,
valores, documentos, e o que o profissional responderia em cada checkpoint.
Use um caso real como molde e **troque todos os identificadores**.

## O que um bom output deve conter

Derivado dos \`success_criteria\` do \`squad.yaml\`; esta parte já está pronta:

${rubrica}

## Sinais de falha

\`[PREENCHER]\`: o que reprova o caso mesmo que o resto esteja bom. Comece
pelos inversos dos critérios acima, e acrescente os erros que você já viu
acontecer neste tipo de trabalho.
`;
}

/**
 * Semeia `_evals/` no squad. Não sobrescreve nada.
 *
 * @returns {{ code: string, criados: string[], jaExistiam: string[], pendentes: number }}
 */
export function semearEvals(squadDir, { agora = new Date() } = {}) {
  const dir = resolve(squadDir);
  if (!existsSync(dir)) throw new Error(`squad não encontrado: ${dir}`);

  const squadYaml = join(dir, 'squad.yaml');
  if (!existsSync(squadYaml)) throw new Error(`sem squad.yaml em ${dir}: não é um squad`);
  const y = readFileSync(squadYaml, 'utf8');
  const code = escalarDeTopo(y, 'code') || basename(dir);
  const goal = escalarDeTopo(y, 'goal');
  const criterios = listaDeTopo(y, 'success_criteria');
  const hoje = agora.toISOString().slice(0, 10);

  const criados = [];
  const jaExistiam = [];

  const scores = join(dir, '_evals', 'scores.md');
  if (existsSync(scores)) {
    jaExistiam.push('_evals/scores.md');
  } else {
    mkdirSync(join(dir, '_evals'), { recursive: true });
    writeFileSync(scores, cabecalhoDeScores(code, hoje));
    criados.push('_evals/scores.md');
  }

  const casosDir = join(dir, '_evals', 'casos');
  const jaTem = existsSync(casosDir) && readdirSync(casosDir).some((f) => f.endsWith('.md'));
  const caso = join(casosDir, `caso-ouro-${code}.md`);
  if (jaTem) {
    jaExistiam.push('_evals/casos/ (já tem caso)');
  } else {
    mkdirSync(casosDir, { recursive: true });
    writeFileSync(caso, casoOuro(code, goal, criterios, hoje));
    criados.push(`_evals/casos/caso-ouro-${code}.md`);
  }

  // Quantos `[PREENCHER]` restam no caso — é o que separa "o gate passa" de
  // "a avaliação vale alguma coisa", e o CLI diz isso em voz alta.
  const pendentes = existsSync(caso)
    ? (readFileSync(caso, 'utf8').match(/\[PREENCHER\]/g) || []).length
    : 0;

  return { code, criados, jaExistiam, pendentes };
}

/** Todos os squads de `squadsDir` que ainda não têm o harness completo. */
export function squadsSemEvals(squadsDir) {
  const dir = resolve(squadsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'squad.yaml')))
    .filter((e) => {
      const evals = join(dir, e.name, '_evals');
      const casos = join(evals, 'casos');
      const temScores = existsSync(join(evals, 'scores.md'));
      const temCaso = existsSync(casos) && readdirSync(casos).some((f) => f.endsWith('.md'));
      return !temScores || !temCaso;
    })
    .map((e) => e.name);
}
