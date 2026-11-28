"use strict";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const GROQ_LLM_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-2.5-flash"];
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24 MB safety margin under Groq's 25 MB cap
const MAX_PERSISTENT_CACHE = 100;
const ALLOWED_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];

let keyCursor = 0;
const inFlight = new Map(); // videoKey -> Promise<result>
const inFlightStudy = new Map(); // videoKey -> Promise<studyResult>

function isAllowedMediaUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

function formatSrtTime(seconds) {
  const msTotal = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(msTotal / 3600000);
  const minutes = Math.floor((msTotal % 3600000) / 60000);
  const secs = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)},${pad3(ms)}`;
}

function segmentsToSrt(segments) {
  const blocks = [];
  let idx = 1;
  for (const seg of segments) {
    const text = String(seg.text || "").trim();
    if (!text) continue;
    blocks.push(`${idx}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${text}\n`);
    idx += 1;
  }
  return blocks.join("\n").trim() + (blocks.length ? "\n" : "");
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (res) => resolve(res || {})));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
}

async function getGroqKeys() {
  const { groqKeys } = await storageGet(["groqKeys"]);
  if (!Array.isArray(groqKeys)) return [];
  return groqKeys.map((k) => String(k || "").trim()).filter(Boolean);
}

async function getCachedSubtitle(videoKey) {
  if (!videoKey) return null;
  const { subtitleCacheV3 } = await storageGet(["subtitleCacheV3"]);
  if (subtitleCacheV3 && subtitleCacheV3[videoKey]) {
    return { ...subtitleCacheV3[videoKey], cached: true };
  }
  return null;
}

async function saveCachedSubtitle(videoKey, result) {
  if (!videoKey) return;
  const { subtitleCacheV3 } = await storageGet(["subtitleCacheV3"]);
  const cache = subtitleCacheV3 && typeof subtitleCacheV3 === "object" ? { ...subtitleCacheV3 } : {};
  delete cache[videoKey];
  cache[videoKey] = result;
  const keys = Object.keys(cache);
  while (keys.length > MAX_PERSISTENT_CACHE) {
    const oldest = keys.shift();
    delete cache[oldest];
  }
  await storageSet({ subtitleCacheV3: cache });
}

async function callGroqWhisper(audioBuf, keys) {
  const rotated = [];
  const start = keyCursor % keys.length;
  keyCursor = (keyCursor + 1) % keys.length;
  for (let i = 0; i < keys.length; i++) {
    rotated.push(keys[(start + i) % keys.length]);
  }

  let lastErr = "Groq transcription failed";
  for (const key of rotated) {
    const form = new FormData();
    form.append("file", new Blob([audioBuf], { type: "audio/mp4" }), "audio.mp4");
    form.append("model", GROQ_MODEL);
    form.append("language", "en");
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");

    try {
      const resp = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (resp.ok) {
        return await resp.json();
      }
      const errText = (await resp.text()).slice(0, 240);
      lastErr = `Groq HTTP ${resp.status}: ${errText}`;
      if ([401, 429, 500, 502, 503].includes(resp.status)) {
        continue;
      }
      throw new Error(lastErr);
    } catch (err) {
      lastErr = err && err.message ? err.message : String(err);
      if (lastErr.startsWith("Groq HTTP 400") || lastErr.startsWith("Groq HTTP 413")) {
        throw new Error(lastErr);
      }
    }
  }
  throw new Error(lastErr);
}

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== "function") {
    throw new Error("Browser offscreen audio extractor is not available.");
  }
  if (chrome.runtime && typeof chrome.runtime.getContexts === "function") {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existing && existing.length > 0) return;
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Decode audio track from large Instagram videos into 16kHz mono WAV chunks under 24MB for Whisper transcription.",
    })
    .catch((err) => {
      const msg = String((err && err.message) || err || "");
      if (!msg.includes("single offscreen document")) {
        throw err;
      }
    })
    .finally(() => {
      offscreenCreating = null;
    });
  await offscreenCreating;
}

async function transcribeOversizedViaOffscreen(mediaUrl, keys) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "IG_CC_OFFSCREEN_EXTRACT_AND_TRANSCRIBE",
        mediaUrl,
        keys,
        groqEndpoint: GROQ_ENDPOINT,
        groqModel: GROQ_MODEL,
      },
      (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(res);
      }
    );
  });
}

function buildFinalResult(videoKey, fullText, rawSegments) {
  let segments = (Array.isArray(rawSegments) ? rawSegments : [])
    .filter((s) => {
      // Filter Whisper silence/music hallucinations (high no_speech_prob)
      const nsp = Number(s && s.no_speech_prob);
      if (Number.isFinite(nsp) && nsp > 0.85) return false;
      return true;
    })
    .map((s) => ({
      start: Math.round(Number(s.start || 0) * 1000) / 1000,
      end: Math.round(Number(s.end || 0) * 1000) / 1000,
      text: String(s.text || "").trim(),
    }))
    .filter((s) => s.text);

  const cleanedText = segments.length > 0 ? segments.map((s) => s.text).join(" ") : String(fullText || "").trim();
  if (segments.length === 0 && cleanedText) {
    segments = [{ start: 0, end: 5, text: cleanedText }];
  }

  return {
    ok: true,
    cached: false,
    key: videoKey,
    text: cleanedText,
    segments,
    srt: segmentsToSrt(segments),
  };
}

async function transcribeCandidates(candidates, videoKey) {
  const cached = await getCachedSubtitle(videoKey);
  if (cached) return cached;

  const keys = await getGroqKeys();
  if (keys.length === 0) {
    return {
      ok: false,
      error: "No Groq API key set. Click the IG English CC toolbar icon to paste your free key.",
    };
  }

  const validUrls = candidates.filter(isAllowedMediaUrl);
  if (validUrls.length === 0) {
    return { ok: false, error: "No allowed Instagram CDN audio stream found." };
  }

  let lastError = "Could not transcribe audio stream.";
  const oversized = [];

  // Pass 1 (Fast Path): try any stream <= 24 MB directly without audio transcoding
  for (const mediaUrl of validUrls) {
    try {
      const mediaResp = await fetch(mediaUrl);
      if (!mediaResp.ok) {
        lastError = `CDN HTTP ${mediaResp.status}`;
        continue;
      }

      const clHeader = mediaResp.headers && mediaResp.headers.get("content-length");
      const declaredBytes = clHeader ? Number(clHeader) : 0;
      if (declaredBytes > MAX_AUDIO_BYTES) {
        try {
          await mediaResp.body?.cancel?.();
        } catch {}
        oversized.push({ url: mediaUrl, size: declaredBytes });
        lastError = `Media > 24 MB (${(declaredBytes / (1024 * 1024)).toFixed(1)} MB), queued for audio extraction`;
        continue;
      }

      const buf = await mediaResp.arrayBuffer();
      if (buf.byteLength < 1024) {
        lastError = "Audio buffer too small";
        continue;
      }
      if (buf.byteLength > MAX_AUDIO_BYTES) {
        oversized.push({ url: mediaUrl, size: buf.byteLength });
        lastError = `Media > 24 MB (${(buf.byteLength / (1024 * 1024)).toFixed(1)} MB), queued for audio extraction`;
        continue;
      }

      const groqRes = await callGroqWhisper(buf, keys);
      const result = buildFinalResult(videoKey, groqRes.text, groqRes.segments);
      await saveCachedSubtitle(videoKey, result);
      return result;
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
  }

  // Pass 2 (Large Video Fallback): extract 16 kHz mono WAV & chunk via Offscreen AudioContext
  if (oversized.length > 0) {
    oversized.sort((a, b) => a.size - b.size);
    for (const item of oversized) {
      try {
        const offRes = await transcribeOversizedViaOffscreen(item.url, keys);
        if (offRes && offRes.ok) {
          const result = buildFinalResult(videoKey, offRes.text, offRes.segments);
          await saveCachedSubtitle(videoKey, result);
          return result;
        }
        if (offRes && offRes.error) {
          lastError = offRes.error;
        }
      } catch (err) {
        lastError = err && err.message ? err.message : String(err);
      }
    }
  }

  return { ok: false, error: lastError };
}

async function getGeminiConfig() {
  const { geminiApiKey, geminiModel } = await storageGet(["geminiApiKey", "geminiModel"]);
  const apiKey = typeof geminiApiKey === "string" ? geminiApiKey.trim() : "";
  const model =
    typeof geminiModel === "string" && geminiModel.trim() ? geminiModel.trim() : DEFAULT_GEMINI_MODEL;
  return { apiKey, model };
}

async function getCachedStudy(videoKey) {
  if (!videoKey) return null;
  const { studyCacheV1 } = await storageGet(["studyCacheV1"]);
  if (studyCacheV1 && studyCacheV1[videoKey]) {
    return { ...studyCacheV1[videoKey], cached: true };
  }
  return null;
}

async function saveCachedStudy(videoKey, result) {
  if (!videoKey) return;
  const { studyCacheV1 } = await storageGet(["studyCacheV1"]);
  const cache = studyCacheV1 && typeof studyCacheV1 === "object" ? { ...studyCacheV1 } : {};
  delete cache[videoKey];
  cache[videoKey] = result;
  const keys = Object.keys(cache);
  while (keys.length > MAX_PERSISTENT_CACHE) {
    const oldest = keys.shift();
    delete cache[oldest];
  }
  await storageSet({ studyCacheV1: cache });
}

function cleanAnkiField(str) {
  return String(str || "")
    .replace(/\r?\n/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/[\[\]]/g, "")
    .replace(/^(情境|参考|解析|正面|背面)[：:]\s*/g, "")
    .replace(/;/g, "，")
    .trim();
}

function buildStudyMiningPrompt(transcriptText, segments) {
  const timeline = Array.isArray(segments) && segments.length > 0
    ? segments.map((s) => `[${Number(s.start || 0).toFixed(1)}s] ${s.text}`).join("\n")
    : transcriptText;

  return `You are a C1/C2 English Lexicographer & Anki Scenario Card Engine for an advanced Chinese-speaking English learner.

