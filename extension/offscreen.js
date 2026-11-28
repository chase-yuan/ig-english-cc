"use strict";

const ALLOWED_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];
const MAX_RAW_MEDIA_BYTES = 250 * 1024 * 1024; // 250 MB safety cap against browser OOM

let offscreenKeyCursor = 0;

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

async function sendWavChunkToGroq(wavBuf, chunkIndex, keys, groqEndpoint, groqModel) {
  const rotated = [];
  const start = offscreenKeyCursor % keys.length;
  offscreenKeyCursor = (offscreenKeyCursor + 1) % keys.length;
  for (let i = 0; i < keys.length; i++) {
    rotated.push(keys[(start + i) % keys.length]);
  }

  let lastErr = "Groq WAV transcription failed";
  for (const key of rotated) {
    const form = new FormData();
    form.append("file", new Blob([wavBuf], { type: "audio/wav" }), `chunk_${chunkIndex}.wav`);
    form.append("model", groqModel);
    form.append("language", "en");
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");

    try {
      const resp = await fetch(groqEndpoint, {
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

async function extractAndTranscribe(msg) {
  const { mediaUrl, keys, groqEndpoint, groqModel } = msg;
  if (!isAllowedMediaUrl(mediaUrl)) {
    return { ok: false, error: "Blocked disallowed media URL in offscreen extractor." };
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    return { ok: false, error: "No Groq API key provided." };
  }

  const resp = await fetch(mediaUrl);
  if (!resp.ok) {
    return { ok: false, error: `CDN HTTP ${resp.status}` };
  }
  const clHeader = resp.headers && resp.headers.get("content-length");
  if (clHeader && Number(clHeader) > MAX_RAW_MEDIA_BYTES) {
    try {
      await resp.body?.cancel?.();
    } catch {}
    return {
      ok: false,
      error: `Video exceeds 250 MB browser decode limit (${(Number(clHeader) / (1024 * 1024)).toFixed(0)} MB).`,
    };
  }

  const rawBuf = await resp.arrayBuffer();
  if (rawBuf.byteLength > MAX_RAW_MEDIA_BYTES) {
    return {
      ok: false,
      error: `Video exceeds 250 MB browser decode limit (${(rawBuf.byteLength / (1024 * 1024)).toFixed(0)} MB).`,
    };
  }

  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) {
    return { ok: false, error: "Web Audio API unavailable for large video decoding." };
  }

  const ctx = new AudioCtx();
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(rawBuf);
  } finally {
    await ctx.close().catch(() => {});
  }

  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  const utils = globalThis.IGCCAudioUtils;
  const int16 = utils.downsampleTo16kMono(channels, audioBuffer.sampleRate, utils.TARGET_SAMPLE_RATE);
  const chunks = utils.chunkInt16Audio(int16, utils.TARGET_SAMPLE_RATE, utils.DEFAULT_MAX_CHUNK_SECONDS);

  const chunkResults = [];
  for (const chunk of chunks) {
    const groqRes = await sendWavChunkToGroq(chunk.wavBuffer, chunk.index, keys, groqEndpoint, groqModel);
    chunkResults.push({
      offsetSec: chunk.offsetSec,
      durationSec: chunk.durationSec,
      text: groqRes.text || "",
      segments: Array.isArray(groqRes.segments) ? groqRes.segments : [],
    });
  }

  const merged = utils.mergeChunkTranscripts(chunkResults);
  return {
    ok: true,
    text: merged.text,
    segments: merged.segments,
    chunks: chunks.length,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "IG_CC_OFFSCREEN_EXTRACT_AND_TRANSCRIBE") return false;
  extractAndTranscribe(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
  return true;
});
