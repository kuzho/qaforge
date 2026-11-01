#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Storage } from './core/storage';
import {
  collectRequestFiles, collectTestCaseFiles, makeSuite, requestAsCase,
  resolveVariables, runRequestFile, runTestCase, loadDataRows, parseCsv,
} from './core/suite';
import { writeReports } from './core/report';
import { testCasesToZephyrCsv } from './core/zephyr';
import type { CaseResult } from './core/types';

const HELP = `QAForge CLI

Usage:
  qaforge run [targets...] [options]
  qaforge export-zephyr [targets...] [options]

Commands:
  run                   Execute test cases or collections and write reports
  export-zephyr         Export test cases to Jira Zephyr Scale / Squad CSV format

Options for export-zephyr:
  -w, --workspace <dir> Workspace root containing .qaforge (default: cwd)
  -o, --out <file>      Target CSV file path (default: zephyr_testcases.csv)

Options for run:
  -w, --workspace <dir> workspace root containing .qaforge (default: cwd)
  -e, --env <name>        environment to use
      --data <file>       CSV/JSON rows for data-driven test cases (overrides the case's data)
      --var k=v           extra variable (repeatable)
  -f, --format <list>     html,junit,json (default: html,junit,json)
  -o, --out <dir>         report folder (default: .qaforge/reports)

Secrets: set QAFORGE_SECRET_<NAME> environment variables for each variable listed in "secrets".
`;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'export-zephyr') {
    let workspace = process.cwd();
    let outFile = 'zephyr_testcases.csv';
    const targets: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '-w' || a === '--workspace') workspace = path.resolve(args[++i]);
      else if (a === '-o' || a === '--out') outFile = args[++i];
      else if (!a.startsWith('-')) targets.push(a);
    }
    const storage = new Storage(workspace);
    const caseFiles: string[] = [];
    if (targets.length === 0) {
      caseFiles.push(...collectTestCaseFiles(storage));
    } else {
      for (const t of targets) {
        const asCase = path.join(storage.testCasesDir, t.endsWith('.json') ? path.basename(t) : `${t}.json`);
        if (fs.existsSync(asCase)) caseFiles.push(asCase);
        else console.warn(`Warning: test case "${t}" not found in ${storage.testCasesDir}`);
      }
    }
    if (caseFiles.length === 0) {
      console.error('No test cases found to export.');
      process.exit(1);
    }
    const cases = caseFiles.map((f) => storage.readTestCase(f));
    const csv = testCasesToZephyrCsv(cases, storage);
    const outPath = path.isAbsolute(outFile) ? outFile : path.join(workspace, outFile);
    fs.writeFileSync(outPath, csv, 'utf8');
    const totalSteps = cases.reduce((acc, c) => acc + (c.steps?.length || 0), 0);
    console.log(`Exported ${cases.length} test case(s) (${totalSteps} steps) to Zephyr CSV: ${outPath}`);
    process.exit(0);
  }

  if (args[0] !== 'run' || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    process.exit(args[0] === 'run' ? 0 : 1);
  }
  let workspace = process.cwd();
  let envName: string | undefined;
  let dataFile: string | undefined;
  let outDir: string | undefined;
  let formats = ['html', 'junit', 'json'];
  const extra: Record<string, string> = {};
  const targets: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-w' || a === '--workspace') workspace = path.resolve(args[++i]);
    else if (a === '-e' || a === '--env') envName = args[++i];
    else if (a === '--data') dataFile = path.resolve(args[++i]);
    else if (a === '--var') {
      const [k, ...v] = args[++i].split('=');
      extra[k] = v.join('=');
    } else if (a === '-f' || a === '--format') formats = args[++i].split(',');
    else if (a === '-o' || a === '--out') outDir = path.resolve(args[++i]);
    else targets.push(a);
  }

  const storage = new Storage(workspace);
  if (!fs.existsSync(storage.root)) {
    console.error(`No .qaforge folder found in ${workspace}`);
    process.exit(2);
  }
  const envVars = {
    ...(await resolveVariables(storage, envName, async (scope, name) => {
      const v = process.env[`QAFORGE_SECRET_${name}`];
      if (v === undefined) console.warn(`warning: secret "${name}" (${scope}) not set: define QAFORGE_SECRET_${name}`);
      return v;
    })),
    ...extra,
  };
  const dataRows = dataFile
    ? dataFile.endsWith('.json')
      ? (JSON.parse(fs.readFileSync(dataFile, 'utf8')) as Record<string, unknown>[]).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])))
      : parseCsv(fs.readFileSync(dataFile, 'utf8'))
    : undefined;

  const caseFiles: string[] = [];
  const requestTargets: string[] = [];
  if (targets.length === 0) caseFiles.push(...collectTestCaseFiles(storage));
  for (const t of targets) {
    const asCase = path.join(storage.testCasesDir, t.endsWith('.json') ? path.basename(t) : `${t}.json`);
    const abs = path.resolve(storage.root, t);
    if (fs.existsSync(asCase)) caseFiles.push(asCase);
    else if (fs.existsSync(abs)) {
      if (abs.startsWith(storage.testCasesDir)) caseFiles.push(abs);
      else requestTargets.push(abs);
    } else {
      console.error(`Target not found: ${t}`);
      process.exit(2);
    }
  }

  const started = Date.now();
  const cases: CaseResult[] = [];
  for (const f of caseFiles) {
    const tc = storage.readTestCase(f);
    const rows = loadDataRows(storage, tc, dataRows);
    process.stdout.write(`${tc.id} ${tc.title} (${rows.length} iteration${rows.length > 1 ? 's' : ''}) ... `);
    const r = await runTestCase(storage, tc, envVars, { dataRows });
    console.log(r.passed ? 'PASS' : 'FAIL');
    for (const it of r.iterations) {
      for (const s of it.steps.filter((x) => !x.passed && !x.skipped)) {
        console.log(`   #${it.index} ${s.name}: ${s.error ?? s.tests.filter((t) => !t.passed).map((t) => `${t.name} (${t.error})`).join('; ')}`);
      }
    }
    cases.push(r);
  }
  for (const t of requestTargets) {
    const runtime: Record<string, string> = {};
    for (const file of collectRequestFiles(t)) {
      const r = await runRequestFile(storage, file, envVars, runtime);
      console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.passed ? '' : ' - ' + (r.error ?? r.tests.filter((x) => !x.passed).map((x) => x.name).join('; '))}`);
      cases.push(requestAsCase(r, storage.collectionsDir));
    }
  }

  const suite = makeSuite(path.basename(workspace), envName, started, cases);
  const files = writeReports(storage, suite, formats, outDir);
  const failed = cases.filter((c) => !c.passed).length;
  console.log(`\n${cases.length - failed}/${cases.length} passed. Reports: ${files.join(', ')}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

