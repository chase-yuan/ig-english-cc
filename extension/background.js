"use strict";

const LOCAL_API = "http://127.0.0.1:18795";

async function transcribeOne(mediaUrl, videoKey) {
  let resp;
  try {
    const mediaResp = await fetch(mediaUrl);
    if (!mediaResp.ok) throw new Error(`CDN HTTP ${mediaResp.status}`);
    const buf = await mediaResp.arrayBuffer();
    if (buf.byteLength < 1024) throw new Error("Media buffer too small");
    resp = await fetch(`${LOCAL_API}/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Video-Key": videoKey || mediaUrl,
      },
      body: buf,
    });
  } catch (_cdnErr) {
    resp = await fetch(`${LOCAL_API}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_url: mediaUrl, video_key: videoKey || mediaUrl }),
    });
  }
  return await resp.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "IG_CC_HEALTH") {
    fetch(`${LOCAL_API}/health`)
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "IG_CC_TRANSCRIBE_CANDIDATES") {
    const candidates = Array.isArray(msg.candidates) ? msg.candidates : [];
    const videoKey = msg.videoKey || "";
    (async () => {
      let lastError = "No valid audio stream found for this video.";
      for (const mediaUrl of candidates) {
        try {
          const data = await transcribeOne(mediaUrl, videoKey);
          if (data && data.ok) {
            sendResponse(data);
            return;
          }
          lastError = (data && data.error) || lastError;
        } catch (err) {
          lastError = String(err);
        }
      }
      sendResponse({ ok: false, error: lastError });
    })();
    return true;
  }

  return false;
});
