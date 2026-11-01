import * as fs from 'fs';
import { interpolate } from './variables';
import type { KV, RequestDef, ResponseResult } from './types';

const active = (list: KV[]) => list.filter((kv) => kv.enabled && kv.key.trim() !== '');

export function buildUrl(req: RequestDef, vars: Record<string, string>): string {
  let url = interpolate(req.url.trim(), vars);
  const params = active(req.params);
  if (params.length) {
    const qs = params
      .map((p) => `${encodeURIComponent(interpolate(p.key, vars))}=${encodeURIComponent(interpolate(p.value, vars))}`)
      .join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

export async function fetchOAuth2Token(
  cfg: NonNullable<RequestDef['auth']['oauth2']>,
  vars: Record<string, string>,
): Promise<string> {
  const tokenUrl = interpolate(cfg.tokenUrl, vars);
  const clientId = interpolate(cfg.clientId, vars);
  const clientSecret = interpolate(cfg.clientSecret, vars);
  const scope = cfg.scope ? interpolate(cfg.scope, vars) : '';

  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);
  if (scope) params.set('scope', scope);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OAuth2 Client Credentials failed (${res.status}): ${errText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('OAuth2 response did not contain access_token');
  return data.access_token;
}

export async function executeRequest(
  req: RequestDef,
  vars: Record<string, string>,
  timeoutMs = 30000,
): Promise<ResponseResult> {
  let resolvedUrl = buildUrl(req, vars);
  const headers = new Headers();
  for (const h of active(req.headers)) {
    headers.set(interpolate(h.key, vars), interpolate(h.value, vars));
  }

  if (req.auth.type === 'bearer' && req.auth.token) {
    headers.set('Authorization', `Bearer ${interpolate(req.auth.token, vars)}`);
  } else if (req.auth.type === 'basic') {
    const raw = `${interpolate(req.auth.username, vars)}:${interpolate(req.auth.password, vars)}`;
    headers.set('Authorization', `Basic ${Buffer.from(raw).toString('base64')}`);
  } else if (req.auth.type === 'apikey') {
    const keyName = interpolate(req.auth.apiKeyName || 'X-API-Key', vars);
    const keyValue = interpolate(req.auth.apiKeyValue || '', vars);
    if (req.auth.apiKeyIn === 'query') {
      const sep = resolvedUrl.includes('?') ? '&' : '?';
      resolvedUrl += `${sep}${encodeURIComponent(keyName)}=${encodeURIComponent(keyValue)}`;
    } else {
      headers.set(keyName, keyValue);
    }
  } else if (req.auth.type === 'oauth2_cc' && req.auth.oauth2) {
    // If access_token is already in vars, reuse it, otherwise fetch automatically
    let token = vars.access_token;
    if (!token && req.auth.oauth2.autoFetch !== false) {
      try {
        token = await fetchOAuth2Token(req.auth.oauth2, vars);
        vars.access_token = token;
      } catch (e) {
        return {
          ok: false,
          status: 0,
          statusText: '',
          durationMs: 0,
          sizeBytes: 0,
          headers: {},
          body: '',
          error: (e as Error).message,
          resolvedUrl,
        };
      }
    }
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  let body: BodyInit | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.body.type === 'file' && req.body.filePath) {
      const resolvedPath = interpolate(req.body.filePath, vars);
      if (fs.existsSync(resolvedPath)) {
        body = fs.readFileSync(resolvedPath);
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
      } else {
        return {
          ok: false,
          status: 0,
          statusText: '',
          durationMs: 0,
          sizeBytes: 0,
          headers: {},
          body: '',
          error: `File not found: ${resolvedPath}`,
          resolvedUrl,
        };
      }
    } else if (req.body.type === 'json') {
      body = interpolate(req.body.content, vars);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    } else if (req.body.type === 'text') {
      body = interpolate(req.body.content, vars);
    } else if (req.body.type === 'form') {
      const lines = interpolate(req.body.content, vars)
        .split(/\r?\n/)
        .filter((l) => l.includes('='));
      body = lines
        .map((l) => {
          const i = l.indexOf('=');
          return `${encodeURIComponent(l.slice(0, i).trim())}=${encodeURIComponent(l.slice(i + 1).trim())}`;
        })
        .join('&');
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded');
    }
  }

  const started = performance.now();
  try {
    const res = await fetch(resolvedUrl, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (resHeaders[k] = v));
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      durationMs: Math.round(performance.now() - started),
      sizeBytes: buf.length,
      headers: resHeaders,
      body: buf.toString('utf8'),
      resolvedUrl,
    };
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return {
      ok: false,
      status: 0,
      statusText: '',
      durationMs: Math.round(performance.now() - started),
      sizeBytes: 0,
      headers: {},
      body: '',
      error: err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message,
      resolvedUrl,
    };
  }
}

