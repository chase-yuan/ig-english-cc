---
plugin: grill
version: 1.0.0
target: .
style: Hard-Nosed Critique & Backlog
findings_count:
  critical: 1
  high: 3
  medium: 2
  low: 1
  good: 1
---

# Codebase Interrogation Report: ig-english-cc

## Executive Summary
`ig-english-cc` delivers a lean, zero-dependency Python backend and Manifest V3 extension that solves a concrete Instagram English learning workflow. However, adversarial interrogation reveals one critical local SSRF/CORS vulnerability (`server.py` fetches arbitrary user-supplied URLs with `Access-Control-Allow-Origin: *`), non-atomic cache writes under concurrent requests, fragile Reels DOM shortcode resolution when URLs omit shortcodes, and significant automated test gaps across `content.js`, `background.js`, and negative error paths.

## Findings by Lane

### Lane 1: Architecture & Topology

- **File**: `extension/content.js:44-63`
- **Observation**: In Instagram Reels feed (`/reels/`) or Home feed (`/`), `extractShortcodeFromVideo()` walks up 12 DOM ancestors looking for `a[href*="/reel/"]`. Reels cards often lack anchor tags or share a container with neighboring cards, causing either failed binding or wrong-video binding.
- **Severity**: `[HIGH]`
- **Evidence**: `const links = node.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]'); if (links.length > 0 && links.length <= 6)`
- **Proposed change**: Restrict ancestor link matching to elements whose bounding box overlaps the target `<video>` rect, and extract shortcode from Instagram's React fiber props on the video container as a deterministic fallback.
- **Tradeoff**: Gain: Eliminates feed cross-binding and missing-link errors. Lose: Minor coupling to Instagram's DOM geometry / React container layout.
- **Effort**: `[< 1 day]`

- **File**: `server.py:1-19`
- **Observation**: Backend uses pure Python stdlib with zero third-party packages, round-robin 4-key Groq failover, and single-file `config.json` with zero settings UI bloat.
- **Severity**: `[GOOD]`
- **Evidence**: `from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer`
- **Proposed change**: Preserve this zero-dependency boundary as features evolve.
- **Tradeoff**: Gain: Zero virtualenv fragility and instant LaunchAgent startup. Lose: Manual multipart construction instead of `requests`.
- **Effort**: `[< 1 day]`

### Lane 2: Concurrency & Edge Cases

- **File**: `server.py:191-223`
- **Observation**: Concurrent requests for the same `cache_key` (e.g., clicking `CC` and `⬇` rapidly) bypass each other's cache check, invoke duplicate Groq API calls, and perform non-atomic `cache_file.write_text(...)`, risking torn/corrupted JSON cache files.
- **Severity**: `[HIGH]`
- **Evidence**: `cache_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")`
- **Proposed change**: Add a per-key lock dictionary (`_INFLIGHT_LOCKS`) to deduplicate concurrent transcriptions of the same `key_hash`, and write via temporary file + `os.replace()` for atomic cache persistence.
- **Tradeoff**: Gain: Zero duplicate API calls and crash-safe cache files. Lose: ~15 lines of lock management code.
- **Effort**: `[< 1 day]`

- **File**: `server.py:263-264`
- **Observation**: `self.rfile.read(length)` reads arbitrary `Content-Length` into memory with no upper bound, and `call_groq_whisper` does not guard against Groq's 25 MB audio upload cap on long Instagram Live replays.
- **Severity**: `[MEDIUM]`
- **Evidence**: `length = int(self.headers.get("Content-Length", "0")); raw_body = self.rfile.read(length)`
- **Proposed change**: Enforce a strict `MAX_UPLOAD_BYTES = 100 * 1024 * 1024` check returning `413`, and verify `len(mp3_bytes) <= 24 * 1024 * 1024` before calling Groq.
- **Tradeoff**: Gain: Prevents local OOM and surfaces clean user-facing errors on 1-hour replays. Lose: None.
- **Effort**: `[< 1 day]`

### Lane 3: Security & Attack Surface