Analyze the following Instagram video English transcript and extract 3 to 6 of the HIGHEST-VALUE expressions (idiomatic collocations, phrasal verbs, polysemic usages, sharp metaphors, native spoken expressions, or C1/C2 vocabulary).
STRICTLY REJECT basic B2-or-below words. If the video is very short, extract 1 to 3 items.

Return ONLY valid JSON with this exact schema:
{
  "items": [
    {
      "term": "exact base form of the phrase or word",
      "category": "Idiom | Collocation | Phrasal Verb | Polysemy | C1/C2",
      "meaning_zh": "concise, idiomatic Chinese meaning",
      "nuance_zh": "1-sentence high-signal explanation of usage context, register, or why it sounds native",
      "quote": "exact short sentence or clause from the transcript containing this expression",
      "timestamp_sec": 12.4,
      "anki_front": "[简短背景]。你说：“[需要翻译的具体台词]” <br><br> [term]",
      "anki_back": "[与中文双引号内台词在语义和情绪上完美对齐的地道英文参考句] <br><br> [一句高阶精讲，指出精妙之处或使用语境]"
    }
  ]
}

CRITICAL RULES for anki_front & anki_back:
1. NO emojis, NO markdown asterisks (* or **), NO square brackets ([]), NO prefix labels like "情境：" or "参考：" or "解析：".
2. anki_front MUST follow: [简短背景]。你说：“[具体台词]” <br><br> [term]
3. The English sentence in anki_back MUST be the exact, natural, idiomatic translation of the quoted Chinese line in anki_front — zero information mismatch.
4. Keep timestamp_sec as a number matching the [xx.xs] marker where the quote appears.

