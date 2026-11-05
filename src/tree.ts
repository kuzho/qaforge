import * as vscode from 'vscode';

import * as fs from 'fs';

import * as path from 'path';

import type { Storage } from './core/storage';

import { collectTestCaseFiles, resolveStepFile } from './core/suite';



export type ItemKind = 'collection' | 'folder' | 'request' | 'testcase' | 'step' | 'variable' | 'report';



export class QItem extends vscode.TreeItem {

  constructor(

    public readonly fsPath: string,

    public readonly kind: ItemKind,

    label: string,

    method?: string,

    public readonly stepIndex?: number,

    public readonly testCasePath?: string,

  ) {

    super(

      label,

      kind === 'testcase' || kind === 'collection' || kind === 'folder'

        ? vscode.TreeItemCollapsibleState.Collapsed

        : vscode.TreeItemCollapsibleState.None,

    );

    this.contextValue = kind === 'step' ? 'testcase_step' : kind;

    this.resourceUri = vscode.Uri.file(fsPath);

    if (kind === 'report') {

      this.description = method;

      const isPass = label.includes('✔') || (method && method.includes('PASS'));

      this.iconPath = new vscode.ThemeIcon(isPass ? 'pass-filled' : 'error');

      this.command = { command: 'qaforge.openReportFile', title: 'Open Report in QAForge', arguments: [fsPath] };

    } else if (kind === 'variable') {

      this.description = method; // used as value preview

      this.iconPath = new vscode.ThemeIcon(method === 'secret' ? 'key' : 'symbol-variable');

    } else if (kind === 'testcase') {

      this.description = method;

      this.iconPath = new vscode.ThemeIcon('beaker');

      this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(fsPath)] };

    } else if (kind === 'step') {

      this.description = method;

      let icon = 'symbol-event';

      const m = (method || '').toLowerCase();

      if (m.includes('sql') || m.includes('db')) icon = 'database';

      else if (m.includes('cloud') || m.includes('api')) icon = 'cloud';

      else if (m.includes('file') || m.includes('script') || m.includes('mule') || m.includes('fs')) icon = 'file-code';

      else if (m.includes('desktop') || m.includes('robot')) icon = 'device-desktop';

      else if (m.includes('manual')) icon = 'checklist';

      this.iconPath = new vscode.ThemeIcon(icon);

      this.command = { command: 'qaforge.openStepRequest', title: 'Open Step Request', arguments: [this] };

    } else if (kind === 'request') {

      this.description = method;

      let rIcon = 'symbol-event';
      if (method === 'SQL') rIcon = 'database';
      else if (method === 'DROP') rIcon = 'package';
      else if (method === 'SCRIPT') rIcon = 'file-code';
      this.iconPath = new vscode.ThemeIcon(rIcon);

      this.command = { command: 'qaforge.openRequest', title: 'Open', arguments: [this] };

    } else {

      this.iconPath = new vscode.ThemeIcon(kind === 'collection' ? 'library' : 'folder');

    }

  }

}



export class CollectionsProvider implements vscode.TreeDataProvider<QItem> {

  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.emitter.event;



  constructor(private readonly storage: Storage) {}



  refresh() {

    this.emitter.fire();

  }



  getTreeItem(el: QItem) {

    return el;

  }



  getChildren(el?: QItem): QItem[] {

    const dir = el ? el.fsPath : this.storage.collectionsDir;

    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    const dirs = entries

      .filter((e) => e.isDirectory())

      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

      .map((e) => new QItem(path.join(dir, e.name), el ? 'folder' : 'collection', e.name));

    const files = entries

      .filter((e) => e.isFile() && e.name.endsWith('.json'))

      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

      .map((e) => {

        const file = path.join(dir, e.name);

        let label = path.basename(e.name, '.json');

        let method = '';

        try {

          const req = this.storage.readRequest(file);

          label = req.name || label;

          method = req.kind === 'sql' ? 'SQL' : req.kind === 'fileDrop' ? 'DROP' : req.kind === 'script' ? 'SCRIPT' : req.method;

        } catch {

          /* ignore malformed file */

        }

        return new QItem(file, 'request', label, method);

      });

    return [...dirs, ...files];

  }

}





export class TestCasesProvider implements vscode.TreeDataProvider<QItem> {

  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.emitter.event;



  constructor(private readonly storage: Storage) {}



  refresh() {

    this.emitter.fire();

  }



  getTreeItem(el: QItem) {

    return el;

  }



