/**
 * Minimal dotenv loader for extension-packaged `.env` files.
 *
 * Notes:
 * - Chrome extensions do not have runtime environment variables.
 * - This is a local-dev convenience for loading keys from a file in the
 *   extension directory (e.g. `.env`) and then seeding chrome.storage.
 */

function stripSurroundingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseDotEnv(text) {
  const env = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = normalized.slice(0, eqIndex).trim();
    const value = stripSurroundingQuotes(normalized.slice(eqIndex + 1).trim());
    if (!key) continue;

    env[key] = value;
  }

  return env;
}

/**
 * Load a dotenv-style file from the extension package (if present).
 * @param {string} path
 * @returns {Promise<Record<string, string> | null>}
 */
export async function loadPackagedDotEnv(path = '.env') {
  try {
    const url = chrome.runtime.getURL(path);
    const response = await fetch(url);
    if (!response.ok) return null;

    const text = await response.text();
    const env = parseDotEnv(text);
    return Object.keys(env).length ? env : null;
  } catch {
    return null;
  }
}

/**
 * Seed API keys into the canonical sync `settings` object (if missing).
 * Does not overwrite existing keys.
 *
 * Supported dotenv keys:
 * - ANTHROPIC_API_KEY
 * - OPENROUTER_API_KEY
 *
 * @param {import('./settings-manager.js').SettingsManager} settingsManager
 * @returns {Promise<{seeded: boolean, source: string | null}>}
 */
export async function seedApiKeysFromDotEnvIfMissing(settingsManager) {
  const env = await loadPackagedDotEnv('.env');
  if (!env) return { seeded: false, source: null };

  const anthropicKey = env.ANTHROPIC_API_KEY || '';
  const openrouterKey = env.OPENROUTER_API_KEY || '';

  if (!anthropicKey && !openrouterKey) return { seeded: false, source: null };

  const current = await settingsManager.getSettings();
  const nextApiKeys = { ...current.apiKeys };

  let changed = false;
  if (!nextApiKeys.anthropic && anthropicKey) {
    nextApiKeys.anthropic = anthropicKey;
    changed = true;
  }
  if (!nextApiKeys.openrouter && openrouterKey) {
    nextApiKeys.openrouter = openrouterKey;
    changed = true;
  }

  if (!changed) return { seeded: false, source: null };

  const result = await settingsManager.updateSettings({ apiKeys: nextApiKeys });
  return { seeded: result.success, source: result.success ? '.env' : null };
}

