#!/usr/bin/env python3
"""/watch entry point: download video, extract frames, parse transcript.

Prints a markdown report to stdout listing frame paths + transcript. Claude
then Reads each frame path to see the video.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))

from config import frame_cap, get_config  # noqa: E402
from download import download, fetch_captions, is_url  # noqa: E402
from frames import MAX_FPS, auto_fps, auto_fps_focus, extract_at_timestamps, extract_keyframes, extract_scene_or_uniform, extract_uniform, format_time, get_metadata, merge_frames, parse_time, parse_timestamps  # noqa: E402
from transcribe import filter_range, format_transcript, parse_vtt  # noqa: E402
from providers import transcribe_video  # noqa: E402


def _remove(path: Path) -> None:
    """Apaga arquivo ou diretorio sem reclamar se ja nao existir."""
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        try:
            path.unlink()
        except OSError:
            pass


def _cleanup_work(
    work: Path,
    *,
    is_temp: bool,
    sigiloso: bool,
    keep: bool,
    produced_frames: bool,
) -> None:
    """Remove o material derivado do work dir — SEMPRE, inclusive em falha.

    Copia derivada de audiencia (audio.mp3, pedacos, midia baixada) e prova
    sigilosa fora do dossie: fica indexada por Spotlight/backup, sem inventario.
    Por isso ela sai em qualquer caminho de saida. Os frames sao a entrega ao
    leitor, entao sobrevivem — mas so quando o operador nao pediu sigilo, ou
    quando escolheu explicitamente onde guardar (--out-dir).
    """
    if keep:
        # Escape hatch de depuracao — recusado sob --sigiloso ja no parse.
        return

    for residue in ("download", "chunks", "audio.mp3"):
        _remove(work / residue)

    if not produced_frames:
        # Nada a entregar ao leitor: o diretorio inteiro sai.
        if is_temp:
            shutil.rmtree(work, ignore_errors=True)
        else:
            try:
                work.rmdir()  # so remove se ficou vazio; o dir e do operador
            except OSError:
                pass
        return

    if sigiloso:
        # Frames sigilosos so existem em --out-dir escolhido pelo operador
        # (garantido antes da extracao). Fecha a permissao do que fica.
        for path in (work / "frames").glob("*.jpg"):
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="watch",
        description="Download a video, extract auto-scaled frames, and surface the transcript.",
    )
    ap.add_argument("source", help="Video URL or local file path")
    ap.add_argument("--max-frames", type=int, default=None, help="Override frame cap")
    ap.add_argument("--resolution", type=int, default=512, help="Frame width in pixels (default 512)")
    ap.add_argument("--fps", type=float, default=None, help="Override auto-fps")
    ap.add_argument(
        "--detail",
        choices=["transcript", "efficient", "balanced", "token-burner"],
        default=None,
        help="Fidelity/speed dial: transcript (no frames), efficient (fast keyframes, cap 50), "
             "balanced (scene, cap 100), token-burner (scene, uncapped).",
    )
    ap.add_argument(
        "--timestamps",
        type=str,
        default=None,
        help="Comma-separated absolute timestamps (SS, MM:SS, HH:MM:SS) to grab a frame at, "
             "e.g. transcript-flagged 'look here' moments. Added on top of the detail frames "
             "(reserved against the cap); with --detail transcript these become the only frames.",
    )
    ap.add_argument("--start", type=str, default=None, help="Range start (SS, MM:SS, or HH:MM:SS)")
    ap.add_argument("--end", type=str, default=None, help="Range end (SS, MM:SS, or HH:MM:SS)")
    ap.add_argument("--out-dir", type=str, default=None, help="Working directory (default: tmp)")
    ap.add_argument(
        "--keep-work",
        action="store_true",
        help="Depuracao: NAO limpar o work dir ao final (audio extraido, midia baixada e "
             "pedacos ficam em disco). Incompativel com --sigiloso.",
    )
    ap.add_argument(
        "--no-transcribe",
        action="store_true",
        help="Nao transcrever. So frames, se houver video.",
    )
    ap.add_argument(
        "--transcribe",
        choices=["local", "openrouter"],
        default="local",
        help="Backend de transcricao. local (faster-whisper, na maquina — PADRAO e obrigatorio "
             "para material sigiloso) ou openrouter (nuvem via OpenRouter — SO para midia publica).",
    )
    ap.add_argument(
        "--sigiloso",
        action="store_true",
        help="Material em segredo de justica: forca transcricao LOCAL e bloqueia qualquer nuvem.",
    )
    ap.add_argument(
        "--publico",
        action="store_true",
        help="Afirma que a midia e PUBLICA (ja divulgada). So com esta afirmacao o backend "
             "openrouter (nuvem) e liberado; sem ela, a nuvem e bloqueada e cai para LOCAL.",
    )
    ap.add_argument(
        "--no-dedup",
        action="store_true",
        help="Disable near-duplicate frame removal. Keeps visually identical "
             "frames (static screen recordings, held slides) instead of collapsing them.",
    )
    ap.add_argument(
        "--every",
        type=float,
        default=None,
        metavar="SEG",
        help="Frame-a-frame FORENSE: um frame a cada SEG segundos por TODO o video, SEM teto "
             "(CFTV/bodycam/audiencia — nao perder momento). Ex.: --every 1 = 1 frame/seg; "
             "--every 2 = a cada 2s. Ignora o cap de --detail; respeita --start/--end. Quadros "
             "visualmente identicos sao colapsados salvo --no-dedup.",
    )
    args = ap.parse_args()
    if args.every is not None and args.every <= 0:
        raise SystemExit("--every deve ser maior que zero (segundos entre frames)")
    # Segredo de justica nao admite residuo "so para depurar".
    if args.sigiloso and args.keep_work:
        raise SystemExit(
            "--keep-work nao e permitido com --sigiloso: material em segredo de justica nao "
            "pode ficar residual em disco. Rode sem --keep-work."
        )

    work_is_temp = args.out_dir is None
    if args.out_dir:
        work = Path(args.out_dir).expanduser().resolve()
    else:
        work = Path(tempfile.mkdtemp(prefix="watch-"))
    work.mkdir(parents=True, exist_ok=True)
    if args.sigiloso:
        # Cópia derivada de material sigiloso nao fica legivel para outros usuarios.
        try:
            os.chmod(work, 0o700)
        except OSError as exc:
            raise SystemExit(f"--sigiloso: nao foi possivel restringir {work} (0700): {exc}")
    print(f"[watch] working dir: {work}", file=sys.stderr)

    state: dict = {"frames": []}
    try:
        return _run(args, work, work_is_temp, state)
    finally:
        _cleanup_work(
            work,
            is_temp=work_is_temp,
            sigiloso=args.sigiloso,
            keep=args.keep_work,
            produced_frames=bool(state["frames"]),
        )


def _run(args, work: Path, work_is_temp: bool, state: dict) -> int:
    config = get_config()
    detail = args.detail or str(config["detail"])
    configured_cap = frame_cap(detail)
    if args.max_frames is not None:
        max_frames = args.max_frames
    else:
        max_frames = configured_cap
    if max_frames is not None and max_frames < 1:
        raise SystemExit("--max-frames must be greater than zero")
    budget_cap = max_frames if max_frames is not None else 100
    cue_timestamps = parse_timestamps(args.timestamps)

    url_source = is_url(args.source)
    dl: dict = {"subtitle_path": None, "info": {}, "downloaded": False}
    transcript_segments: list[dict] = []
    transcript_text: str | None = None
    transcript_source: str | None = None
    video_path: str | None = None

    if url_source:
        print("[watch] checking metadata/captions via yt-dlp…", file=sys.stderr)
        dl = fetch_captions(args.source, work / "download")
        if dl.get("subtitle_path"):
            try:
                transcript_segments = parse_vtt(dl["subtitle_path"])
                transcript_text = format_transcript(transcript_segments)
                transcript_source = "captions"
            except Exception as exc:
                print(f"[watch] subtitle parse failed: {exc}", file=sys.stderr)
                transcript_segments = []

    # --timestamps needs the video for frame grabs, so it overrides the
    # transcript-mode download skip (and forces a full, not audio-only, fetch).
    audio_only = detail == "transcript" and not cue_timestamps
    if detail == "transcript" and transcript_segments and not cue_timestamps:
        video_path = None
    else:
        if url_source:
            print(
                "[watch] downloading audio via yt-dlp…" if audio_only
                else "[watch] downloading video via yt-dlp…",
                file=sys.stderr,
            )
            dl = download(
                args.source,
                work / "download",
                audio_only=audio_only,
            )
        else:
            print("[watch] using local file…", file=sys.stderr)
            dl = download(args.source, work / "download")
        video_path = dl["video_path"]

    meta = get_metadata(video_path) if video_path else {
        "duration_seconds": float((dl.get("info") or {}).get("duration") or 0),
        "width": None,
        "height": None,
        "codec": None,
        "has_audio": False,
    }
    full_duration = meta["duration_seconds"]
    # Midia so-audio (mp3 de audiencia, gravacao telefonica): ha arquivo, mas nao
    # ha faixa de video. Extrair frames dali aborta o ffmpeg e a transcricao — que
    # e justamente o que se quer do audio — nunca acontecia. Degrada para
    # transcricao e avisa, em vez de morrer.
    has_video = bool(meta.get("width"))
    frames_requested = args.every is not None or detail != "transcript" or bool(cue_timestamps)
    if video_path and not has_video and frames_requested:
        print(
            "[watch] midia sem faixa de video — frames impossiveis, seguindo so com transcricao",
            file=sys.stderr,
        )

    # Frames sigilosos no temp do sistema viram residuo indexado sem inventario.
    # Fail-closed: o operador precisa dizer onde guardar (dentro do dossie do caso).
    if args.sigiloso and has_video and frames_requested and work_is_temp:
        raise SystemExit(
            "--sigiloso com extracao de frames exige --out-dir explicito: os frames sao "
            "copia derivada de material sob segredo e nao podem ficar no temp do sistema. "
            "Aponte um diretorio dentro do dossie do caso (ou use --detail transcript)."
        )

    start_sec = parse_time(args.start)
    end_sec = parse_time(args.end)

    if start_sec is not None and start_sec < 0:
        raise SystemExit("--start must be non-negative")
    if end_sec is not None and start_sec is not None and end_sec <= start_sec:
        raise SystemExit("--end must be greater than --start")
    if full_duration > 0 and start_sec is not None and start_sec >= full_duration:
        raise SystemExit(f"--start {start_sec:.1f}s is past end of video ({full_duration:.1f}s)")
    # --end alem do fim: ajusta ao fim real para o relatorio nao anunciar uma
    # janela maior que o video (a cobertura seria enganosa num contexto forense).
    if end_sec is not None and full_duration > 0 and end_sec > full_duration:
        print(f"[watch] --end {end_sec:.1f}s passa do fim ({full_duration:.1f}s) — ajustado para o fim do video.", file=sys.stderr)
        end_sec = full_duration

    effective_start = start_sec if start_sec is not None else 0.0
    effective_end = end_sec if end_sec is not None else full_duration
    effective_duration = max(0.0, effective_end - effective_start)
    focused = start_sec is not None or end_sec is not None

    if focused:
        fps, target = auto_fps_focus(effective_duration, max_frames=budget_cap)
    else:
        fps, target = auto_fps(effective_duration, max_frames=budget_cap)
    if args.fps is not None:
        fps = min(args.fps, MAX_FPS)
        target = max(1, int(round(fps * effective_duration)))

    if transcript_segments and focused:
        transcript_segments = filter_range(transcript_segments, start_sec, end_sec)
        transcript_text = format_transcript(transcript_segments)

    scope = (
        f"{format_time(effective_start)}-{format_time(effective_end)} ({effective_duration:.1f}s)"
        if focused else f"full {effective_duration:.1f}s"
    )
    frames: list[dict] = []
    frame_meta: dict = {"engine": "none", "candidate_count": 0, "selected_count": 0, "fallback": False}
    cue_frames: list[dict] = []
    cue_meta: dict = {}

    # Transcript cues are pinned: extracted first and counted against the cap so
    # the detail engine never evicts the moments the user explicitly asked for.
    if cue_timestamps and video_path and has_video:
        cue_frames, cue_meta = extract_at_timestamps(
            video_path,
            work / "frames",
            cue_timestamps,
            resolution=args.resolution,
            max_frames=max_frames,
            start_seconds=start_sec,
            end_seconds=end_sec,
        )
        if cue_meta.get("dropped_out_of_window"):
            print(
                f"[watch] {cue_meta['dropped_out_of_window']} cue timestamp(s) outside the "
                "focus range — dropped",
                file=sys.stderr,
            )

    detail_budget = max_frames if max_frames is None else max(0, max_frames - len(cue_frames))
    if args.every is not None and video_path and has_video:
        # Frame-a-frame forense: cadencia fixa por todo o intervalo, sem teto.
        print(f"[watch] frame-a-frame: 1 frame a cada {args.every:g}s sobre {scope} (sem teto)…", file=sys.stderr)
        frames, frame_meta = extract_uniform(
            video_path,
            work / "frames",
            interval_seconds=args.every,
            resolution=args.resolution,
            start_seconds=start_sec,
            end_seconds=end_sec,
            dedup=not args.no_dedup,
        )
        if frame_meta.get("clamped"):
            print(
                f"[watch] --every {args.every:g}s abaixo do minimo — limitado a "
                f"{frame_meta['interval_seconds']:g}s (fps maximo {MAX_FPS:g}).",
                file=sys.stderr,
            )
    elif detail != "transcript" and video_path and has_video and detail_budget != 0:
        cap_label = "unlimited" if detail_budget is None else str(detail_budget)
        engine_label = "keyframes" if detail == "efficient" else "scene-aware frames"
        print(
            f"[watch] extracting {engine_label} over {scope} "
            f"(target {target}, cap {cap_label})…",
            file=sys.stderr,
        )
        if detail == "efficient":
            frames, frame_meta = extract_keyframes(
                video_path,
                work / "frames",
                resolution=args.resolution,
                max_frames=detail_budget,
                start_seconds=start_sec,
                end_seconds=end_sec,
                dedup=not args.no_dedup,
            )
        else:  # balanced, token-burner
            frames, frame_meta = extract_scene_or_uniform(
                video_path,
                work / "frames",
                fps=fps,
                target_frames=target,
                resolution=args.resolution,
                max_frames=detail_budget,
                start_seconds=start_sec,
                end_seconds=end_sec,
                dedup=not args.no_dedup,
            )

    if cue_frames:
        frames = merge_frames(frames, cue_frames)
    # A limpeza (finally em main) precisa saber se sobrou algo para o leitor ler.
    state["frames"] = frames

    if not transcript_segments and dl.get("subtitle_path"):
        try:
            all_segments = parse_vtt(dl["subtitle_path"])
            transcript_segments = filter_range(all_segments, start_sec, end_sec) if focused else all_segments
            transcript_text = format_transcript(transcript_segments)
            transcript_source = "captions"
        except Exception as exc:
            print(f"[watch] subtitle parse failed: {exc}", file=sys.stderr)

    if not transcript_segments and not args.no_transcribe and video_path and meta.get("has_audio"):
        provider = args.transcribe
        # Segredo de justica: a nuvem e proibida. Forca local, mesmo se pedirem openrouter.
        if args.sigiloso and provider != "local":
            print("[captura] --sigiloso: forcando transcricao LOCAL (nuvem bloqueada)", file=sys.stderr)
            provider = "local"
        # Fail-closed: a nuvem so roda com afirmacao explicita de midia publica (--publico).
        # Assim, esquecer --sigiloso num material secreto degrada para LOCAL, nunca vaza.
        if provider == "openrouter" and not args.publico:
            print("[captura] nuvem NAO liberada (sem --publico): usando LOCAL. Para enviar a "
                  "nuvem, confirme que a midia e publica com --publico.", file=sys.stderr)
            provider = "local"
        try:
            all_segments, used = transcribe_video(
                video_path, work / "audio.mp3", provider=provider, allow_cloud=(provider == "openrouter"),
            )
            transcript_segments = filter_range(all_segments, start_sec, end_sec) if focused else all_segments
            transcript_text = format_transcript(transcript_segments)
            transcript_source = f"transcricao ({used})"
        except SystemExit as exc:
            setup_py = SCRIPT_DIR / "setup.py"
            print(f"[captura] transcricao falhou: {exc}", file=sys.stderr)
            print(f"[captura] deps no uso: `python3 {setup_py}` (instala ffmpeg/yt-dlp/faster-whisper).", file=sys.stderr)
    elif not transcript_segments and video_path and not meta.get("has_audio"):
        print("[captura] sem faixa de audio — seguindo sem transcricao", file=sys.stderr)

    info = dl.get("info") or {}

    print()
    print("# watch: video report")
    print()
    print(f"- **Source:** {args.source}")
    if args.sigiloso:
        # Quem ler o relatorio precisa saber que o material e sigiloso — o selo
        # acompanha a peca, nao fica so na linha de comando de quem rodou.
        print(
            "- **Sigilo:** ⚠ SIGILOSO (segredo de justiça) — transcrição LOCAL, nuvem bloqueada, "
            "work dir 0700 e cópias derivadas removidas ao encerrar. Não colar este conteúdo "
            "em serviço externo."
        )
    if info.get("title"):
        print(f"- **Title:** {info['title']}")
    if info.get("uploader"):
        print(f"- **Uploader:** {info['uploader']}")
    print(f"- **Duration:** {format_time(full_duration)} ({full_duration:.1f}s)")
    if focused:
        print(
            f"- **Focus range:** {format_time(effective_start)} → {format_time(effective_end)} "
            f"({effective_duration:.1f}s)"
        )
    if meta.get("width") and meta.get("height"):
        print(f"- **Resolution:** {meta['width']}x{meta['height']} ({meta.get('codec') or 'unknown codec'})")
    range_mode = "focused" if focused else "full"
    print(f"- **Detail:** {'frame-a-frame' if args.every is not None else detail}")
    detail_count = frame_meta.get("selected_count", 0)
    if video_path and not has_video and frames_requested:
        print(
            "- **Frames:** nenhum — mídia só-áudio, sem faixa de vídeo "
            "(seguiu direto para transcrição)"
        )
    elif args.every is not None:
        interval = frame_meta.get("interval_seconds", args.every)
        deduped = frame_meta.get("deduped_count", 0)
        dedup_note = f", {deduped} quadro(s) idêntico(s) colapsado(s)" if deduped else ""
        print(
            f"- **Frames:** {detail_count} em cadência fixa de {interval:g}s "
            f"(frame-a-frame, {range_mode} range, sem teto{dedup_note})"
        )
    elif detail != "transcript":
        cap_label = "unlimited" if detail_budget is None else str(detail_budget)
        engine = frame_meta.get("engine", "scene")
        fallback = " with uniform fallback" if frame_meta.get("fallback") else ""
        deduped = frame_meta.get("deduped_count", 0)
        dedup_note = f", {deduped} near-duplicate{'s' if deduped != 1 else ''} dropped" if deduped else ""
        print(
            f"- **Frames:** {detail_count} selected from {frame_meta.get('candidate_count', detail_count)} "
            f"candidates ({engine}{fallback}{dedup_note}, {range_mode} range, budget {target}, cap {cap_label})"
        )
    elif not cue_frames:
        print("- **Frames:** skipped (transcript detail)")
    if cue_meta:
        dropped = cue_meta.get("dropped_out_of_window", 0)
        failed = cue_meta.get("failed_timestamps") or []
        requested_count = cue_meta.get("candidate_count", len(cue_frames))
        drop_note = f", {dropped} fora da janela de foco" if dropped else ""
        # Pedido ≠ extraido: em pericia, calar uma falha de extracao faz o leitor
        # concluir que aquele momento nunca foi marcado.
        fail_note = (
            f", ⚠ FALHOU em {', '.join(format_time(t) for t in failed)}" if failed else ""
        )
        print(
            f"- **Cue frames:** {len(cue_frames)} de {requested_count} timestamps pedidos "
            f"(transcript-cue{drop_note}{fail_note})"
        )
    if frames:
        print(f"- **Frame size:** max {args.resolution}px wide, max 1998px tall")
    transcript_covered_end = 0.0
    transcript_span_end = effective_end if focused else full_duration
    if transcript_segments:
        in_range = " in range" if focused else ""
        gaps = sum(
            1 for s in transcript_segments
            if str(s.get("text", "")).startswith("[TRECHO NAO TRANSCRITO")
        )
        # Cobertura conta so segmentos REAIS: um marcador de lacuna no fim nao pode
        # inflar 'cobre ate' e fingir completude.
        transcript_covered_end = max(
            (
                float(s.get("end") or s.get("start") or 0.0)
                for s in transcript_segments
                if not str(s.get("text", "")).startswith("[TRECHO NAO TRANSCRITO")
            ),
            default=0.0,
        )
        span_end = transcript_span_end
        cov_note = f", cobre até {format_time(transcript_covered_end)} de {format_time(span_end)}" if span_end and span_end > 0 else ""
        gap_note = f", ⚠ {gaps} lacuna(s) não transcrita(s)" if gaps else ""
        print(
            f"- **Transcript:** {len(transcript_segments)} segments{in_range} "
            f"(via {transcript_source or 'captions'}{cov_note}{gap_note})"
        )
    else:
        print("- **Transcript:** none available")

    # Incompletude no fim: transcricao para bem antes do fim do audio. Sinaliza
    # mesmo sem marcador (o caminho local nao marca), com tolerancia p/ silencio final.
    if transcript_segments and transcript_span_end and transcript_span_end > 0:
        shortfall = transcript_span_end - transcript_covered_end
        if shortfall > max(15.0, 0.05 * transcript_span_end):
            print()
            print(
                f"> **Aviso:** a transcrição vai só até {format_time(transcript_covered_end)} de "
                f"{format_time(transcript_span_end)} — faltam ~{format_time(shortfall)} ao fim. "
                "Confira o áudio: pode haver fala não captada (ou é só silêncio final)."
            )

    if args.every is not None and len(frames) > 250:
        print()
        print(
            f"> **Aviso:** frame-a-frame selecionou {len(frames)} frames. Ler todos custa "
            "MUITOS tokens de imagem — considere `--start/--end` para focar um trecho, ou um "
            "`--every` maior."
        )

    if detail == "token-burner" and len(frames) > 250:
        print()
        print(
            f"> **Warning:** token-burner detail selected {len(frames)} frames. "
            "This may use a large number of image tokens."
        )

    if args.every is None and not focused and full_duration > 600 and detail not in ("transcript", "token-burner"):
        mins = int(full_duration // 60)
        print()
        print(
            f"> **Warning:** This is a {mins}-minute video. Frame coverage is sparse at this length "
            f"under `{detail}` detail — its cap spreads thin across the full clip. For better results, "
            "re-run with `--start HH:MM:SS --end HH:MM:SS` to zoom into a section, use "
            "`--detail token-burner` to keep every scene-change frame, or `--every SEG` for "
            "frame-a-frame em cadência fixa."
        )

    print()
    print("## Frames")
    print()
    if frames:
        print(f"Frames live at: `{work / 'frames'}`")
        print()
        print(
            "**Read each frame path below with the Read tool to view the image.** "
            "Frames are in chronological order; `t=MM:SS` is the absolute timestamp in the source video."
        )
        print()
        for frame in frames:
            print(
                f"- `{frame['path']}` "
                f"(t={format_time(frame['timestamp_seconds'])}, reason={frame.get('reason', 'selected')})"
            )
    else:
        print("_No frames extracted._")

    print()
    print("## Transcript")
    print()
    if transcript_text:
        label = transcript_source or "captions"
        if focused:
            print(f"_Source: {label}. Filtered to {format_time(effective_start)} → {format_time(effective_end)}:_")
        else:
            print(f"_Source: {label}._")
        print()
        print("```")
        print(transcript_text)
        print("```")
    elif detail == "transcript":
        print(
            "_Sem transcricao no modo transcript. Nao havia legenda e a transcricao falhou ou "
            "estava indisponivel. Rode com `--detail balanced` para frames._"
        )
    elif focused and dl.get("subtitle_path"):
        print(f"_Nenhuma linha de transcricao caiu em {format_time(effective_start)} → {format_time(effective_end)}._")
    else:
        setup_py = SCRIPT_DIR / "setup.py"
        print(
            "_Sem transcricao — siga com os frames. Nao havia legenda e a transcricao nao rodou "
            "(deps ausentes, `--no-transcribe`, ou falha). "
            f"Rode `python3 {setup_py}` para instalar as dependencias no uso (ffmpeg/yt-dlp/faster-whisper)._"
        )

    print()
    print("---")
    # Retencao: dizer exatamente o que fica em disco e o que ja saiu. Cópia
    # derivada esquecida no temp é vazamento silencioso — o relatório é o único
    # inventário que o operador tem.
    if args.keep_work:
        print(
            f"_⚠ **--keep-work**: o work dir `{work}` FOI PRESERVADO — áudio extraído, mídia "
            "baixada e pedaços continuam em disco. Apague manualmente quando terminar._"
        )
    elif frames and args.sigiloso:
        print(
            f"_⚠ **SIGILOSO**: {len(frames)} frame(s) derivados permanecem em `{work / 'frames'}` "
            "(0700/0600) para leitura. Áudio e mídia baixada foram removidos. Apague os frames "
            "assim que a análise terminar._"
        )
    elif frames:
        print(
            f"_Frames em `{work / 'frames'}` — apague quando terminar. As cópias intermediárias "
            "(áudio extraído, mídia baixada, pedaços) são removidas ao encerrar._"
        )
    else:
        print("_Nada retido em disco: o work dir é removido ao encerrar._")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
