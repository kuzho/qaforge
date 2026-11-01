import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ReportViewerPanel {
  private static currentPanel: ReportViewerPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(ctx: vscode.ExtensionContext, filePath: string) {
    if (!fs.existsSync(filePath)) {
      vscode.window.showErrorMessage(`Report file not found: ${filePath}`);
      return;
    }

    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

    if (ReportViewerPanel.currentPanel) {
      ReportViewerPanel.currentPanel.panel.reveal(column);
      ReportViewerPanel.currentPanel.loadReport(filePath);
      return;
    }

    ReportViewerPanel.currentPanel = new ReportViewerPanel(ctx, filePath, column);
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private currentFilePath: string,
    column: vscode.ViewColumn,
  ) {
    const title = `Report: ${path.basename(currentFilePath, '.html')}`;
    this.panel = vscode.window.createWebviewPanel(
      'qaforge.reportViewer',
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.onDidDispose(() => {
      ReportViewerPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((m) => {
      if (m.type === 'openExternal') {
        void vscode.env.openExternal(vscode.Uri.file(this.currentFilePath));
      }
    });

    this.loadReport(currentFilePath);
  }

  loadReport(filePath: string) {
    this.currentFilePath = filePath;
    this.panel.title = `Report: ${path.basename(filePath, '.html')}`;
    let rawHtml = fs.readFileSync(filePath, 'utf8');

    // Inject a toolbar at the very top of the HTML inside the webview
    const toolbar = `
    <div style="background:#1e1e1e;color:#fff;padding:8px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:13px;position:sticky;top:0;z-index:9999;">
      <div>
        <span>🛡️ <b>QAForge Embedded Viewer</b> &bull; ${path.basename(filePath)}</span>
      </div>
      <div>
        <button onclick="window.vscode.postMessage({type:'openExternal'})" style="background:#0e639c;color:#fff;border:none;padding:5px 12px;border-radius:3px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;">
          <span>🌐 Open in Browser</span>
        </button>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      window.vscode = vscode;
    </script>
    `;

    // Insert toolbar right after <body>
    if (rawHtml.includes('<body')) {
      rawHtml = rawHtml.replace(/<body[^>]*>/i, (match) => `${match}\n${toolbar}`);
    } else {
      rawHtml = `${toolbar}\n${rawHtml}`;
    }

    this.panel.webview.html = rawHtml;
  }
}

