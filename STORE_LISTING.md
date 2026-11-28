# Microsoft Edge Add-ons Submission Pack — English CC for Instagram

**完全免费上架（无需外币信用卡）**。打开 [Microsoft Partner Center — Edge 扩展后台](https://partner.microsoft.com/dashboard/microsoftedge/overview)，按下面步骤直接复制粘贴即可：

---

## Step 1: 上传扩展包 (Packages)
- 直接上传本地文件：`dist/english-cc-for-instagram-v2.1.2.zip`（同一个包，Edge 原生兼容 Manifest V3）

---

## Step 2: 商店信息 (Store listings — English)
- **Display Name**: `English CC for Instagram`
- **Short Description (≤ 132 chars)**: `YouTube-style pure English subtitles and one-click TXT transcript export for Instagram Web (bring your own free Groq API key).`
- **Category**: `Education`（或 `Productivity`）
- **Store Logo (300×300 PNG)**: 上传 `store-assets/edge_store_logo_300x300.png`
- **Screenshot (1280×800 PNG)**: 上传 `store-assets/promo_1280x800.png`
- **Privacy Policy URL**: `https://github.com/chase-yuan/ig-english-cc/blob/main/PRIVACY.md`
- **Website URL**: `https://github.com/chase-yuan/ig-english-cc`

### Description
```text
English CC for Instagram adds clean, YouTube-style pure English closed captions and one-click plain-text transcript export to Instagram Web — built specifically for English learners.

KEY FEATURES
• YouTube-Style English Subtitles: Click "CC" (or press "C") on any Instagram Reel or video post to generate accurate, time-synced pure English captions in 1–3 seconds.
• Dictionary-Friendly Overlay: Captions are rendered as selectable text above Instagram's player, so you can hover, highlight, or double-click any word with your favorite dictionary extension without pausing or liking the video.
• One-Click TXT Export: Click "⬇" to download a clean, line-by-line English transcript (.txt) for vocabulary review, Anki flashcards, or study notes.
• Zero Subscription & Zero Backend: Bring your own free Groq API key (Whisper large-v3-turbo). Supports multiple keys with automatic rotation and local caching.

HOW TO USE (30 SECONDS)
1. Install the extension from Microsoft Edge Add-ons.
2. Click the extension icon in your toolbar and paste a free Groq API key from console.groq.com/keys.
3. Open Instagram, play a video, and click "CC" or press "C".

PRIVACY FIRST
No developer server, no tracking, no analytics. Your API key and subtitle cache stay locally in your browser (chrome.storage.local).

Disclaimer: Independent language-learning tool. Not affiliated with or endorsed by Instagram or Meta.
```

---

## Step 3: 审核备注 (Notes for certification — 极大提高一次过审率)
直接把下面这段粘进 Edge 提交页底部的 **Notes for certification**：

```text
This is a zero-backend, BYOK (Bring Your Own Key) English language-learning extension for Instagram Web.

How to test:
1. Click the extension toolbar icon and paste any free Groq API key (https://console.groq.com/keys), then click Save Key.
2. Open any public Instagram Reel (e.g., https://www.instagram.com/reels/).
3. Click the "CC" button at the top-right of the video (or press "C") to display time-synced pure English captions, or click "⬇" to export a plain-text .txt transcript.

Permission justification:
- storage: Stores the user's own Groq API key(s) and a bounded 100-item local subtitle cache in chrome.storage.local only.
- offscreen: Used strictly as an automatic fallback for large videos (>24 MB) to decode the audio track via Web Audio API into 16 kHz mono WAV chunks under Groq's 25 MB upload limit.
- instagram.com: Renders the CC/download buttons and selectable subtitle overlay.
- cdninstagram.com / fbcdn.net: Strictly reads the active video's audio stream when the user clicks CC or download.
- api.groq.com: Sends that audio stream directly to Groq Whisper using the user's own API key. No developer server or analytics are used.
```
