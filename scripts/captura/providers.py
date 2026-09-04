#!/usr/bin/env python3
"""Transcricao de midia para o LegalSquad — backends local e OpenRouter.

Substitui o whisper.py do claude-video (que era so nuvem Groq/OpenAI). Aqui:

- backend "local" (PADRAO): faster-whisper na maquina. Nenhum byte de audio sai
  do computador — e o slot OBRIGATORIO para audiencia/depoimento em segredo de
  justica (sigilo profissional + LGPD). Instala no uso: `pip install faster-whisper`.
- backend "openrouter": nuvem via OpenRouter (uma API da acesso a varios modelos).
  SO para midia ja PUBLICA — envia o audio a um terceiro. O modelo e configuravel
  (OPENROUTER_MODEL) e o endpoint e escolhido automaticamente pelo tipo de modelo:
    * modelos Whisper (padrao: openai/whisper-large-v3) usam o endpoint dedicado
      /audio/transcriptions, que devolve timestamps REAIS por segmento — o melhor
      para transcricao forense.
    * modelos multimodais (ex.: google/gemini-3.1-flash-lite, que le audio e video)
      usam /chat/completions com input_audio; a saida vem em texto '[MM:SS] fala'.

A saida e uma lista de segmentos {start, end, text} — o mesmo formato de
transcribe.parse_vtt, entao o resto do pipeline (filter_range, format_transcript)
nao muda.

Helpers de ffmpeg (extract_audio, chunking) sao adaptados do whisper.py do
claude-video (MIT, (c) 2026 Bradley Bonanno) — ver LICENSE.claude-video.
"""
from __future__ import annotations

import base64
import json
import math
import os
import re
import shutil
import ssl
import subprocess
import sys
import urllib.error
from pathlib import Path
from urllib.request import Request, urlopen


def _load_config_env() -> None:
    """Carrega ~/.config/captura-midia-av/.env em os.environ (sem sobrescrever env real)."""
    path = Path.home() / ".config" / "captura-midia-av" / ".env"
    if not path.exists():
        return
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip()
            if len(val) >= 2 and val[0] in ("'", '"') and val[-1] == val[0]:
                val = val[1:-1]
            if key and val and key not in os.environ:
                os.environ[key] = val
    except OSError:
        pass


_load_config_env()


OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_TRANSCRIBE_ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"
# Padrao: modelo Whisper dedicado — devolve timestamps reais por segmento (melhor
# para o forense). Alternativa multimodal (le audio E video): google/gemini-3.1-flash-lite.
DEFAULT_OPENROUTER_MODEL = "openai/whisper-large-v3"

# Payload de audio base64 num corpo JSON de chat: mantemos cada pedaco pequeno.
# ~8 min de mp3 mono 16k 64kbps ~= 3.8 MB -> ~5 MB em base64. Chunk por tempo.
MAX_CHUNK_BYTES = 8 * 1024 * 1024

TRANSCRIBE_PROMPT = (
    "Voce e um transcritor forense. Transcreva ESTE AUDIO em portugues do Brasil, "
    "fielmente, sem resumir, inventar ou completar o que nao se ouve. "
    "Uma linha por trecho de fala, no formato: [MM:SS] texto (ou [HH:MM:SS] se passar de 1h). "
    "Marque trechos ininteligiveis como [inaudivel]. Nao adicione comentarios seus."
)


def extract_audio(video_path: str, out_path: Path) -> Path:
    """Extrai audio mono 16kHz 64kbps mp3 (~480 kB/min). Adaptado do claude-video."""
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg nao instalado. Instale com: brew install ffmpeg (macOS) ou apt install ffmpeg")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(Path(video_path).resolve()),
        "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-b:a", "64k",
        str(out_path.resolve()),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"ffmpeg falhou ao extrair audio: {result.stderr.strip()}")
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise SystemExit("ffmpeg nao produziu audio — a midia pode nao ter faixa de audio")
    return out_path


def audio_duration(audio_path: Path) -> float:
    if shutil.which("ffprobe") is None:
        raise SystemExit("ffprobe nao instalado (vem com o ffmpeg).")
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(audio_path.resolve())],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"ffprobe falhou: {result.stderr.strip()}")
    fmt = json.loads(result.stdout or "{}").get("format", {})
    return float(fmt.get("duration") or 0.0)


