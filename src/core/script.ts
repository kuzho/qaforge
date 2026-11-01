import * as vm from 'vm';
import { expect } from 'chai';
import { parseBody } from './assertions';
import type { RequestDef, ResponseResult, TestResult } from './types';

export interface ScriptContext {
  /** mutable request (pre-request scripts may change it) */
  req: RequestDef;
  res?: ResponseResult;
  /** live variables (environment + runtime) */
  vars: Record<string, string>;
  /** variables that persist across requests during the session */
  runtime: Record<string, string>;
}

export interface ScriptOutput {
  tests: TestResult[];
  logs: string[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function makeRes(res: ResponseResult) {
  const body = parseBody(res.body);
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body,
    responseTime: res.durationMs,
    getStatus: () => res.status,
    getStatusText: () => res.statusText,
    getHeader: (n: string) => res.headers[n.toLowerCase()],
    getHeaders: () => res.headers,
    getBody: () => body,
    getResponseTime: () => res.durationMs,
  };
}

export async function runScript(code: string, ctx: ScriptContext): Promise<ScriptOutput> {
  const tests: TestResult[] = [];
  const logs: string[] = [];
  if (!code.trim()) return { tests, logs };
  const pending: Promise<void>[] = [];

  const setVar = (k: string, v: unknown) => {
    const s = str(v) ?? '';
    ctx.vars[k] = s;
    ctx.runtime[k] = s;
  };
  const bru = {
    getEnvVar: (k: string) => ctx.vars[k],
    setEnvVar: setVar,
    getVar: (k: string) => ctx.vars[k],
    setVar,
    hasVar: (k: string) => k in ctx.vars,
    deleteVar: (k: string) => { delete ctx.vars[k]; delete ctx.runtime[k]; },
    setNextRequest: () => undefined,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };

  const req = {
    getUrl: () => ctx.req.url,
    setUrl: (u: string) => { ctx.req.url = u; },
    getMethod: () => ctx.req.method,
    setMethod: (m: string) => { ctx.req.method = m.toUpperCase() as RequestDef['method']; },
    getHeader: (n: string) => ctx.req.headers.find((h) => h.key.toLowerCase() === n.toLowerCase())?.value,
    setHeader: (n: string, v: string) => {
      const h = ctx.req.headers.find((x) => x.key.toLowerCase() === n.toLowerCase());
      if (h) { h.value = v; h.enabled = true; } else ctx.req.headers.push({ key: n, value: v, enabled: true });
    },
    getBody: () => parseBody(ctx.req.body.content),
    setBody: (b: unknown) => {
      ctx.req.body = typeof b === 'string' ? { type: ctx.req.body.type === 'none' ? 'text' : ctx.req.body.type, content: b }
        : { type: 'json', content: JSON.stringify(b) };
    },
  };

  const test = (name: string, fn: () => unknown) => {
    pending.push(
      (async () => {
        try {
          await fn();
          tests.push({ name, passed: true });
        } catch (e) {
          tests.push({ name, passed: false, error: (e as Error).message });
        }
      })(),
    );
  };

  const fmt = (...a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  const sandbox: Record<string, unknown> = {
    bru, req, expect, test, it: test,
    describe: (_n: string, fn: () => void) => fn(),
    console: { log: (...a: unknown[]) => logs.push(fmt(...a)), error: (...a: unknown[]) => logs.push(fmt(...a)), warn: (...a: unknown[]) => logs.push(fmt(...a)) },
    setTimeout,
  };
  if (ctx.res) sandbox.res = makeRes(ctx.res);

  try {
    const context = vm.createContext(sandbox);
    const result = vm.runInContext(`(async () => {\n${code}\n})()`, context, { timeout: 5000 }) as Promise<void>;
    await result;
    await Promise.all(pending);
  } catch (e) {
    await Promise.allSettled(pending);
    tests.push({ name: 'script error', passed: false, error: (e as Error).message });
  }
  return { tests, logs };
}

/** Evaluates a capture expression such as `res.body.access_token` against a response. */
export function evalExpression(expr: string, res: ResponseResult, vars: Record<string, string>): string | undefined {
  try {
    const context = vm.createContext({ res: makeRes(res), vars: { ...vars } });
    const v = vm.runInContext(`(${expr})`, context, { timeout: 1000 });
    return v === undefined || v === null ? undefined : str(v);
  } catch {
    return undefined;
  }
}

