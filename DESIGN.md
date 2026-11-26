# Design File (Spec-First Blueprint): `ig-english-cc`

> This document is intentionally written as a **self-contained AI build spec**. Any capable coding agent can read this file and reconstruct a bug-free, OS-native version tailored to its owner's machine, browser, and ASR provider without hitting the real-world Instagram pitfalls below.

---

## 1. What & Why
- **Problem**: Instagram Web (Reels / Feed / Stories) lacks YouTube-style selectable English subtitles and one-click transcript export, making it hard for language learners to look up unknown words or save transcripts for study (e.g., Anki / Obsidian).
- **Must-Have (Core Loop)**:
  1. **YouTube-style pure English `CC` toggle** (button + `C` shortcut): 1–3s latency, 100% synced to `<video>.currentTime` across pause/seek/replay, selectable DOM text for dictionary lookups without triggering Instagram's play/pause/like click layer.
  2. **One-click plain-text `.txt` transcript download** (`⬇`): clean line-by-line English transcript without timestamps.
- **Won't-Have (Intentional Minimalism)**:
  - No bilingual translation UI, no settings modal/UI (all parameters live in `config.json` and are edited by your AI on demand), no store publishing, no paid third-party subscriptions.

---

## 2. Hard-Won Architectural Invariants (Read Before Writing Code)

Any implementation MUST obey these 5 invariants learned from real Instagram production behavior:

1. **Top-Level Overlay Mounting (Defeat Click-Blocking Masks)**
   - Instagram places a transparent full-card click interceptor above `<video>` siblings.
   - **Rule**: Mount the `CC` / `⬇` control bar and subtitle overlay directly on `document.body` with `position: fixed; z-index: 2147483647`, positioned via `video.getBoundingClientRect()`. Stop propagation on `click`, `mousedown`, `mouseup`, `pointerdown`, `pointerup`, `dblclick`, and `touchstart` so dictionary lookup never pauses or likes the video.

2. **Strict Per-Shortcode Audio Binding (Defeat Preload Cross-Talk)**
   - Instagram GraphQL responses batch 5–10 preloaded Reels in one payload, and initial SSR pages embed media JSON inside `<script type="application/json">`.
   - **Rule**: Inject a `MAIN`-world hook (`hook.js`) that recursively walks parsed JSON trees (supporting NDJSON) and binds each video's DASH `AdaptationSet[mimeType^="audio/"] > BaseURL` (and fallback `video_versions`) **strictly 1-to-1 to that object's own `code`/`shortcode`**. Strip `bytestart` and `byteend` query params to fetch full audio. Never fall back to a global "latest media URL" queue.

3. **Multi-Candidate Failover (Defeat Video-Only DASH Streams)**
   - Instagram DASH splits video and audio into separate `.mp4` streams; passing a video-only stream to `ffmpeg -vn` fails with `Output file does not contain any stream`.
   - **Rule**: Pass an ordered candidate URL list (audio streams first, muxed streams second, video-only excluded) from `content.js` to the Manifest V3 Service Worker (`background.js`), which relays requests to `http://127.0.0.1:<port>` (bypassing HTTPS Mixed Content) and automatically fails over to the next candidate on stream errors.

4. **Entity-Keyed UI State & Bounded Memory (Defeat React DOM Reuse)**
   - Instagram's React SPA reuses the exact same `<video>` DOM element across different Reels.
   - **Rule**: Key all subtitle data and toggle state by `shortcode` (or `src`), never by `<video>` element identity. Pause layout polling when `document.hidden` is true, drive subtitle sync via `<video>` `timeupdate`/`seeked` events, and cap all in-memory Maps (e.g., 200-entry FIFO).

5. **Localhost Security & Concurrency Hardening**
   - **SSRF Defense**: Backend `fetch_media_url` MUST reject any URL that is not `https://` on `*.cdninstagram.com` or `*.fbcdn.net`.
   - **CORS Lockdown**: Never emit `Access-Control-Allow-Origin: *`. Allow only browser extension origins (`chrome-extension://`, `moz-extension://`).
   - **Concurrency & Atomicity**: Deduplicate simultaneous requests for the same video key with a per-key lock, write disk cache atomically via temp file + `os.replace()`, cap uploads at 100 MB, and guard Groq's 25 MB audio ceiling (24 MB cap).

---

## 3. Reference Components
- `server.py`: Pure Python stdlib HTTP server (`127.0.0.1:18795`) + `ffmpeg` (16kHz mono 48kbps MP3) + Groq `whisper-large-v3-turbo` (`language=en`, `verbose_json`, multi-key round-robin failover) + atomic `_cache/`.
- `extension/`: Manifest V3 extension (`manifest.json`, `hook.js`, `background.js`, `content.js`, `styles.css`).
- `config.example.json`: Single-file configuration (no Settings UI).

---

## 4. Mandatory Verification Gates (Exit Code 0 Required)
1. **Security & Concurrency (`test_server.py`)**:
   - `GET /health` returns `200 OK` with `ffmpeg_ok: true` and `groq_keys_loaded >= 1`.
   - `file:///etc/passwd`, `http://127.0.0.1:*`, and arbitrary domains return `400`.
   - `Origin: https://evil.example.com` returns `403` with no CORS header.
   - Oversized `Content-Length` returns `413`; corrupt audio returns `500`.
   - 2 concurrent requests for the same key invoke Groq exactly **once** and produce valid cached JSON.
2. **Frontend Isolation (`test_extension_logic.mjs`)**:
   - Batched multi-reel GraphQL JSON binds each audio URL strictly to its own shortcode.
   - `background.js` fails over cleanly from a video-only stream to an audio stream.
   - Reusing the same `<video>` DOM element across two shortcodes never leaks captions or toggle state; Maps stay bounded at 200 entries.