def plan_chunks(total_seconds: float, total_bytes: int, max_bytes: int = MAX_CHUNK_BYTES) -> list[tuple[float, float]]:
    """Divide a duracao em pedacos contiguos (offset, duracao) abaixo de max_bytes."""
    if total_bytes <= max_bytes or total_seconds <= 0:
        return [(0.0, total_seconds)]
    n = math.ceil(total_bytes / max_bytes)
    chunk = total_seconds / n
    plan: list[tuple[float, float]] = []
    for i in range(n):
        offset = i * chunk
        duration = (total_seconds - offset) if i == n - 1 else chunk
        plan.append((round(offset, 3), round(duration, 3)))
    return plan


def split_audio(full_audio: Path, work_dir: Path, plan: list[tuple[float, float]]) -> list[tuple[Path, float, float]]:
    """Fatia o audio em arquivos por pedaco, retornando (path, offset, duration).

    A duracao viaja junto para que uma falha de pedaco vire uma LACUNA explicita
    no lugar certo da linha do tempo (transcricao forense: nunca sumir com trecho).
    Stream copy, sem re-encode.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    chunks: list[tuple[Path, float, float]] = []
    for index, (offset, duration) in enumerate(plan):
        out_path = work_dir / f"chunk_{index:03d}.mp3"
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{offset:.3f}", "-i", str(full_audio.resolve()),
            "-t", f"{duration:.3f}", "-c", "copy", str(out_path.resolve()),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
            raise SystemExit(f"ffmpeg falhou ao fatiar o pedaco {index + 1}: {result.stderr.strip()}")
        chunks.append((out_path, offset, duration))
    return chunks


def shift_segments(segments: list[dict], offset_seconds: float) -> list[dict]:
    if offset_seconds == 0:
        return segments
    return [
        {"start": round(s["start"] + offset_seconds, 2), "end": round(s["end"] + offset_seconds, 2), "text": s["text"]}
        for s in segments
    ]


# ---------------------------------------------------------------- backend local

def transcribe_local(audio_path: Path) -> list[dict]:
    """Transcreve na maquina com faster-whisper. Nada sai do computador."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise SystemExit(
            "faster-whisper nao instalado (transcricao local). Instale no uso: "
            "`pip install faster-whisper` (ou `pipx install faster-whisper`)."
        )
    size = os.environ.get("WATCH_WHISPER_MODEL", "small")
    device = os.environ.get("WATCH_WHISPER_DEVICE", "auto")
    compute = os.environ.get("WATCH_WHISPER_COMPUTE", "int8")
    lang = os.environ.get("WATCH_WHISPER_LANG", "pt") or None
    # VAD DESLIGADO por padrao: "transcrever TODO o audio". O Silero VAD (vad_filter)
    # corta trechos que classifica como nao-fala ANTES de transcrever e pode
    # descartar fala fraca/distante (CFTV, depoente baixo) sem deixar rastro. Sem
    # VAD, o proprio Whisper ainda evita ruido via no_speech. Ligue com
    # WATCH_WHISPER_VAD=1 para saida mais limpa em audio muito ruidoso.
    vad = (os.environ.get("WATCH_WHISPER_VAD", "0").strip().lower() in ("1", "true", "yes", "on"))
    print(f"[captura] transcrevendo LOCAL (faster-whisper {size}, {device}/{compute}, vad={'on' if vad else 'off'})…", file=sys.stderr)
    model = WhisperModel(size, device=device, compute_type=compute)
    segments, _info = model.transcribe(str(audio_path.resolve()), language=lang, vad_filter=vad)
    out: list[dict] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            out.append({"start": round(float(seg.start), 2), "end": round(float(seg.end), 2), "text": text})
    return out


# ----------------------------------------------------------- backend openrouter

_TS_LINE = re.compile(r"^\s*\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]?\s*[-–:]?\s*(.+?)\s*$")


def _parse_timestamped_text(text: str) -> list[dict]:
    """Converte a saida '[MM:SS] fala' do modelo em segmentos {start,end,text}.

    Fala ANTES do primeiro timestamp (ex.: 'A audiencia esta aberta' antes de
    '[00:08] ...') nao pode sumir: linhas iniciais sem timestamp viram um segmento
    em start=0 — completude acima de tudo.
    """
    out: list[dict] = []
    leading: list[str] = []
    for line in text.splitlines():
        m = _TS_LINE.match(line)
        if not m:
            if out:
                out[-1]["text"] = (out[-1]["text"] + " " + line.strip()).strip()
            elif line.strip():
                leading.append(line.strip())
            continue
        h, mnt, sec, spoken = m.groups()
        start = (int(h) * 3600 if h else 0) + int(mnt) * 60 + int(sec)
        if leading:
            out.append({"start": 0.0, "end": float(start), "text": " ".join(leading)})
            leading = []
        if spoken.strip():
            out.append({"start": float(start), "end": float(start), "text": spoken.strip()})
    for i in range(len(out) - 1):
        out[i]["end"] = out[i + 1]["start"]
    if not out:
        stripped = text.strip()
        if stripped:
            out.append({"start": 0.0, "end": 0.0, "text": stripped})
    return out


