#!/usr/bin/env node
/**
 * Comprehensive automated unit tests for IG English CC extension:
 * 1. hook.js: Batched GraphQL multi-reel 1-to-1 shortcode binding & NDJSON parsing
 * 2. background.js: Multi-candidate failover (stream #1 fails -> stream #2 succeeds)
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
  const hookCode = fs.readFileSync(`${EXT}/hook.js`, "utf8");
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

// --- Suite 2: background.js multi-candidate failover ---
{
  const bgCode = fs.readFileSync(`${EXT}/background.js`, "utf8");
  let listener = null;
  let fetchCalls = [];
  const bgSandbox = {
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
    fetch: async (url, opts) => {
      fetchCalls.push(url);
      if (url === "https://scontent.cdninstagram.com/video_only.mp4") {
        return { ok: true, arrayBuffer: async () => new Uint8Array(2048).buffer };
      }
      if (url === "https://scontent.cdninstagram.com/audio_good.mp4") {
        return { ok: true, arrayBuffer: async () => new Uint8Array(4096).buffer };
      }
      if (url === "http://127.0.0.1:18795/transcribe") {
        // First upload (2048B) simulates video-only ffmpeg failure; second (4096B) succeeds
        if (opts.body && opts.body.byteLength === 2048) {
          return { json: async () => ({ ok: false, error: "ffmpeg failed: Output file does not contain any stream" }) };
        }
        return { json: async () => ({ ok: true, text: "Failover succeeded", segments: [{ start: 0, end: 2, text: "Failover succeeded" }] }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };
  vm.runInNewContext(bgCode, bgSandbox);
  assert.ok(listener, "background.js must register onMessage listener");

  const res = await new Promise((resolve) => {
    listener(
      {
        type: "IG_CC_TRANSCRIBE_CANDIDATES",
        videoKey: "sc:REEL_FAILOVER",
        candidates: [
          "https://scontent.cdninstagram.com/video_only.mp4",
          "https://scontent.cdninstagram.com/audio_good.mp4",
        ],
      },
      {},
      resolve
    );
  });
  assert.equal(res.ok, true);
  assert.equal(res.text, "Failover succeeded");
  console.log("[PASS] 2. background.js: Multi-candidate failover verified");
}

// --- Suite 3: content.js React DOM reuse isolation + bounded Map eviction ---
{
  const contentCode = fs.readFileSync(`${EXT}/content.js`, "utf8");
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
    window: {
      innerWidth: 1200,
      innerHeight: 900,
      addEventListener() {},
    },
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
  assert.ok(api, "content.js test API should be exposed");

  // Simulate React reusing the EXACT SAME <video> DOM object across two different reels
  const sharedVideoEl = { currentSrc: "blob:https://www.instagram.com/aaa", parentElement: null };
  api.recordMedia("https://scontent.cdninstagram.com/a1.mp4", "audio", "REEL_FIRST");
  api.recordMedia("https://scontent.cdninstagram.com/b2.mp4", "audio", "REEL_SECOND");

  const id1 = api.getVideoIdentity(sharedVideoEl);
  assert.equal(id1, "sc:REEL_FIRST");
  api.getKeyState(id1).enabled = true;
  api.getKeyState(id1).data = { text: "First video caption" };

  // Navigate SPA to second reel reusing the SAME DOM element
  loc.pathname = "/reels/REEL_SECOND/";
  const id2 = api.getVideoIdentity(sharedVideoEl);
  assert.equal(id2, "sc:REEL_SECOND");
  assert.equal(api.getKeyState(id2).enabled, false, "Second video must NOT inherit first video's enabled state");
  assert.equal(api.getKeyState(id2).data, null, "Second video must NOT inherit first video's caption data");
  assert.equal(api.resolveCandidates(sharedVideoEl).candidates[0], "https://scontent.cdninstagram.com/b2.mp4");

  // Verify bounded FIFO cache eviction (insert 250 items -> size capped at 200)
  for (let i = 0; i < 250; i++) {
    api.recordMedia(`https://scontent.cdninstagram.com/v${i}.mp4`, "audio", `SC_BOUND_${i}`);
  }
  assert.equal(api.shortcodeMap.size, api.MAX_CACHE_ENTRIES, "shortcodeMap must stay bounded at MAX_CACHE_ENTRIES");
  assert.equal(api.shortcodeMap.has("SC_BOUND_0"), false, "Oldest entry must be evicted");
  assert.equal(api.shortcodeMap.has("SC_BOUND_249"), true, "Newest entry must be retained");
  console.log("[PASS] 3. content.js: React <video> reuse isolation & bounded FIFO cache verified");
}
