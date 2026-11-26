# Chrome Web Store Submission Pack — English CC for Instagram

直接按下面字段复制到 Chrome Web Store 开发者后台即可（已避开所有商标与权限审核红线）。

---

## 1. Store Listing (商店展示信息)
- **Name**: `English CC for Instagram`
- **Summary (≤ 132 chars)**: `YouTube-style pure English subtitles and one-click TXT transcript export for Instagram Web (bring your own free Groq API key).`
- **Category**: `Education` (或 `Productivity`)
- **Language**: `English`
- **Privacy Policy URL**: `https://github.com/chase-yuan/ig-english-cc/blob/main/PRIVACY.md`
- **Homepage / Support URL**: `https://github.com/chase-yuan/ig-english-cc`

### Detailed Description
```text
English CC for Instagram adds clean, YouTube-style pure English closed captions and one-click plain-text transcript export to Instagram Web — built specifically for English learners.

KEY FEATURES
• YouTube-Style English Subtitles: Click "CC" (or press "C") on any Instagram Reel or video post to generate accurate, time-synced pure English captions in 1–3 seconds.
• Dictionary-Friendly Overlay: Captions are rendered as selectable text above Instagram's player, so you can hover, highlight, or double-click any word with your favorite dictionary extension without pausing or liking the video.
• One-Click TXT Export: Click "⬇" to download a clean, line-by-line English transcript (.txt) for vocabulary review, Anki flashcards, or study notes.
• Zero Subscription & Zero Backend: Bring your own free Groq API key (Whisper large-v3-turbo). Supports multiple keys with automatic rotation and local caching.

HOW TO USE (30 SECONDS)
1. Install the extension.
2. Click the extension icon in your toolbar and paste a free Groq API key from console.groq.com/keys.
3. Open Instagram, play a video, and click "CC" or press "C".

PRIVACY FIRST
No developer server, no tracking, no analytics. Your API key and subtitle cache stay locally in your browser (chrome.storage.local).

Disclaimer: Independent language-learning tool. Not affiliated with or endorsed by Instagram or Meta.
```

---

## 2. Privacy Practices / Permission Justifications (审核必填理由)

- **Single Purpose Description**:
  `Generates selectable, time-synced pure English subtitles and exports plain-text transcripts for Instagram Web videos to assist English language learners.`

- **`storage` permission**:
  `Used exclusively to store the user's own Groq API key(s) and a local bounded cache (max 100 items) of generated subtitles in chrome.storage.local.`

- **Host permissions (`https://www.instagram.com/*`, `https://*.cdninstagram.com/*`, `https://*.fbcdn.net/*`, `https://api.groq.com/*`)**:
  `instagram.com is required to render the CC/download buttons and selectable subtitle overlay on videos. cdninstagram.com and fbcdn.net are required strictly to read the active video's audio stream when the user clicks CC or download. api.groq.com is required to send that audio directly to Groq Whisper using the user's own API key.`

- **Remote code**: `No, I am not using Remote code.`

- **Data Usage disclosures**:
  - Check **none** of the personal data collection checkboxes (zero developer collection).
  - Certify the 3 compliance checkboxes at the bottom.
