import * as vscode from 'vscode';
import type { Storage } from './core/storage';
import { runRequest } from './core/runner';
import { makeSuite, requestAsCase } from './core/suite';
import { writeReports } from './core/report';
import type { RequestDef } from './core/types';
import type { VarStore } from './vars';
import { aiDiagnoseFailure, aiGenerateAssertions } from './core/ai';

type ToWebview =
  | { type: 'init'; request: RequestDef; environment: string | null }
  | { type: 'env-changed'; environment: string | null }
  | { type: 'response'; result: unknown }
  | { type: 'ai-assertions'; data: { assertions: any[]; captures: any[] } }
  | { type: 'ai-diagnosis'; text: string }
  | { type: 'ai-error'; error: string }
  | { type: 'saved' };

type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; request: RequestDef }
  | { type: 'ai-generate-assertions'; request: RequestDef; response: any }
  | { type: 'ai-diagnose'; request: RequestDef; response: any; failedTests: any[] }
  | { type: 'save'; request: RequestDef };

export class RequestPanel {
  private static panels = new Map<string, RequestPanel>();
  private readonly panel: vscode.WebviewPanel;

  static updateAllEnvironments(envName: string | undefined) {
    for (const panel of RequestPanel.panels.values()) {
      panel.post({ type: 'env-changed', environment: envName ?? null });
    }
  }

  static open(
    ctx: vscode.ExtensionContext,
    storage: Storage,
    file: string,
    getEnv: () => string | undefined,
    vars: VarStore,
    runtime: Record<string, string>,
    onSaved: () => void,
  ) {
    const existing = RequestPanel.panels.get(file);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    new RequestPanel(ctx, storage, file, getEnv, vars, runtime, onSaved);
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly storage: Storage,
    private readonly file: string,
    private readonly getEnv: () => string | undefined,
    private readonly vars: VarStore,
    private readonly runtime: Record<string, string>,
    private readonly onSaved: () => void,
  ) {
    const request = storage.readRequest(file);
    this.panel = vscode.window.createWebviewPanel('qaforge.request', request.name, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
    });
    RequestPanel.panels.set(file, this);
    this.panel.onDidDispose(() => RequestPanel.panels.delete(file));
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
  }

  private post(msg: ToWebview) {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: FromWebview) {
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          request: this.storage.readRequest(this.file),
          environment: this.getEnv() ?? null,
        });
        break;
      case 'save':
        this.storage.saveRequest(this.file, msg.request);
        this.panel.title = msg.request.name;
        this.onSaved();
        this.post({ type: 'saved' });
        break;
      case 'send': {
        const envName = this.getEnv();
        const envVars = await this.vars.resolve(envName);
        const started = Date.now();
        const output = await runRequest(msg.request, envVars, this.runtime, this.storage.root.replace(/[\/\\]\.qaforge$/, ''));
        this.post({ type: 'response', result: output });

        // Register individual execution in history with complete details!
        const singleCase = requestAsCase(
          {
            name: msg.request.name,
            file: this.file,
            passed: output.passed,
            status: output.response.status,
            durationMs: output.response.durationMs,
            tests: output.tests,
            logs: output.logs,
            error: output.response.error,
            responseBody: output.response.body,
            method: output.request?.method || (msg.request.kind === 'sql' ? 'SQL' : msg.request.kind === 'fileDrop' ? 'FILE' : msg.request.method),
            url: output.request?.url || output.response.resolvedUrl,
            requestHeaders: output.request?.headers || output.response.requestHeaders,
            requestBody: output.request?.body || output.response.requestBody,
            responseHeaders: output.response.headers,
          },
          this.storage.collectionsDir,
        );
        const suite = makeSuite(msg.request.name, envName, started, [singleCase]);
        try {
          writeReports(this.storage, suite);
        } catch (e) {
          console.warn('[QAForge] writeReports failed:', e);
        }

        this.onSaved(); // updates variables and reports tree view
        break;
      }
      case 'ai-generate-assertions': {
        try {
          const generated = await aiGenerateAssertions(msg.request, msg.response);
          this.post({ type: 'ai-assertions', data: generated });
        } catch (e) {
          vscode.window.showErrorMessage(`AI error: ${(e as Error).message}`);
          this.post({ type: 'ai-error', error: (e as Error).message });
        }
        break;
      }
      case 'ai-diagnose': {
        try {
          const diagnosis = await aiDiagnoseFailure(msg.request, msg.response, msg.failedTests);
          this.post({ type: 'ai-diagnosis', text: diagnosis });
        } catch (e) {
          vscode.window.showErrorMessage(`AI error: ${(e as Error).message}`);
          this.post({ type: 'ai-error', error: (e as Error).message });
        }
        break;
      }
    }
  }

  private html(): string {
    const wv = this.panel.webview;
    const script = wv.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body><div id="root"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

