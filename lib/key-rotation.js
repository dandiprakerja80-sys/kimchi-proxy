/**
 * Key rotation manager for Kimchi proxy.
 * Handles multiple API keys with round-robin selection and cooldown tracking.
 */

// In-memory cooldown tracking (shared across function invocations in Vercel)
const keyCooldowns = new Map();
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Parse API keys from comma-separated string.
 * Format: "apikey1,apikey2,apikey3" or "apikey1 apikey2 apikey3"
 */
function parseKeys(raw) {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Select an API key with round-robin selection and cooldown awareness.
 */
function selectKey(config, preferredIndex, contextHash) {
  const { keys, defaultKeyIndex = 0 } = config;
  if (keys.length === 0) {
    throw new Error("No API keys configured");
  }
  if (keys.length === 1) {
    return { key: keys[0], index: 0, totalKeys: 1 };
  }

  if (preferredIndex !== undefined && preferredIndex >= 0 && preferredIndex < keys.length) {
    return { key: keys[preferredIndex], index: preferredIndex, totalKeys: keys.length };
  }

  let idx;
  if (contextHash) {
    let hash = 0;
    for (let i = 0; i < contextHash.length; i++) {
      hash = (hash * 31 + contextHash.charCodeAt(i)) >>> 0;
    }
    idx = hash % keys.length;
  } else {
    idx = (defaultKeyIndex + Math.floor(Math.random() * keys.length)) % keys.length;
  }

  let attempts = 0;
  while (keyCooldowns.has(keys[idx]) && attempts < keys.length) {
    idx = (idx + 1) % keys.length;
    attempts++;
  }

  if (attempts >= keys.length) {
    let soonestIdx = 0;
    let soonestTime = Infinity;
    for (let i = 0; i < keys.length; i++) {
      const cooldownEnd = keyCooldowns.get(keys[i]) || 0;
      if (cooldownEnd < soonestTime) {
        soonestTime = cooldownEnd;
        soonestIdx = i;
      }
    }
    idx = soonestIdx;
  }

  return { key: keys[idx], index: idx, totalKeys: keys.length };
}

function throttleKey(key) {
  keyCooldowns.set(key, Date.now() + COOLDOWN_MS);
}

function isKeyThrottled(key) {
  const cooldownEnd = keyCooldowns.get(key);
  if (!cooldownEnd) return false;
  if (Date.now() > cooldownEnd) {
    keyCooldowns.delete(key);
    return false;
  }
  return true;
}

function getKeyStatus(config) {
  return config.keys.map((key, index) => ({
    index,
    key: key.substring(0, 8) + "...",
    throttled: isKeyThrottled(key),
  }));
}

module.exports = { parseKeys, selectKey, throttleKey, isKeyThrottled, getKeyStatus };
