// Native CLI for the embedded audiovisual-capture engine (scripts/captura/).
//
// The engine (watch.py + providers/download/frames/transcribe, vendored from
// claude-video, MIT) ships INSIDE the package via package.json `files[]`, so it
// is resolved package-relative here — available from any folder, no per-project
// copy. `captura setup` installs on-use deps (ffmpeg/yt-dlp/faster-whisper);
// `captura <file|URL> [flags]` forwards straight to watch.py.
//
// Sigilo: the default transcription backend is LOCAL (faster-whisper, nothing
// leaves the machine). `--sigiloso` forces local and blocks any cloud — the guard
// lives in watch.py and is untouched here; we only forward arguments.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(__dirname, '..', 'scripts', 'captura');

const USAGE = `
  legalsquad captura — assiste vídeo e transcreve áudio dos autos (embarcado)

  Uso:
    npx legalsquad captura setup            Instala deps no uso (ffmpeg/yt-dlp/faster-whisper)
    npx legalsquad captura setup --check    Preflight: 0 = pronto; senão diz o que falta
    npx legalsquad captura <arquivo|URL>    Extrai frames + transcreve (LOCAL por padrão)

  Opções repassadas ao motor (watch.py):
    --sigiloso                 Segredo de justiça: força LOCAL e bloqueia a nuvem
    --transcribe local|openrouter   Backend (padrão local; openrouter exige --publico)
    --publico                  Afirma mídia PÚBLICA — libera a nuvem; sem isto, cai p/ LOCAL
    --start HH:MM:SS --end HH:MM:SS  Recorte de tempo
    --every SEG                Frame-a-frame FORENSE: 1 frame a cada SEG s, sem teto (CFTV/bodycam)
    --timestamps MM:SS,MM:SS        Frames em momentos-chave
    --no-transcribe                 Só frames
    (a lista completa de opções do motor está em scripts/captura/watch.py)

  Sigilo: áudio de audiência/depoimento em segredo de justiça é transcrito
  LOCALMENTE (--sigiloso). O código vem no pacote (scripts/captura/); nada externo.
`;

function resolvePython() {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function runEngine(scriptName, args) {
  const scriptPath = join(ENGINE_DIR, scriptName);
  if (!existsSync(scriptPath)) {
    console.error(`captura: motor não encontrado em ${scriptPath}`);
    return { success: false };
  }
  const python = resolvePython();
  if (!python) {
    console.error('captura: Python 3 não encontrado. Instale o python3 e rode de novo.');
    return { success: false };
  }
  const result = spawnSync(python, [scriptPath, ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`captura: falha ao executar ${scriptName}: ${result.error.message}`);
    return { success: false };
  }
  return { success: result.status === 0 };
}

// args: raw tail after `captura` (process.argv.slice(3)) — forwarded verbatim so
// flags like --sigiloso / --start survive (bin's parseArgs is not consulted here).
export function capturaCli(args = []) {
  const rest = Array.isArray(args) ? args : [];
  const sub = rest[0];
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return { success: true };
  }
  if (!sub) {
    console.error(USAGE);
    return { success: false };
  }
  if (sub === 'setup') {
    return runEngine('setup.py', rest.slice(1));
  }
  return runEngine('watch.py', rest);
}
