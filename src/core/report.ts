import * as fs from 'fs';
import * as path from 'path';
import type { SuiteResult } from './types';

const esc = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);

function renderBody(raw: string): string {
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* not json */ }
  if (parsed === null) return `<pre class="resp-pre">${esc(raw)}</pre>`;

  // SQL result: { rowCount, rows: [...] }
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.rows)) {
    const rows = obj.rows as Record<string, unknown>[];
    if (rows.length === 0)
      return `<div class="sql-meta">rowCount: ${obj.rowCount ?? 0} &mdash; no rows returned</div>`;
    const cols = Object.keys(rows[0]);
    const fmtCell = (v: unknown): string => {
      if (v === null || v === undefined) return '<span class="jnull">null</span>';
      if (typeof v === 'boolean') return `<span class="jbool">${v}</span>`;
      if (typeof v === 'number') return `<span class="jnum">${v}</span>`;
      const s = esc(String(v));
      return s.length > 120 ? `<span title="${s}">${s.slice(0, 120)}&hellip;</span>` : s;
    };
    const thead = `<tr>${cols.map((c) => `<th onclick="sortTable(this)">${esc(c)} <span class="sort-icon">&#8597;</span></th>`).join('')}</tr>`;
    const tbody = rows.map((row) => `<tr>${cols.map((c) => `<td>${fmtCell(row[c])}</td>`).join('')}</tr>`).join('');
    return `<div class="sql-meta">${obj.rowCount ?? rows.length} row${rows.length !== 1 ? 's' : ''} &middot; ${cols.length} col${cols.length !== 1 ? 's' : ''}</div>
<div class="sql-table-wrap"><table class="sql-table" data-sort-col="-1" data-sort-asc="1"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
  }

  // Regular JSON with syntax highlighting
  const pretty = JSON.stringify(parsed, null, 2);
  const highlighted = esc(pretty)
    .replace(/^([ ]*)(&quot;[^&]*&quot;):/gm, '$1<span class="jk">$2</span>:')
    .replace(/: (&quot;[^&]*&quot;)/g, ': <span class="jstr">$1</span>')
    .replace(/: (-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, ': <span class="jnum">$1</span>')
    .replace(/: (true|false)/g, ': <span class="jbool">$1</span>')
    .replace(/: (null)/g, ': <span class="jnull">$1</span>');
  return `<pre class="resp-pre json-hl">${highlighted}</pre>`;
}

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
  const totalSteps = s.cases.reduce((acc, c) => acc + c.iterations.flatMap((it) => it.steps).length, 0);
  const passedSteps = s.cases.reduce((acc, c) => acc + c.iterations.flatMap((it) => it.steps).filter((st) => st.passed).length, 0);
  const body = s.cases
    .map((c) => {
      const iters = c.iterations
        .map((it) => {
          const steps = it.steps
            .map((st) => {
              const tests = st.tests
                .map((t) => `<li class="${t.passed ? 'ok' : 'bad'}">${t.passed ? '✔ PASS' : '✘ FAIL'} ${esc(t.name)}${t.error ? ` &mdash; <span class="err">${esc(t.error)}</span>` : ''}</li>`)
                .join('');
              const responseBody = (st as any).responseBody
                ? `<details class="resp-body"><summary>Response body</summary>${renderBody((st as any).responseBody)}</details>`
                : '';
              const logs = st.logs.length
                ? `<details class="logs"><summary>Logs (${st.logs.length})</summary><pre>${esc(st.logs.join('\n'))}</pre></details>`
                : '';
              const cls = st.skipped ? 'skip' : st.passed ? 'ok' : 'bad';
              return `<div class="step">
                <div class="step-header">
                  <span class="badge ${cls}">${st.skipped ? 'SKIP' : st.passed ? 'PASS' : 'FAIL'}</span>
                  <b>${esc(st.name)}</b>
                  <small class="muted">${st.status || ''} &bull; ${st.durationMs}ms</small>
                </div>
                ${st.error ? `<div class="err">⚠ ${esc(st.error)}</div>` : ''}
                ${tests ? `<ul>${tests}</ul>` : ''}
                ${responseBody}
                ${logs}
              </div>`;
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
header{background:var(--card);padding:20px 24px;border-radius:8px;border:1px solid var(--border);margin-bottom:24px}
.header-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.verdict-badge{flex-shrink:0;padding:10px 18px;border-radius:6px;font-weight:700;font-size:1.1rem;text-transform:uppercase;color:#fff;white-space:nowrap}
.verdict-badge.ok{background:var(--ok)}.verdict-badge.bad{background:var(--bad)}
h1{margin:0 0 6px;font-size:1.6rem}
.summary-meta{color:#666;font-size:0.95rem;margin-top:4px}
.badge{padding:3px 8px;border-radius:4px;font-weight:700;font-size:0.8rem;text-transform:uppercase;color:#fff}
.badge.ok{background:var(--ok)}.badge.bad{background:var(--bad)}.badge.skip{background:var(--skip)}
.tag{padding:2px 7px;border-radius:3px;font-size:0.75rem;margin-left:6px;font-weight:600}
.tag.priority-critical{background:#ffebee;color:#b71c1c}.tag.priority-high{background:#fff3e0;color:#e65100}.tag.req{background:#e3f2fd;color:#0d47a1}.tag.manual{background:#f3e5f5;color:#4a148c}
.case-card{background:var(--card);border:1px solid var(--border);border-radius:6px;margin:10px 0;padding:12px 16px;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
summary{cursor:pointer;display:flex;align-items:center;gap:8px}
.case-id{font-weight:700;color:#1565c0}.case-title{font-weight:600;flex-grow:1}.duration{color:#888;font-size:0.85rem}
.iter{margin:12px 0 0 16px;padding:8px 12px;background:#fcfcfc;border-left:3px solid #ccc;border-radius:0 4px 4px 0}
.iter-title{margin-bottom:8px}
.step{margin:8px 0 8px 14px;padding:8px 10px;border-radius:4px;background:#fafafa;border:1px solid #eee}
.step-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.err{color:var(--bad);font-family:Consolas,monospace;font-size:0.9rem;margin-top:4px}
ul{margin:4px 0 6px;padding-left:22px;list-style:none}small.muted{color:#777}
.resp-body{margin:6px 0 4px}.resp-body>summary{font-size:0.82rem;color:#555;cursor:pointer;display:inline-flex}
.resp-pre{background:#1e1e1e;color:#d4d4d4;border-radius:4px;padding:10px 14px;font-size:0.82rem;overflow-x:auto;max-height:400px;white-space:pre-wrap;word-break:break-all;margin:4px 0;font-family:Consolas,"Courier New",monospace}
.jk{color:#9cdcfe}.jstr{color:#ce9178}.jnum{color:#b5cea8}.jbool{color:#569cd6}.jnull{color:#f44747;opacity:.85}
.sql-meta{font-size:.82rem;color:#555;margin:4px 0 6px}
.sql-table-wrap{overflow:auto;max-height:420px;border:1px solid #ddd;border-radius:4px;margin:4px 0}
.sql-table{border-collapse:collapse;width:100%;font-size:.82rem}
.sql-table th{background:#2a2a2a;color:#ccc;padding:6px 10px;text-align:left;border-bottom:2px solid #444;white-space:nowrap;position:sticky;top:0;cursor:pointer;user-select:none}
.sql-table th:hover{background:#333}.sort-icon{opacity:.5;font-size:.75em}
.sql-table td{padding:5px 10px;border-bottom:1px solid #eee;vertical-align:top;word-break:break-word;max-width:300px}
.sql-table tbody tr:hover td{background:#f0f4ff}
.logs summary{font-size:0.82rem;color:#555;cursor:pointer;margin-top:6px;display:inline-flex}
.logs pre{background:#f4f4f4;border:1px solid #ddd;border-radius:4px;padding:8px 12px;font-size:0.82rem;overflow-x:auto;max-height:200px;white-space:pre-wrap;word-break:break-all;margin:4px 0 0}
</style>
<script>
function sortTable(th){
  const table=th.closest('table'),tbody=table.querySelector('tbody');
  const cols=Array.from(th.parentElement.children),ci=cols.indexOf(th);
  const asc=table.dataset.sortCol==ci?table.dataset.sortAsc=='1'?-1:1:1;
  table.dataset.sortCol=ci;table.dataset.sortAsc=asc;
  const rows=Array.from(tbody.querySelectorAll('tr'));
  rows.sort((a,b)=>{
    const av=a.children[ci].textContent.trim(),bv=b.children[ci].textContent.trim();
    const an=parseFloat(av),bn=parseFloat(bv);
    return isNaN(an)||isNaN(bn)?(av<bv?-1:av>bv?1:0)*asc:(an-bn)*asc;
  });
  rows.forEach(r=>tbody.appendChild(r));
  cols.forEach((c,i)=>c.querySelector('.sort-icon').innerHTML=i===ci?(asc===1?'&#8593;':'&#8595;'):'&#8597;');
}
</script>
</head><body>
<header>
  <div class="header-top">
    <div>
      <h1>🛡️ QAForge &bull; SQA Execution Dossier</h1>
      <div class="summary-meta">Suite: <b>${esc(s.name)}</b> &middot; Environment: <b>${esc(s.environment ?? 'none')}</b> &middot; ${esc(s.startedAt)} &middot; Duration: <b>${s.durationMs}ms</b></div>
    </div>
    <div class="verdict-badge ${passed === total ? 'ok' : 'bad'}">${passed}/${total} CASES &bull; ${passedSteps}/${totalSteps} STEPS</div>
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

  // Determine category and entity folder (e.g. testcases/TC-MTP-PART-NUMBERS-001 or collections/MES-E2E)
  let subDir = '';
  if (safeTarget.startsWith('TC-') || (s.cases?.length === 1 && s.cases[0]?.id?.startsWith('TC-'))) {
    const tcId = (s.cases?.length === 1 && s.cases[0]?.id) || safeTarget;
    subDir = path.join('testcases', tcId.replace(/[<>:"/\\|?*]+/g, '-').trim());
  } else if (safeTarget.toLowerCase().includes('suite')) {
    subDir = path.join('suites', safeTarget);
  } else {
    subDir = path.join('collections', safeTarget);
  }
  const targetFolder = path.join(historyFolder, subDir);
  fs.mkdirSync(targetFolder, { recursive: true });
  if (formats.includes('html')) {
    const histFile = path.join(targetFolder, `${historyBase}.html`);
    fs.writeFileSync(histFile, html, 'utf8');
    written.push(histFile);
  }
  if (formats.includes('json')) {
    const histJson = path.join(targetFolder, `${historyBase}.json`);
    fs.writeFileSync(histJson, json, 'utf8');
  }

  return written;
}

