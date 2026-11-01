import * as fs from 'fs';
import * as path from 'path';
import { emptyRequest, type Assertion, type AssertOp, type AssertSource, type HttpMethod, type KV, type RequestDef } from './types';
import type { Storage } from './storage';
import type { ImportSummary } from './import';

interface TcTest { type: string; custom?: string; action?: string; value?: string }
interface TcRequest {
  _id: string; containerId?: string; name: string; url: string; method: string; sortNum?: number;
  headers?: { name: string; value: string; isDisabled?: boolean }[];
  params?: { name: string; value: string; isPath?: boolean; isDisabled?: boolean }[];
  body?: { type?: string; raw?: string | string[]; form?: { name: string; value: string; isDisabled?: boolean }[] };
  auth?: { type?: string; bearer?: string; basic?: { username?: string; password?: string } };
  tests?: TcTest[];
}
interface TcFolder { _id: string; name: string; containerId?: string; sortNum?: number }
interface TcCollection { colName: string; folders?: TcFolder[]; requests?: TcRequest[] }
interface TcEnvironment { environmentName: string; variables?: { name: string; value: string }[] }

const OPS: Record<string, AssertOp> = {
  equal: 'eq', notequal: 'neq', contains: 'contains', notcontains: 'notContains',
  '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte', regex: 'matches', isjson: 'exists',
};

/** Thunder paths look like `json.data[0].id`; QAForge paths drop the `json.` prefix. */
const jsonPath = (p: string) => p.replace(/^json\.?/, '');

export function convertTests(tests: TcTest[], name: string, warnings: string[]) {
  const assertions: Assertion[] = [];
  const captures: KV[] = [];
  for (const t of tests) {
    const op = OPS[t.action ?? ''];
    const expected = t.value ?? '';
    const push = (source: AssertSource, p: string) =>
      assertions.push({ enabled: true, source, path: p, op: op ?? 'eq', expected });
    if (t.type === 'set-env-var') {
      const key = (t.custom ?? '').replace(/[{}]/g, '').trim();
      const v = expected.trim();
      if (!key) continue;
      captures.push({
        key,
        enabled: true,
        value: v.startsWith('json.') ? `res.body.${v.slice(5)}` : v === 'header' ? `res.headers['${key}']` : JSON.stringify(v),
      });
    } else if (!op) {
      warnings.push(`${name}: unsupported test action "${t.action}"`);
    } else if (t.type === 'res-code') push('status', '');
    else if (t.type === 'res-time') push('time', '');
    else if (t.type === 'res-header') push('header', t.custom ?? '');
    else if (t.type === 'res-body') push('body', '');
    else if (t.type === 'json-query') push('body', jsonPath(t.custom ?? ''));
    else warnings.push(`${name}: unsupported test type "${t.type}"`);
  }
  return { assertions, captures };
}

export function convertRequest(r: TcRequest, warnings: string[]): RequestDef {
  const req = emptyRequest(r.name);
  req.method = (r.method?.toUpperCase() ?? 'GET') as HttpMethod;
  req.url = r.url ?? '';
  req.headers = (r.headers ?? []).map((h) => ({ key: h.name, value: h.value, enabled: !h.isDisabled }));
  if (!req.url.includes('?')) {
    req.params = (r.params ?? []).filter((p) => !p.isPath).map((p) => ({ key: p.name, value: p.value, enabled: !p.isDisabled }));
  }
  const b = r.body;
  if (b?.type === 'json' || b?.type === 'text' || b?.type === 'xml') {
    const raw = Array.isArray(b.raw) ? b.raw.join('\n') : b.raw ?? '';
    if (raw) req.body = { type: b.type === 'json' ? 'json' : 'text', content: raw };
  } else if (b?.type === 'formencoded') {
    req.body = { type: 'form', content: (b.form ?? []).filter((f) => !f.isDisabled).map((f) => `${f.name}=${f.value}`).join('\n') };
  } else if (b?.type && b.type !== 'none') {
    warnings.push(`${r.name}: body type "${b.type}" not supported`);
  }
  if (r.auth?.type === 'bearer' && r.auth.bearer) req.auth = { ...req.auth, type: 'bearer', token: r.auth.bearer };
  else if (r.auth?.type === 'basic') {
    req.auth = { ...req.auth, type: 'basic', username: r.auth.basic?.username ?? '', password: r.auth.basic?.password ?? '' };
  }
  const { assertions, captures } = convertTests(r.tests ?? [], r.name, warnings);
  req.assertions = assertions;
  req.captures = captures;
  return req;
}

const clean = (n: string) => n.trim().replace(/[<>:"/\\|?*]+/g, '-');

export function importThunderCollection(col: TcCollection, storage: Storage, summary: ImportSummary) {
  const root = storage.createDir(storage.collectionsDir, col.colName);
  summary.collection = col.colName;
  const folders = col.folders ?? [];
  const dirOf = new Map<string, string>();
  const resolveDir = (id: string | undefined): string => {
    if (!id) return root;
    const cached = dirOf.get(id);
    if (cached) return cached;
    const f = folders.find((x) => x._id === id);
    if (!f) return root;
    const dir = path.join(resolveDir(f.containerId), clean(f.name));
    fs.mkdirSync(dir, { recursive: true });
    dirOf.set(id, dir);
    return dir;
  };
  folders.forEach((f) => resolveDir(f._id));

  const sorted = [...(col.requests ?? [])].sort((a, b) => (a.sortNum ?? 0) - (b.sortNum ?? 0));
  const seen = new Map<string, number>();
  sorted.forEach((r, i) => {
    const dir = resolveDir(r.containerId);
    const base = `${String(i + 1).padStart(2, '0')}-${clean(r.name)}`;
    const key = path.join(dir, base);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const def = convertRequest(r, summary.warnings);
    def.seq = i + 1;
    storage.saveRequest(`${key}${n > 1 ? `-${n}` : ''}.json`, def);
    summary.requests++;
  });
}

export function importThunderFiles(files: string[], storage: Storage): ImportSummary {
  const summary: ImportSummary = { collection: '', requests: 0, environments: 0, warnings: [] };
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(f, 'utf8')) as TcCollection & TcEnvironment;
    if (data.colName) importThunderCollection(data, storage, summary);
    else if (data.environmentName) {
      const variables: Record<string, string> = {};
      for (const v of data.variables ?? []) variables[v.name] = v.value;
      storage.saveEnvironment({ name: data.environmentName, variables });
      summary.environments++;
    } else summary.warnings.push(`${path.basename(f)}: not a Thunder Client collection or environment`);
  }
  return summary;
}

