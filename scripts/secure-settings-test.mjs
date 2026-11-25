#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  splitSettingsSecrets,
  mergeSecretSettings,
  sealSettingsFile,
  openSettingsFile,
  migrateSettingsFile,
} = require('../src/main/secure-settings.js');

const encryptString = (value) => Buffer.from(`encrypted:${value}`, 'utf8');
const decryptString = (value) => Buffer.from(value).toString('utf8').replace(/^encrypted:/, '');
const options = { encryptString, decryptString, isEncryptionAvailable: () => true };

function legacyFile() {
  return {
    settings: {
      theme: 'dark',
      ai: {
        provider: 'openrouter',
        apiKey: 'sk-test-super-secret',
        customHeaders: [
          { name: 'Authorization', value: 'Bearer custom-secret', enabled: true },
          { name: 'X-Title', value: 'AiPDF Editor', enabled: true },
        ],
      },
      tts: { keys: { elevenlabs: 'eleven-secret', fish: 'fish-secret' }, provider: 'elevenlabs' },
    },
    recents: [{ path: 'C:\\docs\\contract.pdf', name: 'contract.pdf' }],
  };
}

test('secret extraction removes AI keys, custom header values, and TTS keys from persisted settings', () => {
  const { settings, secrets } = splitSettingsSecrets(legacyFile().settings);
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.ai.provider, 'openrouter');
  assert.equal(settings.ai.apiKey, '');
  assert.deepEqual(settings.ai.customHeaders, [
    { name: 'Authorization', value: '', enabled: true },
    { name: 'X-Title', value: '', enabled: true },
  ]);
  assert.deepEqual(settings.tts.keys, {});
  assert.equal(secrets.aiApiKey, 'sk-test-super-secret');
  assert.deepEqual(secrets.aiCustomHeaderValues, ['Bearer custom-secret', 'AiPDF Editor']);
  assert.deepEqual(secrets.ttsKeys, { elevenlabs: 'eleven-secret', fish: 'fish-secret' });
  const persisted = JSON.stringify(settings);
  for (const secret of ['sk-test-super-secret', 'custom-secret', 'eleven-secret', 'fish-secret']) {
    assert.equal(persisted.includes(secret), false);
  }
});

test('secret merge restores the complete original settings without mutating inputs', () => {
  const original = legacyFile().settings;
  const { settings, secrets } = splitSettingsSecrets(original);
  const restored = mergeSecretSettings(settings, secrets);
  assert.deepEqual(restored, original);
  assert.equal(original.ai.apiKey, 'sk-test-super-secret');
  assert.equal(settings.ai.apiKey, '');
});

test('sealed settings files contain ciphertext only and reopen with all secrets restored', () => {
  const sealed = sealSettingsFile(legacyFile(), options);
  assert.equal(sealed.settings.ai.apiKey, '');
  assert.deepEqual(sealed.settings.tts.keys, {});
  assert.equal(typeof sealed.secure, 'string');
  assert.equal(sealed.secure.length > 20, true);
  const persisted = JSON.stringify(sealed);
  for (const secret of ['sk-test-super-secret', 'custom-secret', 'eleven-secret', 'fish-secret']) {
    assert.equal(persisted.includes(secret), false);
  }
  const opened = openSettingsFile(sealed, options);
  assert.deepEqual(opened.settings, legacyFile().settings);
  assert.deepEqual(opened.recents, legacyFile().recents);
});

test('legacy plaintext settings migrate to encrypted storage on load', () => {
  const migrated = migrateSettingsFile(legacyFile(), options);
  assert.equal(migrated.settings.ai.apiKey, '');
  assert.equal(typeof migrated.secure, 'string');
  assert.equal(openSettingsFile(migrated, options).settings.ai.apiKey, 'sk-test-super-secret');
});

test('unavailable encryption strips secrets instead of writing plaintext', () => {
  const sealed = sealSettingsFile(legacyFile(), { ...options, isEncryptionAvailable: () => false });
  assert.equal(sealed.settings.ai.apiKey, '');
  assert.deepEqual(sealed.settings.tts.keys, {});
  assert.equal('secure' in sealed, false);
  const persisted = JSON.stringify(sealed);
  assert.equal(persisted.includes('sk-test-super-secret'), false);
});

test('encryption failure strips secrets instead of aborting or persisting plaintext', () => {
  const sealed = sealSettingsFile(legacyFile(), {
    ...options,
    encryptString: () => { throw new Error('SIMULATED OS KEYSTONE FAILURE'); },
  });
  assert.equal(sealed.settings.ai.apiKey, '');
  assert.deepEqual(sealed.settings.tts.keys, {});
  assert.equal('secure' in sealed, false);
  assert.equal(JSON.stringify(sealed).includes('sk-test-super-secret'), false);
});

test('tampered ciphertext fails closed to sanitized settings', () => {
  const sealed = sealSettingsFile(legacyFile(), options);
  sealed.secure = `${sealed.secure.slice(0, -4)}AAAA`;
  const opened = openSettingsFile(sealed, options);
  assert.equal(opened.settings.ai.apiKey, '');
  assert.deepEqual(opened.settings.tts.keys, {});
});
