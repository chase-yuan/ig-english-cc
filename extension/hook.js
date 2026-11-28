(() => {
  "use strict";
  if (window.__igEnglishCCHooked) return;
  window.__igEnglishCCHooked = true;

  function cleanByteRange(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      u.searchParams.delete("bytestart");
      u.searchParams.delete("byteend");
      return u.toString();
    } catch {
      return rawUrl;
    }
  }

  function extractAudioFromDash(manifestStr) {
    if (!manifestStr || typeof manifestStr !== "string") return [];
    const xml = manifestStr
      .replace(/\\u003C/gi, "<")
      .replace(/\\u003E/gi, ">")
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");

    const found = [];
    const setRe = /<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let m;
    while ((m = setRe.exec(xml)) !== null) {
      const attrs = m[1] || "";
      const body = m[2] || "";
      const isVideoSet =
        /contentType=["']video["']/i.test(attrs) ||
        /mimeType=["']video\//i.test(attrs) ||
        (/mimeType=["']video\//i.test(body) && !/mimeType=["']audio\//i.test(body));
      if (isVideoSet) continue;

      const isAudioSet =
        /contentType=["']audio["']/i.test(attrs) ||
        /mimeType=["']audio\//i.test(attrs) ||
        /mimeType=["']audio\//i.test(body) ||
        /codecs=["']mp4a/i.test(body);
      if (!isAudioSet) continue;

      const repRe = /<Representation([^>]*)>([\s\S]*?)<\/Representation>/gi;
      let rm;
      let matchedRep = false;
      while ((rm = repRe.exec(body)) !== null) {
        const repAttrs = rm[1] || "";
        const repBody = rm[2] || "";
        if (/mimeType=["']video\//i.test(repAttrs)) continue;
        const bwMatch = repAttrs.match(/bandwidth=["'](\d+)["']/i);
        const bandwidth = bwMatch ? Number(bwMatch[1]) : Number.MAX_SAFE_INTEGER;
        const baseRe = /<BaseURL[^>]*>(https?:\/\/[^<]+)<\/BaseURL>/gi;
        let bm;
        while ((bm = baseRe.exec(repBody)) !== null) {
          found.push({ url: cleanByteRange(bm[1].trim()), bandwidth });
          matchedRep = true;
        }
      }

      if (!matchedRep) {
        const baseRe = /<BaseURL[^>]*>(https?:\/\/[^<]+)<\/BaseURL>/gi;
        let bm;
        while ((bm = baseRe.exec(body)) !== null) {
          found.push({ url: cleanByteRange(bm[1].trim()), bandwidth: Number.MAX_SAFE_INTEGER });
        }
      }
    }

    // Prefer lowest-bandwidth audio stream first (e.g. 48-64kbps AAC: tiny & crystal clear for Whisper)
    found.sort((a, b) => a.bandwidth - b.bandwidth);
    const seen = new Set();
    const urls = [];
    for (const item of found) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        urls.push(item.url);
      }
    }
    return urls;
  }

  function extractPrefetchAudio(node) {
    const ext = node && node.extensions;
    const groups = ext && ext.all_video_dash_prefetch_representations;
    if (!Array.isArray(groups)) return [];
    const found = [];
    for (const g of groups) {
      const reps = g && g.representations;
      if (!Array.isArray(reps)) continue;
      for (const r of reps) {
        if (!r || typeof r.base_url !== "string" || !r.base_url.startsWith("http")) continue;
        const mt = String(r.mime_type || r.mimeType || "").toLowerCase();
        if (mt.startsWith("audio/")) {
          found.push({
            url: cleanByteRange(r.base_url),
            bandwidth: Number(r.bandwidth) || Number.MAX_SAFE_INTEGER,
          });
        }
      }
    }
    found.sort((a, b) => a.bandwidth - b.bandwidth);
    return found.map((x) => x.url);
  }

  function emitMedia(payload) {
    window.postMessage({ type: "IG_CC_MEDIA", ...payload }, "*");
  }

  // Recursively walk parsed JSON tree so each media item's audio URL is strictly bound to its OWN shortcode.
  function walkJsonForMedia(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 25) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walkJsonForMedia(node[i], depth + 1);
      }
      return;
    }

    const code =
      (typeof node.code === "string" && node.code.length >= 6 && node.code.length <= 24 && node.code) ||
      (typeof node.shortcode === "string" && node.shortcode.length >= 6 && node.shortcode.length <= 24 && node.shortcode) ||
      null;

    if (code) {
      let found = false;
      const dash =
        node.video_dash_manifest ||
        node.dash_manifest ||
        (node.dash_info && (node.dash_info.video_dash_manifest || node.dash_info.dash_manifest));
      if (typeof dash === "string" && dash.includes("BaseURL")) {
        const audioUrls = extractAudioFromDash(dash);
        for (const u of audioUrls) {
          emitMedia({ url: u, kind: "audio", shortcode: code });
          found = true;
        }
      }
      const prefetchAudio = extractPrefetchAudio(node);
      for (const u of prefetchAudio) {
        emitMedia({ url: u, kind: "audio", shortcode: code });
        found = true;
      }
      if (Array.isArray(node.video_versions)) {
        // Sort smallest resolution first so muxed fallback stays under size caps whenever possible
        const sortedVersions = [...node.video_versions].sort((a, b) => {
          const areaA = (Number(a && a.width) || 9999) * (Number(a && a.height) || 9999);
          const areaB = (Number(b && b.width) || 9999) * (Number(b && b.height) || 9999);
          return areaA - areaB;
        });
        for (const v of sortedVersions) {
          if (v && typeof v.url === "string" && v.url.startsWith("http")) {
            emitMedia({ url: cleanByteRange(v.url), kind: "muxed", shortcode: code });
            found = true;
          }
        }
      }
      if (typeof node.video_url === "string" && node.video_url.startsWith("http")) {
        emitMedia({ url: cleanByteRange(node.video_url), kind: "muxed", shortcode: code });
        found = true;
      }
      // Also check nested media object (e.g. { media: { code, video_dash_manifest } })
      if (found) {
        // Still descend in case of carousel / clips children, but this node is already matched
      }
    }

    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === "object") {
        walkJsonForMedia(val, depth + 1);
      }
    }
  }

  function parseJsonText(text) {
    if (!text || text.length < 40) return;
    if (
      !text.includes("video_dash_manifest") &&
      !text.includes("dash_manifest") &&
      !text.includes("all_video_dash_prefetch_representations") &&
      !text.includes("video_versions") &&
      !text.includes("video_url")
    ) {
      return;
    }
    // Instagram GraphQL sometimes returns multiple newline-delimited JSON objects
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        walkJsonForMedia(parsed, 0);
      } catch {}
    }
  }

  function scanInlineScripts() {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      if (s.__igccScanned) continue;
      s.__igccScanned = true;
      parseJsonText(s.textContent || "");
    }
  }

  // Expose parser for automated unit testing if needed
  window.__igccParseJsonText = parseJsonText;

  // Hook fetch for GraphQL / API responses
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const reqUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
    const promise = origFetch.apply(this, args);
    if (reqUrl.includes("/graphql") || reqUrl.includes("/api/v1/") || reqUrl.includes("instagram.com")) {
      promise
        .then((res) => {
          const ct = res.headers && res.headers.get("content-type");
          if (ct && (ct.includes("json") || ct.includes("text"))) {
            res.clone().text().then(parseJsonText).catch(() => {});
          }
        })
        .catch(() => {});
    }
    return promise;
  };

  // Hook XHR for GraphQL / API responses
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__igccUrl = typeof url === "string" ? url : String(url || "");
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__igccUrl || "";
    if (url.includes("/graphql") || url.includes("/api/v1/")) {
      this.addEventListener("load", () => {
        try {
          if (typeof this.responseText === "string") {
            parseJsonText(this.responseText);
          }
        } catch {}
      });
    }
    return origSend.apply(this, args);
  };

  // Scan SSR embedded JSON scripts on initial page load & DOM updates
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanInlineScripts);
  } else {
    scanInlineScripts();
  }
  setInterval(scanInlineScripts, 2000);
})();
