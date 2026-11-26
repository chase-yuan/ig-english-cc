#!/usr/bin/env python3
"""
Comprehensive E2E + security + concurrency test suite for ig-english-cc server.
Covers:
1. /health verification
2. SSRF rejection (file://, localhost, arbitrary external domains -> 400)
3. Strict CORS enforcement (evil.com -> 403, chrome-extension:// -> allowed)
4. Empty body (400), oversized Content-Length (413), corrupted audio (500)
5. Live macOS speech -> ffmpeg -> Groq Whisper transcription + SRT format
6. Concurrent duplicate-key race test (2 threads hit same key -> only 1 Groq call, valid atomic cache)
"""

import hashlib
import json
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import server


def post_raw(url: str, data: bytes, headers: dict) -> tuple[int, dict, dict]:
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, dict(r.headers.items()), json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw": body}
        return e.code, dict(e.headers.items()), parsed


def run_tests():
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    base = f"http://127.0.0.1:{port}"
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    created_cache_keys = []

    try:
        # 1. Health check
        with urllib.request.urlopen(f"{base}/health", timeout=5) as r:
            health = json.loads(r.read())
        assert health["ok"] is True and health["groq_keys_loaded"] >= 1 and health["ffmpeg_ok"] is True
        print("[PASS] 1. /health:", health)

        # 2. SSRF rejection tests
        for bad_url in [
            "file:///etc/passwd",
            "http://127.0.0.1:5244/api/fs/list",
            "https://evil.example.com/audio.mp4",
            "http://scontent.cdninstagram.com/insecure.mp4",
        ]:
            code, _, body = post_raw(
                f"{base}/transcribe",
                json.dumps({"media_url": bad_url}).encode(),
                {"Content-Type": "application/json"},
            )
            assert code == 400 and body.get("ok") is False, (bad_url, code, body)
        print("[PASS] 2. SSRF allowlist rejected all 4 malicious URLs with 400")

        # 3. CORS origin enforcement
        code, headers, _ = post_raw(
            f"{base}/transcribe",
            b"",
            {"Origin": "https://evil.example.com", "Content-Type": "application/octet-stream"},
        )
        assert code == 403, f"Expected 403 for evil Origin, got {code}"
        assert "Access-Control-Allow-Origin" not in headers, headers

        code, headers, _ = post_raw(
            f"{base}/transcribe",
            b"",
            {"Origin": "chrome-extension://abcdefghijklmnop", "Content-Type": "application/octet-stream"},
        )
        assert code == 400  # empty body, but origin allowed
        assert headers.get("Access-Control-Allow-Origin") == "chrome-extension://abcdefghijklmnop", headers
        print("[PASS] 3. CORS blocked evil.example.com (403) and allowed chrome-extension://")

        # 4. Oversized payload (413) & corrupted audio (500)
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.putrequest("POST", "/transcribe")
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", str(server.MAX_UPLOAD_BYTES + 10))
        conn.endheaders()
        resp = conn.getresponse()
        assert resp.status == 413, f"Expected 413, got {resp.status}"
        conn.close()

        code, _, body = post_raw(
            f"{base}/transcribe",
            b"not-a-valid-audio-file-12345",
            {"Content-Type": "application/octet-stream", "X-Video-Key": "corrupt-test"},
        )
        assert code == 500 and "ffmpeg failed" in body.get("error", ""), (code, body)
        print("[PASS] 4. Oversized payload (413) and corrupt audio (500) handled cleanly")

        # 5. Live English speech -> ffmpeg -> Groq Whisper + concurrent deduplication test
        with tempfile.TemporaryDirectory() as td:
            aiff = Path(td) / "sample.aiff"
            subprocess.run(
                ["say", "-o", str(aiff), "Hello world. Critical thinking helps you see beyond feelings."],
                check=True,
                timeout=15,
            )
            audio_bytes = aiff.read_bytes()

        # Spy on call_groq_whisper to prove concurrent requests only call Groq ONCE
        groq_call_count = 0
        orig_groq = server.call_groq_whisper

        def counted_groq(mp3_bytes: bytes) -> dict:
            nonlocal groq_call_count
            groq_call_count += 1
            return orig_groq(mp3_bytes)

        server.call_groq_whisper = counted_groq
        test_key = f"selftest-race-{int(time.time())}"
        created_cache_keys.append(test_key)

        results = []

        def worker():
            c, _, b = post_raw(
                f"{base}/transcribe",
                audio_bytes,
                {"Content-Type": "application/octet-stream", "X-Video-Key": test_key},
            )
            results.append((c, b))

        t1 = threading.Thread(target=worker)
        t2 = threading.Thread(target=worker)
        t0 = time.time()
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        elapsed = time.time() - t0
        server.call_groq_whisper = orig_groq

        assert len(results) == 2
        assert all(c == 200 and b["ok"] is True for c, b in results), results
        assert groq_call_count == 1, f"Expected exactly 1 Groq call under concurrent race, got {groq_call_count}"
        cached_flags = sorted(b["cached"] for _, b in results)
        assert cached_flags == [False, True], f"Expected one live + one cached response, got {cached_flags}"
        text = results[0][1]["text"]
        assert "critical" in text.lower() or "feelings" in text.lower(), text
        print(f"[PASS] 5. Concurrent live E2E ({elapsed:.2f}s): 2 threads -> 1 Groq call, text={text!r}")

    finally:
        for k in created_cache_keys:
            h = hashlib.sha256(k.encode()).hexdigest()[:24]
            cf = server.CACHE_DIR / f"{h}.json"
            if cf.exists():
                cf.unlink()
        httpd.shutdown()


if __name__ == "__main__":
    run_tests()
