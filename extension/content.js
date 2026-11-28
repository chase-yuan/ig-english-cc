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

  const IG_SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function shortcodeToMediaId(shortcode) {
    if (!shortcode || typeof shortcode !== "string") return null;
    // Strip any query/suffix and convert Instagram base64 shortcode -> 64-bit numeric media_id
    const clean = shortcode.trim();
    if (!clean || clean.length > 24) return null;
    try {
      let id = 0n;
      for (let i = 0; i < clean.length; i++) {
        const idx = IG_SHORTCODE_ALPHABET.indexOf(clean[i]);
        if (idx < 0) return null;
        id = id * 64n + BigInt(idx);
      }
      return id.toString();
    } catch {
      return null;
    }
  }

  function probeVideoViaHook(video) {
    if (!video || typeof video.setAttribute !== "function") {
      return Promise.resolve({ audio: [], muxed: [], shortcode: null });
    }
    const reqId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        try {
          video.removeAttribute("data-igcc-probe");
        } catch {}
        resolve(res || { audio: [], muxed: [], shortcode: null });
      };
      const onMsg = (event) => {
        if (event.source !== window || !event.data || event.data.type !== "IG_CC_PROBE_VIDEO_RES") return;
        if (event.data.reqId !== reqId) return;
        finish({
          audio: Array.isArray(event.data.audio) ? event.data.audio : [],
          muxed: Array.isArray(event.data.muxed) ? event.data.muxed : [],
          shortcode: event.data.shortcode || null,
        });
      };
      window.addEventListener("message", onMsg);
      video.setAttribute("data-igcc-probe", reqId);
      window.postMessage({ type: "IG_CC_PROBE_VIDEO_REQ", reqId }, "*");
      setTimeout(() => finish({ audio: [], muxed: [], shortcode: null }), 400);
    });
  }

  // Exact same-origin fetch when opened from Likes / Activity without preloaded manifest (strictly filters by shortcode!)
  async function fetchShortcodeFallback(shortcode) {
    if (!shortcode || typeof fetch !== "function") return [];
    const outAudio = [];
    const outMuxed = [];

    // Strategy A: Official Instagram Web Media Info API (clean JSON for THIS exact media_id, zero ads)
    const mediaId = shortcodeToMediaId(shortcode);
    if (mediaId) {
      try {
        const apiResp = await fetch(`${location.origin}/api/v1/media/${mediaId}/info/`, {
          credentials: "same-origin",
          headers: {
            "x-ig-app-id": "936619743392459",
            "x-requested-with": "XMLHttpRequest",
          },
        });
        if (apiResp.ok) {
          const data = await apiResp.json();
          extractExactShortcodeFromJson(data, shortcode, outAudio, outMuxed, 0, shortcode);
        }
      } catch {}
    }

    // Strategy B: Same-origin SSR HTML fallback
    if (outAudio.length === 0 && outMuxed.length === 0) {
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

  const aiBtn = document.createElement("button");
  aiBtn.type = "button";
  aiBtn.className = "igcc-btn igcc-btn-ai";
  aiBtn.textContent = "AI";
  aiBtn.title = "Mine C1/C2 Phrases & Anki Cards (Shortcut: A)";

  controls.appendChild(ccBtn);
  controls.appendChild(aiBtn);
  controls.appendChild(dlBtn);

  const overlay = document.createElement("div");
  overlay.className = "igcc-overlay igcc-hidden";
  stopEvents(overlay);

  const captionSpan = document.createElement("span");
  captionSpan.className = "igcc-caption-text";
  overlay.appendChild(captionSpan);

  // Right-side Study & Anki Mining Drawer
  const drawer = document.createElement("aside");
  drawer.className = "igcc-drawer igcc-hidden";
  stopEvents(drawer);

  const drawerHeader = document.createElement("div");
  drawerHeader.className = "igcc-drawer-header";
  const drawerTitleWrap = document.createElement("div");
  drawerTitleWrap.className = "igcc-drawer-title-wrap";
  const drawerTitle = document.createElement("span");
  drawerTitle.className = "igcc-drawer-title";
  drawerTitle.textContent = "Study Cards";
  const drawerBadge = document.createElement("span");
  drawerBadge.className = "igcc-drawer-badge";
  drawerBadge.textContent = "Gemini";
  drawerTitleWrap.appendChild(drawerTitle);
  drawerTitleWrap.appendChild(drawerBadge);

  const drawerCloseBtn = document.createElement("button");
  drawerCloseBtn.type = "button";
  drawerCloseBtn.className = "igcc-drawer-close";
  drawerCloseBtn.textContent = "×";
  drawerCloseBtn.title = "Close Study Panel";
  drawerHeader.appendChild(drawerTitleWrap);
  drawerHeader.appendChild(drawerCloseBtn);

  const drawerBody = document.createElement("div");
  drawerBody.className = "igcc-drawer-body";

  const drawerFooter = document.createElement("div");
  drawerFooter.className = "igcc-drawer-footer";
  const copyAllBtn = document.createElement("button");
  copyAllBtn.type = "button";
  copyAllBtn.className = "igcc-footer-btn igcc-footer-primary";
  copyAllBtn.textContent = "Copy Anki CSV";
  const dlCsvBtn = document.createElement("button");
  dlCsvBtn.type = "button";
  dlCsvBtn.className = "igcc-footer-btn igcc-footer-secondary";
  dlCsvBtn.textContent = "Download .csv";
  drawerFooter.appendChild(copyAllBtn);
  drawerFooter.appendChild(dlCsvBtn);

  drawer.appendChild(drawerHeader);
  drawer.appendChild(drawerBody);
  drawer.appendChild(drawerFooter);

  document.body.appendChild(controls);
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  let activeStudyResult = null;
  let activeStudyShortcode = null;

  function formatMmSs(sec) {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  async function copyText(text, btn, doneLabel = "Copied") {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = doneLabel;
      setTimeout(() => {
        btn.textContent = orig;
      }, 1400);
    } catch {}
  }

  function renderStudyDrawer(studyRes, shortcode) {
    activeStudyResult = studyRes;
    activeStudyShortcode = shortcode;
    drawerBadge.textContent = studyRes.model || "AI";
    drawerBody.textContent = "";

    const items = Array.isArray(studyRes.items) ? studyRes.items : [];
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "igcc-drawer-status";
      empty.textContent = "No C1/C2 expressions found in this short clip.";
      drawerBody.appendChild(empty);
      return;
    }

    for (const item of items) {
      const card = document.createElement("div");
      card.className = "igcc-card";

      const head = document.createElement("div");
      head.className = "igcc-card-head";
      const term = document.createElement("span");
      term.className = "igcc-card-term";
      term.textContent = item.term;
      const cat = document.createElement("span");
      cat.className = "igcc-card-cat";
      cat.textContent = item.category || "C1/C2";
      head.appendChild(term);
      head.appendChild(cat);
      card.appendChild(head);

      const meaning = document.createElement("div");
      meaning.className = "igcc-card-meaning";
      meaning.textContent = item.meaning_zh;
      card.appendChild(meaning);

      if (item.nuance_zh) {
        const nuance = document.createElement("div");
        nuance.className = "igcc-card-nuance";
        nuance.textContent = item.nuance_zh;
        card.appendChild(nuance);
      }

      if (item.quote) {
        const qRow = document.createElement("div");
        qRow.className = "igcc-card-quote-row";
        const tsBtn = document.createElement("button");
        tsBtn.type = "button";
        tsBtn.className = "igcc-ts-btn";
        tsBtn.textContent = formatMmSs(item.timestamp_sec);
        tsBtn.title = "Jump video to this line";
        tsBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const v = currentVideo || pickPrimaryVideo();
          if (v && Number.isFinite(item.timestamp_sec)) {
            v.currentTime = Math.max(0, item.timestamp_sec - 0.3);
            v.play?.().catch?.(() => {});
          }
        });
        const qTxt = document.createElement("span");
        qTxt.className = "igcc-card-quote";
        qTxt.textContent = `“${item.quote}”`;
        qRow.appendChild(tsBtn);
        qRow.appendChild(qTxt);
        card.appendChild(qRow);
      }

      if (item.anki_front && item.anki_back) {
        const ankiBox = document.createElement("div");
        ankiBox.className = "igcc-anki-box";
        const frontDiv = document.createElement("div");
        frontDiv.textContent = item.anki_front.replace(/<br\s*\/?>/gi, " · ");
        const backDiv = document.createElement("div");
        backDiv.className = "igcc-anki-back";
        backDiv.textContent = item.anki_back.replace(/<br\s*\/?>/gi, " — ");
        ankiBox.appendChild(frontDiv);
        ankiBox.appendChild(backDiv);
        card.appendChild(ankiBox);

        const actions = document.createElement("div");
        actions.className = "igcc-card-actions";
        const copyOneBtn = document.createElement("button");
        copyOneBtn.type = "button";
        copyOneBtn.className = "igcc-mini-btn";
        copyOneBtn.textContent = "Copy CSV";
        copyOneBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          copyText(item.csv_line, copyOneBtn, "Copied");
        });
        actions.appendChild(copyOneBtn);
        card.appendChild(actions);
      }

      drawerBody.appendChild(card);
    }
  }

  drawerCloseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drawer.classList.add("igcc-hidden");
  });

  copyAllBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeStudyResult && activeStudyResult.csv) {
      copyText(activeStudyResult.csv, copyAllBtn, "Copied All");
    }
  });

  dlCsvBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeStudyResult && activeStudyResult.csv) {
      const code = activeStudyShortcode || `ig_${Date.now()}`;
      triggerDownload(`${code}_anki.csv`, activeStudyResult.csv);
    }
  });

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
    controls.style.left = `${Math.max(10, Math.round(r.right - 134))}px`;
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

    // 2. Inspect THIS exact <video> DOM node's React Fiber props in MAIN world (instant, 1-to-1 bound, zero ads)
    let probedShortcode = null;
    if (!resolved) {
      const probed = await probeVideoViaHook(video);
      probedShortcode = probed.shortcode || null;
      const fiberUrls = [...probed.audio, ...probed.muxed];
      if (fiberUrls.length > 0) {
        const sc = extractShortcodeFromVideo(video) || probedShortcode;
        if (sc) {
          probed.audio.forEach((u) => recordMedia(u, "audio", sc));
          probed.muxed.forEach((u) => recordMedia(u, "muxed", sc));
        }
        resolved = {
          candidates: fiberUrls,
          videoKey: sc ? `sc:${sc}` : `src:${fiberUrls[0]}`,
          shortcode: sc,
        };
      }
    }

    // 3. If we have a shortcode (from URL, modal dialog, or React Fiber), fetch via official IG Media Info API
    if (!resolved) {
      const fallbackCode = extractShortcodeFromVideo(video) || probedShortcode;
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

    // 4. Only if no shortcode exists at all (anonymous modal video), fall back to live CDN audio sniff
    if (!resolved && !extractShortcodeFromVideo(video) && !probedShortcode) {
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

  async function openStudyMiner() {
    const v = currentVideo || pickPrimaryVideo();
    const vKey = getVideoIdentity(v);
    if (!v || !vKey) return;

    drawer.classList.remove("igcc-hidden");
    drawerBadge.textContent = "Analyzing…";
    drawerBody.textContent = "";
    const loadingEl = document.createElement("div");
    loadingEl.className = "igcc-drawer-status";
    loadingEl.textContent = "Transcribing & mining C1/C2 phrases and Anki cards…";
    drawerBody.appendChild(loadingEl);

    try {
      const { data, shortcode, videoKey } = await ensureTranscribed(v);
      const plainText =
        Array.isArray(data.segments) && data.segments.length > 0
          ? data.segments.map((s) => String(s.text || "").trim()).filter(Boolean).join("\n")
          : String(data.text || "").trim();

      const res = await chrome.runtime.sendMessage({
        type: "IG_CC_MINE_CARDS",
        videoKey,
        text: plainText,
        segments: data.segments || [],
      });
      if (!res || !res.ok) {
        throw new Error((res && res.error) || "Card mining failed.");
      }
      renderStudyDrawer(res, shortcode);
    } catch (err) {
      drawerBadge.textContent = "Error";
      drawerBody.textContent = "";
      const errEl = document.createElement("div");
      errEl.className = "igcc-drawer-status";
      errEl.textContent = `Error: ${err.message}`;
      drawerBody.appendChild(errEl);
    }
  }

  ccBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCC();
  });

  aiBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openStudyMiner();
  });

  dlBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadTxt();
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
    if ((e.key === "c" || e.key === "C") && (currentVideo || pickPrimaryVideo())) {
      e.preventDefault();
      toggleCC();
    } else if ((e.key === "a" || e.key === "A") && (currentVideo || pickPrimaryVideo())) {
      e.preventDefault();
      openStudyMiner();
    } else if (e.key === "Escape" && !drawer.classList.contains("igcc-hidden")) {
      drawer.classList.add("igcc-hidden");
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
    shortcodeToMediaId,
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
