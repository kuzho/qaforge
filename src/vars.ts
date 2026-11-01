import * as vscode from 'vscode';
import type { Storage } from './core/storage';
import { resolveVariables } from './core/suite';
import { interpolate } from './core/variables';
import { collectRequestFiles } from './core/suite';

const SECRET_NAME = /(secret|password|passwd|pwd|token|api[-_]?key|private[-_]?key)/i;

const key = (scope: 'global' | 'env', name: string, env?: string) =>
  scope === 'global' ? `qaforge/global/${name}` : `qaforge/env/${env}/${name}`;

/** Resolves globals + environment variables, pulling secret values from VS Code SecretStorage. */
export class VarStore {
  constructor(
    private readonly storage: Storage,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  resolve(envName: string | undefined) {
    return resolveVariables(this.storage, envName, (scope, name, env) => Promise.resolve(this.secrets.get(key(scope, name, env))));
  }

  /** Stores the value in SecretStorage and records the name (never the value) in the JSON file. */
  async setSecret(scope: 'global' | 'env', name: string, value: string, envName?: string) {
    await this.secrets.store(key(scope, name, envName), value);
    if (scope === 'global') {
      const g = this.storage.readGlobals();
      delete g.variables[name];
      if (!g.secrets.includes(name)) g.secrets.push(name);
      this.storage.saveGlobals(g);
    } else {
      const env = this.storage.getEnvironment(envName);
      if (!env) throw new Error(`Environment "${envName}" not found`);
      delete env.variables[name];
      env.secrets = [...new Set([...(env.secrets ?? []), name])];
      this.storage.saveEnvironment(env);
    }
  }

  /**
   * Finds plaintext secrets and moves them to SecretStorage:
   * variables with secret-like names in globals/environments, and literal passwords/tokens/secrets
   * hard-coded in request auth or form bodies (replaced by {{placeholders}}).
   */
  async protect(envName: string | undefined): Promise<number> {
    interface Finding { label: string; apply: () => Promise<void> }
    const findings: Finding[] = [];
    const scopeForRequests: 'global' | 'env' = envName ? 'env' : 'global';

    const g = this.storage.readGlobals();
    for (const [n, v] of Object.entries(g.variables)) {
      if (SECRET_NAME.test(n) && v) findings.push({ label: `global variable ${n}`, apply: () => this.setSecret('global', n, v) });
    }
    for (const env of this.storage.listEnvironments()) {
      for (const [n, v] of Object.entries(env.variables)) {
        if (SECRET_NAME.test(n) && v) findings.push({ label: `environment ${env.name}: ${n}`, apply: () => this.setSecret('env', n, v, env.name) });
      }
    }

    const isLiteral = (v: string) => v.trim() !== '' && !/\{\{.*\}\}/.test(v);
    const pending = new Map<string, { value: string; scope: 'global' | 'env' }>();
    const requests = collectRequestFiles(this.storage.collectionsDir);
    for (const file of requests) {
      let def;
      try { def = this.storage.readRequest(file); } catch { continue; }
      let changed = false;
      const hide = (name: string, value: string) => {
        pending.set(name, { value, scope: scopeForRequests });
        changed = true;
        return `{{${name}}}`;
      };
      if (def.auth.type === 'bearer' && isLiteral(def.auth.token)) def.auth.token = hide('access_token', def.auth.token);
      if (def.auth.type === 'basic' && isLiteral(def.auth.password)) def.auth.password = hide('basic_password', def.auth.password);
      if (def.body.type === 'form') {
        def.body.content = def.body.content
          .split(/\r?\n/)
          .map((line) => {
            const i = line.indexOf('=');
            if (i < 0) return line;
            const k = line.slice(0, i).trim();
            const v = line.slice(i + 1);
            return SECRET_NAME.test(k) && isLiteral(v) ? `${k}=${hide(k, v)}` : line;
          })
          .join('\n');
      }
      if (changed) findings.push({ label: `request ${vscode.workspace.asRelativePath(file)}`, apply: async () => this.storage.saveRequest(file, def) });
    }

    if (findings.length === 0) return 0;
    const picks = await vscode.window.showQuickPick(
      findings.map((f) => ({ label: f.label, picked: true, f })),
      { canPickMany: true, placeHolder: 'Select plaintext secrets to move to SecretStorage' },
    );
    if (!picks?.length) return 0;
    for (const p of picks) await p.f.apply();
    const chosenRequests = picks.some((p) => p.label.startsWith('request '));
    if (chosenRequests) {
      for (const [name, { value, scope }] of pending) await this.setSecret(scope, name, value, envName);
    }
    return picks.length;
  }

  /** Writes the (non-secret) resolved preview used by the "show variables" command. */
  async preview(envName: string | undefined): Promise<string> {
    const vars = await this.resolve(envName);
    const g = this.storage.readGlobals();
    const env = this.storage.getEnvironment(envName);
    const secret = new Set([...g.secrets, ...(env?.secrets ?? [])]);
    return Object.entries(vars)
      .map(([k, v]) => `${k} = ${secret.has(k) ? '******' : interpolate(v, vars)}`)
      .join('\n');
  }
}
