import { interpolate } from './variables';
import type { Assertion, ResponseResult, TestResult } from './types';

/** Resolves `a.b[0].c` (optionally prefixed with `$.`) against an object. */
export function getPath(obj: unknown, path: string): unknown {
  const clean = path.trim().replace(/^\$\.?/, '');
  if (!clean) return obj;
  const parts = clean.match(/[^.[\]]+/g) ?? [];
  let cur: any = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function parseExpected(raw: string): unknown {
  const t = raw.trim();
  try {
    return JSON.parse(t);
  } catch {
    return t.replace(/^(['"])(.*)\1$/, '$2');
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b) || String(a) === String(b);

export function describeAssertion(a: Assertion): string {
  const target = a.source === 'status' ? 'status' : a.source === 'time' ? 'time' : `${a.source} ${a.path}`.trim();
  const unary = ['exists', 'notExists', 'isEmpty', 'isNotEmpty'].includes(a.op);
  return `${target} ${a.op}${unary ? '' : ' ' + a.expected}`;
}

export function evaluateAssertion(a: Assertion, res: ResponseResult, vars: Record<string, string>): TestResult {
  let actual: unknown;
  switch (a.source) {
    case 'status': actual = res.status; break;
    case 'time': actual = res.durationMs; break;
    case 'header': actual = res.headers[a.path.toLowerCase()]; break;
    case 'body': actual = getPath(parseBody(res.body), a.path); break;
  }
  const resolvedExpected = interpolate(a.expected, vars);
  const expected = parseExpected(resolvedExpected);
  const target = a.source === 'status' ? 'status' : a.source === 'time' ? 'time' : `${a.source} ${a.path}`.trim();
  const unary = ['exists', 'notExists', 'isEmpty', 'isNotEmpty'].includes(a.op);
  const shownActual = typeof actual === 'string' ? `"${actual}"` : JSON.stringify(actual);
  const name = `${target} ${a.op}${unary ? '' : ` "${resolvedExpected}"`} (actual: ${shownActual})`;

  const num = (v: unknown) => Number(v);
  let passed: boolean;
  switch (a.op) {
    case 'eq': passed = same(actual, expected); break;
    case 'neq': passed = !same(actual, expected); break;
    case 'gt': passed = num(actual) > num(expected); break;
    case 'gte': passed = num(actual) >= num(expected); break;
    case 'lt': passed = num(actual) < num(expected); break;
    case 'lte': passed = num(actual) <= num(expected); break;
    case 'contains':
      passed = Array.isArray(actual) ? actual.some((x) => same(x, expected)) : String(actual).includes(String(expected));
      break;
    case 'notContains':
      passed = Array.isArray(actual) ? !actual.some((x) => same(x, expected)) : !String(actual).includes(String(expected));
      break;
    case 'startsWith': passed = String(actual).startsWith(String(expected)); break;
    case 'endsWith': passed = String(actual).endsWith(String(expected)); break;
    case 'matches':
      try { passed = new RegExp(String(expected)).test(String(actual)); } catch { passed = false; }
      break;
    case 'in': passed = Array.isArray(expected) && expected.some((x) => same(x, actual)); break;
    case 'length': passed = (actual as { length?: number } | undefined)?.length === num(expected); break;
    case 'exists': passed = actual !== undefined && actual !== null; break;
    case 'notExists': passed = actual === undefined || actual === null; break;
    case 'isEmpty': passed = actual === '' || (Array.isArray(actual) && actual.length === 0); break;
    case 'isNotEmpty': passed = actual !== '' && !(Array.isArray(actual) && actual.length === 0) && actual != null; break;
    default: passed = false;
  }
  if (passed) return { name, passed };
  const shown = typeof actual === 'string' ? actual : JSON.stringify(actual);
  return { name, passed, error: `expected ${a.op} ${a.expected} but got ${String(shown).slice(0, 200)}` };
}

