#!/usr/bin/env python3
"""Setup / preflight do captura-midia-av (LegalSquad).

Modos:
  setup.py --check   Preflight silencioso. Exit 0 se pronto, !=0 se falta algo.
  setup.py --json    Status legivel por maquina.
  setup.py           Instalador. Instala deps no uso (ffmpeg/ffprobe/yt-dlp + faster-whisper).

Filosofia do LegalSquad:
- Transcricao LOCAL (faster-whisper) e o PADRAO — nao precisa de nenhuma chave de API.
  Roda offline; o audio nunca sai da maquina (obrigatorio para segredo de justica).
- OpenRouter (nuvem multimodal) e OPCIONAL, so para midia ja PUBLICA.
- Deps instalam no uso; nunca sudo automatico. Adaptado do setup do claude-video (MIT).
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REQUIRED_BINARIES = ["ffmpeg", "ffprobe", "yt-dlp"]
PY_DEP = "faster_whisper"          # import name
PY_DEP_PIP = "faster-whisper"      # pip name

CONFIG_DIR = Path.home() / ".config" / "captura-midia-av"
CONFIG_FILE = CONFIG_DIR / ".env"

ENV_TEMPLATE = """# captura-midia-av — configuracao (LegalSquad)
#
# TRANSCRICAO LOCAL e o padrao e NAO precisa de chave nenhuma (faster-whisper).
# Material sigiloso (audiencia/depoimento em segredo de justica) SEMPRE local.
#
# OpenRouter e OPCIONAL — so para midia ja PUBLICA (envia audio a um terceiro).
# Uma API da acesso a varios modelos. Chave: https://openrouter.ai/keys
OPENROUTER_API_KEY=
# Modelo do backend openrouter. O endpoint e escolhido pelo tipo de modelo:
#   openai/whisper-large-v3        -> /audio/transcriptions, timestamps REAIS (padrao)
#   google/gemini-3.1-flash-lite   -> /chat/completions (multimodal: le audio e video)
OPENROUTER_MODEL=openai/whisper-large-v3

# Whisper local (opcionais): modelo (tiny|base|small|medium|large-v3), device, idioma.
# small e um bom equilibrio para PT-BR; large-v3 e mais preciso e mais lento.
WATCH_WHISPER_MODEL=small
WATCH_WHISPER_LANG=pt

# VAD (Silero) DESLIGADO por padrao para transcrever TODO o audio (nao cortar fala
# fraca/distante). Ligue so em audio muito ruidoso, p/ saida mais limpa:
# WATCH_WHISPER_VAD=1

# Air-gapped / sigilo maximo: no 1o uso o backend local baixa o MODELO do Whisper
# (so o modelo, nunca o audio). Pre-baixe o modelo uma vez e descomente a linha abaixo
# para proibir qualquer acesso de rede do transcritor local.
# HF_HUB_OFFLINE=1
"""


def _which(name: str) -> str | None:
    return shutil.which(name)


def _missing_binaries() -> list[str]:
    return [b for b in REQUIRED_BINARIES if not _which(b)]


def _has_python_dep() -> bool:
    try:
        __import__(PY_DEP)
        return True
    except Exception:
        return False


def _brew_pkgs(missing: list[str]) -> list[str]:
    pkgs: list[str] = []
    for b in missing:
        pkg = "ffmpeg" if b in ("ffmpeg", "ffprobe") else b
        if pkg not in pkgs:
            pkgs.append(pkg)
    return pkgs


def _install_binaries(missing: list[str]) -> tuple[bool, str]:
    system = platform.system()
    pkgs = _brew_pkgs(missing)
    if system == "Darwin":
        if _which("brew") is None:
            return False, "Homebrew ausente (https://brew.sh). Depois: brew install " + " ".join(pkgs)
        cmd = ["brew", "install", *pkgs]
        print(f"[setup] {' '.join(cmd)}", file=sys.stderr)
        if subprocess.run(cmd).returncode != 0:
            return False, "brew install falhou"
        return True, f"instalado via brew: {', '.join(pkgs)}"
    if system == "Linux":
        hints = []
        if "ffmpeg" in pkgs:
            hints.append("`sudo apt install ffmpeg` (ou dnf)")
        if "yt-dlp" in pkgs:
            hints.append("`pipx install yt-dlp` (ou pip install --user yt-dlp)")
        return False, "instale manualmente: " + " ; ".join(hints)
    if system == "Windows":
        hints = []
        if "ffmpeg" in pkgs:
            hints.append("`winget install Gyan.FFmpeg`")
        if "yt-dlp" in pkgs:
            hints.append("`winget install yt-dlp.yt-dlp` (ou pip install --user yt-dlp)")
        return False, "instale manualmente: " + " ; ".join(hints)
    return False, f"plataforma {system} sem auto-install: instale {', '.join(pkgs)}"


def _install_python_dep() -> tuple[bool, str]:
    cmd = [sys.executable, "-m", "pip", "install", "--user", PY_DEP_PIP]
    print(f"[setup] {' '.join(cmd)}", file=sys.stderr)
    if subprocess.run(cmd).returncode != 0:
        return False, f"pip install {PY_DEP_PIP} falhou (tente `pipx install {PY_DEP_PIP}`)"
    return True, f"instalado: {PY_DEP_PIP}"


def _status() -> dict:
    missing = _missing_binaries()
    has_local = _has_python_dep()
    has_openrouter = bool((os.environ.get("OPENROUTER_API_KEY") or "").strip())
    # Pronto = da para transcrever localmente (o padrao): binarios + faster-whisper.
    ready = (not missing) and has_local
    return {
        "ready": ready,
        "missing_binaries": missing,
        "local_transcription": has_local,
        "openrouter_available": has_openrouter,
        "config_file": str(CONFIG_FILE),
        "platform": platform.system(),
    }


def cmd_check() -> int:
    s = _status()
    if s["ready"]:
        return 0
    parts = []
    if s["missing_binaries"]:
        parts.append(f"binarios: {', '.join(s['missing_binaries'])}")
    if not s["local_transcription"]:
        parts.append(f"{PY_DEP_PIP} (transcricao local)")
    installer = Path(__file__).resolve()
    sys.stderr.write(f"[captura] setup incompleto (faltam {'; '.join(parts)}). Rode: python3 {installer}\n")
    return 2


def cmd_json() -> int:
    json.dump(_status(), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def _scaffold_env() -> None:
    if CONFIG_FILE.exists():
        print(f"[setup] config existe: {CONFIG_FILE}")
        return
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(ENV_TEMPLATE, encoding="utf-8")
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass
    print(f"[setup] criado: {CONFIG_FILE}")


def cmd_install() -> int:
    missing = _missing_binaries()
    if missing:
        ok, msg = _install_binaries(missing)
        print(f"[setup] {msg}", file=sys.stderr)
        if not ok or _missing_binaries():
            return 2
    if not _has_python_dep():
        ok, msg = _install_python_dep()
        print(f"[setup] {msg}", file=sys.stderr)
        if not ok or not _has_python_dep():
            return 2
    _scaffold_env()
    print("[setup] pronto — transcricao LOCAL disponivel (offline, sigilo-safe).")
    print("[setup] OpenRouter e opcional (so midia publica): edite OPENROUTER_API_KEY em", CONFIG_FILE)
    return 0


def main() -> int:
    if len(sys.argv) > 1:
        if sys.argv[1] == "--check":
            return cmd_check()
        if sys.argv[1] == "--json":
            return cmd_json()
    return cmd_install()


if __name__ == "__main__":
    raise SystemExit(main())
