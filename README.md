# IG English CC

> **YouTube-style pure English subtitles & one-click `.txt` transcript download for Instagram Web (Edge / Chrome).**
>
> Designed in the **AI-Era Spec-First** style: you can either run this zero-dependency reference implementation directly, or hand [`DESIGN.md`](./DESIGN.md) to your own AI coding agent so it builds & configures a personalized version for your OS, browser, and preferred speech-to-text engine in minutes.

---

## Option 1: Let Your AI Build & Configure It for You (Recommended)

Copy [`DESIGN.md`](./DESIGN.md) and give it to your AI coding assistant (Claude Code, Codex, Antigravity, Cursor, etc.) with this prompt:

```text
Read DESIGN.md in this repo. Adapt and set up this Instagram pure-English subtitle extension + local Whisper backend for my machine (my OS, my browser, and my Groq / OpenAI / local Whisper key). Follow all architectural invariants and run every verification test until green.
```

[`DESIGN.md`](./DESIGN.md) already documents every real-world Instagram pitfall (transparent click-blocking overlays, DASH video-only vs. audio-only stream separation, batched GraphQL cross-video subtitle bleed, React `<video>` DOM reuse, and localhost SSRF/CORS defense) so your AI will not repeat them.

---

## Option 2: Run This Reference Implementation Directly (30 Seconds)

### Prerequisites
- Python 3.9+ (stdlib only — **zero `pip install` needed**)
- `ffmpeg` installed and on `PATH` (`brew install ffmpeg` on macOS)
- A free [Groq API key](https://console.groq.com/) (`whisper-large-v3-turbo`)

### 1. Configure & Start Local Backend
```bash
cp config.example.json config.json
export GROQ_API_KEY="your_groq_api_key_here"
python3 server.py
```
Verify health:
```bash
curl http://127.0.0.1:18795/health
```

### 2. Load the Browser Extension (Edge / Chrome)
1. Open `edge://extensions/` (or `chrome://extensions/`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder

### 3. Usage on Instagram
Open any Instagram Reel or video post. Two minimal buttons appear at the top-right of the video:
- **`CC`** (or press **`C`**): Toggle pure English subtitles synced to `<video>.currentTime`. Hover or double-click any word in the caption overlay to use your dictionary extension — clicking the caption never pauses or likes the video.
- **`⬇`**: One-click download of the full plain-text English transcript (`<shortcode>_en.txt`).

---

## Verification Tests
```bash
# Backend security (SSRF, CORS, 413), concurrency lock, and live Whisper E2E
python3 test_server.py

# Extension GraphQL multi-reel isolation, candidate failover, and React DOM reuse
node test_extension_logic.mjs
```

---

## Disclaimer & License
- **Personal Language Learning Only**: Built strictly for personal English listening and vocabulary study. Do not use for mass scraping or violating platform terms of service.
- Licensed under the [MIT License](./LICENSE).
