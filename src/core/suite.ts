import * as fs from 'fs';

import * as path from 'path';

import { runRequest } from './runner';

import type { Storage } from './storage';

import type { CaseIteration, CaseResult, RequestResult, SuiteResult, TestCaseDef } from './types';



const byName = (a: fs.Dirent, b: fs.Dirent) => a.name.localeCompare(b.name, undefined, { numeric: true });



/** Reads a secret value; the VS Code extension uses SecretStorage, the CLI uses QAFORGE_SECRET_<NAME>. */

export type SecretReader = (scope: 'global' | 'env', name: string, env?: string) => Promise<string | undefined>;



/** globals < globals' secrets < environment < environment's secrets */

export async function resolveVariables(

  storage: Storage,

  envName: string | undefined,

  readSecret: SecretReader,

): Promise<Record<string, string>> {

  const globals = storage.readGlobals();

  const vars: Record<string, string> = { ...globals.variables };

  for (const name of globals.secrets) {

    const v = await readSecret('global', name);

    if (v !== undefined) vars[name] = v;

  }

  const env = storage.getEnvironment(envName);

  if (env) {

    Object.assign(vars, env.variables);

    for (const name of env.secrets ?? []) {

      const v = await readSecret('env', name, env.name);

      if (v !== undefined) vars[name] = v;

    }

  }

  return vars;

}



/** Request files under a file or folder, sub-folders first, natural order (01, 02, ... 10). */

export function collectRequestFiles(target: string): string[] {

  if (!fs.existsSync(target)) return [];

  if (fs.statSync(target).isFile()) return [target];

  const entries = fs.readdirSync(target, { withFileTypes: true });

  return [

    ...entries.filter((e) => e.isDirectory()).sort(byName).flatMap((e) => collectRequestFiles(path.join(target, e.name))),

    ...entries.filter((e) => e.isFile() && e.name.endsWith('.json')).sort(byName).map((e) => path.join(target, e.name)),

  ];

}




export function collectTestCaseFiles(storage: Storage, targetDir?: string): string[] {
  const dir = targetDir || storage.testCasesDir;
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return [
    ...entries.filter((e) => e.isDirectory()).sort(byName).flatMap((e) => collectTestCaseFiles(storage, path.join(dir, e.name))),
    ...entries.filter((e) => e.isFile() && e.name.endsWith('.json')).sort(byName).map((e) => path.join(dir, e.name)),
  ];
}



export async function runRequestFile(

  storage: Storage,

  file: string,

  envVars: Record<string, string>,

  runtime: Record<string, string>,

): Promise<RequestResult> {

  const def = storage.readRequest(file);

  const out = await runRequest(def, envVars, runtime, storage.workspaceRoot);

  return {

    name: def.name,

    file,

    passed: out.passed,

    status: out.response.status,

    durationMs: out.response.durationMs,

    tests: out.tests,

    logs: out.logs,

    error: out.response.error,

    responseBody: out.response.body,

  };

}



/** Minimal CSV parser (quotes, commas, CRLF). First row is the header. */

export function parseCsv(text: string): Record<string, string>[] {

  const rows: string[][] = [];

  let row: string[] = [];

  let cell = '';

  let quoted = false;

  for (let i = 0; i < text.length; i++) {

    const c = text[i];

    if (quoted) {

      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }

      else if (c === '"') quoted = false;

      else cell += c;

    } else if (c === '"') quoted = true;

    else if (c === ',') { row.push(cell); cell = ''; }

    else if (c === '\n' || c === '\r') {

      if (c === '\r' && text[i + 1] === '\n') i++;

      row.push(cell); cell = '';

      if (row.some((x) => x !== '')) rows.push(row);

      row = [];

    } else cell += c;

  }

  row.push(cell);

  if (row.some((x) => x !== '')) rows.push(row);

  const [header, ...rest] = rows;

  if (!header) return [];

  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));

}



export function loadDataRows(storage: Storage, tc: TestCaseDef, extra?: Record<string, string>[]): Record<string, string>[] {

  if (extra?.length) return extra;

  if (tc.dataFile) {

    const file = path.resolve(storage.root, tc.dataFile);

    const text = fs.readFileSync(file, 'utf8');

    const rows = file.endsWith('.json')

      ? (JSON.parse(text) as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])))

      : parseCsv(text);

    if (rows.length) return rows;

  }

  return tc.data?.length ? tc.data : [{}];

}



