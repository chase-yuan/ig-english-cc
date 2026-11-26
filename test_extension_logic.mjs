#!/usr/bin/env node
/**
 * Comprehensive automated unit tests for IG English CC v2.0 (Zero-Backend Pure Extension):
 * 1. hook.js: Batched GraphQL multi-reel 1-to-1 shortcode binding & NDJSON parsing
 * 2. background.js:
 *    - Missing API key clear prompt
 *    - SSRF domain allowlist rejection (file://, evil.com, non-HTTPS)
 *    - 24 MB audio cap enforcement
 *    - Multi-candidate stream failover (stream #1 fails -> stream #2 succeeds)
 *    - Multi-key 429 automatic rotation (Key #1 returns 429 -> Key #2 succeeds)
 *    - Concurrent duplicate-key deduplication (2 concurrent calls -> 1 Groq API call) + persistent cache hit
 * 3. content.js: React <video> DOM reuse state isolation + bounded FIFO Map eviction
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(__dirname, "extension");

// --- Suite 1: hook.js multi-reel isolation ---
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
    location: { href: "https://www.instagram.com/reels/REEL_AAA111/" },
    URL,
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
              video_dash_manifest: `<MPD><AdaptationSet mimeType="video/mp4"><BaseURL>https://scontent.cdninstagram.com/v/video_only_aaa.mp4</BaseURL></AdaptationSet><AdaptationSet mimeType="audio/mp4"><BaseURL>https://scontent.cdninstagram.com/v/audio_aaa.mp4?bytestart=0&amp;byteend=500&amp;oh=1</BaseURL></AdaptationSet></MPD>`,
            },
          },
        },
        {
          node: {
            media: {
              code: "REEL_BBB222",
              video_dash_manifest: `<MPD><AdaptationSet mimeType="audio/mp4"><BaseURL>https://scontent.cdninstagram.com/v/audio_bbb.mp4?oh=2</BaseURL></AdaptationSet></MPD>`,
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
  assert.equal(byCode.get("REEL_AAA111")?.length, 1);
  assert.equal(byCode.get("REEL_AAA111")[0].url, "https://scontent.cdninstagram.com/v/audio_aaa.mp4?oh=1");
  assert.equal(byCode.get("REEL_BBB222")?.length, 1);
  assert.equal(byCode.get("REEL_BBB222")[0].url, "https://scontent.cdninstagram.com/v/audio_bbb.mp4?oh=2");
  console.log("[PASS] 1. hook.js: Batched GraphQL multi-reel 1-to-1 binding verified");
}

// --- Suite 2: background.js zero-backend Groq engine ---
{
  const bgCode = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const store = { groqKeys: [], subtitleCacheV2: {} };
  let listener = null;
  let groqCallCount = 0;

  const bgSandbox = {
    URL,
    Blob,
    FormData,
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
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
    fetch: async (url, opts = {}) => {
      if (url === "https://scontent.cdninstagram.com/bad_stream.mp4") {
        return { ok: false, status: 403 };
      }
      if (url === "https://scontent.cdninstagram.com/oversized.mp4") {
        return { ok: true, arrayBuffer: async () => new Uint8Array(25 * 1024 * 1024).buffer };
      }
      if (url === "https://scontent.cdninstagram.com/good_audio.mp4") {
        return { ok: true, arrayBuffer: async () => new Uint8Array(4096).buffer };
      }
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        groqCallCount += 1;
        const auth = opts.headers && opts.headers.Authorization;
        // Key 1 simulates 429 rate-limit; Key 2 succeeds
        if (auth === "Bearer gsk_rate_limited") {
          return { ok: false, status: 429, text: async () => "rate limit exceeded" };
        }
        await new Promise((r) => setTimeout(r, 30));
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
    },
  };

  vm.runInNewContext(bgCode, bgSandbox);
  assert.ok(listener, "background.js must register onMessage listener");

  const sendMsg = (msg) => new Promise((resolve) => listener(msg, {}, resolve));

  // 2a. Missing API key
  const noKeyRes = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:NOKEY",
    candidates: ["https://scontent.cdninstagram.com/good_audio.mp4"],
  });
  assert.equal(noKeyRes.ok, false);
  assert.match(noKeyRes.error, /No Groq API key/i);

  // Set 2 keys (first rate-limited, second valid)
  store.groqKeys = ["gsk_rate_limited", "gsk_valid_key"];

  // 2b. SSRF rejection
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

  // 2c. Oversized audio rejection (> 24 MB)
  const bigRes = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:BIG",
    candidates: ["https://scontent.cdninstagram.com/oversized.mp4"],
  });
  assert.equal(bigRes.ok, false);
  assert.match(bigRes.error, /24 MB/);

  // 2d. Multi-candidate failover + 429 key rotation + concurrent deduplication
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
  // Exactly 2 Groq attempts total (key 1 429 -> key 2 200), NOT 4 (deduplicated!)
  assert.equal(groqCallCount, 2, `Expected 2 calls (1 failover rotation, deduplicated), got ${groqCallCount}`);

  // 2e. Persistent cache hit (0 Groq calls)
  groqCallCount = 0;
  const r3 = await sendMsg({
    type: "IG_CC_TRANSCRIBE_CANDIDATES",
    videoKey: "sc:RACE_OK",
    candidates: ["https://scontent.cdninstagram.com/good_audio.mp4"],
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.cached, true);
  assert.equal(groqCallCount, 0);
  console.log("[PASS] 2. background.js: Key check, SSRF, 24MB cap, stream failover, 429 rotation, race dedup & cache verified");
}

// --- Suite 3: content.js React DOM reuse isolation + bounded Map eviction ---
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
  console.log("[PASS] 3. content.js: React <video> reuse isolation & bounded FIFO cache verified");
}
