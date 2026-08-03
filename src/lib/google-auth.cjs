'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { expandHome, fetchJson } = require('./common.cjs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const READ_SCOPE = 'https://www.googleapis.com/auth/monitoring.read';
const ASSERTION_TTL_SECONDS = 3600;
const RENEW_MARGIN_MS = 5 * 60 * 1000;

const tokenCache = new Map();

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function readServiceAccount(credentialsFile) {
  const filePath = expandHome(credentialsFile);
  if (!filePath) throw new Error('没有配置 credentialsFile');
  if (!fs.existsSync(filePath)) throw new Error('没有找到服务账号密钥文件');
  let account;
  try {
    account = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('服务账号密钥文件不是合法 JSON');
  }
  if (account.type !== 'service_account') {
    throw new Error('该文件不是服务账号密钥（type 不是 service_account）');
  }
  if (!account.client_email || !account.private_key) {
    throw new Error('服务账号密钥文件缺少 client_email 或 private_key');
  }
  return account;
}

function signAssertion(account, scope, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope,
    aud: account.token_uri || TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

async function getAccessToken(credentialsFile, scope = READ_SCOPE) {
  const cacheKey = `${expandHome(credentialsFile)}::${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) return cached.token;

  const account = readServiceAccount(credentialsFile);
  const assertion = signAssertion(account, scope, Math.floor(Date.now() / 1000));
  const payload = await fetchJson(account.token_uri || TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString(),
  });

  const token = String((payload && payload.access_token) || '').trim();
  if (!token) throw new Error('令牌响应缺少 access_token');
  const ttlSeconds = Number(payload.expires_in) || ASSERTION_TTL_SECONDS;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttlSeconds * 1000 });
  return token;
}

function clearTokenCache() {
  tokenCache.clear();
}

module.exports = {
  READ_SCOPE,
  base64url,
  clearTokenCache,
  getAccessToken,
  readServiceAccount,
  signAssertion,
};