  getChildren(el?: QItem): QItem[] {
    if (!el || el.kind === 'folder') {
      const dir = el ? el.fsPath : this.storage.testCasesDir;
      if (!fs.existsSync(dir)) return [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((e) => new QItem(path.join(dir, e.name), 'folder', e.name));
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((e) => {
          const file = path.join(dir, e.name);
          let label = path.basename(e.name, '.json');
          let desc = '';
          try {
            const tc = this.storage.readTestCase(file);
            label = `${tc.id} ${tc.title}`;
            desc = tc.priority ? `[${tc.priority}]` : '';
            if (tc.steps && tc.steps.length) {
              desc = `${desc} (${tc.steps.length} steps)`.trim();
            }
          } catch { /* malformed */ }
          return new QItem(file, 'testcase', label, desc);
        });
      return [...dirs, ...files];
    }

    if (el.kind === 'testcase') {

      try {

        const tc = this.storage.readTestCase(el.fsPath);

        return (tc.steps || []).map((step, idx) => {

          const resolved = resolveStepFile(this.storage, step.request) || el.fsPath;

          let method = step.layer || '';

          if (!method && step.request) {

            try {

              const req = this.storage.readRequest(resolved);

              method = req.kind === 'sql' ? 'SQL' : req.kind === 'script' ? 'script' : req.method;

            } catch {

              method = 'step';

            }

          }

          if (step.manual) method = 'Manual';

          const label = step.name || `Step ${idx + 1}`;

          return new QItem(resolved, 'step', label, method, idx, el.fsPath);

        });

      } catch {

        return [];

      }

    }



    return [];

  }

}



export class VariablesProvider implements vscode.TreeDataProvider<QItem> {

  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.emitter.event;



  constructor(

    private readonly storage: Storage,

    private readonly getEnv: () => string | undefined,

    private readonly runtime: Record<string, string>,

  ) {}



  refresh() {

    this.emitter.fire();

  }



  getTreeItem(el: QItem) {

    return el;

  }



  getChildren(): QItem[] {

    const items: QItem[] = [];

    const envName = this.getEnv();

    const env = this.storage.getEnvironment(envName);

    const globals = this.storage.readGlobals();



    // 1. Runtime Variables (Live from execution)

    const rtKeys = Object.keys(this.runtime);

    if (rtKeys.length > 0) {

      for (const k of rtKeys) {

        items.push(new QItem(path.join(this.storage.root, `runtime_${k}`), 'variable', `⚡ ${k}`, this.runtime[k]));

      }

    }



    // 2. Environment Variables

    if (env) {

      for (const [k, v] of Object.entries(env.variables)) {

        if (!rtKeys.includes(k)) {

          items.push(new QItem(path.join(this.storage.environmentsDir, `${env.name}_${k}`), 'variable', `🌐 ${k}`, v));

        }

      }

      for (const s of env.secrets ?? []) {

        items.push(new QItem(path.join(this.storage.environmentsDir, `${env.name}_secret_${s}`), 'variable', `🔒 ${s}`, 'secret'));

      }

    }



    // 3. Global Variables

    for (const [k, v] of Object.entries(globals.variables)) {

      if (!rtKeys.includes(k) && (!env || !Object.prototype.hasOwnProperty.call(env.variables, k))) {

        items.push(new QItem(path.join(this.storage.root, `global_${k}`), 'variable', `🌍 ${k}`, v));

      }

    }

    for (const s of globals.secrets ?? []) {

      items.push(new QItem(path.join(this.storage.root, `global_secret_${s}`), 'variable', `🔒 ${s} (global)`, 'secret'));

    }



    if (items.length === 0) {

      items.push(new QItem(this.storage.root, 'variable', '(No active variables)', ''));

    }



    return items;

  }

}



interface ReportEntry {
  fullPath: string;
  targetName: string;
  category: 'Test Case' | 'Collection' | 'Suite';
  dateFormatted: string;
  verdict: string;
  score: string;
  isPass: boolean;
  timePart: string;
}

export class ReportsProvider implements vscode.TreeDataProvider<QItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private filterQuery = '';

  constructor(private readonly storage: Storage) {}

  setFilter(query: string) {
    this.filterQuery = query.toLowerCase().trim();
    this.refresh();
  }

  getFilter(): string {
    return this.filterQuery;
  }

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(el: QItem) {
    return el;
  }

