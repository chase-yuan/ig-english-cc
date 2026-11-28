"use strict";

const keysInput = document.getElementById("keysInput");
const saveBtn = document.getElementById("saveBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const statusEl = document.getElementById("status");

function parseKeys(raw) {
  return raw
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

chrome.storage.local.get(["groqKeys"], (res) => {
  const keys = Array.isArray(res.groqKeys) ? res.groqKeys : [];
  keysInput.value = keys.join("\n");
  if (keys.length > 0) {
    statusEl.textContent = `${keys.length} key(s) ready.`;
  }
});

saveBtn.addEventListener("click", () => {
  const keys = parseKeys(keysInput.value);
  chrome.storage.local.set({ groqKeys: keys }, () => {
    statusEl.style.color = keys.length > 0 ? "#4ade80" : "#facc15";
    statusEl.textContent =
      keys.length > 0
        ? `Saved ${keys.length} key(s). Reload IG tab if needed.`
        : "Cleared keys. Paste a Groq API key to enable CC.";
  });
});

clearCacheBtn.addEventListener("click", () => {
  chrome.storage.local.set({ subtitleCacheV2: {} }, () => {
    statusEl.style.color = "#60a5fa";
    statusEl.textContent = "Subtitle cache cleared.";
  });
});
