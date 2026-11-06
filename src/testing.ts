import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Storage } from './core/storage';
import type { VarStore } from './vars';
import { collectRequestFiles, collectTestCaseFiles, makeSuite, requestAsCase, runRequestFile, runTestCase } from './core/suite';
import { writeReports } from './core/report';
import type { CaseResult } from './core/types';

const byName = (a: fs.Dirent, b: fs.Dirent) => a.name.localeCompare(b.name, undefined, { numeric: true });
const nl = (s: string) => s.replace(/\r?\n/g, '\r\n');

export class QaTesting {
  readonly controller: vscode.TestController;
  private readonly items = new Map<string, vscode.TestItem>();
  private lastReport: string | undefined;

  constructor(
    private readonly storage: Storage,
    private readonly getEnv: () => string | undefined,
    private readonly vars: VarStore,
    private readonly onRunComplete?: () => void,
  ) {
    this.controller = vscode.tests.createTestController('qaforge', 'QAForge');
    this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (req, token) => this.run(req, token), true);
    this.controller.refreshHandler = () => this.refresh();
    this.refresh();
  }

  get reportFile() {
    return path.join(this.storage.reportsDir, 'last.html');
  }

  refresh() {
    this.items.clear();
    this.controller.items.replace([]);

    if (fs.existsSync(this.storage.testCasesDir)) {
      const tcRoot = this.buildTestCases(this.storage.testCasesDir, 'Test Cases');
      if (tcRoot.children.size > 0) {
        this.controller.items.add(tcRoot);
      }
    }

    const dir = this.storage.collectionsDir;
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).sort(byName)) {
      this.controller.items.add(this.build(path.join(dir, e.name), e.name));
    }
  }

  private buildTestCases(dir: string, label: string): vscode.TestItem {
    const item = this.controller.createTestItem(dir, label, vscode.Uri.file(dir));
    this.items.set(dir, item);
    if (!fs.existsSync(dir)) return item;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries.filter((x) => x.isDirectory()).sort(byName)) {
      item.children.add(this.buildTestCases(path.join(dir, e.name), e.name));
    }
    for (const e of entries.filter((x) => x.isFile() && x.name.endsWith('.json')).sort(byName)) {
      const file = path.join(dir, e.name);
      let name = path.basename(e.name, '.json');
      try {
        const tc = this.storage.readTestCase(file);
        name = `${tc.id} ${tc.title}`;
      } catch { /* malformed */ }
      const child = this.controller.createTestItem(file, name, vscode.Uri.file(file));
      this.items.set(file, child);
      item.children.add(child);
    }
    return item;
  }

  private build(dir: string, label: string): vscode.TestItem {
    const item = this.controller.createTestItem(dir, label, vscode.Uri.file(dir));
    this.items.set(dir, item);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries.filter((x) => x.isDirectory()).sort(byName)) {
      item.children.add(this.build(path.join(dir, e.name), e.name));
    }
    for (const e of entries.filter((x) => x.isFile() && x.name.endsWith('.json')).sort(byName)) {
      const file = path.join(dir, e.name);
      let name = path.basename(e.name, '.json');
      try { name = this.storage.readRequest(file).name || name; } catch { /* malformed */ }
      const child = this.controller.createTestItem(file, name, vscode.Uri.file(file));
      this.items.set(file, child);
      item.children.add(child);
    }
    return item;
  }

  /** Runs a collection, folder, request or test case from the QAForge trees. Supports cascade execution. */
  async runPath(fsPath: string) {
    let item = this.items.get(fsPath);
    if (!item) {
      this.refresh();
      item = this.items.get(fsPath);
    }
    if (item) {
      const source = new vscode.CancellationTokenSource();
      await this.run(new vscode.TestRunRequest([item]), source.token);
      return;
    }

    // Fallback: If fsPath is a directory or path on disk, gather all matching TestItems
    if (fs.existsSync(fsPath)) {
      const norm = path.normalize(fsPath).toLowerCase();
      const matching: vscode.TestItem[] = [];
      for (const [key, testItem] of this.items.entries()) {
        const normKey = path.normalize(key).toLowerCase();
        if (normKey.startsWith(norm) && key.endsWith('.json')) {
          matching.push(testItem);
        }
      }
      if (matching.length) {
        const source = new vscode.CancellationTokenSource();
        await this.run(new vscode.TestRunRequest(matching), source.token);
      }
    }
  }

  async openReport() {
    if (!fs.existsSync(this.reportFile)) {
      vscode.window.showInformationMessage('QAForge: no report yet. Run some tests first.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.file(this.reportFile));
  }

  private leaves(item: vscode.TestItem, out: vscode.TestItem[] = []) {
    if (item.children.size === 0) {
      if (item.id.endsWith('.json')) out.push(item);
    } else item.children.forEach((c) => this.leaves(c, out));
    return out;
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const run = this.controller.createTestRun(request);
    const roots: vscode.TestItem[] = [];
    if (request.include) roots.push(...request.include);
    else this.controller.items.forEach((i) => roots.push(i));

    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    const queue = roots.flatMap((r) => this.leaves(r)).filter((i) => !excluded.has(i.id));
    queue.forEach((i) => run.enqueued(i));

    let envName = this.getEnv();

    // If running a single test case with environments defined, prompt to pick one
    const singleCaseItem = queue.length === 1 && queue[0].id.startsWith(this.storage.testCasesDir) ? queue[0] : undefined;
    if (singleCaseItem) {
      try {
        const tc = this.storage.readTestCase(singleCaseItem.id);
        if (tc.environments?.length) {
          const availableEnvs = this.storage.listEnvironments().map((e) => e.name);
          const picks = tc.environments.filter((e) => availableEnvs.includes(e));
          if (picks.length === 1) {
            envName = picks[0];
          } else if (picks.length > 1) {
            const current = envName && picks.includes(envName) ? envName : undefined;
            const chosen = await vscode.window.showQuickPick(
              picks.map((e) => ({ label: e, description: e === current ? '$(check) active' : '' })),
              { placeHolder: `Select environment for ${tc.id}`, title: 'QAForge: Environment Selection' },
            );
            if (!chosen) { run.end(); return; }
            envName = chosen.label;
          }
        }
      } catch { /* malformed tc, continue with current env */ }
    }

    // Notify user that execution has started
    const runLabel = queue.length === 1 ? queue[0].label : `${queue.length} tests`;
    vscode.window.showInformationMessage(`QAForge ▶ Running: ${runLabel}${envName ? ` [${envName}]` : ''}…`);
    const started = Date.now();
    const results: CaseResult[] = [];
    const sharedRuntime: Record<string, string> = {};
    let envVars: Record<string, string> = {};
    try {
      envVars = await this.vars.resolve(envName);
    } catch (e) {
      vscode.window.showErrorMessage(`QAForge: could not resolve variables: ${(e as Error).message}`);
    }

    for (const item of queue) {
      if (token.isCancellationRequested) {
        run.skipped(item);
        continue;
      }
      run.started(item);
      const t0 = Date.now();
      try {
        const isCase = item.id.startsWith(this.storage.testCasesDir);
        let result: CaseResult;
        if (isCase) {
          const tc = this.storage.readTestCase(item.id);
          run.appendOutput(nl(`${tc.id} ${tc.title}\n`), undefined, item);
          result = await runTestCase(this.storage, tc, envVars, {
            onStep: (r, i) =>
              run.appendOutput(nl(`  #${i + 1} ${r.passed ? '✔' : '✘'} ${r.name} [${r.status || 'ERR'} ${r.durationMs}ms]\n`), undefined, item),
          });
          for (const it of result.iterations) {
            for (const s of it.steps) {
              if (s.skipped) run.appendOutput(nl(`  #${it.index} - ${s.name} (skipped)\n`), undefined, item);
              for (const t of s.tests.filter((x) => !x.passed)) {
                run.appendOutput(nl(`      ✘ ${t.name}${t.error ? ` — ${t.error}` : ''}\n`), undefined, item);
              }
              if (s.error) run.appendOutput(nl(`      ✘ ${s.error}\n`), undefined, item);
              for (const l of s.logs) run.appendOutput(nl(`      log: ${l}\n`), undefined, item);
            }
          }
          if (result.manualSteps) run.appendOutput(nl(`  (${result.manualSteps} manual step(s) require a human)\n`), undefined, item);
        } else {
          const r = await runRequestFile(this.storage, item.id, envVars, sharedRuntime);
          run.appendOutput(nl(`${r.passed ? '✔' : '✘'} ${r.name} [${r.status || 'ERR'} ${r.durationMs}ms]\n`), undefined, item);
          for (const t of r.tests) run.appendOutput(nl(`   ${t.passed ? '✔' : '✘'} ${t.name}${t.error ? ` — ${t.error}` : ''}\n`), undefined, item);
          if (r.error) run.appendOutput(nl(`   ✘ ${r.error}\n`), undefined, item);
          for (const l of r.logs) run.appendOutput(nl(`   log: ${l}\n`), undefined, item);
          result = requestAsCase(r, this.storage.collectionsDir);
        }
        results.push(result);
        if (result.passed) run.passed(item, Date.now() - t0);
        else {
          const lines = result.iterations.flatMap((it) =>
            it.steps
              .filter((s) => !s.passed && !s.skipped)
              .map((s) => `#${it.index} ${s.name}: ${s.error ?? s.tests.filter((t) => !t.passed).map((t) => `${t.name} (${t.error ?? ''})`).join('; ')}`),
          );
          run.failed(item, new vscode.TestMessage(lines.join('\n') || 'Failed'), Date.now() - t0);
        }
      } catch (e) {
        run.errored(item, new vscode.TestMessage((e as Error).message));
      }
    }

    const passed = results.filter((r) => r.passed).length;
    const totalSteps = results.reduce((acc, r) => acc + r.iterations.flatMap((it) => it.steps).length, 0);
    const passedSteps = results.reduce((acc, r) => acc + r.iterations.flatMap((it) => it.steps).filter((s) => s.passed).length, 0);
    run.appendOutput(nl(`\nDone: ${passed}/${results.length} cases passed | ${passedSteps}/${totalSteps} steps passed\n`));
    run.end();

    if (results.length) {
      let targetName = 'Run';
      if (queue.length === 1) {
        targetName = results[0].id || results[0].title;
      } else if (roots.length === 1) {
        targetName = roots[0].label;
      } else if (results.some((r) => r.id.startsWith('TC-'))) {
        targetName = results.find((r) => r.id.startsWith('TC-'))!.id;
      } else {
        targetName = `${results.length} items`;
      }

      const suite = makeSuite(targetName, envName, started, results);
      writeReports(this.storage, suite);
      this.onRunComplete?.();
      const act = await vscode.window.showInformationMessage(
        `QAForge ✅ ${passed}/${results.length} cases | ${passedSteps}/${totalSteps} steps passed`,
        'Open report',
      );
      if (act) {
        await vscode.commands.executeCommand('qaforge.openReport');
      }
    }
  }
}
