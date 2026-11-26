"use strict";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24 MB safety margin under Groq's 25 MB cap
const MAX_PERSISTENT_CACHE = 100;
const ALLOWED_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];

let keyCursor = 0;
const inFlight = new Map(); // videoKey -> Promise<result>

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
  const { subtitleCacheV2 } = await storageGet(["subtitleCacheV2"]);
  if (subtitleCacheV2 && subtitleCacheV2[videoKey]) {
    return { ...subtitleCacheV2[videoKey], cached: true };
  }
  return null;
}

async function saveCachedSubtitle(videoKey, result) {
  if (!videoKey) return;
  const { subtitleCacheV2 } = await storageGet(["subtitleCacheV2"]);
  const cache = subtitleCacheV2 && typeof subtitleCacheV2 === "object" ? { ...subtitleCacheV2 } : {};
  delete cache[videoKey];
  cache[videoKey] = result;
  const keys = Object.keys(cache);
  while (keys.length > MAX_PERSISTENT_CACHE) {
    const oldest = keys.shift();
    delete cache[oldest];
  }
  await storageSet({ subtitleCacheV2: cache });
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
  for (const mediaUrl of validUrls) {
    try {
      const mediaResp = await fetch(mediaUrl);
      if (!mediaResp.ok) {
        lastError = `CDN HTTP ${mediaResp.status}`;
        continue;
      }
      const buf = await mediaResp.arrayBuffer();
      if (buf.byteLength < 1024) {
        lastError = "Audio buffer too small";
        continue;
      }
      if (buf.byteLength > MAX_AUDIO_BYTES) {
        lastError = `Media too large (${(buf.byteLength / (1024 * 1024)).toFixed(1)} MB > 24 MB Groq limit)`;
        continue;
      }

      const groqRes = await callGroqWhisper(buf, keys);
      const rawSegments = Array.isArray(groqRes.segments) ? groqRes.segments : [];
      let segments = rawSegments
        .map((s) => ({
          start: Math.round(Number(s.start || 0) * 1000) / 1000,
          end: Math.round(Number(s.end || 0) * 1000) / 1000,
          text: String(s.text || "").trim(),
        }))
        .filter((s) => s.text);

      const fullText = String(groqRes.text || "").trim();
      if (segments.length === 0 && fullText) {
        segments = [{ start: 0, end: 5, text: fullText }];
      }

      const result = {
        ok: true,
        cached: false,
        key: videoKey,
        text: fullText,
        segments,
        srt: segmentsToSrt(segments),
      };
      await saveCachedSubtitle(videoKey, result);
      return result;
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
  }

  return { ok: false, error: lastError };
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

  return false;
});
