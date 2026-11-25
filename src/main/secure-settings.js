function clone(value) {
  return value == null ? value : structuredClone(value);
}

function splitSettingsSecrets(settings) {
  const safe = clone(settings || {});
  const secrets = {};
  if (safe.ai && typeof safe.ai === 'object') {
    if (typeof safe.ai.apiKey === 'string' && safe.ai.apiKey) {
      secrets.aiApiKey = safe.ai.apiKey;
      safe.ai.apiKey = '';
    }
    if (Array.isArray(safe.ai.customHeaders)) {
      const values = safe.ai.customHeaders.map((header) => typeof header?.value === 'string' ? header.value : '');
      if (values.some(Boolean)) {
        secrets.aiCustomHeaderValues = values;
        safe.ai.customHeaders = safe.ai.customHeaders.map((header) => ({ ...header, value: '' }));
      }
    }
  }
  if (safe.tts && typeof safe.tts === 'object' && safe.tts.keys && typeof safe.tts.keys === 'object') {
    const keys = clone(safe.tts.keys);
    if (Object.values(keys).some((value) => typeof value === 'string' && value)) {
      secrets.ttsKeys = keys;
      safe.tts.keys = {};
    }
  }
  return { settings: safe, secrets };
}

function mergeSecretSettings(settings, secrets) {
  const merged = clone(settings || {});
  const secure = secrets && typeof secrets === 'object' ? secrets : {};
  if (typeof secure.aiApiKey === 'string') {
    merged.ai = { ...(merged.ai || {}), apiKey: secure.aiApiKey };
  }
  if (Array.isArray(secure.aiCustomHeaderValues) && Array.isArray(merged.ai?.customHeaders)
    && secure.aiCustomHeaderValues.length === merged.ai.customHeaders.length) {
    merged.ai.customHeaders = merged.ai.customHeaders.map((header, index) => ({
      ...header,
      value: typeof secure.aiCustomHeaderValues[index] === 'string' ? secure.aiCustomHeaderValues[index] : '',
    }));
  }
  if (secure.ttsKeys && typeof secure.ttsKeys === 'object') {
    merged.tts = { ...(merged.tts || {}), keys: clone(secure.ttsKeys) };
  }
  return merged;
}

function hasPlaintextSecrets(settings) {
  return Object.keys(splitSettingsSecrets(settings).secrets).length > 0;
}

function sealSettingsFile(file, { encryptString, isEncryptionAvailable = () => true } = {}) {
  const sealed = clone(file || {});
  const { settings, secrets } = splitSettingsSecrets(sealed.settings || {});
  sealed.settings = settings;
  delete sealed.secure;
  if (Object.keys(secrets).length && isEncryptionAvailable() && typeof encryptString === 'function') {
    try {
      const encrypted = encryptString(JSON.stringify(secrets));
      sealed.secure = Buffer.isBuffer(encrypted)
        ? encrypted.toString('base64')
        : Buffer.from(String(encrypted), 'utf8').toString('base64');
    } catch {
      delete sealed.secure;
    }
  }
  return sealed;
}

function openSettingsFile(file, { decryptString, isEncryptionAvailable = () => true } = {}) {
  const opened = clone(file || {});
  if (!opened.secure) return opened;
  if (!isEncryptionAvailable() || typeof decryptString !== 'function') {
    opened.settings = splitSettingsSecrets(opened.settings || {}).settings;
    delete opened.secure;
    return opened;
  }
  try {
    const decrypted = decryptString(Buffer.from(opened.secure, 'base64'));
    const secrets = JSON.parse(Buffer.isBuffer(decrypted) ? decrypted.toString('utf8') : String(decrypted));
    opened.settings = mergeSecretSettings(opened.settings || {}, secrets);
  } catch {
    opened.settings = splitSettingsSecrets(opened.settings || {}).settings;
    delete opened.secure;
  }
  return opened;
}

function migrateSettingsFile(file, options = {}) {
  if (file?.secure) return clone(file || {});
  return hasPlaintextSecrets(file?.settings) ? sealSettingsFile(file, options) : clone(file || {});
}

module.exports = {
  splitSettingsSecrets,
  mergeSecretSettings,
  hasPlaintextSecrets,
  sealSettingsFile,
  openSettingsFile,
  migrateSettingsFile,
};
