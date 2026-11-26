# Privacy Policy — English CC for Instagram

**Last Updated**: November 26, 2026

**English CC for Instagram** ("the Extension") is an independent, open-source browser extension designed strictly for personal English language learning.

## 1. Data We Do NOT Collect
- We do **not** collect, track, sell, or transmit any personally identifiable information (PII), browsing history, Instagram credentials, cookies, or analytics to any developer-owned server.
- This Extension has **no developer backend server**.

## 2. Local Storage Only
- Your Groq API key(s) and cached English subtitle transcripts (capped at 100 entries) are stored **exclusively on your own device** using `chrome.storage.local`.

## 3. Third-Party API Communication (User-Initiated Only)
- Only when you explicitly click the **`CC`** button (or press `C`) or click **`⬇`** on an Instagram video does the Extension fetch that video's audio stream and send it directly to **Groq's Whisper API** (`https://api.groq.com/openai/v1/audio/transcriptions`) using **your own API key**.
- Please refer to [Groq's Privacy Policy](https://groq.com/privacy-policy/) for how Groq processes API requests.

## 4. Open Source & Contact
- Full source code is publicly auditable at: https://github.com/chase-yuan/ig-english-cc
- For questions or issues, please open an issue on GitHub.
