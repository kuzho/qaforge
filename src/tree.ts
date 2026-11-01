import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Storage } from './core/storage';
import { collectTestCaseFiles } from './core/suite';

export type ItemKind = 'collection' | 'folder' | 'request' | 'testcase' | 'variable' | 'report';

export class QItem extends vscode.TreeItem {
  constructor(
    public readonly fsPath: string,
    public readonly kind: ItemKind,
    label: string,
    method?: string,
  ) {
    super(
      label,
      kind === 'request' || kind === 'testcase' || kind === 'variable' || kind === 'report'
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = kind;
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
    } else if (kind === 'request') {
      this.description = method;
      this.iconPath = new vscode.ThemeIcon(method === 'SQL' ? 'database' : 'symbol-event');
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
          method = req.kind === 'sql' ? 'SQL' : req.method;
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

  getChildren(): QItem[] {
    return collectTestCaseFiles(this.storage).map((file) => {
      let label = path.basename(file, '.json');
      let desc = '';
      try {
        const tc = this.storage.readTestCase(file);
        label = `${tc.id} ${tc.title}`;
        desc = tc.priority ?? '';
      } catch { /* malformed */ }
      return new QItem(file, 'testcase', label, desc);
    });
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

  getChildren(): QItem[] {
    const items: QItem[] = [];
    const histDir = this.storage.historyDir;
    if (!fs.existsSync(histDir)) {
      items.push(new QItem(this.storage.reportsDir, 'report', '(No run history yet)', ''));
      return items;
    }

    const files = fs
      .readdirSync(histDir)
      .filter((f) => f.endsWith('.html'))
      .sort((a, b) => b.localeCompare(a)); // Newest first

    for (const f of files) {
      const full = path.join(histDir, f);
      // New format: 2026-11-01T02-37-59-426Z_FAIL_TC-IPE-001_0of1.html
      // Legacy format: 2026-11-01T02-37-59-426Z_FAIL_0of1.html
      const withoutExt = f.slice(0, -5);
      const parts = withoutExt.split('_');
      const timePart = parts[0] || '';
      const verdict = parts[1] || '';
      let targetName = '';
      let score = '';

      if (parts.length >= 4) {
        targetName = parts.slice(2, parts.length - 1).join('_');
        score = parts[parts.length - 1];
      } else if (parts.length === 3) {
        score = parts[2];
      }

      // If json companion exists, read suite info if needed
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

      // Apply search filter if active
      if (this.filterQuery) {
        const textToMatch = `${targetName} ${verdict} ${timePart} ${score}`.toLowerCase();
        if (!textToMatch.includes(this.filterQuery)) continue;
      }

      // Format timestamp: "2026-11-01 02:37:59"
      const dateFormatted = timePart.slice(0, 19).replace('T', ' ').replace(/-/g, (match, offset) => offset > 10 ? ':' : match);
      const isPass = verdict.toUpperCase() === 'PASS';
      const icon = isPass ? '✔' : '✘';
      const displayTarget = targetName ? `[${targetName}] ` : '';
      const displayScore = score ? ` (${score})` : '';
      const label = `${icon} ${displayTarget}${dateFormatted}${displayScore}`.trim();
      items.push(new QItem(full, 'report', label, verdict || 'Report'));
    }

    if (items.length === 0) {
      const msg = this.filterQuery ? `(No reports matching "${this.filterQuery}")` : '(No run history yet)';
      items.push(new QItem(this.storage.reportsDir, 'report', msg, ''));
    }

    return items;
  }
}