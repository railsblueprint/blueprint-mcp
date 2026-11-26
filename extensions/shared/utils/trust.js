/* global URL */
/**
 * Trusted origins for PRO login and relay connections.
 *
 * Tokens handed to the extension are decoded client-side without signature
 * verification, so nothing inside them can be trusted on its own. Every
 * login message and every relay URL must be checked against this list.
 *
 * Keep in sync with TRUSTED_LOGIN_HOSTS in the content scripts
 * (content scripts cannot import ES modules).
 */

export const TRUSTED_HOSTS = Object.freeze([
  'mcp-for-chrome.railsblueprint.com',
  'mcp-for-firefox.railsblueprint.com',
  'mcp-for-edge.railsblueprint.com',
  'mcp-for-safari.railsblueprint.com',
  'mcp-for-brave.railsblueprint.com',
  'blueprint-mcp.railsblueprint.com'
]);

export const RELAY_PATH = '/relay/extension';

function parseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * True if the URL is an https page served by one of our own sites.
 * Used to check sender.url of messages that carry login tokens.
 */
export function isTrustedSiteUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  return url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    TRUSTED_HOSTS.includes(url.hostname);
}

/**
 * True if the URL is a wss relay endpoint on one of our own hosts.
 */
export function isTrustedRelayUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  return url.protocol === 'wss:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === RELAY_PATH &&
    TRUSTED_HOSTS.includes(url.hostname);
}
