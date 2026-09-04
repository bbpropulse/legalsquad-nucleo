import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { watch as chokidarWatch } from "chokidar";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { SquadInfo, SquadState, SquadStateError, WsMessage } from "../types/state";
import { validateSquadState } from "../lib/validateState";
import { removalMessage } from "./finalRunState";
import { isAllowedOrigin } from "./originGuard";
import { createKeyedQueue } from "./broadcastQueue";
import { createRecentFinishes, type RecentFinishes } from "./recentFinishes";

function resolveSquadsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "../squads"),  // started from dashboard/
    path.resolve(process.cwd(), "squads"),     // started from project root
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.resolve(process.cwd(), "../squads"); // default (will be created on demand)
}

async function discoverSquads(squadsDir: string): Promise<SquadInfo[]> {
  let entries;
  try {
    entries = await fsp.readdir(squadsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const squads: SquadInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

    const yamlPath = path.join(squadsDir, entry.name, "squad.yaml");
    try {
      const raw = await fsp.readFile(yamlPath, "utf-8");
      const parsed = parseYaml(raw);
      // squad.yaml fields are TOP-LEVEL (code/name/icon/description at the root),
      // not nested under a `squad:` key. Reading them correctly is what makes the
      // sidebar show the real name/icon instead of the folder name + default icon.
      const s = (parsed && typeof parsed === "object" ? parsed : null) as
        | { code?: unknown; name?: unknown; description?: unknown; icon?: unknown; agents?: unknown }
        | null;
      if (s) {
        squads.push({
          code: typeof s.code === "string" ? s.code : entry.name,
          name: typeof s.name === "string" ? s.name : entry.name,
          description: typeof s.description === "string" ? s.description : "",
          icon: typeof s.icon === "string" ? s.icon : "\u{1F4CB}",
          agents: Array.isArray(s.agents) ? (s.agents as unknown[]).filter((a): a is string => typeof a === "string") : [],
        });
        continue;
      }
    } catch {
      // No squad.yaml or invalid YAML — fall through to default
    }

    squads.push({
      code: entry.name,
      name: entry.name,
      description: "",
      icon: "\u{1F4CB}",
      agents: [],
    });
  }

  return squads;
}

// Canonical squad identity = the `code` from squad.yaml (what the UI keys on,
// via SquadInfo.code). The directory name is NOT canonical: a squad may have
// `code` != folder name. Resolving here keeps activeStates / SQUAD_UPDATE /
// SQUAD_INACTIVE consistent with the squad list, so the dashboard always matches
// state to squad. Falls back to the directory name when squad.yaml has no code.
async function squadCodeForDir(squadsDir: string, dir: string): Promise<string> {
  try {
    const raw = await fsp.readFile(path.join(squadsDir, dir, "squad.yaml"), "utf-8");
    const code = (parseYaml(raw) as { code?: unknown } | null)?.code; // top-level
    if (typeof code === "string" && code) return code;
  } catch {
    // no squad.yaml or invalid YAML — fall back to the directory name
  }
  return dir;
}

// A validação completa do state.json vive em lib/validateState.ts — compartilhada
// com o cliente e testável sem subir o dev server (tests/dashboard.test.js).

interface ScanResult {
  states: Record<string, SquadState>;
  /** state.json que EXISTE mas não pôde ser lido — não é o mesmo que ausente. */
  invalid: Record<string, SquadStateError>;
}

async function scanStates(squadsDir: string): Promise<ScanResult> {
  const result: ScanResult = { states: {}, invalid: {} };

  let entries;
  try {
    entries = await fsp.readdir(squadsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(squadsDir, entry.name, "state.json");

    let raw: string;
    try {
      raw = await fsp.readFile(statePath, "utf-8");
    } catch {
      continue; // arquivo ausente = squad realmente inativo
    }

    const code = await squadCodeForDir(squadsDir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      result.invalid[code] = {
        reason: `JSON inválido: ${(err as Error).message}`,
        at: new Date().toISOString(),
      };
      continue;
    }

    const check = validateSquadState(parsed);
    if (check.ok) {
      result.states[code] = check.state;
    } else {
      result.invalid[code] = { reason: check.reason, at: new Date().toISOString() };
    }
  }

  return result;
}

async function buildSnapshot(squadsDir: string, recentes?: RecentFinishes): Promise<WsMessage> {
  const [squads, scan] = await Promise.all([discoverSquads(squadsDir), scanStates(squadsDir)]);
  // Desfechos recentes (≤10s) cujo state.json vivo já foi apagado — do mapa em
  // MEMÓRIA, nunca do disco: "recarregar não ressuscita do disco" continua de
  // pé, e scanStates segue intocado. Squads que o scan lista como vivos ou
  // ilegíveis nunca entram: um desfecho velho não compete com um run real.
  const finished = recentes
    ? recentes.snapshotEntries(
        new Set([...Object.keys(scan.states), ...Object.keys(scan.invalid)]),
      )
    : [];
  return {
    type: "SNAPSHOT",
    squads,
    activeStates: scan.states,
    invalidStates: scan.invalid,
    ...(finished.length > 0 ? { finished } : {}),
  };
}

function broadcast(wss: WebSocketServer, msg: WsMessage) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch {
        // Client connection dying — ws library will clean it up
      }
    }
  }
}

