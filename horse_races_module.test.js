'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  validateMaxInitData,
  extractPublicPhotoUrl
} = require('./horse_races_module');

const BOT_TOKEN = 'unit-test-token';

function signInitData(entries, token = BOT_TOKEN) {
  const values = new Map(entries);
  const launchParams = [...values.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', Buffer.from('WebAppData', 'utf8'))
    .update(Buffer.from(token, 'utf8'))
    .digest();

  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(Buffer.from(launchParams, 'utf8'))
    .digest('hex');

  return [...values.entries(), ['hash', hash]]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

const currentAuthDate = Math.floor(Date.now() / 1000);
const validRaw = signInitData([
  ['query_id', 'test-query'],
  ['auth_date', String(currentAuthDate)],
  ['user', JSON.stringify({
    id: 149140003,
    first_name: 'Тест',
    last_name: 'Пользователь',
    username: 'tester'
  })]
]);

const valid = validateMaxInitData(validRaw, BOT_TOKEN);
assert.equal(valid.ok, true);
assert.equal(String(valid.data.user.id), '149140003');

const tampered = validateMaxInitData(validRaw.replace('tester', 'attacker'), BOT_TOKEN);
assert.equal(tampered.ok, false);
assert.equal(tampered.code, 'signature_mismatch');

const duplicate = validateMaxInitData(`${validRaw}&hash=abc`, BOT_TOKEN);
assert.equal(duplicate.ok, false);
assert.equal(duplicate.code, 'duplicate_parameter');

const expiredRaw = signInitData([
  ['query_id', 'expired-query'],
  ['auth_date', String(currentAuthDate - 7200)],
  ['user', JSON.stringify({ id: 149140003 })]
]);
const expired = validateMaxInitData(expiredRaw, BOT_TOKEN, { maxAgeSeconds: 3600 });
assert.equal(expired.ok, false);
assert.equal(expired.code, 'init_data_expired');

assert.equal(
  extractPublicPhotoUrl({ payload: { photos: [{ preview_url: 'https://cdn.example.org/photo.jpg' }] } }),
  'https://cdn.example.org/photo.jpg'
);
assert.equal(extractPublicPhotoUrl({ url: 'http://127.0.0.1/private.jpg' }), null);
assert.equal(extractPublicPhotoUrl({ url: 'javascript:alert(1)' }), null);

console.log('✅ horse_races_module tests passed');