- **File**: `server.py:179-188`
- **Observation**: `fetch_media_url(url)` passes unvalidated JSON input directly to `urllib.request.urlopen()` while `_send_json()` sets `Access-Control-Allow-Origin: *` (`server.py:236`). Any malicious website open in the user's browser can trigger local SSRF against localhost services (`http://127.0.0.1:5244/...`) or attempt `file://` URI reads via `POST http://127.0.0.1:18795/transcribe`.
- **Severity**: `[CRITICAL]`
- **Evidence**: `with urllib.request.urlopen(req, timeout=30) as resp: return resp.read()` and `self.send_header("Access-Control-Allow-Origin", "*")`
- **Proposed change**: Validate `urllib.parse.urlparse(url)` to require `scheme == "https"` and `hostname.endswith((".cdninstagram.com", ".fbcdn.net"))`; restrict `Access-Control-Allow-Origin` to `chrome-extension://` origins or require a shared local token header `X-IGCC-Token`.
- **Tradeoff**: Gain: Completely closes local SSRF and cross-site abuse from arbitrary web pages. Lose: Requires syncing a static token or extension origin check.
- **Effort**: `[< 1 day]`

### Lane 4: Fault Tolerance & Errors

- **File**: `extension/content.js:343-345`
- **Observation**: `setInterval(renderUI, 100)` continuously runs `document.querySelectorAll("video")` and `getBoundingClientRect()` 10 times per second even when the Instagram tab is backgrounded, causing unnecessary layout reflows and battery drain; `shortcodeMap` and `subtitleCache` grow unbounded over long sessions.
- **Severity**: `[HIGH]`
- **Evidence**: `setInterval(renderUI, 100);`
- **Proposed change**: Skip work when `document.hidden` is true, drive subtitle text updates via `<video>` `timeupdate` events instead of polling, and cap `shortcodeMap` / `subtitleCache` at 200 entries (FIFO eviction).
- **Tradeoff**: Gain: Near-zero idle CPU/battery usage and bounded memory. Lose: Slightly more event listener wiring.
- **Effort**: `[< 1 day]`

- **File**: `server.py:306`
- **Observation**: Fallback default port is still `18765`, which collides with an existing local service (`AI-Daily`), whereas `config.json` uses `18795`.
- **Severity**: `[LOW]`
- **Evidence**: `port = int(CONFIG.get("port", 18765))`
- **Proposed change**: Align fallback default to `18795` so config omission never collides with `18765`.
- **Tradeoff**: Gain: Eliminates silent port collision hazard. Lose: None.
- **Effort**: `[< 1 day]`

### Lane 5: Test Integrity & Gaps

- **File**: `test_extension_logic.mjs:1-106`
- **Observation**: Automated tests currently cover only `server.py` happy-path and `hook.js` JSON parsing. There are zero automated tests for `content.js` React `<video>` reuse, `background.js` multi-candidate failover, or `server.py` negative paths (SSRF rejection, corrupted audio, Groq 429 key rotation).
- **Severity**: `[MEDIUM]`
- **Evidence**: `test_extension_logic.mjs` only loads `extension/hook.js` via `vm.runInNewContext`.
- **Proposed change**: Add unit/integration tests covering (1) `server.py` SSRF & oversized payload rejection, (2) `background.js` candidate failover when stream #1 returns `no audio stream`, and (3) `content.js` state isolation across React `<video>` node reuse.
- **Tradeoff**: Gain: Catches real regressions before user ever reloads Edge. Lose: ~100 lines of test code.
- **Effort**: `[< 1 day]`

## Prioritized Remediation Backlog

### Phase 1: Critical Fixes (Immediate)
- [ ] `server.py:179-188` — Enforce HTTPS + Instagram CDN domain allowlist on `fetch_media_url` and lock down CORS (Effort: `< 1 day`)

### Phase 2: High-Priority Hardening (Next Sprint)
- [ ] `server.py:191-223` — Add per-key in-flight lock and atomic temp-file + `os.replace()` cache writes (Effort: `< 1 day`)
- [ ] `extension/content.js:44-63` — Harden shortcode extraction using bounding-box overlap & React container fallback (Effort: `< 1 day`)
- [ ] `extension/content.js:343-345` — Pause polling when `document.hidden`, use `timeupdate`, and bound Map sizes (Effort: `< 1 day`)

### Phase 3: Structural Clean-up (Ongoing)
- [ ] `server.py:263-264` — Enforce upload size ceiling (100 MB) and Groq 24 MB MP3 cap check (Effort: `< 1 day`)
- [ ] `test_extension_logic.mjs:1-106` — Add negative-path tests for SSRF, failover, and React video reuse (Effort: `< 1 day`)
- [ ] `server.py:306` — Align fallback default port to `18795` (Effort: `< 1 day`)