export function squadWatcherPlugin(): Plugin {
  return {
    name: "squad-watcher",
    configureServer(server: ViteDevServer) {
      if (!server.httpServer) {
        server.config.logger.warn("[squad-watcher] no httpServer — skipping");
        return;
      }

      const squadsDir = resolveSquadsDir();
      server.config.logger.info(`[squad-watcher] squads dir: ${squadsDir}`);

      // Desfechos ≤10s para o campo `finished` do SNAPSHOT (página recém-aberta
      // e polling recuperam a janela de exibição que o FINISHED só-WS não dá).
      const recentes = createRecentFinishes();

      // Broadcasts de um MESMO squad precisam sair na ordem dos eventos do fs —
      // os handlers são assíncronos e, soltos, um stall de leitura faria o
      // FINISHED do run velho sair depois do primeiro UPDATE do run novo.
      // Ver o contrato completo em broadcastQueue.ts.
      const filas = createKeyedQueue((squadName, err) => {
        server.config.logger.warn(
          `[squad-watcher] ${squadName}: broadcast descartado — ${(err as Error)?.message ?? err}`,
        );
      });

      // Create WebSocket server with noServer to avoid intercepting Vite's HMR
      const wss = new WebSocketServer({ noServer: true });
      (server.httpServer as Server).on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (req.url === "/__squads_ws") {
          // O handshake de WebSocket não é barrado pela same-origin policy — sem
          // esta checagem, qualquer aba de qualquer site leria o snapshot do
          // escritório (squads, agentes, estado dos casos). Fail-closed.
          if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
            server.config.logger.warn(
              `[squad-watcher] upgrade recusado — Origin ${req.headers.origin ?? "(ausente)"} ` +
                `não confere com o host ${req.headers.host ?? "(ausente)"}`
            );
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        }
        // Let Vite handle all other upgrade requests (HMR)
      });

      // Send snapshot on new connection
      wss.on("connection", async (ws) => {
        try {
          const snap = await buildSnapshot(squadsDir, recentes);
          ws.send(JSON.stringify(snap));
        } catch {
          // Connection may have closed before snapshot was ready
        }
      });

      // Ensure squads directory exists
      fsp.mkdir(squadsDir, { recursive: true }).catch((err) => {
        server.config.logger.error(`[squad-watcher] failed to create squads dir: ${err.message}`);
      });

      // REST API fallback — serves snapshot over HTTP for polling clients
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/snapshot") return next();
        try {
          const snapshot = await buildSnapshot(squadsDir, recentes);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-cache");
          res.end(JSON.stringify(snapshot));
        } catch {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });

      // File watcher using chokidar — reliable cross-platform, handles partial writes
      const watcher = chokidarWatch(squadsDir, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
        ignored: [/(^|[/\\])\./, /node_modules/, /output[/\\]/],
        depth: 2,
      });

      function handleFileChange(filePath: string) {
        const relative = path.relative(squadsDir, filePath).replace(/\\/g, "/");
        const parts = relative.split("/");
        if (parts.length < 2) return;

        const squadName = parts[0];
        const fileName = parts[1];

        if (fileName === "state.json") {
          filas.enqueue(squadName, async () => {
            let raw: string;
            try {
              raw = await fsp.readFile(filePath, "utf-8");
            } catch {
              // Falha de leitura do arquivo (removido no meio da escrita) — o
              // próximo evento do watcher (o unlink, já atrás de nós na fila)
              // reprocessa.
              return;
            }
            const code = await squadCodeForDir(squadsDir, squadName);
            // "Não sei ler" ≠ "não existe": um state.json quebrado significa um
            // squad provavelmente RODANDO cujo estado não pôde ser lido. Some em
            // silêncio ele viraria "inativo" na UI, sem erro em lugar nenhum.
            const invalido = (reason: string) => {
              server.config.logger.warn(`[squad-watcher] ${code}: state.json ilegível — ${reason}`);
              broadcast(wss, {
                type: "SQUAD_INVALID",
                squad: code,
                error: { reason, at: new Date().toISOString() },
              });
            };

            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch (err) {
              invalido(`JSON inválido: ${(err as Error).message}`);
              return;
            }

            const check = validateSquadState(parsed);
            if (!check.ok) {
              invalido(check.reason);
              return;
            }
            // Um state.json vivo válido SUPERA o desfecho em memória: o run novo
            // é a verdade do squad, e o próximo snapshot não pode voltar a
            // listar o desfecho velho em `finished`.
            recentes.forget(code);
            broadcast(wss, { type: "SQUAD_UPDATE", squad: code, state: check.state });
          });
        } else if (fileName === "squad.yaml") {
          filas.enqueue(squadName, async () => {
            broadcast(wss, await buildSnapshot(squadsDir, recentes));
          });
        }
      }

      function handleFileRemoval(filePath: string) {
        const relative = path.relative(squadsDir, filePath).replace(/\\/g, "/");
        const parts = relative.split("/");
        if (parts.length < 2) return;

        const squadName = parts[0];
        const fileName = parts[1];

        if (fileName === "state.json") {
          // Sumiço do arquivo vivo é o ÚNICO evento garantido no fim de um run:
          // a escrita terminal pode ser engolida pelo awaitWriteFinish se o
          // runner apagar logo em seguida. Por isso o desfecho é reconstituído
          // aqui, do arquivo arquivado, em vez de depender de o runner segurar o
          // apagamento por alguns segundos.
          filas.enqueue(squadName, async () => {
            const code = await squadCodeForDir(squadsDir, squadName);
            const msg = await removalMessage(squadsDir, squadName, code);
            if (msg.type === "SQUAD_FINISHED") {
              // Guarda o desfecho para os SNAPSHOTs da janela (página
              // recém-aberta, polling) — o broadcast abaixo só alcança quem já
              // está conectado por WS neste instante.
              recentes.remember(code, msg.state);
            } else {
              // Sem desfecho provável no disco, o squad está provadamente
              // inativo — nenhuma entrada antiga pode sobreviver a isso.
              recentes.forget(code);
            }
            broadcast(wss, msg);
          });
        } else if (fileName === "squad.yaml") {
          filas.enqueue(squadName, async () => {
            broadcast(wss, await buildSnapshot(squadsDir, recentes));
          });
        }
      }

      watcher.on("add", handleFileChange);
      watcher.on("change", handleFileChange);
      watcher.on("unlink", handleFileRemoval);

      server.httpServer.on("close", () => {
        watcher.close();
      });
    },
  };
}

