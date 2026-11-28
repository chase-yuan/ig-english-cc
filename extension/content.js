(() => {
  "use strict";

  const MAX_CACHE_ENTRIES = 200;

  // Bounded FIFO Map helper to prevent unbounded memory growth over long Reels sessions
  function setBounded(map, key, value) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > MAX_CACHE_ENTRIES) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }

  // Strict per-shortcode media registry: shortcode -> Array<{url, kind}>
  const shortcodeMap = new Map();
  // Live CDN audio stream fallback per pathname (for Likes / Watch History / Activity modals where GraphQL omits manifest)
  const pathnameCdnMap = new Map(); // pathname -> Array<{url, kind, ts}>
  // Subtitle cache keyed strictly by videoKey (shortcode or direct video src)
  const subtitleCache = new Map();
  // Per-videoKey UI toggle state (immune to React reusing the same <video> DOM node)
  const keyStates = new Map(); // videoKey -> { enabled, loading, data }

  let currentVideo = null;
  let currentVideoKey = null;
  let boundVideoForEvents = null;
  let toastText = "";
  let toastTimer = null;

  function cleanUrl(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      u.searchParams.delete("bytestart");
      u.searchParams.delete("byteend");
      return u.toString();
    } catch {
      return rawUrl;
    }
  }

  function recordMedia(url, kind, shortcode) {
    if (!url || !shortcode || url.startsWith("blob:")) return;
    const cleaned = cleanUrl(url);
    const list = shortcodeMap.get(shortcode) || [];
    if (!list.some((e) => e.url === cleaned)) {
      list.push({ url: cleaned, kind: kind || "muxed" });
      setBounded(shortcodeMap, shortcode, list);
    }
  }

  function recordCdnSniff(url, kind, pathname, ts) {
    if (!url || url.startsWith("blob:")) return;
    const cleaned = cleanUrl(url);
    const pathKey = pathname || location.pathname || "/";
    const list = pathnameCdnMap.get(pathKey) || [];
    const existingIdx = list.findIndex((e) => e.url === cleaned);
    if (existingIdx >= 0) list.splice(existingIdx, 1);
    list.unshift({ url: cleaned, kind: kind || "muxed", ts: ts || Date.now() });
    if (list.length > 12) list.length = 12;
    setBounded(pathnameCdnMap, pathKey, list);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === "IG_CC_MEDIA") {
      recordMedia(event.data.url, event.data.kind, event.data.shortcode);
    } else if (event.data.type === "IG_CC_CDN_SNIFF") {
      recordCdnSniff(event.data.url, event.data.kind, event.data.pathname, event.data.ts);
    }
  });

  function rectsOverlapVertically(a, b) {
    if (!a || !b || b.width === 0 || b.height === 0) return false;
    return b.bottom >= a.top - 120 && b.top <= a.bottom + 120;
  }

  function extractShortcodeFromVideo(video) {
    // 1. Dedicated /reel/CODE/, /reels/CODE/, /p/CODE/, /tv/CODE/ URL path
    const pathMatch = location.pathname.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]{6,24})/);
    if (pathMatch) return pathMatch[1];

    if (video) {
      // 2. Modal dialog check (e.g. Likes / Watch History / Saved post modal where link sits in side column)
      const dialog = typeof video.closest === "function" ? video.closest('[role="dialog"], dialog') : null;
      if (dialog && dialog.querySelectorAll) {
        const dialogVideos = dialog.querySelectorAll("video");
        if (dialogVideos.length === 1) {
          const dLinks = dialog.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]');
          for (const a of dLinks) {
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]{6,24})/);
            if (m) return m[1];
          }
        }
      }

      // 3. Geometry-aware ancestor scan: only accept links belonging to THIS video's card
      const vRect = typeof video.getBoundingClientRect === "function" ? video.getBoundingClientRect() : null;
      let node = video.parentElement;
      for (let i = 0; i < 12 && node && node !== document.body; i++) {
        // Stop ascending if this container already wraps multiple distinct videos
        const nestedVideos = node.querySelectorAll ? node.querySelectorAll("video") : [];
        if (nestedVideos.length > 1) break;

        const links = node.querySelectorAll
          ? node.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]')
          : [];
        if (links.length > 0 && links.length <= 6) {
          for (const a of links) {
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]{6,24})/);
            if (!m) continue;
            if (!vRect || typeof a.getBoundingClientRect !== "function") return m[1];
            const aRect = a.getBoundingClientRect();
            if (rectsOverlapVertically(vRect, aRect)) return m[1];
          }
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function getVideoIdentity(video) {
    if (!video) return null;
    const shortcode = extractShortcodeFromVideo(video);
    if (shortcode) return `sc:${shortcode}`;
    const src = video.currentSrc || video.src;
    if (src) return `src:${src}`;
    return `path:${location.pathname || "/"}`;
  }

  function resolveCandidates(video, { allowPathSniff = false } = {}) {
    const shortcode = extractShortcodeFromVideo(video);
    const ordered = [];
    const seen = new Set();

    function push(url) {
      if (!url || seen.has(url)) return;
      seen.add(url);
      ordered.push(url);
    }

    // Priority 1: Strict 1-to-1 shortcode-bound media from GraphQL / SSR
    if (shortcode && shortcodeMap.has(shortcode)) {
      const list = shortcodeMap.get(shortcode);
      list.filter((e) => e.kind === "audio").forEach((e) => push(e.url));
      list.filter((e) => e.kind !== "audio").forEach((e) => push(e.url));
    }

    // Priority 2: Direct HTTP video src
    const directSrc = video.currentSrc || video.src;
    if (directSrc && directSrc.startsWith("http")) {
      push(cleanUrl(directSrc));
    }

    // Priority 3: Live CDN audio sniff ONLY when explicitly allowed (never preempting exact shortcode fetch,
    // because Instagram prefetches sponsored ads in the background on the same pathname!)
    if (ordered.length === 0 && allowPathSniff) {
      const pathList = pathnameCdnMap.get(location.pathname || "/") || [];
      pathList.filter((e) => e.kind === "audio").forEach((e) => push(e.url));
      pathList.filter((e) => e.kind !== "audio").forEach((e) => push(e.url));
    }

    if (ordered.length === 0) return null;
    return {
      candidates: ordered,
      videoKey: shortcode ? `sc:${shortcode}` : `src:${ordered[0]}`,
      shortcode,
    };
  }

  function extractAudioFromDashXml(manifestStr) {
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
      if (/contentType=["']video["']|mimeType=["']video\//i.test(attrs)) continue;
      if (!/contentType=["']audio["']|mimeType=["']audio\/|codecs=["']mp4a/i.test(attrs + " " + body)) continue;
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
          found.push({ url: cleanUrl(bm[1].trim()), bandwidth });
          matchedRep = true;
        }
      }
      if (!matchedRep) {
        const baseRe = /<BaseURL[^>]*>(https?:\/\/[^<]+)<\/BaseURL>/gi;
        let bm;
        while ((bm = baseRe.exec(body)) !== null) {
          found.push({ url: cleanUrl(bm[1].trim()), bandwidth: Number.MAX_SAFE_INTEGER });
        }
      }
    }
    found.sort((a, b) => a.bandwidth - b.bandwidth);
    return found.map((x) => x.url);
  }

  function extractExactShortcodeFromJson(node, targetCode, outAudio, outMuxed, depth = 0, inheritedCode = null) {
    if (!node || typeof node !== "object" || depth > 25) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        extractExactShortcodeFromJson(node[i], targetCode, outAudio, outMuxed, depth + 1, inheritedCode);
      }
      return;
    }
    const ownCode =
      (typeof node.code === "string" && node.code.length >= 6 && node.code.length <= 24 && node.code) ||
      (typeof node.shortcode === "string" && node.shortcode.length >= 6 && node.shortcode.length <= 24 && node.shortcode) ||
      null;
    const activeCode = ownCode || inheritedCode;

    if (activeCode === targetCode) {
      const dash =
        node.video_dash_manifest ||
        node.dash_manifest ||
        (node.dash_info && (node.dash_info.video_dash_manifest || node.dash_info.dash_manifest));
      if (typeof dash === "string" && dash.includes("BaseURL")) {
        for (const u of extractAudioFromDashXml(dash)) outAudio.push(u);
      }
      if (Array.isArray(node.video_versions)) {
        const sorted = [...node.video_versions].sort((a, b) => {
          const areaA = (Number(a && a.width) || 9999) * (Number(a && a.height) || 9999);
          const areaB = (Number(b && b.width) || 9999) * (Number(b && b.height) || 9999);
          return areaA - areaB;
        });
        for (const v of sorted) {
          if (v && typeof v.url === "string" && v.url.startsWith("http")) {
            outMuxed.push(cleanUrl(v.url));
          }
        }
      }
      if (typeof node.video_url === "string" && node.video_url.startsWith("http")) {
        outMuxed.push(cleanUrl(node.video_url));
      }
    }

    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === "object") {
        extractExactShortcodeFromJson(val, targetCode, outAudio, outMuxed, depth + 1, activeCode);
      }
    }
  }

  // Exact same-origin fetch when opened from Likes / Activity without preloaded manifest (strictly filters by shortcode!)
  async function fetchShortcodeFallback(shortcode) {
    if (!shortcode || typeof fetch !== "function") return [];
    const outAudio = [];
    const outMuxed = [];

    for (const pathPrefix of ["p", "reel"]) {
      try {
        const resp = await fetch(`${location.origin}/${pathPrefix}/${shortcode}/`, { credentials: "same-origin" });
        if (!resp.ok) continue;
        const html = await resp.text();
        const scriptRe = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let sm;
        while ((sm = scriptRe.exec(html)) !== null) {
          const raw = sm[1];
          if (!raw || !raw.includes(shortcode)) continue;
          try {
            const parsed = JSON.parse(raw);
            extractExactShortcodeFromJson(parsed, shortcode, outAudio, outMuxed, 0, null);
          } catch {}
        }
        if (outAudio.length > 0 || outMuxed.length > 0) break;
      } catch {}
    }

    const seen = new Set();
    const ordered = [];
    for (const u of outAudio) {
      if (!seen.has(u)) {
        seen.add(u);
        ordered.push(u);
        recordMedia(u, "audio", shortcode);
      }
    }
    for (const u of outMuxed) {
      if (!seen.has(u)) {
        seen.add(u);
        ordered.push(u);
        recordMedia(u, "muxed", shortcode);
      }
    }
    return ordered;
  }

  function getKeyState(videoKey) {
    if (!keyStates.has(videoKey)) {
      setBounded(keyStates, videoKey, { enabled: false, loading: false, data: null });
    }
    return keyStates.get(videoKey);
  }

  function triggerDownload(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stopEvents(el) {
    for (const evt of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "touchstart"]) {
      el.addEventListener(evt, (e) => {
        e.stopPropagation();
      });
    }
  }

  function findSegment(segments, currentTime) {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (currentTime >= s.start - 0.15 && currentTime <= s.end + 0.15) {
        return s.text;
      }
    }
    return "";
  }

  const controls = document.createElement("div");
  controls.className = "igcc-controls igcc-hidden";
  stopEvents(controls);

  const ccBtn = document.createElement("button");
  ccBtn.type = "button";
  ccBtn.className = "igcc-btn";
  ccBtn.textContent = "CC";
  ccBtn.title = "Toggle English Subtitles (Shortcut: C)";

  const dlBtn = document.createElement("button");
  dlBtn.type = "button";
  dlBtn.className = "igcc-btn igcc-btn-dl";
  dlBtn.textContent = "⬇";
  dlBtn.title = "Download English TXT Transcript";

  controls.appendChild(ccBtn);
  controls.appendChild(dlBtn);

  const overlay = document.createElement("div");
  overlay.className = "igcc-overlay igcc-hidden";
  stopEvents(overlay);

  const captionSpan = document.createElement("span");
  captionSpan.className = "igcc-caption-text";
  overlay.appendChild(captionSpan);

  document.body.appendChild(controls);
  document.body.appendChild(overlay);

  function showToast(text, durationMs = 0) {
    toastText = text;
    if (toastTimer) clearTimeout(toastTimer);
    if (durationMs > 0) {
      toastTimer = setTimeout(() => {
        toastText = "";
        renderUI();
      }, durationMs);
    }
    renderUI();
  }

  function pickPrimaryVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best = null;
    let bestScore = 0;

    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width < 180 || r.height < 180) continue;
      const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const area = visW * visH;
      if (area < 30000) continue;
      const inDialog = typeof v.closest === "function" && Boolean(v.closest('[role="dialog"], dialog'));
      const score = area * (v.paused ? 1 : 3) * (inDialog ? 10 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function updateCaptionOnly() {
    if (!currentVideo || !currentVideoKey) return;
    if (toastText) {
      captionSpan.textContent = toastText;
      overlay.classList.remove("igcc-hidden");
      return;
    }
    const state = getKeyState(currentVideoKey);
    if (state.enabled && state.data) {
      const txt = findSegment(state.data.segments, currentVideo.currentTime);
      if (txt) {
        captionSpan.textContent = txt;
        overlay.classList.remove("igcc-hidden");
      } else {
        overlay.classList.add("igcc-hidden");
      }
    } else {
      overlay.classList.add("igcc-hidden");
    }
  }

  function bindVideoEvents(v) {
    if (boundVideoForEvents === v) return;
    if (boundVideoForEvents) {
      boundVideoForEvents.removeEventListener("timeupdate", updateCaptionOnly);
      boundVideoForEvents.removeEventListener("seeked", updateCaptionOnly);
    }
    boundVideoForEvents = v;
    if (v) {
      v.addEventListener("timeupdate", updateCaptionOnly);
      v.addEventListener("seeked", updateCaptionOnly);
    }
  }

  function renderUI() {
    if (document.hidden) return;

    const v = pickPrimaryVideo();
    const vKey = getVideoIdentity(v);

    if (vKey !== currentVideoKey) {
      toastText = "";
      currentVideoKey = vKey;
    }
    currentVideo = v;
    bindVideoEvents(v);

    if (!v || !vKey) {
      controls.classList.add("igcc-hidden");
      overlay.classList.add("igcc-hidden");
      return;
    }

    const r = v.getBoundingClientRect();
    const state = getKeyState(vKey);

    controls.style.top = `${Math.max(10, Math.round(r.top + 12))}px`;
    controls.style.left = `${Math.max(10, Math.round(r.right - 92))}px`;
    controls.classList.remove("igcc-hidden");

    ccBtn.textContent = state.loading ? "CC…" : "CC";
    ccBtn.classList.toggle("igcc-loading", state.loading);
    ccBtn.classList.toggle("igcc-active", state.enabled);

    const centerX = Math.round(r.left + r.width / 2);
    const bottomY = Math.min(window.innerHeight - 24, Math.round(r.bottom - 58));
    overlay.style.left = `${centerX}px`;
    overlay.style.top = `${Math.max(60, bottomY)}px`;
    overlay.style.maxWidth = `${Math.max(220, Math.round(r.width * 0.88))}px`;

    updateCaptionOnly();
  }

  async function ensureTranscribed(video) {
    // 1. Try exact shortcode / direct HTTP binding first (never let background-prefetched ads hijack it)
    let resolved = resolveCandidates(video, { allowPathSniff: false });

    // 2. If we have a shortcode (e.g. Likes / Activity modal), fetch that exact post's manifest directly
    if (!resolved) {
      const fallbackCode = extractShortcodeFromVideo(video);
      if (fallbackCode) {
        showToast("Locating audio stream…");
        const fetchedUrls = await fetchShortcodeFallback(fallbackCode);
        if (fetchedUrls.length > 0) {
          resolved = {
            candidates: fetchedUrls,
            videoKey: `sc:${fallbackCode}`,
            shortcode: fallbackCode,
          };
        }
      }
    }

    // 3. Only if no shortcode exists at all (anonymous modal video), fall back to live CDN audio sniff
    if (!resolved && !extractShortcodeFromVideo(video)) {
      resolved = resolveCandidates(video, { allowPathSniff: true });
    }

    if (!resolved) {
      throw new Error("Could not bind this video's audio stream yet. Play the video for 1 second or refresh once, then click CC.");
    }
    const state = getKeyState(resolved.videoKey);
    if (state.data) return { data: state.data, shortcode: resolved.shortcode, videoKey: resolved.videoKey };

    if (subtitleCache.has(resolved.videoKey)) {
      state.data = subtitleCache.get(resolved.videoKey);
      return { data: state.data, shortcode: resolved.shortcode, videoKey: resolved.videoKey };
    }

    state.loading = true;
    showToast("Generating English subtitles…");

    try {
      const res = await chrome.runtime.sendMessage({
        type: "IG_CC_TRANSCRIBE_CANDIDATES",
        candidates: resolved.candidates,
        videoKey: resolved.videoKey,
      });
      if (!res || !res.ok) {
        throw new Error((res && res.error) || "Transcription failed. Click the IG English CC icon to check your Groq API key.");
      }
      setBounded(subtitleCache, resolved.videoKey, res);
      state.data = res;
      toastText = "";
      return { data: res, shortcode: resolved.shortcode, videoKey: resolved.videoKey };
    } finally {
      state.loading = false;
      renderUI();
    }
  }

  async function toggleCC() {
    const v = currentVideo || pickPrimaryVideo();
    const vKey = getVideoIdentity(v);
    if (!v || !vKey) return;
    const state = getKeyState(vKey);
    if (state.loading) return;

    if (state.enabled) {
      state.enabled = false;
      toastText = "";
      renderUI();
      return;
    }
    try {
      const res = await ensureTranscribed(v);
      const targetState = getKeyState(res.videoKey);
      targetState.enabled = true;
      state.enabled = true;
      state.data = res.data;
      renderUI();
    } catch (err) {
      showToast(`CC Error: ${err.message}`, 4500);
    }
  }

  async function downloadTxt() {
    const v = currentVideo || pickPrimaryVideo();
    const vKey = getVideoIdentity(v);
    if (!v || !vKey) return;
    const state = getKeyState(vKey);
    if (state.loading) return;

    try {
      const { data, shortcode } = await ensureTranscribed(v);
      const code = shortcode || `ig_${Date.now()}`;
      const plainText =
        (Array.isArray(data.segments) && data.segments.length > 0
          ? data.segments.map((s) => String(s.text || "").trim()).filter(Boolean).join("\n")
          : String(data.text || "").trim()) + "\n";
      triggerDownload(`${code}_en.txt`, plainText);
      dlBtn.textContent = "✓";
      setTimeout(() => {
        dlBtn.textContent = "⬇";
      }, 1500);
    } catch (err) {
      showToast(`Download Error: ${err.message}`, 4500);
    }
  }

  ccBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCC();
  });

  dlBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadTxt();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "c" && e.key !== "C") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
    if (currentVideo || pickPrimaryVideo()) {
      e.preventDefault();
      toggleCC();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderUI();
  });

  // Expose internal helpers for automated testing
  window.__igccTestAPI = {
    setBounded,
    MAX_CACHE_ENTRIES,
    recordMedia,
    recordCdnSniff,
    getVideoIdentity,
    resolveCandidates,
    getKeyState,
    shortcodeMap,
    pathnameCdnMap,
    subtitleCache,
    keyStates,
  };

  setInterval(renderUI, 200);
  window.addEventListener("scroll", renderUI, { passive: true, capture: true });
  window.addEventListener("resize", renderUI, { passive: true });
  renderUI();
})();
