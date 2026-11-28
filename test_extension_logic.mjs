#!/usr/bin/env node
/**
 * Comprehensive automated unit tests for IG English CC v2.1 (Zero-Backend + Large-Video Audio Chunker):
 * 1. hook.js:
 *    - Batched GraphQL multi-reel 1-to-1 shortcode binding
 *    - Real Instagram DASH where mimeType="audio/mp4" is on <Representation> & lowest bandwidth wins
 *    - dash_info.video_dash_manifest & all_video_dash_prefetch_representations
 *    - video_versions sorted smallest resolution first
 * 2. audio_utils.js:
 *    - 48 kHz stereo -> 16 kHz mono box-filter downsampling
 *    - Valid 44-byte RIFF/WAVE PCM header encoding
 *    - Multi-chunk slicing (25 min -> 3 chunks <= 19.2 MB each) & timestamp stitching
 * 3. background.js + offscreen.js:
 *    - Missing API key clear prompt
 *    - SSRF domain allowlist rejection (file://, evil.com, non-HTTPS)
 *    - Fast-path skip of > 24 MB stream when a smaller stream is available
 *    - Automatic Offscreen AudioContext decode + 16 kHz WAV chunking when ALL streams > 24 MB
 *    - Multi-candidate failover, 429 key rotation, concurrent deduplication & persistent cache hit
 *    - 250 MB OOM guard in offscreen extractor
 * 4. content.js: React <video> DOM reuse state isolation + bounded FIFO Map eviction
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(__dirname, "extension");

// --- Suite 1: hook.js multi-reel isolation + real IG DASH parsing ---
{
  const hookCode = fs.readFileSync(path.join(EXT, "hook.js"), "utf8");
  const emitted = [];
  const sandbox = {
    window: {
      postMessage(msg) {
        emitted.push(msg);
      },
      fetch: () => Promise.resolve({ headers: { get: () => "" }, clone: () => ({ text: () => Promise.resolve("") }) }),
    },
    location: { href: "https://www.instagram.com/reels/REEL_AAA111/", pathname: "/reels/REEL_AAA111/" },
    URL,
    atob,
    XMLHttpRequest: { prototype: { open() {}, send() {} } },
    document: { readyState: "complete", querySelectorAll: () => [], addEventListener() {} },
    setInterval: () => 0,
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(hookCode, sandbox);

  const batchedGraphQL = JSON.stringify({
    data: {
      edges: [
        {
          node: {
            media: {
              code: "REEL_AAA111",
              // Real IG format: contentType="audio" on AdaptationSet, mimeType on Representation, multiple bitrates
              video_dash_manifest: `<MPD>
                <AdaptationSet id="0" contentType="video"><Representation mimeType="video/mp4" bandwidth="2500000"><BaseURL>https://scontent.cdninstagram.com/v/video_only_aaa.mp4</BaseURL></Representation></AdaptationSet>
                <AdaptationSet id="1" contentType="audio">
                  <Representation id="a_hi" mimeType="audio/mp4" codecs="mp4a.40.5" bandwidth="128000"><BaseURL>https://scontent.cdninstagram.com/v/audio_aaa_128k.mp4?bytestart=0&amp;byteend=500&amp;oh=1</BaseURL></Representation>
                  <Representation id="a_lo" mimeType="audio/mp4" codecs="mp4a.40.5" bandwidth="48000"><BaseURL>https://scontent.cdninstagram.com/v/audio_aaa_48k.mp4?oh=1</BaseURL></Representation>
                </AdaptationSet>
              </MPD>`,
              video_versions: [
                { width: 1080, height: 1920, url: "https://scontent.cdninstagram.com/v/muxed_1080p.mp4" },
                { width: 480, height: 854, url: "https://scontent.cdninstagram.com/v/muxed_480p.mp4" },
              ],
            },
          },
        },
        {
          node: {
            media: {
              code: "REEL_BBB222",
              dash_info: {
                video_dash_manifest: `<MPD><AdaptationSet mimeType="audio/mp4"><BaseURL>https://scontent.cdninstagram.com/v/audio_bbb.mp4?oh=2</BaseURL></AdaptationSet></MPD>`,
              },
            },
          },
        },
        {
          node: {
            media: {
              code: "REEL_CCC333",
              extensions: {
                all_video_dash_prefetch_representations: [
                  {
                    representations: [
                      { mime_type: "video/mp4", bandwidth: 1500000, base_url: "https://scontent.cdninstagram.com/v/vid_ccc.mp4" },
                      { mime_type: "audio/mp4", bandwidth: 64000, base_url: "https://scontent.cdninstagram.com/v/aud_ccc.mp4" },
                    ],
                  },
                ],
              },
            },
          },
        },
      ],
    },
  });
  sandbox.window.__igccParseJsonText(batchedGraphQL);

  const byCode = new Map();
  for (const e of emitted) {
    if (!byCode.has(e.shortcode)) byCode.set(e.shortcode, []);
    byCode.get(e.shortcode).push(e);
  }
  const aaaAudio = byCode.get("REEL_AAA111").filter((x) => x.kind === "audio");
  const aaaMuxed = byCode.get("REEL_AAA111").filter((x) => x.kind === "muxed");
  assert.equal(aaaAudio.length, 2);
  assert.equal(aaaAudio[0].url, "https://scontent.cdninstagram.com/v/audio_aaa_48k.mp4?oh=1", "Lowest audio bandwidth should come first");
  assert.equal(aaaAudio[1].url, "https://scontent.cdninstagram.com/v/audio_aaa_128k.mp4?oh=1");
  assert.equal(aaaMuxed[0].url, "https://scontent.cdninstagram.com/v/muxed_480p.mp4", "Smallest resolution muxed video should come first");
  assert.equal(byCode.get("REEL_BBB222")[0].url, "https://scontent.cdninstagram.com/v/audio_bbb.mp4?oh=2");
  assert.equal(byCode.get("REEL_CCC333")[0].url, "https://scontent.cdninstagram.com/v/aud_ccc.mp4");

  // Nested carousel_media inheriting parent shortcode (Likes / Saved / Carousel posts)
  sandbox.window.__igccParseJsonText(
    JSON.stringify({
      shortcode: "LIKED_CAROUSEL",
      carousel_media: [
        {
          video_dash_manifest: `<MPD><AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="48000"><BaseURL>https://scontent.cdninstagram.com/v/liked_aud.mp4</BaseURL></Representation></AdaptationSet></MPD>`,
        },
      ],
    })
  );
  assert.ok(
    emitted.some((e) => e.shortcode === "LIKED_CAROUSEL" && e.url === "https://scontent.cdninstagram.com/v/liked_aud.mp4"),
    "Nested carousel_media must inherit parent shortcode"
  );

  // Live CDN URL classification via efg base64 metadata
  const audioEfg = Buffer.from('{"vencode_tag":"dash_baseline_audio_v1"}').toString("base64");
  const videoEfg = Buffer.from('{"vencode_tag":"dash_vp9_video_720p"}').toString("base64");
  const audioClassified = sandbox.window.__igccClassifyCdnUrl(
    `https://scontent.cdninstagram.com/v/stream.mp4?efg=${audioEfg}&bytestart=0&byteend=999`
  );
  const videoClassified = sandbox.window.__igccClassifyCdnUrl(
    `https://scontent.cdninstagram.com/v/stream.mp4?efg=${videoEfg}&bytestart=0&byteend=999`
  );
  assert.equal(audioClassified?.kind, "audio");
  assert.equal(audioClassified?.url.includes("bytestart"), false);
  assert.equal(videoClassified, null, "Silent video-only DASH tracks must be ignored");
  console.log("[PASS] 1. hook.js: Real IG DASH, nested shortcode inheritance & live CDN efg audio sniffing verified");
}

// --- Suite 2: audio_utils.js DSP downsampling, WAV header & chunk stitching ---
{
  const audioUtilsCode = fs.readFileSync(path.join(EXT, "audio_utils.js"), "utf8");
  const aSandbox = { globalThis: {} };
  aSandbox.globalThis = aSandbox;
  vm.runInNewContext(audioUtilsCode, aSandbox);
  const U = aSandbox.IGCCAudioUtils;
  assert.ok(U, "IGCCAudioUtils must be exported");

  // 1 second of 48 kHz stereo -> 16,000 mono samples
  const chL = new Float32Array(48000).fill(0.5);
  const chR = new Float32Array(48000).fill(0.5);
  const int16 = U.downsampleTo16kMono([chL, chR], 48000, 16000);
  assert.equal(int16.length, 16000);
  assert.ok(Math.abs(int16[100] - 16384) <= 2, `Expected ~16384, got ${int16[100]}`);

  const wav = U.encodeWav16kMono(int16, 16000);
  assert.equal(wav.byteLength, 44 + 16000 * 2);
  const dv = new DataView(wav);
  assert.equal(String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)), "RIFF");
  assert.equal(String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11)), "WAVE");
  assert.equal(dv.getUint16(22, true), 1); // mono
  assert.equal(dv.getUint32(24, true), 16000); // 16 kHz

  // 25 minutes at 16 kHz -> 3 chunks (10m, 10m, 5m), each <= 19.2 MB
  const fake25m = new Int16Array(25 * 60 * 16000);
  const chunks = U.chunkInt16Audio(fake25m, 16000, 600);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].offsetSec, 0);
  assert.equal(chunks[1].offsetSec, 600);
  assert.equal(chunks[2].offsetSec, 1200);
  for (const c of chunks) {
    assert.ok(c.wavBuffer.byteLength < 20 * 1024 * 1024, "Every WAV chunk must stay well under 24 MB");
  }

  const merged = U.mergeChunkTranscripts([
    { offsetSec: 0, text: "First part.", segments: [{ start: 1.2, end: 4.5, text: "First part." }] },
    { offsetSec: 600, text: "Second part.", segments: [{ start: 0.5, end: 3.0, text: "Second part." }] },
  ]);
  assert.equal(merged.text, "First part. Second part.");
  assert.equal(merged.segments.length, 2);
  assert.equal(merged.segments[1].start, 600.5);
  assert.equal(merged.segments[1].end, 603.0);
  console.log("[PASS] 2. audio_utils.js: 48k->16k mono WAV encoding, 25-min multi-chunk slicing & timestamp stitching verified");
}

// --- Suite 3: background.js + offscreen.js zero-backend & large-video fallback ---
{
  const bgCode = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const audioUtilsCode = fs.readFileSync(path.join(EXT, "audio_utils.js"), "utf8");
  const offscreenCode = fs.readFileSync(path.join(EXT, "offscreen.js"), "utf8");

  const store = { groqKeys: [], subtitleCacheV2: {} };
  let bgListener = null;
  let offscreenListener = null;
  let offscreenCreatedCount = 0;
  let groqCallCount = 0;
  let groqWavChunkCount = 0;
  let oversizedBodyCancelled = false;

  const sharedFetch = async (url, opts = {}) => {
    if (url === "https://scontent.cdninstagram.com/bad_stream.mp4") {
      return { ok: false, status: 403, headers: new Headers() };
    }
    if (url === "https://scontent.cdninstagram.com/oversized_muxed.mp4") {
      return {
        ok: true,
        headers: new Headers({ "content-length": String(35 * 1024 * 1024) }),
        body: {
          cancel: async () => {
            oversizedBodyCancelled = true;
          },
        },
        arrayBuffer: async () => new Uint8Array(8192).buffer,
      };
    }
    if (url === "https://scontent.cdninstagram.com/giant_300mb.mp4") {
      return {
        ok: true,
        headers: new Headers({ "content-length": String(300 * 1024 * 1024) }),
        body: { cancel: async () => {} },
        arrayBuffer: async () => new Uint8Array(0).buffer,
      };
    }
    if (url === "https://scontent.cdninstagram.com/good_audio.mp4") {
      return {
        ok: true,
        headers: new Headers({ "content-length": "4096" }),
        arrayBuffer: async () => new Uint8Array(4096).buffer,
      };
    }
    if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
      groqCallCount += 1;
      const auth = opts.headers && opts.headers.Authorization;
      if (auth === "Bearer gsk_rate_limited") {
        return { ok: false, status: 429, text: async () => "rate limit exceeded" };
      }
      const file = opts.body && typeof opts.body.get === "function" ? opts.body.get("file") : null;
      if (file && file.type === "audio/wav") {
        groqWavChunkCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            text: `Chunk ${groqWavChunkCount} ok.`,
            segments: [{ start: 0.5, end: 2.0, text: `Chunk ${groqWavChunkCount} ok.` }],
          }),
        };
      }
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          text: "Zero backend works cleanly.",
          segments: [{ start: 0.0, end: 2.1, text: "Zero backend works cleanly." }],
        }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  // Boot offscreen sandbox first
  class MockAudioContext {
    async decodeAudioData(_buf) {
      // Simulate a 2-second 48 kHz mono decoded audio buffer
      const pcm = new Float32Array(48000 * 2).fill(0.1);
      return {
        sampleRate: 48000,
        numberOfChannels: 1,
        getChannelData: () => pcm,
      };
    }
    async close() {}
  }

  const offSandbox = {
    URL,
    Blob,
    FormData,
    Headers,
    AudioContext: MockAudioContext,
    fetch: sharedFetch,
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            offscreenListener = fn;
          },
        },
      },
    },
  };
  offSandbox.globalThis = offSandbox;
  vm.runInNewContext(audioUtilsCode, offSandbox);
  vm.runInNewContext(offscreenCode, offSandbox);
  assert.ok(offscreenListener, "offscreen.js must register onMessage listener");

  const bgSandbox = {
    URL,
    Blob,
    FormData,
    Headers,
    chrome: {
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            for (const k of keys) out[k] = store[k];
            cb(out);
          },
          set(obj, cb) {
            Object.assign(store, obj);
            if (cb) cb();
          },
        },
      },
      offscreen: {
        async createDocument() {
          offscreenCreatedCount += 1;
        },
      },
      runtime: {
        lastError: null,
        async getContexts() {
          return offscreenCreatedCount > 0 ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
        },
        sendMessage(msg, cb) {
          offscreenListener(msg, {}, cb);
        },
        onMessage: {
          addListener(fn) {
            bgListener = fn;
          },
        },
      },
    },
    fetch: sharedFetch,
  };

  vm.runInNewContext(bgCode, bgSandbox);
  assert.ok(bgListener, "background.js must register onMessage listener");

  const sendMsg = (msg) => new Promise((resolve) => bgListener(msg, {}, resolve));

  // 3a. Missing API key
  const noKeyRes = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:NOKEY",
    candidates: ["https://scontent.cdninstagram.com/good_audio.mp4"],
  });
  assert.equal(noKeyRes.ok, false);
  assert.match(noKeyRes.error, /No Groq API key/i);

  store.groqKeys = ["gsk_rate_limited", "gsk_valid_key"];

  // 3b. SSRF rejection
  const ssrfRes = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:SSRF",
    candidates: [
      "file:///etc/passwd",
      "http://127.0.0.1:5244/api/fs/list",
      "https://evil.example.com/a.mp4",
      "http://scontent.cdninstagram.com/insecure.mp4",
    ],
  });
  assert.equal(ssrfRes.ok, false);
  assert.match(ssrfRes.error, /No allowed Instagram CDN/i);

  // 3c. Fast-path skips > 24 MB stream (cancelling body) when smaller stream follows
  oversizedBodyCancelled = false;
  groqWavChunkCount = 0;
  const skipBigRes = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:SKIP_BIG",
    candidates: [
      "https://scontent.cdninstagram.com/oversized_muxed.mp4",
      "https://scontent.cdninstagram.com/good_audio.mp4",
    ],
  });
  assert.equal(skipBigRes.ok, true);
  assert.equal(oversizedBodyCancelled, true, "Oversized stream body should be cancelled on fast path");
  assert.equal(groqWavChunkCount, 0, "Should NOT invoke offscreen when a small audio stream exists");

  // 3d. ALL candidates > 24 MB -> automatic Offscreen AudioContext decode + 16 kHz WAV transcription!
  groqWavChunkCount = 0;
  const bigFallbackRes = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:BIG_ONLY",
    candidates: ["https://scontent.cdninstagram.com/oversized_muxed.mp4"],
  });
  assert.equal(bigFallbackRes.ok, true, `Expected large video fallback to succeed, got: ${JSON.stringify(bigFallbackRes)}`);
  assert.equal(groqWavChunkCount, 1);
  assert.equal(offscreenCreatedCount, 1);
  assert.match(bigFallbackRes.text, /Chunk 1 ok/);

  // 3e. 250 MB OOM guard in offscreen extractor
  const giantRes = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:GIANT_300MB",
    candidates: ["https://scontent.cdninstagram.com/giant_300mb.mp4"],
  });
  assert.equal(giantRes.ok, false);
  assert.match(giantRes.error, /250 MB/);

  // 3f. Multi-candidate failover + 429 key rotation + concurrent deduplication + cache hit
  groqCallCount = 0;
  const [r1, r2] = await Promise.all([
    sendMsg({
      type: "IG_CC_TRANSCRIBE_CANDIDATES",
      videoKey: "sc:RACE_OK",
      candidates: [
        "https://scontent.cdninstagram.com/bad_stream.mp4",
        "https://scontent.cdninstagram.com/good_audio.mp4",
      ],
    }),
    sendMsg({
      type: "IG_CC_TRANSCRIBE_CANDIDATES",
      videoKey: "sc:RACE_OK",
      candidates: [
        "https://scontent.cdninstagram.com/bad_stream.mp4",
        "https://scontent.cdninstagram.com/good_audio.mp4",
      ],
    }),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.text, "Zero backend works cleanly.");
  assert.ok(groqCallCount <= 2, `Deduplicated calls should be <= 2, got ${groqCallCount}`);

  groqCallCount = 0;
  const r3 = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:RACE_OK",
    candidates: ["https://scontent.cdninstagram.com/good_audio.mp4"],
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.cached, true);
  assert.equal(groqCallCount, 0);
  console.log("[PASS] 3. background.js + offscreen.js: Fast-path skip, >24MB auto WAV extraction, OOM guard, SSRF, 429 rotation, race dedup & cache verified");
}

// --- Suite 4: content.js React DOM reuse isolation + bounded Map eviction ---
{
  const contentCode = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
  const makeEl = () => ({
    className: "",
    textContent: "",
    title: "",
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {},
    addEventListener() {},
    removeEventListener() {},
  });

  const loc = { href: "https://www.instagram.com/reels/REEL_FIRST/", pathname: "/reels/REEL_FIRST/" };
  const cSandbox = {
    window: { innerWidth: 1200, innerHeight: 900, addEventListener() {} },
    location: loc,
    URL,
    document: {
      hidden: false,
      body: makeEl(),
      createElement: () => makeEl(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    chrome: { runtime: { sendMessage: async () => ({ ok: true }) } },
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
  };
  cSandbox.window.window = cSandbox.window;
  vm.runInNewContext(contentCode, cSandbox);

  const api = cSandbox.window.__igccTestAPI;
  const sharedVideoEl = { currentSrc: "blob:https://www.instagram.com/aaa", parentElement: null };
  api.recordMedia("https://scontent.cdninstagram.com/a1.mp4", "audio", "REEL_FIRST");
  api.recordMedia("https://scontent.cdninstagram.com/b2.mp4", "audio", "REEL_SECOND");

  const id1 = api.getVideoIdentity(sharedVideoEl);
  assert.equal(id1, "sc:REEL_FIRST");
  api.getKeyState(id1).enabled = true;
  api.getKeyState(id1).data = { text: "First video caption" };

  loc.pathname = "/reels/REEL_SECOND/";
  const id2 = api.getVideoIdentity(sharedVideoEl);
  assert.equal(id2, "sc:REEL_SECOND");
  assert.equal(api.getKeyState(id2).enabled, false);
  assert.equal(api.getKeyState(id2).data, null);
  assert.equal(api.resolveCandidates(sharedVideoEl).candidates[0], "https://scontent.cdninstagram.com/b2.mp4");

  for (let i = 0; i < 250; i++) {
    api.recordMedia(`https://scontent.cdninstagram.com/v${i}.mp4`, "audio", `SC_BOUND_${i}`);
  }
  assert.equal(api.shortcodeMap.size, api.MAX_CACHE_ENTRIES);
  assert.equal(api.shortcodeMap.has("SC_BOUND_0"), false);
  assert.equal(api.shortcodeMap.has("SC_BOUND_249"), true);

  // Likes / Activity modal scenario: no /reel/CODE in URL, blob: video src, resolved via live CDN sniff
  loc.pathname = "/your_activity/interactions/likes/";
  const likesVideo = { currentSrc: "blob:https://www.instagram.com/likes-vid", parentElement: null };
  api.recordCdnSniff("https://scontent.cdninstagram.com/live_likes_audio.mp4?bytestart=0&byteend=4096", "audio", "/your_activity/interactions/likes/", Date.now());
  const likesResolved = api.resolveCandidates(likesVideo);
  assert.ok(likesResolved, "Likes modal video must resolve via live CDN audio sniff");
  assert.equal(likesResolved.candidates[0], "https://scontent.cdninstagram.com/live_likes_audio.mp4");
  console.log("[PASS] 4. content.js: React <video> reuse isolation, bounded FIFO cache & Likes/Activity modal CDN fallback verified");
}
