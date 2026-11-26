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
    const urls = [];
    const audioBlockRe = /<AdaptationSet[^>]*mimeType=["']audio\/[^"']+["'][^>]*>[\s\S]*?<BaseURL[^>]*>(https?:\/\/[^<]+)<\/BaseURL>/gi;
    let m;
    while ((m = audioBlockRe.exec(xml)) !== null) {
      urls.push(cleanByteRange(m[1]));
    }
    return urls;
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
      const dash = node.video_dash_manifest || node.dash_manifest;
      if (typeof dash === "string" && dash.includes("BaseURL")) {
        const audioUrls = extractAudioFromDash(dash);
        for (const u of audioUrls) {
          emitMedia({ url: u, kind: "audio", shortcode: code });
          found = true;
        }
      }
      if (Array.isArray(node.video_versions)) {
        for (const v of node.video_versions) {
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
    if (!text.includes("video_dash_manifest") && !text.includes("video_versions") && !text.includes("video_url")) {
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
