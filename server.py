#!/usr/bin/env python3
"""
Local lightweight backend for ig-english-cc.
Zero external Python dependencies (stdlib only + ffmpeg + Groq Whisper).
Hardened against SSRF, CORS abuse, concurrent cache races, and oversized payloads.
"""

import hashlib
import itertools
import json
import os
import shutil
import subprocess
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"

MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB raw media ceiling
MAX_GROQ_MP3_BYTES = 24 * 1024 * 1024  # 24 MB safety margin under Groq's 25 MB cap
ALLOWED_MEDIA_HOST_SUFFIXES = (".cdninstagram.com", ".fbcdn.net")


def load_config() -> dict:
    cfg_file = CONFIG_PATH if CONFIG_PATH.exists() else (BASE_DIR / "config.example.json")
    with open(cfg_file, "r", encoding="utf-8") as f:
        return json.load(f)


CONFIG = load_config()
_raw_cache = Path(os.path.expanduser(CONFIG.get("cache_dir", "./_cache")))
CACHE_DIR = _raw_cache if _raw_cache.is_absolute() else (BASE_DIR / _raw_cache).resolve()
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def load_groq_keys() -> list[str]:
    env_key = os.environ.get("GROQ_API_KEY", "").strip()
    keys_out: list[str] = [env_key] if env_key else []
    p = Path(os.path.expanduser(CONFIG.get("groq_keys_path", "~/.config/groq/keys.json")))
    if p.exists():
        with open(p, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, list):
            keys_out.extend(k.strip() for k in raw if isinstance(k, str) and k.strip())
        elif isinstance(raw, dict):
            keys = raw.get("keys") or raw.get("api_keys") or []
            keys_out.extend(k.strip() for k in keys if isinstance(k, str) and k.strip())
    # Deduplicate preserving order
    return list(dict.fromkeys(keys_out))


GROQ_KEYS = load_groq_keys()
_KEY_LOCK = threading.Lock()
_KEY_CYCLE = itertools.cycle(GROQ_KEYS) if GROQ_KEYS else None

# Per-key lock registry to prevent duplicate concurrent Groq calls & cache write races
_INFLIGHT_GUARD = threading.Lock()
_INFLIGHT_LOCKS: dict[str, threading.Lock] = {}


def get_key_lock(key_hash: str) -> threading.Lock:
    with _INFLIGHT_GUARD:
        lock = _INFLIGHT_LOCKS.get(key_hash)
        if lock is None:
            lock = threading.Lock()
            _INFLIGHT_LOCKS[key_hash] = lock
        return lock


def next_groq_keys() -> list[str]:
    """Return all keys starting from the next round-robin slot for automatic failover."""
    if not GROQ_KEYS:
        return []
    with _KEY_LOCK:
        first = next(_KEY_CYCLE)
    idx = GROQ_KEYS.index(first)
    return GROQ_KEYS[idx:] + GROQ_KEYS[:idx]


