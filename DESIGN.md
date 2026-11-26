# Design File (v2.0 Zero-Backend Blueprint): `ig-english-cc`

> Self-contained AI build spec for a **100% browser-native, zero-backend** Instagram pure-English subtitle extension.

---

## 1. What & Why
- **Problem**: Instagram Web lacks YouTube-style selectable English subtitles and one-click `.txt` transcript export. Requiring users to install Python, `ffmpeg`, and a local background daemon creates unnecessary setup friction.
- **v2.0 Breakthrough**: Groq Whisper (`whisper-large-v3-turbo`) natively accepts Instagram's raw DASH `audio/mp4` streams directly over HTTPS — eliminating `server.py`, `ffmpeg`, and OS daemons completely.
- **Must-Have**:
  1. **YouTube-style pure English `CC` toggle** (`CC` button + `C` shortcut), synced to `<video>.currentTime`, selectable DOM text for dictionary lookups without triggering Instagram's play/pause/like layer.
  2. **One-click `.txt` transcript download** (`⬇`).
  3. **Zero-friction setup**: Single-box toolbar popup to save one or more free Groq API keys locally in `chrome.storage.local`.

---

## 2. Hard-Won Architectural Invariants
1. **Top-Level Overlay Mounting**: Mount `CC` / `⬇` and caption bar directly on `document.body` (`position: fixed; z-index: 2147483647`) to defeat Instagram's transparent click-interceptor masks. Stop propagation on mouse/pointer/touch events.
2. **Strict Per-Shortcode Audio Binding**: `hook.js` (`MAIN` world) recursively walks parsed GraphQL (including NDJSON) and SSR `<script type="application/json">` trees, binding each video's DASH `audio/mp4` `<BaseURL>` (and `video_versions` fallback) 1-to-1 to its own `shortcode`. Strip `bytestart` & `byteend`.
3. **Zero-Backend Direct Groq Transcription + Failover (`background.js`)**:
   - Strict CDN allowlist (`https://*.cdninstagram.com`, `https://*.fbcdn.net`) against SSRF.
   - Direct `FormData` upload of `audio/mp4` to `https://api.groq.com/openai/v1/audio/transcriptions` (`whisper-large-v3-turbo`, `language=en`, `verbose_json`).
   - 24 MB upload guard, multi-candidate stream failover, multi-key 401/429/5xx rotation, per-key `inFlight` Promise deduplication, and bounded 100-entry persistent cache in `chrome.storage.local`.
4. **Entity-Keyed UI State & Resource Hygiene (`content.js`)**:
   - Key state strictly by `shortcode` (immune to React reusing `<video>` DOM nodes).
   - Pause layout checks when `document.hidden`, drive caption updates via `timeupdate`/`seeked`, and cap in-memory Maps at 200 entries.

---

## 3. Verification Gates (`node test_extension_logic.mjs`)
- `hook.js`: Multi-reel batched GraphQL binds each audio URL strictly 1-to-1 to its own shortcode.
- `background.js`: Missing key prompt, SSRF rejection, 24 MB cap, stream failover, 429 key rotation, concurrent duplicate-key deduplication, and persistent cache hit all pass.
- `content.js`: React `<video>` DOM reuse isolation and bounded FIFO cache eviction pass.
