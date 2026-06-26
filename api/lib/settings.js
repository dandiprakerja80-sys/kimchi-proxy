const SETTINGS_PATHNAME = "kimchi-proxy/settings.json";
const DEFAULT_SETTINGS = {
  cf_enabled: true,
};
const CACHE_TTL_MS = 30000;

let _settings = null;
let _lastLoadAt = 0;

function getBlobClient() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { put, del } = require("@vercel/blob");
    return { put, del };
  } catch (e) {
    console.error("[settings] failed to init blob:", e.message);
    return null;
  }
}

async function loadFromBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { list } = require("@vercel/blob");
    const { blobs } = await list({ prefix: SETTINGS_PATHNAME, limit: 1 });
    const blob = blobs.find((b) => b.pathname === SETTINGS_PATHNAME);
    if (!blob) return null;
    const res = await fetch(blob.url, { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.error("[settings] blob load failed:", e.message);
    return null;
  }
}

async function saveToBlob(payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { put } = require("@vercel/blob");
    await put(SETTINGS_PATHNAME, JSON.stringify(payload), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });
  } catch (e) {
    console.error("[settings] blob save failed:", e.message);
  }
}

async function load() {
  const now = Date.now();
  if (_settings && _lastLoadAt && now - _lastLoadAt < CACHE_TTL_MS) {
    return _settings;
  }

  const blobSettings = await loadFromBlob();
  _settings = blobSettings ? { ...DEFAULT_SETTINGS, ...blobSettings } : { ...DEFAULT_SETTINGS };
  _lastLoadAt = now;
  return _settings;
}

async function getSettings() {
  return load();
}

async function setSettings(partial) {
  const settings = await load();
  Object.assign(settings, partial);
  await saveToBlob(settings);
  _settings = settings;
  _lastLoadAt = Date.now();
  return settings;
}

module.exports = {
  getSettings,
  setSettings,
  DEFAULT_SETTINGS,
};
