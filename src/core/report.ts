import * as fs from 'fs';
import * as path from 'path';
import type { SuiteResult } from './types';

const esc = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);

const label = (data: Record<string, string>) => {
  const e = Object.entries(data);
  return e.length ? ` [${e.map(([k, v]) => `${k}=${v}`).join(', ')}]` : '';
};

export function toJUnit(s: SuiteResult): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>'];
  for (const c of s.cases) {
    const cases = c.iterations.flatMap((it) =>
      it.steps.map((st) => ({ it, st })),
    );
    const failures = cases.filter(({ st }) => !st.passed && !st.skipped).length;
    const skipped = cases.filter(({ st }) => st.skipped).length;
    out.push(
      `  <testsuite name="${esc(`${c.id} ${c.title}`)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${(c.durationMs / 1000).toFixed(3)}">`,
    );
    for (const { it, st } of cases) {
      const name = `${st.name}${c.iterations.length > 1 ? ` (iteration ${it.index}${label(it.data)})` : ''}`;
      out.push(`    <testcase classname="${esc(c.id)}" name="${esc(name)}" time="${(st.durationMs / 1000).toFixed(3)}">`);
      if (st.skipped) out.push('      <skipped/>');
      else if (!st.passed) {
        const msg = st.error ?? st.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error ?? ''}`).join('; ');
        out.push(`      <failure message="${esc(msg)}">${esc(msg)}</failure>`);
      }
      if (st.logs.length) out.push(`      <system-out>${esc(st.logs.join('\n'))}</system-out>`);
      out.push('    </testcase>');
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>');
  return out.join('\n') + '\n';
}

export function toHtml(s: SuiteResult): string {
  const total = s.cases.length;
  const passed = s.cases.filter((c) => c.passed).length;
  const body = s.cases
    .map((c) => {
      const iters = c.iterations
        .map((it) => {
          const steps = it.steps
            .map((st) => {
              const tests = st.tests
                .map((t) => `<li class="${t.passed ? 'ok' : 'bad'}">${t.passed ? '✔ PASS' : '✘ FAIL'} ${esc(t.name)}${t.error ? ` &mdash; <span class="err">${esc(t.error)}</span>` : ''}</li>`)
                .join('');
              const cls = st.skipped ? 'skip' : st.passed ? 'ok' : 'bad';
              return `<div class="step"><span class="badge ${cls}">${st.skipped ? 'SKIP' : st.passed ? 'PASS' : 'FAIL'}</span> <b>${esc(st.name)}</b> <small class="muted">${st.status || ''} &bull; ${st.durationMs}ms</small>${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}<ul>${tests}</ul></div>`;
            })
            .join('');
          return `<div class="iter"><div class="iter-title"><b>Iteration ${it.index}</b>${esc(label(it.data))} <span class="badge ${it.passed ? 'ok' : 'bad'}">${it.passed ? 'PASSED' : 'FAILED'}</span></div>${steps}</div>`;
        })
        .join('');
      return `<details ${c.passed ? '' : 'open'} class="case-card">
        <summary>
          <span class="badge ${c.passed ? 'ok' : 'bad'}">${c.passed ? 'PASS' : 'FAIL'}</span>
          <span class="case-id">${esc(c.id)}</span>
          <span class="case-title">${esc(c.title)}</span>
          ${c.priority ? `<span class="tag priority-${c.priority}">${esc(c.priority)}</span>` : ''}
          ${c.requirement ? `<span class="tag req">Req: ${esc(c.requirement)}</span>` : ''}
          ${c.manualSteps ? `<span class="tag manual">${c.manualSteps} manual steps</span>` : ''}
          <span class="duration">${c.durationMs}ms</span>
        </summary>
        ${iters}
      </details>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>QAForge - SQA Executive Dossier</title><style>
:root{--ok:#2e7d32;--bad:#c62828;--skip:#757575;--bg:#f8f9fa;--card:#fff;--border:#e0e0e0;--text:#212529}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;margin:0;padding:28px 36px;color:var(--text);background:var(--bg)}
header{background:var(--card);padding:20px 24px;border-radius:8px;border:1px solid var(--border);margin-bottom:24px;display:flex;justify-content:space-between;align-items:center}
h1{margin:0 0 6px;font-size:1.6rem}
.summary-meta{color:#666;font-size:0.95rem}
.badge{padding:3px 8px;border-radius:4px;font-weight:700;font-size:0.8rem;text-transform:uppercase;color:#fff}
.badge.ok{background:var(--ok)}.badge.bad{background:var(--bad)}.badge.skip{background:var(--skip)}
.tag{padding:2px 7px;border-radius:3px;font-size:0.75rem;margin-left:6px;font-weight:600}
.tag.priority-critical{background:#ffebee;color:#b71c1c}.tag.priority-high{background:#fff3e0;color:#e65100}.tag.req{background:#e3f2fd;color:#0d47a1}.tag.manual{background:#f3e5f5;color:#4a148c}
.case-card{background:var(--card);border:1px solid var(--border);border-radius:6px;margin:10px 0;padding:12px 16px;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
summary{cursor:pointer;display:flex;align-items:center;gap:8px}
.case-id{font-weight:700;color:#1565c0}.case-title{font-weight:600;flex-grow:1}.duration{color:#888;font-size:0.85rem}
.iter{margin:12px 0 0 16px;padding:8px 12px;background:#fcfcfc;border-left:3px solid #ccc;border-radius:0 4px 4px 0}
.iter-title{margin-bottom:8px}
.step{margin:8px 0 8px 14px}.err{color:var(--bad);font-family:Consolas,monospace;font-size:0.9rem}
ul{margin:4px 0 6px;padding-left:22px;list-style:none}small.muted{color:#777}
</style></head><body>
<header>
  <div>
    <h1>🛡️ QAForge &bull; SQA Execution Dossier</h1>
    <div class="summary-meta">Suite: <b>${esc(s.name)}</b> &middot; Environment: <b>${esc(s.environment ?? 'none')}</b> &middot; ${esc(s.startedAt)} &middot; Total Duration: <b>${s.durationMs}ms</b></div>
  </div>
  <div>
    <span class="badge ${passed === total ? 'ok' : 'bad'}" style="font-size:1.1rem;padding:8px 16px">${passed}/${total} CASES PASSED (${total > 0 ? Math.round((passed / total) * 100) : 0}%)</span>
  </div>
</header>
${body}
</body></html>
`;
}

export function writeReports(storage: { reportsDir: string }, s: SuiteResult, formats = ['html', 'junit', 'json'], outDir?: string) {
  const dir = outDir ?? storage.reportsDir;
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const write = (name: string, content: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'utf8');
    written.push(file);
  };

  const html = toHtml(s);
  const junit = toJUnit(s);
  const json = JSON.stringify(s, null, 2);

  // Always write 'last.*' for quick access
  if (formats.includes('html')) write('last.html', html);
  if (formats.includes('junit')) write('last.junit.xml', junit);
  if (formats.includes('json')) write('last.json', json);

  // Write timestamped archive for historical records
  const ts = new Date(s.startedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
  const total = s.cases.length;
  const passed = s.cases.filter((c) => c.passed).length;
  const verdict = passed === total ? 'PASS' : 'FAIL';
  const historyFolder = path.join(dir, 'history');
  fs.mkdirSync(historyFolder, { recursive: true });

  const safeTarget = (s.name || 'Run').replace(/[<>:"/\\|?*]+/g, '-').trim();
  const historyBase = `${ts}_${verdict}_${safeTarget}_${passed}of${total}`;
  if (formats.includes('html')) {
    const histFile = path.join(historyFolder, `${historyBase}.html`);
    fs.writeFileSync(histFile, html, 'utf8');
    written.push(histFile);
  }
  if (formats.includes('json')) {
    const histJson = path.join(historyFolder, `${historyBase}.json`);
    fs.writeFileSync(histJson, json, 'utf8');
  }

  return written;
}

