/**
 * JWT utility for browser extensions
 * Provides JWT decoding (without validation) and token management
 *
 * Note: This only decodes JWTs to extract claims. It does NOT validate signatures.
 * Validation happens server-side.
 */

import { isTrustedRelayUrl } from './trust.js';

const API_HOST = 'https://mcp-for-chrome.railsblueprint.com';
const TOKEN_KEYS = ['accessToken', 'refreshToken', 'isPro'];

/**
 * Build user info from a decoded payload.
 * Returns null if the token points at a relay we do not operate:
 * the payload is unverified, so connection_url must be allow-listed.
 */
function userInfoFromPayload(payload) {
  if (!payload) return null;

  const connectionUrl = payload.connection_url || null;
  if (connectionUrl && !isTrustedRelayUrl(connectionUrl)) {
    console.error('[JWT] Rejecting token with untrusted connection_url:', connectionUrl);
    return null;
  }

  return {
    email: payload.email || payload.sub || null,
    sub: payload.sub,
    connectionUrl, // PRO mode relay URL
  };
}

/**
 * Check whether a token may be stored by the extension.
 * Tokens must decode and must not name an untrusted relay.
 */
export function isAcceptableToken(token) {
  if (typeof token !== 'string') return false;
  return userInfoFromPayload(decodeJWT(token)) !== null;
}

/**
 * Remove stored tokens that point at an untrusted relay.
 * Run on startup to clean up tokens planted by older versions.
 * @returns {Promise<boolean>} True if tokens were removed
 */
export async function purgeUntrustedTokens(browserAPI) {
  const result = await browserAPI.storage.local.get(['accessToken', 'refreshToken']);
  const stored = [result.accessToken, result.refreshToken].filter(Boolean);
  if (stored.length === 0) return false;

  if (stored.every(isAcceptableToken)) return false;

  console.error('[JWT] Stored tokens failed validation, clearing them');
  await browserAPI.storage.local.remove(TOKEN_KEYS);
  return true;
}

/**
 * Decode a JWT token and extract the payload
 * @param {string} token - JWT token to decode
 * @returns {object|null} Decoded payload or null if invalid
 */
export function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Decode the payload (second part)
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch (e) {
    console.error('[JWT] Failed to decode JWT:', e.message);
    return null;
  }
}

/**
 * Get user info from stored JWT in browser storage
 * Automatically refreshes expired tokens using refresh token
 * @param {object} browserAPI - Browser API (chrome or browser)
 * @returns {Promise<object|null>} User info or null
 */
export async function getUserInfoFromStorage(browserAPI) {
  const result = await browserAPI.storage.local.get(['accessToken', 'refreshToken']);

  if (!result.accessToken) {
    return null;
  }

  // Check if token is expired BEFORE using it
  if (isTokenExpired(result.accessToken)) {
    console.log('[JWT] Access token expired, attempting refresh...');

    if (!result.refreshToken) {
      console.log('[JWT] No refresh token available, cannot refresh');
      return null;
    }

    try {
      // Call OAuth API directly to get new tokens (same way server does)
      const newTokens = await refreshAccessToken(result.refreshToken);

      console.log('[JWT] ✅ Token refreshed successfully');

      // Save new tokens to storage
      await browserAPI.storage.local.set({
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token,
        isPro: true
      });

      // Decode the NEW fresh token
      const info = userInfoFromPayload(decodeJWT(newTokens.access_token));

      if (!info) {
        console.error('[JWT] Refreshed token is invalid');
        await browserAPI.storage.local.remove(TOKEN_KEYS);
        return null;
      }

      return info;

    } catch (error) {
      console.error('[JWT] ❌ Token refresh failed:', error);
      // Clear invalid tokens on refresh failure
      await browserAPI.storage.local.remove(TOKEN_KEYS);
      return null;
    }
  }

  // Token is still valid, decode and return it
  const info = userInfoFromPayload(decodeJWT(result.accessToken));

  if (!info) {
    await browserAPI.storage.local.remove(TOKEN_KEYS);
    return null;
  }

  return info;
}

/**
 * Refresh access token using refresh token
 * @param {string} refreshToken - Refresh token
 * @param {string} apiHost - API host URL (optional, defaults to production)
 * @returns {Promise<object>} New tokens { access_token, refresh_token }
 * @throws {Error} If refresh fails
 */
export async function refreshAccessToken(refreshToken, apiHost = API_HOST) {
  const url = `${apiHost}/api/v1/auth/login`;
  console.log('[JWT] Calling refresh token API:', url);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    const error = await response.text();
    const err = new Error(`Token refresh failed: ${response.status} ${error}`);
    err.status = response.status; // Attach status code for caller to check
    throw err;
  }

  const data = await response.json();
  console.log('[JWT] API response data:', data);

  // Handle JSON:API format (data.attributes) or plain format
  const tokens = data.data?.attributes || data;

  if (!tokens.access_token || !tokens.refresh_token) {
    console.error('[JWT] Response missing tokens. Got:', Object.keys(data));
    throw new Error(`Invalid refresh response: missing tokens. Got keys: ${Object.keys(data).join(', ')}`);
  }

  // Return in expected format
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in
  };
}

/**
 * Check if a token is expired
 * @param {string} token - JWT token to check
 * @returns {boolean} True if expired, false if still valid
 */
export function isTokenExpired(token) {
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) return true;

  // exp is in seconds, Date.now() is in milliseconds
  const now = Math.floor(Date.now() / 1000);
  return payload.exp < now;
}

/**
 * Get token expiry time
 * @param {string} token - JWT token
 * @returns {Date|null} Expiry date or null if invalid
 */
export function getTokenExpiry(token) {
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) return null;

  return new Date(payload.exp * 1000);
}
