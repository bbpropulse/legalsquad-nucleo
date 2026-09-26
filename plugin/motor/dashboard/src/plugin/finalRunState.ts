import fsp from "node:fs/promises";
import path from "node:path";
// Extensão explícita de propósito: ao contrário do resto do plugin, este módulo
// também é carregado direto pelo node em tests/dashboard.test.js — e lá não há
// resolução de bundler para completar o caminho.
import { validateSquadState } from "../lib/validateState.ts";
import type { SquadState, WsMessage } from "../types/state.ts";

/** Os dois status que ENCERRAM um run. Só eles podem ser servidos do arquivo. */
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed"]);

/** Ledger durável do run — sobrevive ao cleanup e guarda o `run_id`. */
const RUN_LEDGER = "run-state.json";

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf-8"));
  } catch {
    return null; // ausente, ilegível ou JSON quebrado — todos levam ao mesmo lugar
  }
}

/**
 * `run_id` vem de um arquivo local que o runner sanciona editar à mão. Ele vira
 * segmento de caminho, então um valor com `..` ou barra leria fora da pasta do
 * squad. Aceitamos só um nome de pasta simples.
 */
function isSafeRunId(id: string): boolean {
  return id.length > 0 && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");
}

/**
 * O estado final do último run, lido da CÓPIA ARQUIVADA — não do `state.json` vivo.
 *
 * O runner apaga `squads/{name}/state.json` assim que arquiva o run, e o watcher
 * pode perfeitamente ver o arquivo sumir sem nunca ter lido a escrita terminal
 * (o `awaitWriteFinish` do chokidar descarta a mudança pendente quando o arquivo
 * é removido antes de estabilizar). Reconstituir o desfecho a partir do disco é o
 * que dispensa a espera cega que existia no cleanup do runner só para dar tempo
 * ao dashboard.
 *
 * **Não adivinha qual era o run** — mesma regra da varredura de run morto: o
 * `run_id` vem do ledger durável (`run-state.json`, que o cleanup preserva). Isso
 * é o que impede ressuscitar o run ANTERIOR quando um run novo já começou: o
 * ledger já aponta para o `run_id` novo, cuja pasta ainda não tem estado
 * arquivado, e a resolução falha em vez de mentir.
 *
 * O ledger só localiza; quem PROVA que o run acabou é o próprio estado arquivado
 * (`completed`/`failed`). Qualquer outra coisa devolve `null` — fail-closed, para
 * o chamador cair no comportamento de sempre ("squad inativo").
 */
export async function resolveFinalRunState(squadDir: string): Promise<SquadState | null> {
  const ledger = (await readJson(path.join(squadDir, RUN_LEDGER))) as { runId?: unknown } | null;
  const runId = ledger && typeof ledger.runId === "string" ? ledger.runId.trim() : "";
  if (!isSafeRunId(runId)) return null;

  const archived = await readJson(path.join(squadDir, "output", runId, "state.json"));
  if (archived === null) return null;

  const check = validateSquadState(archived);
  if (!check.ok) return null;
  if (!TERMINAL.has(check.state.status)) return null;

  return check.state;
}

/**
 * O que o watcher anuncia quando `state.json` some.
 *
 * `SQUAD_FINISHED` carrega o desfecho e é o que o painel exibe na transição;
 * `SQUAD_INACTIVE` continua sendo a resposta quando não há desfecho provável no
 * disco (run antigo sem arquivamento, arquivo apagado no meio da execução). São
 * mensagens diferentes porque significam coisas diferentes: "terminou assim" e
 * "não há nada aqui" pedem reações opostas do cliente.
 */
export async function removalMessage(
  squadsDir: string,
  dir: string,
  code: string
): Promise<WsMessage> {
  const state = await resolveFinalRunState(path.join(squadsDir, dir));
  return state
    ? { type: "SQUAD_FINISHED", squad: code, state }
    : { type: "SQUAD_INACTIVE", squad: code };
}