export function resolveStepFile(storage: Storage, stepRequest?: string): string | undefined {

  if (!stepRequest) return undefined;

  let target = path.resolve(storage.collectionsDir, stepRequest);

  // If direct resolution didn't find files, try searching loosely under collectionsDir

  if (!fs.existsSync(target) && !target.endsWith('.json')) {

    const withJson = `${target}.json`;

    if (fs.existsSync(withJson)) target = withJson;

  }

  if (!fs.existsSync(target)) {

    // Fallback: look for match anywhere under collections

    const allFiles = collectRequestFiles(storage.collectionsDir);

    const normStep = stepRequest.replace(/\\/g, '/').toLowerCase();

    const found = allFiles.find((f) => f.replace(/\\/g, '/').toLowerCase().endsWith(normStep));

    if (found) target = found;

  }

  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;

  const files = collectRequestFiles(target);

  return files.length ? files[0] : undefined;

}



export interface CaseOptions {

  dataRows?: Record<string, string>[];

  onStep?: (r: RequestResult, iteration: number) => void;

  runtime?: Record<string, string>;

  startIndex?: number;

  endIndex?: number;

}



export async function runTestCase(

  storage: Storage,

  tc: TestCaseDef,

  envVars: Record<string, string>,

  opts: CaseOptions = {},

): Promise<CaseResult> {

  const started = Date.now();

  const rows = loadDataRows(storage, tc, opts.dataRows);

  const iterations: CaseIteration[] = [];

  let manualSteps = 0;

  const stop = tc.stopOnFailure !== false;

  const vars = { __qaforgeRoot: storage.root, ...envVars };



  for (let i = 0; i < rows.length; i++) {

    const runtime: Record<string, string> = opts.runtime ?? { ...(tc.variables ?? {}), ...rows[i] };

    if (opts.runtime) {

      Object.assign(opts.runtime, tc.variables ?? {}, rows[i]);

    }

    const results: RequestResult[] = [];

    let failed = false;

    const start = opts.startIndex ?? 0;

    const end = opts.endIndex !== undefined ? Math.min(opts.endIndex, tc.steps.length) : tc.steps.length;

    for (let sIdx = start; sIdx < end; sIdx++) {

      const step = tc.steps[sIdx];

      if (step.manual || !step.request) {

        if (i === 0) manualSteps++;

        continue;

      }

      const file = resolveStepFile(storage, step.request);

      if (!file) {

        results.push({ name: step.name, file: step.request, passed: false, status: 0, durationMs: 0, tests: [], logs: [], error: `No requests found at "${step.request}"` });

        failed = true;

        continue;

      }

      if (failed && stop) {

        const name = storage.readRequest(file).name;

        results.push({ name, file, passed: false, skipped: true, status: 0, durationMs: 0, tests: [], logs: [] });

        continue;

      }

      const r = await runRequestFile(storage, file, vars, runtime);

      results.push(r);

      opts.onStep?.(r, i);

      if (!r.passed) failed = true;

    }

    iterations.push({ index: i + 1, data: rows[i], steps: results, passed: !failed });

  }



  return {

    id: tc.id,

    title: tc.title,

    requirement: tc.requirement,

    priority: tc.priority,

    passed: iterations.every((it) => it.passed),

    durationMs: Date.now() - started,

    manualSteps,

    iterations,

  };

}



/** Wraps plain request runs (e.g. a whole collection) as one single-step case per request. */

export function requestAsCase(r: RequestResult, collectionsDir: string): CaseResult {

  return {

    id: path.relative(collectionsDir, r.file).replace(/\\/g, '/'),

    title: r.name,

    passed: r.passed,

    durationMs: r.durationMs,

    manualSteps: 0,

    iterations: [{ index: 1, data: {}, steps: [r], passed: r.passed }],

  };

}



export function makeSuite(name: string, environment: string | undefined, started: number, cases: CaseResult[]): SuiteResult {

  return { name, environment, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, cases };

}



