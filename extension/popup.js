"use strict";

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

const keysInput = document.getElementById("keysInput");
const geminiKeyInput = document.getElementById("geminiKeyInput");
const geminiModelInput = document.getElementById("geminiModelInput");
const saveBtn = document.getElementById("saveBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const statusEl = document.getElementById("status");

function parseKeys(raw) {
  return raw
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

chrome.storage.local.get(["groqKeys", "geminiApiKey", "geminiModel"], (res) => {
  const keys = Array.isArray(res.groqKeys) ? res.groqKeys : [];
  keysInput.value = keys.join("\n");
  geminiKeyInput.value = typeof res.geminiApiKey === "string" ? res.geminiApiKey : "";
  geminiModelInput.value =
    typeof res.geminiModel === "string" && res.geminiModel.trim()
      ? res.geminiModel.trim()
      : DEFAULT_GEMINI_MODEL;

  const parts = [];
  if (keys.length > 0) parts.push(`${keys.length} Groq key(s)`);
  if (geminiKeyInput.value.trim()) parts.push(`Gemini (${geminiModelInput.value})`);
  if (parts.length > 0) {
    statusEl.textContent = `Ready: ${parts.join(" + ")}`;
  }
});

saveBtn.addEventListener("click", () => {
  const keys = parseKeys(keysInput.value);
  const geminiApiKey = geminiKeyInput.value.trim();
  const geminiModel = geminiModelInput.value.trim() || DEFAULT_GEMINI_MODEL;

  chrome.storage.local.set({ groqKeys: keys, geminiApiKey, geminiModel }, () => {
    statusEl.style.color = keys.length > 0 ? "#4ade80" : "#facc15";
    const summary = [];
    if (keys.length > 0) summary.push(`${keys.length} Groq key(s)`);
    if (geminiApiKey) summary.push(`Gemini (${geminiModel})`);
    statusEl.textContent =
      summary.length > 0
        ? `Saved: ${summary.join(" + ")}.`
        : "Saved. Paste a Groq key to enable CC.";
  });
});

clearCacheBtn.addEventListener("click", () => {
  chrome.storage.local.set({ subtitleCacheV2: {}, subtitleCacheV3: {}, studyCacheV1: {} }, () => {
    statusEl.style.color = "#60a5fa";
    statusEl.textContent = "Subtitle & study card cache cleared.";
  });
});