TRANSCRIPT:
${timeline.slice(0, 12000)}`;
}

async function fetchWithTimeout(url, options, timeoutMs = 18000) {
  if (typeof AbortController !== "function") {
    return fetch(url, options);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiStudyMiner(prompt, apiKey, preferredModel) {
  const modelChain = Array.from(
    new Set([preferredModel, ...GEMINI_FALLBACK_MODELS].filter(Boolean))
  );
  let lastErr = "Gemini study mining failed";

  for (const model of modelChain) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const resp = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.3,
            },
          }),
        },
        18000
      );
      if (resp.ok) {
        const data = await resp.json();
        const rawText =
          data &&
          data.candidates &&
          data.candidates[0] &&
          data.candidates[0].content &&
          data.candidates[0].content.parts &&
          data.candidates[0].content.parts[0] &&
          data.candidates[0].content.parts[0].text;
        if (!rawText) throw new Error("Empty Gemini response");
        return { parsed: JSON.parse(rawText), modelUsed: model };
      }
      const errText = (await resp.text()).slice(0, 220);
      lastErr = `Gemini ${model} HTTP ${resp.status}: ${errText}`;
      if ([404, 429, 500, 502, 503, 504].includes(resp.status)) {
        continue;
      }
      throw new Error(lastErr);
    } catch (err) {
      lastErr = err && err.message ? err.message : String(err);
    }
  }
  throw new Error(lastErr);
}

async function callGroqStudyMiner(prompt, keys) {
  const rotated = [];
  const start = keyCursor % keys.length;
  keyCursor = (keyCursor + 1) % keys.length;
  for (let i = 0; i < keys.length; i++) {
    rotated.push(keys[(start + i) % keys.length]);
  }
  let lastErr = "Groq LLM study mining failed";
  for (const key of rotated) {
    try {
      const resp = await fetchWithTimeout(
        GROQ_CHAT_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: GROQ_LLM_MODEL,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
          }),
        },
        18000
      );
      if (resp.ok) {
        const data = await resp.json();
        const rawText =
          data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!rawText) throw new Error("Empty Groq LLM response");
        return { parsed: JSON.parse(rawText), modelUsed: `groq/${GROQ_LLM_MODEL}` };
      }
      const errText = (await resp.text()).slice(0, 220);
      lastErr = `Groq LLM HTTP ${resp.status}: ${errText}`;
      if ([401, 429, 500, 502, 503].includes(resp.status)) continue;
      throw new Error(lastErr);
    } catch (err) {
      lastErr = err && err.message ? err.message : String(err);
    }
  }
  throw new Error(lastErr);
}

async function mineStudyCards(videoKey, transcriptText, segments) {
  const cached = await getCachedStudy(videoKey);
  if (cached) return cached;

  const cleanText = String(transcriptText || "").trim();
  if (!cleanText) {
    return { ok: false, error: "Transcript is empty — nothing to mine." };
  }

  const prompt = buildStudyMiningPrompt(cleanText, segments);
  const gemini = await getGeminiConfig();
  const groqKeys = await getGroqKeys();

  let rawResult = null;
  let lastError = "No Gemini or Groq API key configured.";

  if (gemini.apiKey) {
    try {
      rawResult = await callGeminiStudyMiner(prompt, gemini.apiKey, gemini.model);
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
  }

  if (!rawResult && groqKeys.length > 0) {
    try {
      rawResult = await callGroqStudyMiner(prompt, groqKeys);
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
  }

  if (!rawResult) {
    return { ok: false, error: lastError };
  }

  const rawItems = Array.isArray(rawResult.parsed && rawResult.parsed.items)
    ? rawResult.parsed.items
    : [];
  const items = rawItems
    .map((it) => {
      const term = String((it && it.term) || "").trim();
      const front = cleanAnkiField(it && it.anki_front);
      const back = cleanAnkiField(it && it.anki_back);
      return {
        term,
        category: String((it && it.category) || "C1/C2").trim(),
        meaning_zh: String((it && it.meaning_zh) || "").trim(),
        nuance_zh: String((it && it.nuance_zh) || "").trim(),
        quote: String((it && it.quote) || "").trim(),
        timestamp_sec: Number.isFinite(Number(it && it.timestamp_sec)) ? Number(it.timestamp_sec) : 0,
        anki_front: front,
        anki_back: back,
        csv_line: front && back ? `${front};${back}` : "",
      };
    })
    .filter((it) => it.term);

  const csv = items
    .map((it) => it.csv_line)
    .filter(Boolean)
    .join("\n");

  const finalRes = {
    ok: true,
    cached: false,
    key: videoKey,
    model: rawResult.modelUsed,
    items,
    csv: csv ? `${csv}\n` : "",
  };
  await saveCachedStudy(videoKey, finalRes);
  return finalRes;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "IG_CC_TRANSCRIBE_CANDIDATES") {
    const candidates = Array.isArray(msg.candidates) ? msg.candidates : [];
    const videoKey = String(msg.videoKey || "").trim();

    if (videoKey && inFlight.has(videoKey)) {
      inFlight.get(videoKey).then(sendResponse);
      return true;
    }

    const promise = transcribeCandidates(candidates, videoKey).finally(() => {
      if (videoKey) inFlight.delete(videoKey);
    });
    if (videoKey) inFlight.set(videoKey, promise);
    promise.then(sendResponse);
    return true;
  }

  if (msg.type === "IG_CC_MINE_CARDS") {
    const videoKey = String(msg.videoKey || "").trim();
    const transcriptText = String(msg.text || "");
    const segments = Array.isArray(msg.segments) ? msg.segments : [];

    if (videoKey && inFlightStudy.has(videoKey)) {
      inFlightStudy.get(videoKey).then(sendResponse);
      return true;
    }

    const promise = mineStudyCards(videoKey, transcriptText, segments).finally(() => {
      if (videoKey) inFlightStudy.delete(videoKey);
    });
    if (videoKey) inFlightStudy.set(videoKey, promise);
    promise.then(sendResponse);
    return true;
  }

  return false;
});
