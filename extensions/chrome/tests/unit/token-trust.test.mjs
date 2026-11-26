/* global Buffer */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isTrustedSiteUrl, isTrustedRelayUrl } from '../../../shared/utils/trust.js';
import {
  isAcceptableToken,
  purgeUntrustedTokens,
  getUserInfoFromStorage
} from '../../../shared/utils/jwt.js';

const RELAY = 'wss://mcp-for-chrome.railsblueprint.com/relay/extension';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;

function makeToken(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    api: { storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        },
        async set(obj) { Object.assign(data, obj); },
        async remove(keys) { for (const k of keys) delete data[k]; }
      }
    } }
  };
}

// The module logs rejected tokens; keep test output readable
console.error = () => {};

describe('isTrustedSiteUrl', () => {
  test('accepts our login pages', () => {
    assert.equal(isTrustedSiteUrl('https://mcp-for-chrome.railsblueprint.com/extension/login/success'), true);
    assert.equal(isTrustedSiteUrl('https://mcp-for-firefox.railsblueprint.com/'), true);
  });

  test('rejects other sites and lookalikes', () => {
    for (const url of [
      'https://evil.example/',
      'http://mcp-for-chrome.railsblueprint.com/',
      'https://mcp-for-chrome.railsblueprint.com.evil.example/',
      'https://evil-mcp-for-chrome.railsblueprint.com/',
      'https://railsblueprint.com/',
      'https://mcp-for-chrome.railsblueprint.com:8443/',
      'https://user@mcp-for-chrome.railsblueprint.com/',
      'data:text/html,<div>',
      'not a url',
      undefined,
      null,
      ''
    ]) {
      assert.equal(isTrustedSiteUrl(url), false, String(url));
    }
  });
});

describe('isTrustedRelayUrl', () => {
  test('accepts the production relay endpoint', () => {
    assert.equal(isTrustedRelayUrl(RELAY), true);
  });

  test('rejects attacker relays and variants', () => {
    for (const url of [
      'wss://attacker.example/relay/extension',
      'ws://mcp-for-chrome.railsblueprint.com/relay/extension',
      'wss://mcp-for-chrome.railsblueprint.com.attacker.example/relay/extension',
      'wss://mcp-for-chrome.railsblueprint.com:444/relay/extension',
      'wss://mcp-for-chrome.railsblueprint.com/other',
      'https://mcp-for-chrome.railsblueprint.com/relay/extension',
      'ws://127.0.0.1:5555/extension',
      42,
      null
    ]) {
      assert.equal(isTrustedRelayUrl(url), false, String(url));
    }
  });
});

describe('isAcceptableToken', () => {
  test('accepts tokens with trusted or no connection_url', () => {
    assert.equal(isAcceptableToken(makeToken({ sub: 'u', exp: FAR_FUTURE, connection_url: RELAY })), true);
    assert.equal(isAcceptableToken(makeToken({ sub: 'u', exp: FAR_FUTURE })), true);
  });

  test('rejects planted tokens and garbage', () => {
    assert.equal(isAcceptableToken(makeToken({ sub: 'u', exp: FAR_FUTURE, connection_url: 'wss://attacker.example/x' })), false);
    assert.equal(isAcceptableToken('not.a.jwt'), false);
    assert.equal(isAcceptableToken('abc'), false);
    assert.equal(isAcceptableToken(undefined), false);
  });
});

describe('getUserInfoFromStorage', () => {
  test('returns trusted relay URL', async () => {
    const token = makeToken({ sub: 'u', exp: FAR_FUTURE, connection_url: RELAY });
    const { api } = makeStorage({ accessToken: token, refreshToken: token });
    const info = await getUserInfoFromStorage(api);
    assert.equal(info.connectionUrl, RELAY);
  });

  test('refuses and clears a planted token instead of connecting to it', async () => {
    const token = makeToken({ sub: 'u', exp: FAR_FUTURE, connection_url: 'wss://attacker.example/relay/extension' });
    const { api, data } = makeStorage({ accessToken: token, refreshToken: token, isPro: true });
    assert.equal(await getUserInfoFromStorage(api), null);
    assert.deepEqual(data, {});
  });
});

describe('purgeUntrustedTokens', () => {
  test('keeps legitimate tokens', async () => {
    const token = makeToken({ sub: 'u', exp: FAR_FUTURE, connection_url: RELAY });
    const { api, data } = makeStorage({ accessToken: token, refreshToken: token, isPro: true, mcpPort: '5555' });
    assert.equal(await purgeUntrustedTokens(api), false);
    assert.equal(data.accessToken, token);
  });

  test('removes planted tokens but keeps other settings', async () => {
    const good = makeToken({ sub: 'u', exp: FAR_FUTURE, connection_url: RELAY });
    const bad = makeToken({ sub: 'u', exp: FAR_FUTURE, connection_url: 'wss://attacker.example/relay/extension' });
    const { api, data } = makeStorage({ accessToken: good, refreshToken: bad, isPro: true, mcpPort: '5555' });
    assert.equal(await purgeUntrustedTokens(api), true);
    assert.deepEqual(data, { mcpPort: '5555' });
  });

  test('does nothing when no tokens are stored', async () => {
    const { api } = makeStorage({ mcpPort: '5555' });
    assert.equal(await purgeUntrustedTokens(api), false);
  });
});
