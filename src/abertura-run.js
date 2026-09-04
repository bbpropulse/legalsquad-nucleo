// Abertura do run — a parte determinística que saiu do `runner.pipeline.md`
// (achados M1/M2 da auditoria de prompts, 02/09/2026).
//
// Fonte da verdade deste bloco; a cópia verbatim vive em
// `scripts/squad-state.mjs` (e no espelho de `templates/`), porque o script é
// distribuído a um projeto que NÃO tem `src/`. As cópias são guardadas por
// `scripts/sync-blocos.mjs` e por `tests/abertura-run.test.js`: se divergirem,
// a suíte quebra.
//
// O bloco não importa nada e não usa `export` — é código que precisa colar
// dentro de um script CLI. Os `export` desta casa ficam no fim do arquivo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** No script CLI, `die` já existe; aqui, lançar é o equivalente honesto. */
function die(mensagem) {
  throw new Error(mensagem);
}

/** No script CLI, `readSquadCode` já existe; aqui é a mesma leitura. */
function readSquadCode(dir) {
  const p = join(dir, 'squad.yaml');
  if (!existsSync(p)) die(`squad.yaml não encontrado em ${dir}`);
  const m = readFileSync(p, 'utf-8').match(/^code:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m ? m[1].trim() : '';
}

// >>> abertura-run:begin
/** Nome de exibição do squad (`name:`); cai no `code` quando ausente. */
function readSquadName(dir) {
  const p = join(dir, 'squad.yaml');
  if (!existsSync(p)) return readSquadCode(dir);
  const m = readFileSync(p, 'utf-8').match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m ? m[1].trim() : readSquadCode(dir);
}

/**
 * `YYYY-MM-DD-HHmmss` no fuso do FORO — não o da máquina. Contêiner, cron e
 * viagem rodam em UTC, e um run aberto às 21h de Recife não deve nascer com a
 * data do dia seguinte. Mesmo racional do `today()` dos scripts orchestra.
 */
const FUSO_DO_FORO = 'America/Sao_Paulo';

function formatarRunId(agora = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_DO_FORO,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(agora).reduce((acc, { type, value }) => ({ ...acc, [type]: value }), {});
  const hora = p.hour === '24' ? '00' : p.hour; // en-CA usa 24 para meia-noite
  return `${p.year}-${p.month}-${p.day}-${hora}${p.minute}${p.second}`;
}

/**
 * Um `run_id` livre: o formato acima e, na colisão sub-segundo, `-2`, `-3`…
 * até a pasta do run não existir. `ocupado` é injetável para teste.
 */
function gerarRunId(dir, { agora = new Date(), ocupado } = {}) {
  const existe = ocupado || ((id) => existsSync(join(dir, 'output', id)));
  const base = formatarRunId(agora);
  if (!existe(base)) return base;
  for (let n = 2; n <= 100; n += 1) {
    if (!existe(`${base}-${n}`)) return `${base}-${n}`;
  }
  die(`não consegui um run_id livre a partir de ${base} — 100 colisões seguidas`);
}

/** As cinco seções canônicas do `memories.md`, na ordem. */
const SECOES_DE_MEMORIA = Object.freeze([
  '## Estilo de Escrita',
  '## Design Visual',
  '## Estrutura de Conteúdo',
  '## Proibições Explícitas',
  '## Técnico (específico do squad)',
]);

/**
 * Normaliza `_memory/memories.md` e `_memory/runs.md` do squad.
 *
 * **Idempotente e NÃO destrutiva** — e aqui houve uma correção de premissa:
 * a instrução que este código substitui mandava, em prosa, "reset
 * unconditionally… do NOT attempt to salvage content from the old file".
 * Em código isso viraria apagar em silêncio o que o escritório escreveu, toda
 * vez que faltasse um cabeçalho — a mesma perda silenciosa que a rota de
 * aprendizado técnico sofria ao gravar em pasta de pacote. O que uma migração
 * de FORMATO precisa é garantir que as seções existam: arquivo ausente ou
 * vazio recebe o modelo; arquivo com conteúdo recebe, no fim, apenas as
 * seções que faltavam. Nada do usuário é descartado.
 */
function normalizarMemoriaDoSquad(dir, nomeDeExibicao) {
  const memDir = join(dir, '_memory');
  const resultado = { memories: 'ok', runs: 'ok' };

  const alvoMemories = join(memDir, 'memories.md');
  const atual = existsSync(alvoMemories) ? readFileSync(alvoMemories, 'utf-8') : null;
  if (atual === null || !atual.trim()) {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(alvoMemories, `# Squad Memory: ${nomeDeExibicao}\n\n${SECOES_DE_MEMORIA.join('\n\n')}\n`, 'utf-8');
    resultado.memories = atual === null ? 'criado' : 'preenchido';
  } else {
    const faltando = SECOES_DE_MEMORIA.filter((h) => !atual.includes(h));
    if (faltando.length) {
      const corpo = `${atual.replace(/\s*$/, '')}\n\n${faltando.join('\n\n')}\n`;
      mkdirSync(memDir, { recursive: true });
      writeFileSync(alvoMemories, corpo, 'utf-8');
      resultado.memories = `seções acrescentadas: ${faltando.length}`;
    }
  }

  const alvoRuns = join(memDir, 'runs.md');
  const CABECALHO_DE_RUNS = '| Data | Run ID | Tema | Output | Resultado |';
  const runs = existsSync(alvoRuns) ? readFileSync(alvoRuns, 'utf-8') : null;
  if (runs === null || !runs.trim()) {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      alvoRuns,
      `# Run History: ${nomeDeExibicao}\n\n${CABECALHO_DE_RUNS}\n|------|--------|------|--------|-----------|\n`,
      'utf-8',
    );
    resultado.runs = runs === null ? 'criado' : 'preenchido';
  }
  return resultado;
}
// <<< abertura-run:end

export { formatarRunId, gerarRunId, normalizarMemoriaDoSquad, readSquadName, SECOES_DE_MEMORIA };