def validate_media_url(url: str) -> str:
    """Strict SSRF defense: allow ONLY HTTPS URLs on Instagram/Facebook CDN domains."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"Rejected non-HTTPS media_url scheme: {parsed.scheme!r}")
    host = (parsed.hostname or "").lower()
    if not host or not any(host.endswith(suffix) for suffix in ALLOWED_MEDIA_HOST_SUFFIXES):
        raise ValueError(f"Rejected disallowed media_url host: {host!r}")
    return url


def is_allowed_origin(origin: str) -> bool:
    if not origin:
        return False
    return (
        origin.startswith("chrome-extension://")
        or origin.startswith("moz-extension://")
        or origin.startswith("extension://")
    )


def format_srt_time(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(ms_total, 3600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def segments_to_srt(segments: list[dict]) -> str:
    lines = []
    for idx, seg in enumerate(segments, start=1):
        start = format_srt_time(float(seg.get("start", 0.0)))
        end = format_srt_time(float(seg.get("end", 0.0)))
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        lines.append(f"{idx}\n{start} --> {end}\n{text}\n")
    return "\n".join(lines).strip() + ("\n" if lines else "")


def convert_to_speech_mp3(input_bytes: bytes) -> bytes:
    ffmpeg = CONFIG.get("ffmpeg_bin") or shutil.which("ffmpeg") or "ffmpeg"
    with tempfile.TemporaryDirectory(prefix="igcc_") as td:
        in_path = Path(td) / "input.bin"
        out_path = Path(td) / "audio.mp3"
        in_path.write_bytes(input_bytes)
        cmd = [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(in_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "48k",
            str(out_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if proc.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.strip() or 'empty output'}")
        mp3_bytes = out_path.read_bytes()
        if len(mp3_bytes) > MAX_GROQ_MP3_BYTES:
            raise ValueError(
                f"Audio too large for single Groq request ({len(mp3_bytes) / (1024 * 1024):.1f} MB > 24 MB cap)"
            )
        return mp3_bytes


def build_multipart(
    fields: dict[str, str],
    file_field: str,
    filename: str,
    file_bytes: bytes,
    content_type: str,
) -> tuple[bytes, str]:
    boundary = f"----igcc{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for name, val in fields.items():
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{val}\r\n".encode("utf-8")
        )
    parts.append(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n".encode("utf-8")
        + file_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def call_groq_whisper(mp3_bytes: bytes) -> dict:
    keys = next_groq_keys()
    if not keys:
        raise RuntimeError("No Groq API keys found in config")

    body, content_type = build_multipart(
        fields={
            "model": CONFIG.get("groq_model", "whisper-large-v3-turbo"),
            "language": CONFIG.get("language", "en"),
            "response_format": "verbose_json",
            "temperature": "0",
        },
        file_field="file",
        filename="audio.mp3",
        file_bytes=mp3_bytes,
        content_type="audio/mpeg",
    )

    last_err = None
    for key in keys:
        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": content_type,
                "User-Agent": "ig-english-cc/1.1",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:300]
            last_err = f"HTTP {e.code}: {err_body}"
            if e.code in (401, 429, 500, 502, 503):
                continue
            raise RuntimeError(last_err)
        except Exception as e:
            last_err = str(e)
            continue

    raise RuntimeError(f"All Groq keys failed. Last error: {last_err}")


def fetch_media_url(url: str) -> bytes:
    validated = validate_media_url(url)
    req = urllib.request.Request(
        validated,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://www.instagram.com/",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise ValueError("Remote media exceeds 100 MB limit")
        return data


def atomic_write_json(path: Path, payload: dict) -> None:
    tmp_path = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp_path, path)


def process_transcription(cache_key: str, raw_media: bytes) -> dict:
    key_hash = hashlib.sha256(cache_key.encode("utf-8")).hexdigest()[:24]
    cache_file = CACHE_DIR / f"{key_hash}.json"
    lock = get_key_lock(key_hash)

    with lock:
        if cache_file.exists():
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            data["cached"] = True
            return data

        mp3_bytes = convert_to_speech_mp3(raw_media)
        groq_res = call_groq_whisper(mp3_bytes)
        raw_segments = groq_res.get("segments") or []
        segments = [
            {
                "start": round(float(s.get("start", 0.0)), 3),
                "end": round(float(s.get("end", 0.0)), 3),
                "text": str(s.get("text", "")).strip(),
            }
            for s in raw_segments
            if str(s.get("text", "")).strip()
        ]
        if not segments and groq_res.get("text"):
            segments = [{"start": 0.0, "end": 5.0, "text": str(groq_res["text"]).strip()}]

        result = {
            "ok": True,
            "cached": False,
            "key": cache_key,
            "text": str(groq_res.get("text", "")).strip(),
            "segments": segments,
            "srt": segments_to_srt(segments),
        }
        atomic_write_json(cache_file, result)
        return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        pass

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        origin = self.headers.get("Origin", "")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Video-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin and not is_allowed_origin(origin):
            self._send_json(403, {"ok": False, "error": "Origin not allowed"})
            return
        self._send_json(200, {"ok": True})

    def do_GET(self) -> None:
        if self.path == "/health":
            ffmpeg_cfg = CONFIG.get("ffmpeg_bin") or "ffmpeg"
            ffmpeg_resolved = ffmpeg_cfg if Path(ffmpeg_cfg).exists() else shutil.which(ffmpeg_cfg)
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "ig-english-cc",
                    "groq_keys_loaded": len(GROQ_KEYS),
                    "ffmpeg_ok": bool(ffmpeg_resolved and Path(ffmpeg_resolved).exists()),
                    "cache_dir": str(CACHE_DIR),
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:
        try:
            origin = self.headers.get("Origin", "")
            if origin and not is_allowed_origin(origin):
                self._send_json(403, {"ok": False, "error": "Origin not allowed"})
                return

            length = int(self.headers.get("Content-Length", "0"))
            if length < 0:
                self._send_json(400, {"ok": False, "error": "Invalid Content-Length"})
                return
            if length > MAX_UPLOAD_BYTES:
                self._send_json(413, {"ok": False, "error": "Payload exceeds 100 MB limit"})
                return

            raw_body = self.rfile.read(length) if length > 0 else b""

            if self.path == "/transcribe":
                content_type = self.headers.get("Content-Type", "")
                if "application/json" in content_type:
                    payload = json.loads(raw_body.decode("utf-8"))
                    media_url = str(payload.get("media_url", "")).strip()
                    video_key = str(payload.get("video_key", "")).strip() or media_url
                    if not media_url:
                        self._send_json(400, {"ok": False, "error": "Missing media_url"})
                        return
                    try:
                        validate_media_url(media_url)
                    except ValueError as ve:
                        self._send_json(400, {"ok": False, "error": str(ve)})
                        return

                    key_hash = hashlib.sha256(video_key.encode("utf-8")).hexdigest()[:24]
                    cache_file = CACHE_DIR / f"{key_hash}.json"
                    if cache_file.exists():
                        data = json.loads(cache_file.read_text(encoding="utf-8"))
                        data["cached"] = True
                        self._send_json(200, data)
                        return
                    raw_media = fetch_media_url(media_url)
                    res = process_transcription(video_key, raw_media)
                    self._send_json(200, res)
                    return

                video_key = self.headers.get("X-Video-Key", "").strip()
                if not raw_body:
                    self._send_json(400, {"ok": False, "error": "Empty audio body"})
                    return
                if not video_key:
                    video_key = hashlib.sha256(raw_body).hexdigest()
                res = process_transcription(video_key, raw_body)
                self._send_json(200, res)
                return

            self._send_json(404, {"ok": False, "error": "Not found"})
        except ValueError as ve:
            self._send_json(400, {"ok": False, "error": str(ve)})
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})


def main() -> None:
    host = CONFIG.get("host", "127.0.0.1")
    port = int(CONFIG.get("port", 18795))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"ig-english-cc listening on http://{host}:{port} (keys={len(GROQ_KEYS)})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
