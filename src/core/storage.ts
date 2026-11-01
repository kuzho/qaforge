import * as fs from 'fs';
import * as path from 'path';
import { emptyRequest, emptySql, type Environment, type Globals, type RequestDef, type TestCaseDef } from './types';

const safeName = (name: string) => name.trim().replace(/[<>:"/\\|?*]+/g, '-');

export class Storage {
  constructor(private readonly workspaceRoot: string) {}

  get root() {
    return path.join(this.workspaceRoot, '.qaforge');
  }
  get collectionsDir() {
    return path.join(this.root, 'collections');
  }
  get environmentsDir() {
    return path.join(this.root, 'environments');
  }
  get testCasesDir() {
    return path.join(this.root, 'testcases');
  }
  get reportsDir() {
    return path.join(this.root, 'reports');
  }
  get historyDir() {
    return path.join(this.reportsDir, 'history');
  }
  get globalsFile() {
    return path.join(this.root, 'globals.json');
  }

  readGlobals(): Globals {
    try {
      const g = JSON.parse(fs.readFileSync(this.globalsFile, 'utf8')) as Partial<Globals>;
      return { variables: g.variables ?? {}, secrets: g.secrets ?? [] };
    } catch {
      return { variables: {}, secrets: [] };
    }
  }

  saveGlobals(g: Globals) {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.globalsFile, JSON.stringify(g, null, 2) + '\n', 'utf8');
  }

  readTestCase(file: string): TestCaseDef {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TestCaseDef;
  }

  createTestCase(id: string, title: string): string {
    fs.mkdirSync(this.testCasesDir, { recursive: true });
    const file = path.join(this.testCasesDir, `${safeName(id)}.json`);
    if (fs.existsSync(file)) throw new Error(`Test case "${id}" already exists`);
    const tc: TestCaseDef = {
      id,
      title,
      description: '',
      requirement: '',
      priority: 'medium',
      tags: [],
      preconditions: '',
      variables: {},
      stopOnFailure: true,
      steps: [{ name: 'Step 1', request: '', expected: '' }],
    };
    fs.writeFileSync(file, JSON.stringify(tc, null, 2) + '\n', 'utf8');
    return file;
  }

  ensure() {
    fs.mkdirSync(this.collectionsDir, { recursive: true });
    fs.mkdirSync(this.environmentsDir, { recursive: true });
    fs.mkdirSync(this.testCasesDir, { recursive: true });
  }

  createDir(parent: string, name: string): string {
    const dir = path.join(parent, safeName(name));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  createRequest(parent: string, name: string): string {
    const file = path.join(parent, `${safeName(name)}.json`);
    if (fs.existsSync(file)) throw new Error(`"${name}" already exists`);
    this.saveRequest(file, emptyRequest(name));
    return file;
  }

  readRequest(file: string): RequestDef {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RequestDef>;
    const req = { ...emptyRequest(path.basename(file, '.json')), ...raw };
    if (req.kind === 'sql') req.sql = { ...emptySql(), ...raw.sql };
    return req;
  }

  saveRequest(file: string, req: RequestDef) {
    fs.writeFileSync(file, JSON.stringify(req, null, 2) + '\n', 'utf8');
  }

  rename(target: string, newName: string): string {
    const isFile = fs.statSync(target).isFile();
    const dest = path.join(path.dirname(target), safeName(newName) + (isFile ? '.json' : ''));
    if (fs.existsSync(dest)) throw new Error(`"${newName}" already exists`);
    fs.renameSync(target, dest);
    if (isFile) {
      const req = this.readRequest(dest);
      req.name = newName;
      this.saveRequest(dest, req);
    }
    return dest;
  }

  remove(target: string) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  listEnvironments(): Environment[] {
    if (!fs.existsSync(this.environmentsDir)) return [];
    return fs
      .readdirSync(this.environmentsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const env = JSON.parse(fs.readFileSync(path.join(this.environmentsDir, f), 'utf8')) as Environment;
          return { name: env.name ?? path.basename(f, '.json'), variables: env.variables ?? {}, secrets: env.secrets ?? [] };
        } catch {
          return { name: path.basename(f, '.json'), variables: {} };
        }
      });
  }

  getEnvironment(name: string | undefined): Environment | undefined {
    return name ? this.listEnvironments().find((e) => e.name === name) : undefined;
  }

  saveEnvironment(env: Environment): string {
    fs.mkdirSync(this.environmentsDir, { recursive: true });
    const file = path.join(this.environmentsDir, `${safeName(env.name)}.json`);
    fs.writeFileSync(file, JSON.stringify(env, null, 2) + '\n', 'utf8');
    return file;
  }

  createEnvironment(name: string): string {
    const file = path.join(this.environmentsDir, `${safeName(name)}.json`);
    if (fs.existsSync(file)) throw new Error(`Environment "${name}" already exists`);
    const env: Environment = { name, variables: { baseUrl: 'https://httpbin.org' } };
    fs.writeFileSync(file, JSON.stringify(env, null, 2) + '\n', 'utf8');
    return file;
  }
}

