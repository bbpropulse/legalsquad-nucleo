import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bundledDashboard = fileURLToPath(
  new URL("../dashboard/", import.meta.url),
);

export function dashboardOptions(root, { port = "5173", open = true } = {}) {
  const portNumber = Number(port);
  if (
    !/^\d+$/.test(String(port)) ||
    !Number.isInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65535
  ) {
    throw new Error(
      "Porta inválida. Use --port com um número entre 1 e 65535.",
    );
  }
  const directory = join(resolve(root), "dashboard");
  return {
    directory,
    args: [
      join(directory, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(portNumber),
      ...(open ? ["--open"] : []),
    ],
    env: { ...process.env, LEGALSQUAD_PROJECT_ROOT: resolve(root) },
  };
}

function run(command, args, options) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (err) => {
      cleanup();
      reject(err);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveExit(["SIGINT", "SIGTERM"].includes(signal) ? 0 : (code ?? 1));
    });
  });
}

/** Instala dependências sob demanda e mantém o servidor local ligado até Ctrl+C. */
export async function dashboard(root, options = {}) {
  const { directory, args, env } = dashboardOptions(root, options);
  if (!existsSync(join(directory, "package.json"))) {
    await mkdir(directory, { recursive: true });
    await cp(bundledDashboard, directory, {
      recursive: true,
      filter: (source) =>
        ![
          "node_modules",
          "dist",
          "test-results",
          "tsconfig.tsbuildinfo",
        ].includes(basename(source)),
    });
  }
  const dependencies = [
    "vite",
    "react",
    "react-dom",
    "phaser",
    "zustand",
    "yaml",
    "ws",
    "chokidar",
    "@vitejs/plugin-react",
  ];
  if (
    dependencies.some(
      (name) =>
        !existsSync(join(directory, "node_modules", name, "package.json")),
    )
  ) {
    console.log(
      "Preparando o escritório virtual: instalando as dependências do dashboard (primeira abertura)…",
    );
    const result = await run(
      "npm",
      [
        existsSync(join(directory, "package-lock.json")) ? "ci" : "install",
        "--include=dev",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: directory,
        // npm.cmd no Windows; argumentos constantes, nenhum texto do usuário no shell.
        shell: process.platform === "win32",
      },
    );
    if (result !== 0)
      throw new Error(
        "Não foi possível preparar o dashboard. Confira a conexão e execute o comando novamente.",
      );
  }
  console.log(
    `\n⚖ LegalSquad · Escritório virtual\n  Projeto: ${resolve(root)}\n  Squads e agentes se atualizam conforme o runner trabalha.\n  Ctrl+C encerra o servidor.\n`,
  );
  const code = await run(process.execPath, args, { cwd: directory, env });
  return { success: code === 0 };
}
