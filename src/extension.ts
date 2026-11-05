import { closeAllSqlPools } from './core/sql';
import { checkEnvironmentHealth, compareEnvironments } from './core/envDoctor';
import { publishResultsToZephyr } from './core/zephyrApi';
import type { CaseResult } from './core/types';
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

import { collectTestCaseFiles, resolveStepFile, runRequestFile } from './core/suite';

import { testCasesToZephyrXml, testCasesToZephyrExcel } from './core/zephyr';



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



    // Ask format first

    const format = await vscode.window.showQuickPick(

      [

        { label: '$(file-code) Zephyr Scale XML', description: 'ATM importer — recommended for Zephyr Scale', value: 'xml' },

        { label: '$(table) Excel / CSV', description: 'Spreadsheet import via atm-exporter template', value: 'csv' },

      ],

      { placeHolder: 'Select Zephyr export format', title: 'Export to Jira Zephyr' },

    );

    if (!format) return;



    // Ask for Zephyr folder path

    const folder = await vscode.window.showInputBox({

      prompt: 'Folder name inside Zephyr (you will select the parent path in the Zephyr UI)',

      value: 'QAForge Automated Tests',

      ignoreFocusOut: true,

    });

    if (folder === undefined) return;



    const isXml = format.value === 'xml';

    // Ask parameter resolution source
    const activeEnv = getEnv();
    const envOptions: Array<{ label: string; description: string; mode: 'default' | 'active' | 'choose' }> = [
      {
        label: '$(file-text) As defined in Test Case (Default parameters)',
        description: 'Use default parameters defined in the test case (falls back to active env for placeholders)',
        mode: 'default',
      },
    ];

    if (activeEnv) {
      envOptions.push({
        label: `$(globe) Active Environment: ${activeEnv}`,
        description: 'Populate parameters using values from the currently active environment',
        mode: 'active',
      });
    }

    envOptions.push({
      label: '$(list-unordered) Choose another Environment...',
      description: 'Select a specific environment to populate parameters',
      mode: 'choose',
    });

    const paramChoice = await vscode.window.showQuickPick(envOptions, {
      placeHolder: 'Select parameter source for Zephyr export',
      title: 'Export Parameters Source',
    });
    if (!paramChoice) return;

    let useEnvironmentValues = false;
    let resolvedVariables: Record<string, string> = {};

    if (paramChoice.mode === 'active' && activeEnv) {
      useEnvironmentValues = true;
      resolvedVariables = await vars.resolve(activeEnv);
    } else if (paramChoice.mode === 'choose') {
      const allEnvs = storage.listEnvironments().map((e) => e.name);
      if (allEnvs.length === 0) {
        vscode.window.showWarningMessage('QAForge: No environments found in .qaforge/environments.');
        return;
      }
      const pickedEnv = await vscode.window.showQuickPick(allEnvs, {
        placeHolder: 'Select environment to populate parameters',
      });
      if (!pickedEnv) return;
      useEnvironmentValues = true;
      resolvedVariables = await vars.resolve(pickedEnv);
    } else {
      useEnvironmentValues = false;
      if (activeEnv) {
        resolvedVariables = await vars.resolve(activeEnv);
      }
    }

    let projectKey = 'MES';

    if (isXml) {

      const pk = await vscode.window.showInputBox({

        prompt: 'Jira Project Key (e.g. MES)',

        value: 'MES',

        ignoreFocusOut: true,

      });

      if (pk === undefined) return;

      projectKey = pk;

    }



    const ext = isXml ? 'xml' : 'csv';

    const defaultName = cases.length === 1 ? `${cases[0].id}_zephyr.${ext}` : `zephyr_testcases.${ext}`;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const defaultUri = workspaceRoot

      ? vscode.Uri.file(path.join(workspaceRoot, '.qaforge', defaultName))

      : undefined;



    const saveUri = await vscode.window.showSaveDialog({

      defaultUri,

      filters: isXml

        ? { 'Zephyr Scale XML (*.xml)': ['xml'] }

        : { 'Excel CSV (*.csv)': ['csv'] },

      title: `Export Test Cases to Jira Zephyr (${isXml ? 'XML' : 'CSV'})`,

    });

    if (!saveUri) return;



    const content = isXml

      ? testCasesToZephyrXml(cases, storage, { folder, projectKey, resolvedVariables, useEnvironmentValues })

      : testCasesToZephyrExcel(cases, storage, { folder, resolvedVariables, useEnvironmentValues });

    fs.writeFileSync(saveUri.fsPath, content, 'utf8');



    const totalSteps = cases.reduce((acc, c) => acc + (c.steps?.length || 0), 0);

    const act = await vscode.window.showInformationMessage(

      `QAForge: Exported ${cases.length} test case(s) (${totalSteps} steps) to Zephyr ${isXml ? 'XML' : 'CSV'}.`,

      `Open ${isXml ? 'XML' : 'CSV'}`,

      'Reveal in Explorer',

    );

    if (act === `Open ${isXml ? 'XML' : 'CSV'}`) {

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



  
  reg('qaforge.saveReportAs', (file?: string | QItem) =>
    guard(async () => {
      let sourcePath = typeof file === 'string' ? file : file?.fsPath;
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        sourcePath = path.join(storage.reportsDir, 'last.html');
      }
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        vscode.window.showWarningMessage('No report file available to save.');
        return;
      }

      // If source is a directory (e.g. user right-clicked a report group folder)
      if (fs.statSync(sourcePath).isDirectory()) {
        const findHtml = (dir: string): string[] => {
          let res: string[] = [];
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) res = res.concat(findHtml(p));
            else if (entry.name.endsWith('.html')) res.push(p);
          }
          return res;
        };
        const htmlFiles = findHtml(sourcePath).sort().reverse();
        if (htmlFiles.length > 0) {
          sourcePath = htmlFiles[0];
        } else {
          vscode.window.showWarningMessage('No report files found in this group.');
          return;
        }
      }

      const defaultName = path.basename(sourcePath);
      const defaultUri = vscode.Uri.file(
        path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(), defaultName),
      );

      const destUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: {
          'HTML Report (*.html)': ['html'],
          'JSON Report (*.json)': ['json'],
          'JUnit XML (*.xml)': ['xml'],
          'All Files (*.*)': ['*'],
        },
        title: 'Save Execution Report As',
      });

      if (!destUri) return;

      const ext = path.extname(destUri.fsPath).toLowerCase();
      let actualSource = sourcePath;

      if (ext === '.json') {
        const jsonCompanion = sourcePath.replace(/\.html$/, '.json');
        if (fs.existsSync(jsonCompanion)) {
          actualSource = jsonCompanion;
        } else {
          const lastJson = path.join(storage.reportsDir, 'last.json');
          if (fs.existsSync(lastJson)) actualSource = lastJson;
        }
      } else if (ext === '.xml') {
        const lastXml = path.join(storage.reportsDir, 'last.junit.xml');
        if (fs.existsSync(lastXml)) actualSource = lastXml;
      }

      fs.copyFileSync(actualSource, destUri.fsPath);

      const action = await vscode.window.showInformationMessage(
        `Report saved successfully to: ${path.basename(destUri.fsPath)}`,
        'Open File',
        'Reveal in OS',
      );
      if (action === 'Open File') {
        void vscode.commands.executeCommand('vscode.open', destUri);
      } else if (action === 'Reveal in OS') {
        void vscode.commands.executeCommand('revealFileInOS', destUri);
      }
    }),
  );

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



  reg('qaforge.openStepRequest', (item?: QItem) => {

    if (!item) return;

    if (fs.existsSync(item.fsPath) && item.fsPath.endsWith('.json')) {

      openFile(item.fsPath);

    } else if (item.testCasePath) {

      vscode.window.showTextDocument(vscode.Uri.file(item.testCasePath));

    }

  });



  reg('qaforge.runStep', async (item?: QItem) => {

    if (!item || item.stepIndex === undefined || !item.testCasePath) return;

    const tc = storage.readTestCase(item.testCasePath);

    const step = tc.steps[item.stepIndex];

    if (!step) return;



    const out = vscode.window.createOutputChannel('QAForge Step Execution');

    out.show(true);

    out.appendLine(`=======================================================`);

    out.appendLine(`QAForge ▶ Running Step [${item.stepIndex + 1}/${tc.steps.length}]`);

    out.appendLine(`Test Case: ${tc.id} - ${tc.title}`);

    out.appendLine(`Step Name: ${step.name}`);

    out.appendLine(`Layer:     ${step.layer ?? 'N/A'}`);

    out.appendLine(`Request:   ${step.request ?? '(manual step)'}`);

    out.appendLine(`Time:      ${new Date().toLocaleTimeString()}`);

    out.appendLine(`=======================================================`);



    if (step.manual || !step.request) {

      out.appendLine(`ℹ Manual step: ${step.name}`);

      if (step.expected) out.appendLine(`Expected: ${step.expected}`);

      vscode.window.showInformationMessage(`Manual step: ${step.name}`);

      return;

    }



    const file = resolveStepFile(storage, step.request);

    if (!file) {

      const err = `Step request not found: "${step.request}"`;

      out.appendLine(`✘ Error: ${err}`);

      vscode.window.showErrorMessage(err);

      return;

    }



    const envName = getEnv();

    const baseVars = await vars.resolve(envName);

    const executionVars = {

      __qaforgeRoot: storage.root,

      ...baseVars,

      ...(tc.variables ?? {}),

    };



    out.appendLine(`Environment: ${envName ?? 'No environment'}`);

    out.appendLine(`Active Runtime Variables before step: ${Object.keys(runtime).length}`);



    const t0 = Date.now();

    try {

      const result = await runRequestFile(storage, file, executionVars, runtime);

      const duration = Date.now() - t0;



      out.appendLine(`Status:    ${result.status || 'N/A'} (${duration}ms)`);

      out.appendLine(`Passed:    ${result.passed ? '✔ YES' : '✘ NO'}`);



      if (result.tests && result.tests.length) {

        out.appendLine(`\nAssertions (${result.tests.length}):`);

        for (const t of result.tests) {

          out.appendLine(`  ${t.passed ? '✔' : '✘'} ${t.name}${t.error ? ' -> ' + t.error : ''}`);

        }

      }



      if (result.logs && result.logs.length) {

        out.appendLine(`\nLogs:`);

        for (const l of result.logs) out.appendLine(`  [log] ${l}`);

      }



      if (result.error) {

        out.appendLine(`\nError: ${result.error}`);

      }



      varsProvider.refresh();



      if (result.passed) {

        vscode.window.showInformationMessage(`✔ Step ${item.stepIndex + 1} Passed: ${step.name} (${duration}ms)`);

      } else {

        vscode.window.showErrorMessage(`✘ Step ${item.stepIndex + 1} Failed: ${step.name} (${result.error || 'Assertions failed'})`);

      }

    } catch (err: any) {

      out.appendLine(`\n✘ Exception: ${err.message || String(err)}`);

      vscode.window.showErrorMessage(`Step execution error: ${err.message || String(err)}`);

    }

  });



  reg('qaforge.runFromStep', async (item?: QItem) => {

    if (!item || item.stepIndex === undefined || !item.testCasePath) return;

    const tc = storage.readTestCase(item.testCasePath);

    const startIndex = item.stepIndex;

    const total = tc.steps.length;



    const out = vscode.window.createOutputChannel('QAForge Step Execution');

    out.show(true);

    out.appendLine(`=======================================================`);

    out.appendLine(`QAForge ▶ Running Steps from [${startIndex + 1}/${total}] to end`);

    out.appendLine(`Test Case: ${tc.id} - ${tc.title}`);

    out.appendLine(`Time:      ${new Date().toLocaleTimeString()}`);

    out.appendLine(`=======================================================`);



    const envName = getEnv();

    const baseVars = await vars.resolve(envName);

    const executionVars = {

      __qaforgeRoot: storage.root,

      ...baseVars,

      ...(tc.variables ?? {}),

    };



    let allPassed = true;

    for (let i = startIndex; i < total; i++) {

      const step = tc.steps[i];

      if (step.manual || !step.request) {

        out.appendLine(`ℹ [${i + 1}/${total}] Manual step: ${step.name}`);

        continue;

      }



      const file = resolveStepFile(storage, step.request);

      if (!file) {

        out.appendLine(`✘ [${i + 1}/${total}] Step file not found: ${step.request}`);

        allPassed = false;

        break;

      }



      const t0 = Date.now();

      try {

        const r = await runRequestFile(storage, file, executionVars, runtime);

        const duration = Date.now() - t0;

        varsProvider.refresh();

        const passIcon = r.passed ? '✔' : '✘';

        out.appendLine(`${passIcon} [${i + 1}/${total}] ${step.name} [Status ${r.status || 'ERR'} in ${duration}ms]`);

        if (!r.passed) {

          allPassed = false;

          if (r.error) out.appendLine(`  Error: ${r.error}`);

          if (r.tests) {

            for (const t of r.tests.filter((x) => !x.passed)) {

              out.appendLine(`  Failed test: ${t.name} -> ${t.error || ''}`);

            }

          }

          if (tc.stopOnFailure !== false) {

            out.appendLine(`\n⏹ Stopped on failure at step ${i + 1}.`);

            break;

          }

        }

      } catch (err: any) {

        allPassed = false;

        out.appendLine(`✘ [${i + 1}/${total}] Exception: ${err.message || String(err)}`);

        break;

      }

    }



    if (allPassed) {

      vscode.window.showInformationMessage(`✔ Steps ${startIndex + 1}-${total} completed successfully!`);

    } else {

      vscode.window.showErrorMessage(`✘ Step execution failed during steps ${startIndex + 1}-${total}.`);

    }

  });



  const stepTestCase = async (targetTcPath?: string, initialStepIdx: number = 0) => {

    let tcPath = targetTcPath;

    if (!tcPath) {

      const allCases = collectTestCaseFiles(storage);

      if (allCases.length === 0) {

        vscode.window.showWarningMessage('QAForge: No test cases found.');

        return;

      }

      const picks = allCases.map((f) => {

        try {

          const tc = storage.readTestCase(f);

          return { label: `${tc.id} ${tc.title}`, description: `${tc.steps?.length || 0} steps`, path: f };

        } catch {

          return { label: path.basename(f, '.json'), description: '', path: f };

        }

      });

      const selected = await vscode.window.showQuickPick(picks, { placeHolder: 'Select Test Case to run step-by-step', title: 'QAForge Step Debugger' });

      if (!selected) return;

      tcPath = selected.path;

    }



    const tc = storage.readTestCase(tcPath);

    if (!tc.steps || tc.steps.length === 0) {

      vscode.window.showWarningMessage(`Test case "${tc.id}" has no steps defined.`);

      return;

    }



    const out = vscode.window.createOutputChannel('QAForge Step Debugger');

    out.show(true);

    out.appendLine(`=======================================================`);

    out.appendLine(`QAForge ▶ Step-by-Step Debugger Session Started`);

    out.appendLine(`Test Case: ${tc.id} - ${tc.title}`);

    out.appendLine(`Total Steps: ${tc.steps.length}`);

    out.appendLine(`Environment: ${getEnv() ?? 'No environment'}`);

    out.appendLine(`=======================================================\n`);



    let currentIdx = Math.max(0, Math.min(initialStepIdx, tc.steps.length - 1));



    const resolveVars = async () => {

      const baseVars = await vars.resolve(getEnv());

      return {

        __qaforgeRoot: storage.root,

        ...baseVars,

        ...(tc.variables ?? {}),

      };

    };



    while (currentIdx < tc.steps.length) {

      const step = tc.steps[currentIdx];

      const stepNum = currentIdx + 1;

      const stepTotal = tc.steps.length;

      const layerTag = step.layer ? `[${step.layer}]` : '';



      const quickPickItems = [

        {

          label: `$(play) Execute Step ${stepNum}: ${step.name}`,

          description: `${layerTag} Run this step now`,

          action: 'run',

        },

        {

          label: `$(refresh) Retry Step ${stepNum}`,

          description: `Re-execute step with current runtime state`,

          action: 'retry',

        },

        {

          label: `$(debug-step-skip) Skip Step ${stepNum}`,

          description: `Advance to next step without running`,

          action: 'skip',

        },

        {

          label: `$(play-circle) Run Remaining Steps (${stepNum} → ${stepTotal})`,

          description: `Run automatically to the end`,

          action: 'run-remaining',

        },

        {

          label: `$(go-to-file) Open Step in Editor`,

          description: step.request ?? 'View definition',

          action: 'open',

        },

        {

          label: `$(symbol-variable) View Active Runtime Variables (${Object.keys(runtime).length} active)`,

          description: `Inspect values currently captured in memory`,

          action: 'vars',

        },

        {

          label: `$(debug-stop) Stop Debugger Session`,

          description: `Keep captured variables and exit session`,

          action: 'stop',

        },

      ];



      const pick = await vscode.window.showQuickPick(quickPickItems, {

        title: `QAForge Stepper [${stepNum}/${stepTotal}]: ${tc.id}`,

        placeHolder: `Next action for: ${step.name} (${step.layer ?? 'Step'})`,

        ignoreFocusOut: true,

      });



      if (!pick || pick.action === 'stop') {

        out.appendLine(`\n⏹ Stepper session stopped at step ${stepNum}. Runtime variables preserved.`);

        break;

      }



      if (pick.action === 'skip') {

        out.appendLine(`⏭ Skipped Step ${stepNum}: ${step.name}`);

        currentIdx++;

        continue;

      }



      if (pick.action === 'open') {

        const file = resolveStepFile(storage, step.request);

        if (file) openFile(file);

        else vscode.window.showTextDocument(vscode.Uri.file(tcPath));

        continue;

      }



      if (pick.action === 'vars') {

        const varKeys = Object.keys(runtime);

        if (varKeys.length === 0) {

          vscode.window.showInformationMessage('QAForge: No runtime variables captured yet.');

        } else {

          const varItems = varKeys.map((k) => ({

            label: k,

            description: String(runtime[k]).slice(0, 80),

          }));

          await vscode.window.showQuickPick(varItems, {

            title: `Active Runtime Variables (${varKeys.length})`,

            placeHolder: 'Press Esc to return to stepper',

          });

        }

        continue;

      }



      if (pick.action === 'run-remaining') {

        out.appendLine(`\n▶ Running remaining steps from ${stepNum} to ${stepTotal}...`);

        const executionVars = await resolveVars();

        for (let j = currentIdx; j < tc.steps.length; j++) {

          const s = tc.steps[j];

          if (s.manual || !s.request) {

            out.appendLine(`ℹ [${j + 1}/${stepTotal}] Manual step: ${s.name} (skipped in automated run)`);

            continue;

          }

          const f = resolveStepFile(storage, s.request);

          if (!f) {

            out.appendLine(`✘ [${j + 1}/${stepTotal}] Request file not found: ${s.request}`);

            break;

          }

          const t0 = Date.now();

          const r = await runRequestFile(storage, f, executionVars, runtime);

          varsProvider.refresh();

          const passIcon = r.passed ? '✔' : '✘';

          out.appendLine(`${passIcon} [${j + 1}/${stepTotal}] ${s.name} [${r.status || 'ERR'} in ${Date.now() - t0}ms]`);

          if (!r.passed) {

            out.appendLine(`  Error: ${r.error || 'Assertions failed'}`);

            if (tc.stopOnFailure !== false) {

              out.appendLine(`⏹ Stopped on failure at step ${j + 1}.`);

              break;

            }

          }

        }

        break;

      }



      if (pick.action === 'run' || pick.action === 'retry') {

        out.appendLine(`-------------------------------------------------------`);

        out.appendLine(`▶ Executing [${stepNum}/${stepTotal}]: ${step.name}`);

        out.appendLine(`Layer:     ${step.layer ?? 'N/A'}`);

        out.appendLine(`Request:   ${step.request ?? '(manual step)'}`);



        if (step.manual || !step.request) {

          out.appendLine(`ℹ Manual Step: ${step.name}`);

          if (step.expected) out.appendLine(`Expected: ${step.expected}`);

          const act = await vscode.window.showInformationMessage(

            `Manual Step [${stepNum}/${stepTotal}]: ${step.name}\n${step.expected ?? ''}`,

            'Mark Passed & Continue',

            'Skip',

            'Stop',

          );

          if (act === 'Mark Passed & Continue') currentIdx++;

          else if (act === 'Skip') currentIdx++;

          else break;

          continue;

        }



        const file = resolveStepFile(storage, step.request);

        if (!file) {

          out.appendLine(`✘ Error: Request file not found at "${step.request}"`);

          vscode.window.showErrorMessage(`Request file not found: ${step.request}`);

          continue;

        }



        const executionVars = await resolveVars();

        const t0 = Date.now();

        try {

          const r = await runRequestFile(storage, file, executionVars, runtime);

          const duration = Date.now() - t0;

          varsProvider.refresh();



          out.appendLine(`Result:    ${r.passed ? '✔ PASSED' : '✘ FAILED'} [Status ${r.status || 'ERR'} in ${duration}ms]`);



          if (r.tests && r.tests.length) {

            for (const t of r.tests) {

              out.appendLine(`  ${t.passed ? '✔' : '✘'} ${t.name}${t.error ? ' -> ' + t.error : ''}`);

            }

          }

          if (r.logs && r.logs.length) {

            for (const l of r.logs) out.appendLine(`  [log] ${l}`);

          }

          if (r.error) {

            out.appendLine(`  Error: ${r.error}`);

          }



          if (r.passed) {

            vscode.window.showInformationMessage(`✔ Step ${stepNum} Passed (${duration}ms)`);

            currentIdx++;

          } else {

            vscode.window.showErrorMessage(`✘ Step ${stepNum} Failed: ${r.error || 'Assertions failed'}`);

          }

        } catch (err: any) {

          out.appendLine(`✘ Exception: ${err.message || String(err)}`);

          vscode.window.showErrorMessage(`Execution error on step ${stepNum}: ${err.message}`);

        }

      }

    }



    if (currentIdx >= tc.steps.length) {

      out.appendLine(`\n=======================================================`);

      out.appendLine(`🎉 All ${tc.steps.length} steps in "${tc.id}" completed!`);

      out.appendLine(`=======================================================`);

      vscode.window.showInformationMessage(`QAForge: All steps in "${tc.id}" completed!`);

    }

  };



  reg('qaforge.stepTestCase', (item?: QItem) => {

    if (item && item.kind === 'testcase') {

      stepTestCase(item.fsPath, 0);

    } else if (item && item.kind === 'step' && item.testCasePath) {

      stepTestCase(item.testCasePath, item.stepIndex ?? 0);

    } else {

      stepTestCase();

    }

  });



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



    reg('qaforge.checkEnvironment', () =>
    guard(async () => {
      const envName = getEnv();
      const resolved = await vars.resolve(envName);
      const out = vscode.window.createOutputChannel('QAForge Environment Health');
      out.show(true);
      out.appendLine(`=======================================================`);
      out.appendLine(`QAForge ▶ Environment Health Check: [${envName ?? 'No Environment'}]`);
      out.appendLine(`Timestamp: ${new Date().toLocaleString()}`);
      out.appendLine(`=======================================================`);

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `QAForge: Running Health Check on [${envName ?? 'No Environment'}]...`,
          cancellable: false,
        },
        async () => {
          const report = await checkEnvironmentHealth(storage, envName, resolved);
          for (const item of report.items) {
            const icon = item.status === 'pass' ? '✔' : item.status === 'warn' ? '⚠' : '✘';
            const latency = item.latencyMs ? ` [${item.latencyMs}ms]` : '';
            out.appendLine(`${icon} [${item.category.toUpperCase()}] ${item.name} (${item.target})${latency}`);
            out.appendLine(`   ${item.message}`);
          }
          out.appendLine(`=======================================================`);
          out.appendLine(`Overall Health: ${report.passed ? '✔ ALL CHECKS PASSED' : '✘ ISSUES DETECTED'}`);
          out.appendLine(`=======================================================`);

          if (report.passed) {
            vscode.window.showInformationMessage(`QAForge: Environment [${envName ?? 'Default'}] is healthy! All checks passed.`);
          } else {
            vscode.window.showWarningMessage(`QAForge: Environment [${envName ?? 'Default'}] has connection issues or warnings. Check Output.`);
          }
        },
      );
    }),
  );

  reg('qaforge.compareEnvironments', () =>
    guard(async () => {
      const envs = storage.listEnvironments().map((e) => e.name);
      if (envs.length < 2) {
        vscode.window.showWarningMessage('QAForge: Need at least 2 environments to compare.');
        return;
      }
      const envA = await vscode.window.showQuickPick(envs, { placeHolder: 'Select first environment (Baseline)' });
      if (!envA) return;
      const envB = await vscode.window.showQuickPick(envs.filter((e) => e !== envA), { placeHolder: 'Select second environment to compare against' });
      if (!envB) return;

      const report = compareEnvironments(storage, envA, envB);
      const out = vscode.window.createOutputChannel('QAForge Environment Diff');
      out.show(true);
      out.appendLine(`=======================================================`);
      out.appendLine(`QAForge ▶ Environment Drift & Diff: [${envA}] vs [${envB}]`);
      out.appendLine(`=======================================================`);

      let diffCount = 0;
      for (const item of report.items) {
        if (item.status === 'different') {
          diffCount++;
          out.appendLine(`~ [DIFFERENT] ${item.key}:`);
          out.appendLine(`    ${envA}: "${item.envAValue}"`);
          out.appendLine(`    ${envB}: "${item.envBValue}"`);
        } else if (item.status === 'only_in_a') {
          diffCount++;
          out.appendLine(`- [MISSING IN ${envB}] ${item.key}: "${item.envAValue}"`);
        } else if (item.status === 'only_in_b') {
          diffCount++;
          out.appendLine(`+ [ONLY IN ${envB}] ${item.key}: "${item.envBValue}"`);
        }
      }
      if (diffCount === 0) {
        out.appendLine(`✔ Both environments have identical variable names and values!`);
      } else {
        out.appendLine(`-------------------------------------------------------`);
        out.appendLine(`Found ${diffCount} differences/drift between [${envA}] and [${envB}].`);
      }
      out.appendLine(`=======================================================`);
      vscode.window.showInformationMessage(`QAForge: Found ${diffCount} difference(s) between [${envA}] and [${envB}].`);
    }),
  );

  reg('qaforge.publishZephyr', () =>
    guard(async () => {
      const lastReportJson = path.join(storage.reportsDir, 'last.json');
      if (!fs.existsSync(lastReportJson)) {
        vscode.window.showWarningMessage('QAForge: No execution results found. Run a test case or suite first.');
        return;
      }

      let cases: CaseResult[] = [];
      try {
        const data = JSON.parse(fs.readFileSync(lastReportJson, 'utf8'));
        cases = data.cases || [];
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed reading last.json report: ${err.message}`);
        return;
      }

      if (cases.length === 0) {
        vscode.window.showWarningMessage('QAForge: No test cases recorded in the last report.');
        return;
      }

      const envVars = await vars.resolve(getEnv());
      const defaultJiraUrl = envVars.JIRA_URL || 'https://jira.aligntech.com';
      const jiraUrl = await vscode.window.showInputBox({
        prompt: 'Jira Base URL',
        value: defaultJiraUrl,
        ignoreFocusOut: true,
      });
      if (!jiraUrl) return;

      const projectKey = await vscode.window.showInputBox({
        prompt: 'Jira Project Key (e.g. MES)',
        value: 'MES',
        ignoreFocusOut: true,
      });
      if (!projectKey) return;

      let apiToken = await ctx.secrets.get('qaforge/global/JIRA_API_TOKEN');
      if (!apiToken) {
        const entered = await vscode.window.showInputBox({
          prompt: 'Jira Personal Access Token (PAT)',
          password: true,
          ignoreFocusOut: true,
        });
        if (!entered) return;
        apiToken = entered;
        await ctx.secrets.store('qaforge/global/JIRA_API_TOKEN', apiToken);
      }

      const cycleName = await vscode.window.showInputBox({
        prompt: 'Test Cycle / Run Name',
        value: `QAForge Automated Run - ${new Date().toISOString().slice(0, 10)}`,
        ignoreFocusOut: true,
      });
      if (!cycleName) return;

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `QAForge: Publishing ${cases.length} test case(s) to Jira Zephyr Scale...`,
          cancellable: false,
        },
        async () => {
          const res = await publishResultsToZephyr(cases, {
            jiraBaseUrl: jiraUrl,
            apiToken: apiToken!,
            projectKey,
            cycleName,
            environment: getEnv(),
          });
          if (res.ok) {
            const act = await vscode.window.showInformationMessage(
              `QAForge: Published ${res.casesPublished} test cases to Zephyr Test Run [${res.testRunKey ?? cycleName}].`,
              res.testRunUrl ? 'Open in Jira' : 'OK',
            );
            if (act === 'Open in Jira' && res.testRunUrl) {
              await vscode.env.openExternal(vscode.Uri.parse(res.testRunUrl));
            }
          } else {
            vscode.window.showErrorMessage(`QAForge: Failed publishing to Zephyr: ${res.error}`);
          }
        },
      );
    }),
  );

  reg('qaforge.addStepToTestCase', (item?: QItem) =>
    guard(async () => {
      if (!item || !item.fsPath.endsWith('.json')) return;
      const allCases = collectTestCaseFiles(storage);
      if (allCases.length === 0) {
        vscode.window.showWarningMessage('QAForge: No test cases found in .qaforge/testcases.');
        return;
      }
      const picks = allCases.map((f) => {
        try {
          const tc = storage.readTestCase(f);
          return { label: `${tc.id} ${tc.title}`, path: f };
        } catch {
          return { label: path.basename(f, '.json'), path: f };
        }
      });
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Select target Test Case to append step to' });
      if (!chosen) return;

      const tc = storage.readTestCase(chosen.path);
      const req = storage.readRequest(item.fsPath);
      const relPath = path.relative(storage.collectionsDir, item.fsPath).replace(/\\/g, '/');

      let layer = 'Cloud API';
      if (req.kind === 'sql') layer = 'SQL Server';
      else if (req.kind === 'fileDrop') layer = 'Filesystem';
      else if (req.kind === 'script') layer = 'Script';

      const stepName = `Step ${String((tc.steps?.length || 0) + 1).padStart(2, '0')}: ${req.name}`;
      if (!tc.steps) tc.steps = [];
      tc.steps.push({
        name: stepName,
        layer,
        request: relPath,
      });

      storage.saveTestCase(chosen.path, tc);
      casesProvider.refresh();
      vscode.window.showInformationMessage(`QAForge: Appended step "${stepName}" to ${tc.id}!`);
    }),
  );

  reg('qaforge.newFileDropRequest', (item?: QItem) =>
    guard(async () => {
      if (!item) return;
      const name = await ask('Mule / Simulator Drop step name (e.g. Drop Mule Order JSON)');
      if (!name) return;
      const file = storage.createRequest(item.fsPath, name);
      const def = storage.readRequest(file);
      def.kind = 'fileDrop';
      def.fileDrop = {
        targetDir: '{{muleInbox}}',
        templateFile: 'PALATAL_EXPANDER_PALATAL_EXPANDER_with_Scan.json',
        filename: '{{SO}}_PALATAL_EXPANDER.json',
        envelope: 'auto',
        generateLot: true,
      };
      def.assertions = [
        { enabled: true, source: 'status', path: '', op: 'eq', expected: '200' },
        { enabled: true, source: 'body', path: 'ok', op: 'eq', expected: 'true' },
      ];
      storage.saveRequest(file, def);
      refreshAll();
      openFile(file);
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



export function deactivate() {
  closeAllSqlPools().catch(() => undefined);
}





