import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Storage } from './core/storage';
import { CollectionsProvider, QItem, TestCasesProvider, VariablesProvider, ReportsProvider } from './tree';
import { VarStore } from './vars';
import { RequestPanel } from './panel';
import { ReportViewerPanel } from './reportViewer';
import { QaTesting } from './testing';
import { importUniversal } from './core/universalImport';
import { emptySql, TestCaseDef } from './core/types';
import { collectTestCaseFiles } from './core/suite';
import { testCasesToZephyrCsv } from './core/zephyr';

export function activate(ctx: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const storage = new Storage(folder.uri.fsPath);
  storage.ensure();
  const provider = new CollectionsProvider(storage);
  /** variables set by scripts/captures; shared across requests until cleared */
  const runtime: Record<string, string> = {};
  const getEnv = () => ctx.workspaceState.get<string>('qaforge.env');
  const vars = new VarStore(storage, ctx.secrets);
  const casesProvider = new TestCasesProvider(storage);
  const varsProvider = new VariablesProvider(storage, getEnv, runtime);
  const reportsProvider = new ReportsProvider(storage);
  const testing = new QaTesting(storage, getEnv, vars, () => {
    reportsProvider.refresh();
  });
  const refreshAll = () => {
    provider.refresh();
    casesProvider.refresh();
    varsProvider.refresh();
    reportsProvider.refresh();
    testing.refresh();
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'qaforge.selectEnvironment';
  const updateStatus = () => {
    status.text = `$(globe) QAForge: ${getEnv() ?? 'No environment'}`;
    status.show();
  };
  updateStatus();

  const ask = (prompt: string, value?: string) => vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
  const guard = async (fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (e) {
      vscode.window.showErrorMessage((e as Error).message);
    }
  };
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('qaforge.collections', provider),
    vscode.window.registerTreeDataProvider('qaforge.testcases', casesProvider),
    vscode.window.registerTreeDataProvider('qaforge.variables', varsProvider),
    vscode.window.registerTreeDataProvider('qaforge.reports', reportsProvider),
    status,
  );

  reg('qaforge.runItem', (item?: QItem) => item && testing.runPath(item.fsPath));

  reg('qaforge.clearVariables', () => {
    for (const k of Object.keys(runtime)) delete runtime[k];
    vscode.window.showInformationMessage('QAForge: runtime variables cleared');
  });

  reg('qaforge.importCollection', () =>
    guard(async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: true,
        canSelectMany: false,
        openLabel: 'Import Collection / Environment',
        filters: {
          'Collections & Environments': ['json', 'bru'],
          'All Files': ['*'],
        },
      });
      if (!picked?.[0]) return;
      const summary = importUniversal(picked[0].fsPath, storage);
      refreshAll();
      const msg = `Imported "${summary.collection}": ${summary.requests} requests, ${summary.environments} environments` +
        (summary.warnings.length ? `, ${summary.warnings.length} warnings` : '');
      if (summary.warnings.length) {
        const out = vscode.window.createOutputChannel('QAForge Import');
        out.appendLine(summary.warnings.join('\n'));
        const act = await vscode.window.showWarningMessage(msg, 'Show warnings');
        if (act) out.show();
      } else vscode.window.showInformationMessage(msg);
    }),
  );

  reg('qaforge.newSqlRequest', (item?: QItem) =>
    guard(async () => {
      if (!item) return;
      const name = await ask('SQL step name');
      if (!name) return;
      const file = storage.createRequest(item.fsPath, name);
      const def = storage.readRequest(file);
      def.kind = 'sql';
      def.sql = emptySql();
      def.assertions = [{ enabled: true, source: 'body', path: 'rowCount', op: 'gt', expected: '0' }];
      storage.saveRequest(file, def);
      refreshAll();
      openFile(file);
    }),
  );

  reg('qaforge.newTestCase', () =>
    guard(async () => {
      const id = await ask('Test case ID (e.g. TC-001)');
      if (!id) return;
      const title = await ask('Title');
      if (!title) return;
      const file = storage.createTestCase(id, title);
      refreshAll();
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
  );

  const exportCasesToZephyr = async (targetFile?: string) => {
    let files: string[] = [];
    if (targetFile) {
      files = [targetFile];
    } else {
      files = collectTestCaseFiles(storage);
    }

    if (files.length === 0) {
      vscode.window.showWarningMessage('QAForge: No test cases found in .qaforge/testcases.');
      return;
    }

    const cases: TestCaseDef[] = [];
    for (const f of files) {
      try {
        cases.push(storage.readTestCase(f));
      } catch {
        /* ignore malformed */
      }
    }

    if (cases.length === 0) {
      vscode.window.showWarningMessage('QAForge: Could not read any valid test case definitions.');
      return;
    }

    const defaultName = cases.length === 1 ? `${cases[0].id}_zephyr.csv` : 'zephyr_testcases.csv';
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const defaultUri = workspaceRoot
      ? vscode.Uri.file(path.join(workspaceRoot, '.qaforge', defaultName))
      : undefined;

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'CSV Files (*.csv)': ['csv'] },
      title: 'Export Test Cases to Jira Zephyr (CSV)',
    });
    if (!saveUri) return;

    const csv = testCasesToZephyrCsv(cases, storage);
    fs.writeFileSync(saveUri.fsPath, csv, 'utf8');

    const totalSteps = cases.reduce((acc, c) => acc + (c.steps?.length || 0), 0);
    const act = await vscode.window.showInformationMessage(
      `QAForge: Exported ${cases.length} test case(s) (${totalSteps} steps) to Zephyr CSV.`,
      'Open CSV',
      'Reveal in Explorer',
    );
    if (act === 'Open CSV') {
      await vscode.commands.executeCommand('vscode.open', saveUri);
    } else if (act === 'Reveal in Explorer') {
      await vscode.commands.executeCommand('revealFileInOS', saveUri);
    }
  };

  reg('qaforge.exportZephyr', () =>
    guard(async () => exportCasesToZephyr()),
  );

  reg('qaforge.exportTestCaseZephyr', (item?: QItem) =>
    guard(async () => exportCasesToZephyr(item?.fsPath)),
  );

  reg('qaforge.setSecret', () =>
    guard(async () => {
      const env = getEnv();
      const scopes = ['Global (all environments)', ...(env ? [`Environment: ${env}`] : [])];
      const scopePick = await vscode.window.showQuickPick(scopes, { placeHolder: 'Where should the secret live?' });
      if (!scopePick) return;
      const name = await ask('Variable name (e.g. DB_PASSWORD)');
      if (!name) return;
      const value = await vscode.window.showInputBox({ prompt: `Value for ${name}`, password: true, ignoreFocusOut: true });
      if (value === undefined) return;
      await vars.setSecret(scopePick.startsWith('Global') ? 'global' : 'env', name, value, env);
      vscode.window.showInformationMessage(`QAForge: secret "${name}" stored in SecretStorage. Use it as {{${name}}}.`);
    }),
  );

  reg('qaforge.protectSecrets', () =>
    guard(async () => {
      const n = await vars.protect(getEnv());
      refreshAll();
      vscode.window.showInformationMessage(n ? `QAForge: ${n} plaintext secret(s) moved to SecretStorage` : 'QAForge: nothing to protect');
    }),
  );

  reg('qaforge.editGlobals', () =>
    guard(async () => {
      if (!fs.existsSync(storage.globalsFile)) storage.saveGlobals(storage.readGlobals());
      await vscode.window.showTextDocument(vscode.Uri.file(storage.globalsFile));
    }),
  );

  reg('qaforge.showVariables', () =>
    guard(async () => {
      const doc = await vscode.workspace.openTextDocument({ content: await vars.preview(getEnv()), language: 'properties' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  reg('qaforge.openReport', () => {
    if (fs.existsSync(testing.reportFile)) {
      ReportViewerPanel.show(ctx, testing.reportFile);
    } else {
      vscode.window.showInformationMessage('QAForge: no report yet. Run some tests first.');
    }
  });

  reg('qaforge.openReportFile', (file?: string | QItem) => {
    const fsPath = typeof file === 'string' ? file : file?.fsPath;
    if (fsPath && fs.existsSync(fsPath)) {
      ReportViewerPanel.show(ctx, fsPath);
    }
  });

  reg('qaforge.openReportInBrowser', (file?: string | QItem) => {
    const fsPath = typeof file === 'string' ? file : file?.fsPath;
    if (fsPath && fs.existsSync(fsPath)) {
      void vscode.env.openExternal(vscode.Uri.file(fsPath));
    }
  });

  reg('qaforge.deleteReport', (item?: QItem) =>
    guard(async () => {
      if (!item || !fs.existsSync(item.fsPath)) return;
      const ok = await vscode.window.showWarningMessage(`Delete report "${item.label}"?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      fs.rmSync(item.fsPath, { force: true });
      // Also delete companion json if exists
      const jsonCompanion = item.fsPath.replace(/\.html$/, '.json');
      if (fs.existsSync(jsonCompanion)) fs.rmSync(jsonCompanion, { force: true });
      reportsProvider.refresh();
      vscode.window.showInformationMessage('Report deleted.');
    }),
  );

  reg('qaforge.filterReports', () =>
    guard(async () => {
      const current = reportsProvider.getFilter();
      const input = await vscode.window.showInputBox({
        prompt: 'Search Execution History (Filter by Test Case ID, Collection, PASS, FAIL, Date)',
        value: current,
        placeHolder: 'e.g. TC-IPE-001, PASS, 2026-11, Primary-Scan...',
      });
      if (input === undefined) return;
      reportsProvider.setFilter(input);
    }),
  );

  reg('qaforge.clearReportsFilter', () => {
    reportsProvider.setFilter('');
  });

  reg('qaforge.clearReports', () =>
    guard(async () => {
      if (!fs.existsSync(storage.historyDir)) return;
      const ok = await vscode.window.showWarningMessage('Delete ALL historical reports?', { modal: true }, 'Delete All');
      if (ok !== 'Delete All') return;
      fs.rmSync(storage.historyDir, { recursive: true, force: true });
      reportsProvider.refresh();
      vscode.window.showInformationMessage('All historical reports cleared.');
    }),
  );

  reg('qaforge.addVariable', () =>
    guard(async () => {
      const envName = getEnv();
      if (!envName) {
        vscode.window.showWarningMessage('Please select an active environment first (click the globe in status bar).');
        return;
      }
      const name = await ask('Variable Name (e.g. baseUrl, SO)');
      if (!name) return;
      const value = await ask(`Value for ${name}`);
      if (value === undefined) return;
      const env = storage.getEnvironment(envName);
      if (env) {
        env.variables[name] = value;
        storage.saveEnvironment(env);
        refreshAll();
        vscode.window.showInformationMessage(`Variable "${name}" added to environment "${envName}".`);
      }
    }),
  );

  reg('qaforge.editVariable', (item?: QItem) =>
    guard(async () => {
      if (!item) return;
      const rawLabel = String(item.label || '');
      const oldVarName = rawLabel.replace(/^[\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF\s]+/, '').trim();
      const currentVal = item.description ? String(item.description) : '';
      if (currentVal === 'secret') {
        await vscode.commands.executeCommand('qaforge.setSecret');
        return;
      }

      // Step 1: Prompt for variable NAME (allows renaming the variable itself)
      const newVarName = await ask('Variable Name', oldVarName);
      if (!newVarName) return;

      // Step 2: Prompt for variable VALUE
      const newVal = await ask(`Value for ${newVarName}`, currentVal);
      if (newVal === undefined) return;
      
      const envName = getEnv();
      const env = storage.getEnvironment(envName);
      if (env && Object.prototype.hasOwnProperty.call(env.variables, oldVarName)) {
        if (newVarName !== oldVarName) delete env.variables[oldVarName];
        env.variables[newVarName] = newVal;
        storage.saveEnvironment(env);
      } else {
        const globals = storage.readGlobals();
        if (Object.prototype.hasOwnProperty.call(globals.variables, oldVarName)) {
          if (newVarName !== oldVarName) delete globals.variables[oldVarName];
          globals.variables[newVarName] = newVal;
          storage.saveGlobals(globals);
        } else if (env) {
          env.variables[newVarName] = newVal;
          storage.saveEnvironment(env);
        }
      }
      refreshAll();
      vscode.window.showInformationMessage(`Variable "${newVarName}" updated.`);
    }),
  );

  reg('qaforge.deleteVariable', (item?: QItem) =>
    guard(async () => {
      if (!item) return;
      const rawLabel = String(item.label || '');
      const varName = rawLabel.replace(/^[\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF\s]+/, '').trim();
      const ok = await vscode.window.showWarningMessage(`Delete variable "${varName}"?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;

      const envName = getEnv();
      const env = storage.getEnvironment(envName);
      if (env && Object.prototype.hasOwnProperty.call(env.variables, varName)) {
        delete env.variables[varName];
        storage.saveEnvironment(env);
      } else {
        const globals = storage.readGlobals();
        if (Object.prototype.hasOwnProperty.call(globals.variables, varName)) {
          delete globals.variables[varName];
          storage.saveGlobals(globals);
        }
      }
      refreshAll();
      vscode.window.showInformationMessage(`Variable "${varName}" deleted.`);
    }),
  );

  reg('qaforge.refresh', () => refreshAll());

  reg('qaforge.newCollection', () =>
    guard(async () => {
      const name = await ask('Collection name');
      if (!name) return;
      storage.createDir(storage.collectionsDir, name);
      refreshAll();
    }),
  );

  reg('qaforge.newFolder', (item?: QItem) =>
    guard(async () => {
      if (!item) return;
      const name = await ask('Folder name');
      if (!name) return;
      storage.createDir(item.fsPath, name);
      refreshAll();
    }),
  );

  const openFile = (file: string) =>
    RequestPanel.open(ctx, storage, file, getEnv, vars, runtime, refreshAll);

  reg('qaforge.newRequest', (item?: QItem) =>
    guard(async () => {
      if (!item) return;
      const name = await ask('Request name');
      if (!name) return;
      const file = storage.createRequest(item.fsPath, name);
      refreshAll();
      openFile(file);
    }),
  );

  reg('qaforge.openRequest', (item?: QItem) => item && openFile(item.fsPath));

  reg('qaforge.renameItem', (item?: QItem) =>
    guard(async () => {
      if (!item) return;
      const name = await ask('New name', String(item.label));
      if (!name) return;
      storage.rename(item.fsPath, name);
      refreshAll();
    }),
  );

  reg('qaforge.deleteItem', (item?: QItem) =>
    guard(async () => {
      if (!item || !fs.existsSync(item.fsPath)) return;
      const ok = await vscode.window.showWarningMessage(`Delete "${item.label}"?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      storage.remove(item.fsPath);
      refreshAll();
    }),
  );

  reg('qaforge.selectEnvironment', () =>
    guard(async () => {
      const NEW = '$(add) New environment...';
      const picks = [...storage.listEnvironments().map((e) => e.name), NEW];
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Select environment' });
      if (!pick) return;
      let name = pick;
      if (pick === NEW) {
        const created = await ask('Environment name');
        if (!created) return;
        const file = storage.createEnvironment(created);
        name = created;
        await vscode.window.showTextDocument(vscode.Uri.file(file));
      }
      await ctx.workspaceState.update('qaforge.env', name);
      for (const k of Object.keys(runtime)) delete runtime[k];
      RequestPanel.updateAllEnvironments(name);
      updateStatus();
      refreshAll();
    }),
  );
}

export function deactivate() {}