def _openrouter_key() -> str | None:
    for name in ("OPENROUTER_API_KEY", "OPENROUTER_KEY"):
        v = os.environ.get(name)
        if v and v.strip():
            return v.strip()
    return None


def _is_whisper_model(model: str) -> bool:
    """Modelos Whisper usam o endpoint dedicado /audio/transcriptions (timestamps reais)."""
    return "whisper" in (model or "").lower()


def _openrouter_post(endpoint: str, body: dict, api_key: str) -> dict:
    """POST JSON a um endpoint do OpenRouter e devolve o payload decodificado."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Title": "LegalSquad captura-midia-av",
    }
    request = Request(endpoint, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    context = ssl.create_default_context()
    try:
        with urlopen(request, timeout=300, context=context) as response:
            return json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = f" — {exc.read().decode('utf-8', errors='replace')[:300]}"
        except Exception:
            pass
        raise SystemExit(f"OpenRouter HTTP {exc.code}{detail}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SystemExit(f"OpenRouter erro de rede: {exc}")


def _audio_b64(audio_path: Path) -> tuple[str, str]:
    return base64.b64encode(audio_path.read_bytes()).decode("ascii"), (audio_path.suffix.lstrip(".").lower() or "mp3")


def transcribe_openrouter_whisper(audio_path: Path, api_key: str, model: str) -> list[dict]:
    """Whisper via /audio/transcriptions (verbose_json) — timestamps REAIS por segmento."""
    data, fmt = _audio_b64(audio_path)
    lang = (os.environ.get("WATCH_WHISPER_LANG", "pt") or "").strip() or None
    body = {
        "model": model,
        "input_audio": {"data": data, "format": fmt},
        "response_format": "verbose_json",
        "temperature": 0,
    }
    if lang:
        body["language"] = lang
    payload = _openrouter_post(OPENROUTER_TRANSCRIBE_ENDPOINT, body, api_key)
    segments = payload.get("segments")
    if isinstance(segments, list) and segments:
        out: list[dict] = []
        for seg in segments:
            text = str(seg.get("text") or "").strip()
            if text:
                out.append({
                    "start": round(float(seg.get("start") or 0.0), 2),
                    "end": round(float(seg.get("end") or seg.get("start") or 0.0), 2),
                    "text": text,
                })
        if out:
            return out
    # Sem segmentos → usa o texto plano como um unico segmento.
    text = str(payload.get("text") or "").strip()
    if not text:
        raise SystemExit(f"OpenRouter: resposta sem transcricao: {json.dumps(payload)[:300]}")
    return [{"start": 0.0, "end": 0.0, "text": text}]


def transcribe_openrouter_chat(audio_path: Path, api_key: str, model: str) -> list[dict]:
    """Modelo multimodal (Gemini/GPT-audio) via /chat/completions com input_audio."""
    data, fmt = _audio_b64(audio_path)
    body = {
        "model": model,
        "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": TRANSCRIBE_PROMPT},
            {"type": "input_audio", "input_audio": {"data": data, "format": fmt}},
        ]}],
    }
    payload = _openrouter_post(OPENROUTER_CHAT_ENDPOINT, body, api_key)
    try:
        content = payload["choices"][0]["message"]["content"]
        if isinstance(content, list):
            content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    except (KeyError, IndexError, TypeError):
        raise SystemExit(f"OpenRouter: resposta sem transcricao: {json.dumps(payload)[:300]}")
    return _parse_timestamped_text(content or "")


def transcribe_openrouter(audio_path: Path, api_key: str, model: str | None = None) -> list[dict]:
    """Transcreve via OpenRouter. SO para midia publica (envia o audio a um terceiro).

    Roteia pelo modelo: Whisper → /audio/transcriptions (timestamps reais);
    multimodal (Gemini etc.) → /chat/completions com input_audio.
    """
    model = model or os.environ.get("OPENROUTER_MODEL") or DEFAULT_OPENROUTER_MODEL
    if _is_whisper_model(model):
        return transcribe_openrouter_whisper(audio_path, api_key, model)
    return transcribe_openrouter_chat(audio_path, api_key, model)


# --------------------------------------------------------------- orquestracao

def _fmt_ts(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


def _transcribe_chunks(chunks: list[tuple[Path, float, float]], transcribe_one) -> list[dict]:
    """Transcreve cada pedaco; um pedaco que falhar vira LACUNA explicita.

    Cobrir TODO o audio: cada pedaco tem uma tentativa + 1 retry. Se ainda assim
    falhar, insere um segmento-marcador `[TRECHO NAO TRANSCRITO ...]` no lugar
    exato — nunca some com o trecho em silencio (uma transcricao incompleta jamais
    pode se passar por completa).
    """
    segments: list[dict] = []
    failures = 0
    for index, (path, offset, duration) in enumerate(chunks):
        part = None
        for attempt in (1, 2):
            try:
                part = transcribe_one(path)
                break
            except SystemExit as exc:
                if attempt == 1:
                    print(f"[captura] pedaco {index + 1}/{len(chunks)} falhou — nova tentativa… ({exc})", file=sys.stderr)
                else:
                    failures += 1
                    print(f"[captura] pedaco {index + 1}/{len(chunks)} falhou apos retry — marcando lacuna ({exc})", file=sys.stderr)
        if part is None:
            end = offset + (duration or 0.0)
            segments.append({
                "start": round(offset, 2),
                "end": round(end, 2),
                "text": f"[TRECHO NAO TRANSCRITO — falha ao transcrever {_fmt_ts(offset)}–{_fmt_ts(end)}]",
            })
            continue
        segments.extend(shift_segments(part, offset))
        print(f"[captura] pedaco {index + 1}/{len(chunks)} → {len(part)} segmentos", file=sys.stderr)
    if failures == len(chunks):
        raise SystemExit("transcricao falhou em todos os pedacos")
    return segments


def transcribe_video(
    video_path: str,
    audio_out: Path,
    provider: str = "local",
    allow_cloud: bool = False,
) -> tuple[list[dict], str]:
    """Fluxo completo: extrai audio → transcreve (local ou openrouter) → segmentos.

    provider="local" nunca envia audio para fora. provider="openrouter" envia o audio
    a um terceiro e por isso e FAIL-CLOSED: so acontece se o chamador afirmar que a
    midia e publica passando allow_cloud=True. Sem essa afirmacao, a nuvem e bloqueada
    (protege material sigiloso mesmo quando o operador esquece de marcar o sigilo).
    """
    if provider == "openrouter":
        if not allow_cloud:
            raise SystemExit(
                "captura: upload a nuvem BLOQUEADO (fail-closed) — a midia nao foi afirmada "
                "como publica. Para midia ja divulgada, confirme com --publico; material em "
                "segredo de justica permanece LOCAL (padrao)."
            )
        api_key = _openrouter_key()
        if not api_key:
            raise SystemExit("OPENROUTER_API_KEY ausente. Configure ou use o backend local (padrao).")
        def transcribe_one(p: Path) -> list[dict]:
            return transcribe_openrouter(p, api_key)
    elif provider == "local":
        def transcribe_one(p: Path) -> list[dict]:
            return transcribe_local(p)
    else:
        raise SystemExit(f"provider desconhecido: {provider} (use local|openrouter)")

    audio_path = extract_audio(video_path, audio_out)
    audio_bytes = audio_path.stat().st_size

    if provider == "local" or audio_bytes <= MAX_CHUNK_BYTES:
        segments = transcribe_one(audio_path)
    else:
        duration = audio_duration(audio_path)
        plan = plan_chunks(duration, audio_bytes, MAX_CHUNK_BYTES)
        print(f"[captura] audio {audio_bytes // (1024 * 1024)} MB — {len(plan)} pedacos", file=sys.stderr)
        chunks = split_audio(audio_path, audio_out.parent / "chunks", plan)
        segments = _transcribe_chunks(chunks, transcribe_one)

    if not segments:
        raise SystemExit("nenhum segmento de transcricao retornado")
    print(f"[captura] {len(segments)} segmentos via {provider}", file=sys.stderr)
    return segments, provider


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("uso: providers.py <video-path> [audio-out.mp3] [--provider local|openrouter] [--publico]", file=sys.stderr)
        raise SystemExit(2)
    video = sys.argv[1]
    out = Path(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else Path("audio.mp3")
    prov = "local"
    if "--provider" in sys.argv:
        prov = sys.argv[sys.argv.index("--provider") + 1]
    # Nuvem so com afirmacao explicita de que a midia e publica (fail-closed).
    allow_cloud = "--publico" in sys.argv
    segs, used = transcribe_video(video, out, provider=prov, allow_cloud=allow_cloud)
    print(json.dumps({"provider": used, "segments": segs}, indent=2, ensure_ascii=False))
