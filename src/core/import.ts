import * as fs from 'fs';
import * as path from 'path';
import { parseBruEnvironment, parseBruRequest } from './bru';
import type { Storage } from './storage';

export interface ImportSummary {
  collection: string;
  requests: number;
  environments: number;
  warnings: string[];
}

export function importBruno(srcDir: string, storage: Storage): ImportSummary {
  // If the user selected the parent directory that contains a subfolder with bruno.json
  const subEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const brunoSub = subEntries.find((e) => e.isDirectory() && fs.existsSync(path.join(srcDir, e.name, 'bruno.json')));
  const effectiveSrc = brunoSub ? path.join(srcDir, brunoSub.name) : srcDir;

  const summary: ImportSummary = { collection: path.basename(effectiveSrc), requests: 0, environments: 0, warnings: [] };
  const destRoot = storage.createDir(storage.collectionsDir, summary.collection);

  const walk = (src: string, dest: string) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(src, e.name);
      if (e.isDirectory()) {
        if (src === srcDir && e.name === 'environments') continue;
        const sub = path.join(dest, e.name);
        fs.mkdirSync(sub, { recursive: true });
        walk(full, sub);
      } else if (e.name.endsWith('.bru')) {
        if (e.name === 'folder.bru' || e.name === 'collection.bru') {
          summary.warnings.push(`${path.relative(srcDir, full)}: folder/collection-level settings skipped`);
          continue;
        }
        const base = path.basename(e.name, '.bru');
        const parsed = parseBruRequest(fs.readFileSync(full, 'utf8'), base);
        if (!parsed) {
          summary.warnings.push(`${path.relative(srcDir, full)}: not an HTTP request, skipped`);
          continue;
        }
        storage.saveRequest(path.join(dest, `${base}.json`), parsed.request);
        summary.warnings.push(...parsed.warnings);
        summary.requests++;
      }
    }
  };
  walk(srcDir, destRoot);

  const envDir = path.join(srcDir, 'environments');
  if (fs.existsSync(envDir)) {
    for (const f of fs.readdirSync(envDir).filter((x) => x.endsWith('.bru'))) {
      const name = path.basename(f, '.bru');
      const vars = parseBruEnvironment(fs.readFileSync(path.join(envDir, f), 'utf8'));
      storage.saveEnvironment({ name, variables: vars });
      summary.environments++;
    }
  }
  return summary;
}

