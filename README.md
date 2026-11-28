# IG English CC (v2.2 — Zero-Backend Subtitles + AI Study Cards)

> **YouTube-style pure English subtitles, one-click `.txt` export, and side-panel C1/C2 phrase & Anki card mining for Instagram Web (Edge / Chrome).**
>
> **Zero Python. Zero `ffmpeg`. Zero local server.** Just load the `extension/` folder, paste a free Groq key (plus optional free Gemini API key for AI study cards), and learn directly while watching Instagram.

---

## 30-Second Setup (Anyone Can Do It)

1. **Download this repo** (Code → Download ZIP, or `git clone https://github.com/chase-yuan/ig-english-cc.git`).
2. **Load in Edge or Chrome**:
   - Open `edge://extensions/` (or `chrome://extensions/`)
   - Turn on **Developer mode**
   - Click **Load unpacked** → select the **`extension/`** folder
3. **Paste your free Groq API key**:
   - Click the **IG English CC** icon in your browser toolbar
   - Get a free key at [console.groq.com/keys](https://console.groq.com/keys) and paste it in (supports multiple keys, one per line, with automatic rotation)
   - Click **Save Key**

---

## Usage on Instagram

Open any Instagram Reel or video post. Two minimal buttons appear at the top-right of the video:
- **`CC`** (or press **`C`**): Toggle pure English subtitles synced to `<video>.currentTime`. Hover or double-click any word in the caption overlay to use your dictionary extension — clicking the caption never pauses or likes the video.
- **`⬇`**: One-click download of the full plain-text English transcript (`<shortcode>_en.txt`).

---

## Spec-First AI Blueprint
Want to customize it for your own workflow (e.g., auto-export to Obsidian/Anki, custom font, or OpenAI/local Whisper)? Hand [`DESIGN.md`](./DESIGN.md) to your AI coding agent — it documents every real-world Instagram pitfall (click-blocking overlays, DASH audio separation, batched GraphQL cross-talk, React `<video>` reuse, and security bounds) so your AI gets it right on the first try.

---

## Verification Tests
```bash
node test_extension_logic.mjs
```

## Disclaimer & License
- **Personal Language Learning Only**: Built strictly for personal English listening and vocabulary study. Your API key is stored locally in `chrome.storage.local` and only sent to `api.groq.com`.
- Licensed under the [MIT License](./LICENSE).