  private collectReports(dir: string): ReportEntry[] {
    const entries: ReportEntry[] = [];
    if (!fs.existsSync(dir)) return entries;

    const scan = (currentDir: string, currentCategory?: string, currentTarget?: string) => {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          const lower = item.name.toLowerCase();
          if (lower === 'testcases') {
            scan(full, 'Test Case', currentTarget);
          } else if (lower === 'collections') {
            scan(full, 'Collection', currentTarget);
          } else if (lower === 'suites') {
            scan(full, 'Suite', currentTarget);
          } else {
            const cat = currentCategory || (item.name.startsWith('TC-') ? 'Test Case' : item.name.toLowerCase().includes('suite') ? 'Suite' : 'Collection');
            scan(full, cat, item.name);
          }
        } else if (item.isFile() && item.name.endsWith('.html') && item.name !== 'last.html') {
          const withoutExt = item.name.slice(0, -5);
          const parts = withoutExt.split('_');
          const timePart = parts[0] || '';
          const verdict = parts[1] || '';
          let targetName = currentTarget || '';
          let score = '';

          if (!targetName) {
            if (parts.length >= 4) {
              targetName = parts.slice(2, parts.length - 1).join('_');
              score = parts[parts.length - 1];
            } else if (parts.length === 3) {
              score = parts[2];
            }
          } else {
            score = parts[parts.length - 1] || '';
          }

          if (!targetName) {
            const jsonPath = full.replace(/\.html$/, '.json');
            if (fs.existsSync(jsonPath)) {
              try {
                const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                if (parsed.cases?.[0]?.id) targetName = parsed.cases[0].id;
                else if (parsed.name && parsed.name !== 'QAForge run') targetName = parsed.name;
              } catch { /* ignore */ }
            }
          }

          if (!targetName) targetName = 'General Run';

          const cat: 'Test Case' | 'Collection' | 'Suite' = (currentCategory as any) || (targetName.startsWith('TC-') ? 'Test Case' : targetName.toLowerCase().includes('suite') ? 'Suite' : 'Collection');
          const isPass = verdict.toUpperCase() === 'PASS';
          const dateFormatted = timePart
            .slice(0, 19)
            .replace('T', ' ')
            .replace(/-/g, (match, offset) => (offset > 10 ? ':' : match));

          entries.push({
            fullPath: full,
            targetName,
            category: cat,
            dateFormatted,
            verdict,
            score,
            isPass,
            timePart,
          });
        }
      }
    };

    scan(dir);
    return entries;
  }

  getChildren(element?: QItem): QItem[] {
    const histDir = this.storage.historyDir;
    if (!fs.existsSync(histDir)) {
      return [new QItem(this.storage.reportsDir, 'report', '(No run history yet)', '')];
    }

    const allReports = this.collectReports(histDir);

    const filtered = this.filterQuery
      ? allReports.filter((r) =>
          `${r.targetName} ${r.verdict} ${r.timePart} ${r.score} ${r.category}`
            .toLowerCase()
            .includes(this.filterQuery),
        )
      : allReports;

    if (filtered.length === 0) {
      const msg = this.filterQuery ? `(No reports matching "${this.filterQuery}")` : '(No run history yet)';
      return [new QItem(this.storage.reportsDir, 'report', msg, '')];
    }

    // Child level (inside a group folder)
    if (element) {
      const groupName = element.label as string;
      const groupReports = filtered
        .filter((r) => r.targetName === groupName)
        .sort((a, b) => b.timePart.localeCompare(a.timePart));

      return groupReports.map((r) => {
        const icon = r.isPass ? '✔' : '✘';
        const displayScore = r.score ? ` (${r.score})` : '';
        const itemLabel = `${icon} ${r.dateFormatted}${displayScore}`.trim();
        const item = new QItem(r.fullPath, 'report', itemLabel, r.verdict || 'Report');
        item.description = r.verdict;
        item.contextValue = 'report';
        item.iconPath = new vscode.ThemeIcon(r.isPass ? 'pass-filled' : 'error');
        item.command = { command: 'qaforge.openReportFile', title: 'Open Report in QAForge', arguments: [r.fullPath] };
        return item;
      });
    }

    // Root level: Group by targetName
    const groups = new Map<string, ReportEntry[]>();
    for (const r of filtered) {
      const list = groups.get(r.targetName) || [];
      list.push(r);
      groups.set(r.targetName, list);
    }

    const groupItems: QItem[] = [];
    for (const [targetName, reports] of groups.entries()) {
      reports.sort((a, b) => b.timePart.localeCompare(a.timePart));
      const latest = reports[0];
      const category = latest.category;
      const folderPath = path.dirname(latest.fullPath);

      const groupItem = new QItem(
        folderPath,
        'folder',
        targetName,
        `${category} · ${reports.length} run${reports.length !== 1 ? 's' : ''}`,
      );
      groupItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      groupItem.contextValue = 'report_group';
      groupItem.iconPath = new vscode.ThemeIcon(category === 'Test Case' ? 'checklist' : 'folder');
      groupItems.push(groupItem);
    }

    groupItems.sort((a, b) => {
      const aDesc = (a.description as string) || '';
      const bDesc = (b.description as string) || '';
      if (aDesc.startsWith('Test Case') && !bDesc.startsWith('Test Case')) return -1;
      if (!aDesc.startsWith('Test Case') && bDesc.startsWith('Test Case')) return 1;
      return (a.label as string).localeCompare(b.label as string);
    });

    return groupItems;
  }
}
