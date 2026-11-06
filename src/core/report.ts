import * as fs from 'fs';
import * as path from 'path';
import type { SuiteResult, RequestResult } from './types';

const esc = (s: string) =>
  String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);

function renderHeaders(headers?: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) return '';
  const rows = Object.entries(headers)
    .map(([k, v]) => `<tr><td class="h-key">${esc(k)}</td><td class="h-val">${esc(v)}</td></tr>`)
    .join('');
  return `<div class="headers-wrap"><table class="headers-table"><tbody>${rows}</tbody></table></div>`;
}

function renderBody(raw: string): string {
  if (!raw || !raw.trim()) return '<div class="empty-hint">(Empty body)</div>';
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* not json */ }

  if (parsed === null) {
    return `<pre class="resp-pre">${esc(raw)}</pre>`;
  }

  // SQL result: { rowCount, rows: [...] }
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.rows)) {
    const rows = obj.rows as Record<string, unknown>[];
    if (rows.length === 0) {
      return `<div class="sql-meta">rowCount: ${obj.rowCount ?? 0} &mdash; (No rows returned)</div>`;
    }
    const cols = Object.keys(rows[0]);
    const fmtCell = (v: unknown): string => {
      if (v === null || v === undefined) return '<span class="jnull">null</span>';
      if (typeof v === 'boolean') return `<span class="jbool">${v}</span>`;
      if (typeof v === 'number') return `<span class="jnum">${v}</span>`;
      const s = esc(String(v));
      return s.length > 150 ? `<span title="${s}">${s.slice(0, 150)}&hellip;</span>` : s;
    };
    const thead = `<tr>${cols.map((c) => `<th onclick="sortTable(this)">${esc(c)} <span class="sort-icon">&#8597;</span></th>`).join('')}</tr>`;
    const tbody = rows.map((row) => `<tr>${cols.map((c) => `<td>${fmtCell(row[c])}</td>`).join('')}</tr>`).join('');
    return `<div class="sql-meta"><b>${obj.rowCount ?? rows.length}</b> row${rows.length !== 1 ? 's' : ''} &middot; <b>${cols.length}</b> column${cols.length !== 1 ? 's' : ''}</div>
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

function renderMethodBadge(method?: string): string {
  const m = (method || 'GET').toUpperCase();
  const cls = m === 'GET' ? 'm-get'
    : m === 'POST' ? 'm-post'
    : m === 'PUT' ? 'm-put'
    : m === 'PATCH' ? 'm-patch'
    : m === 'DELETE' ? 'm-delete'
    : m === 'SQL' ? 'm-sql'
    : m === 'FILE' ? 'm-file'
    : m === 'SCRIPT' ? 'm-script'
    : 'm-other';
  return `<span class="method-badge ${cls}">${esc(m)}</span>`;
}

function renderStatusBadge(status?: number): string {
  if (!status || status === 0) return '<span class="status-badge st-err">ERR</span>';
  if (status >= 200 && status < 300) return `<span class="status-badge st-2xx">${status} OK</span>`;
  if (status >= 300 && status < 400) return `<span class="status-badge st-3xx">${status}</span>`;
  if (status >= 400 && status < 500) return `<span class="status-badge st-4xx">${status}</span>`;
  return `<span class="status-badge st-5xx">${status} ERR</span>`;
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
  const failed = total - passed;
  const totalSteps = s.cases.reduce((acc, c) => acc + c.iterations.flatMap((it) => it.steps).length, 0);
  const passedSteps = s.cases.reduce((acc, c) => acc + c.iterations.flatMap((it) => it.steps).filter((st) => st.passed).length, 0);
  const failedSteps = totalSteps - passedSteps;
  const passRate = totalSteps > 0 ? Math.round((passedSteps / totalSteps) * 100) : (passed === total ? 100 : 0);

  const isSingleRun = total === 1 && totalSteps === 1;

  const body = s.cases
    .map((c) => {
      const iters = c.iterations
        .map((it) => {
          const steps = it.steps
            .map((st: RequestResult) => {
              const tests = st.tests
                .map((t) => `<li class="test-item ${t.passed ? 'ok' : 'bad'}"><span class="t-icon">${t.passed ? '✔' : '✘'}</span> <span class="t-name">${esc(t.name)}</span>${t.error ? `<div class="t-err">${esc(t.error)}</div>` : ''}</li>`)
                .join('');

              const reqHeadersHtml = renderHeaders(st.requestHeaders);
              const reqBodyHtml = st.requestBody ? renderBody(st.requestBody) : '';
              const hasReqDetails = reqHeadersHtml || reqBodyHtml;

              const resHeadersHtml = renderHeaders(st.responseHeaders);
              const resBodyHtml = st.responseBody ? renderBody(st.responseBody) : '';
              const hasResDetails = resHeadersHtml || resBodyHtml;

              const reqSection = hasReqDetails
                ? `<details class="step-sub details-req">
                    <summary class="sub-summary">📤 <b>Request Details</b> ${st.requestBody ? '<span class="pill-mini">Payload</span>' : ''}</summary>
                    <div class="sub-content">
                      ${reqHeadersHtml ? `<div class="headers-block"><div class="block-title">Request Headers</div>${reqHeadersHtml}</div>` : ''}
                      ${reqBodyHtml ? `<div class="body-block"><div class="block-title">Request Body</div>${reqBodyHtml}</div>` : ''}
                    </div>
                  </details>`
                : '';

              const resSection = hasResDetails
                ? `<details class="step-sub details-res" ${isSingleRun || !st.passed || hasResDetails ? 'open' : ''}>
                    <summary class="sub-summary">📥 <b>Response Details</b> ${st.status ? renderStatusBadge(st.status) : ''}</summary>
                    <div class="sub-content">
                      ${resHeadersHtml ? `<div class="headers-block"><div class="block-title">Response Headers</div>${resHeadersHtml}</div>` : ''}
                      ${resBodyHtml ? `<div class="body-block"><div class="block-title">Response Body</div>${resBodyHtml}</div>` : ''}
                    </div>
                  </details>`
                : (st.responseBody === '' ? '<div class="empty-hint">(Empty response body)</div>' : '');

              const logs = st.logs.length
                ? `<details class="step-sub details-logs" ${!st.passed ? 'open' : ''}>
                    <summary class="sub-summary">📋 <b>Execution Logs (${st.logs.length})</b></summary>
                    <div class="sub-content"><pre class="logs-pre">${esc(st.logs.join('\n'))}</pre></div>
                  </details>`
                : '';

              const cls = st.skipped ? 'skip' : st.passed ? 'ok' : 'bad';
              return `<div class="step-card step-${cls}" data-verdict="${cls}">
                <div class="step-header">
                  <div class="step-main">
                    <span class="badge ${cls}">${st.skipped ? 'SKIP' : st.passed ? 'PASS' : 'FAIL'}</span>
                    ${renderMethodBadge(st.method)}
                    <span class="step-name">${esc(st.name)}</span>
                  </div>
                  <div class="step-meta">
                    ${renderStatusBadge(st.status)}
                    <span class="meta-pill duration-pill">⏱ ${st.durationMs}ms</span>
                  </div>
                </div>

                ${st.url ? `<div class="step-url-bar"><span class="url-label">Endpoint:</span> <code>${esc(st.url)}</code></div>` : ''}
                ${st.error ? `<div class="err-box"><b>⚠ Error:</b> ${esc(st.error)}</div>` : ''}

                ${tests ? `<div class="assertions-block"><div class="block-title">Assertions (${st.tests.length})</div><ul class="assertions-list">${tests}</ul></div>` : ''}

                ${reqSection}
                ${resSection}
                ${logs}
              </div>`;
            })
            .join('');

          const iterHeader = c.iterations.length > 1
            ? `<div class="iter-title"><b>Iteration ${it.index}</b>${esc(label(it.data))} <span class="badge ${it.passed ? 'ok' : 'bad'}">${it.passed ? 'PASSED' : 'FAILED'}</span></div>`
            : '';

          return `<div class="iter">${iterHeader}${steps}</div>`;
        })
        .join('');

      return `<details ${isSingleRun || !c.passed ? 'open' : ''} class="case-card case-${c.passed ? 'ok' : 'bad'}" data-verdict="${c.passed ? 'ok' : 'bad'}">
        <summary class="case-summary">
          <div class="case-summary-left">
            <span class="badge ${c.passed ? 'ok' : 'bad'}">${c.passed ? 'PASS' : 'FAIL'}</span>
            <span class="case-id">${esc(c.id)}</span>
            <span class="case-title">${esc(c.title)}</span>
          </div>
          <div class="case-summary-right">
            ${c.priority ? `<span class="tag priority-${c.priority}">${esc(c.priority)}</span>` : ''}
            ${c.requirement ? `<span class="tag req">Req: ${esc(c.requirement)}</span>` : ''}
            ${c.manualSteps ? `<span class="tag manual">${c.manualSteps} manual steps</span>` : ''}
            <span class="duration">${c.durationMs}ms</span>
          </div>
        </summary>
        <div class="case-content">
          ${iters}
        </div>
      </details>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QAForge - SQA Executive Dossier &bull; ${esc(s.name)}</title>
<style>
:root {
  --ok: #2e7d32;
  --ok-bg: #e8f5e9;
  --ok-border: #a5d6a7;
  --bad: #d32f2f;
  --bad-bg: #ffebee;
  --bad-border: #ef9a9a;
  --skip: #757575;
  --bg: #f5f7fa;
  --card: #ffffff;
  --border: #dcdfe6;
  --text: #1a1f2c;
  --muted: #5f6b7c;
  --code-bg: #1e1e1e;
  --code-text: #d4d4d4;
  --accent: #0066cc;
}

* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  margin: 0;
  padding: 24px 32px 60px;
  color: var(--text);
  background: var(--bg);
  line-height: 1.5;
}

header {
  background: var(--card);
  padding: 20px 24px;
  border-radius: 8px;
  border: 1px solid var(--border);
  box-shadow: 0 2px 6px rgba(0,0,0,0.04);
  margin-bottom: 20px;
}

.header-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}

.header-title-area h1 {
  margin: 0 0 6px;
  font-size: 1.5rem;
  display: flex;
  align-items: center;
  gap: 8px;
}

.summary-meta {
  color: var(--muted);
  font-size: 0.9rem;
}

.env-pill {
  background: #e3f2fd;
  color: #0d47a1;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
}

.kpi-row {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.kpi-card {
  flex: 1;
  min-width: 140px;
  background: #fafbfc;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
}

.kpi-label {
  font-size: 0.75rem;
  color: var(--muted);
  text-transform: uppercase;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.kpi-val {
  font-size: 1.4rem;
  font-weight: 700;
  margin-top: 2px;
}

.kpi-card.ok .kpi-val { color: var(--ok); }
.kpi-card.bad .kpi-val { color: var(--bad); }

.progress-bar-wrap {
  width: 100%;
  height: 8px;
  background: #e0e0e0;
  border-radius: 4px;
  margin-top: 14px;
  overflow: hidden;
  display: flex;
}

.progress-pass {
  background: var(--ok);
  height: 100%;
  transition: width 0.3s;
}

.progress-fail {
  background: var(--bad);
  height: 100%;
  transition: width 0.3s;
}

/* Toolbar */
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.toolbar-left, .toolbar-right {
  display: flex;
  gap: 8px;
  align-items: center;
}

.search-input {
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  font-size: 0.85rem;
  min-width: 260px;
  background: #fff;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0,102,204,0.15);
}

.btn-filter, .btn-action {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: #fff;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text);
  transition: all 0.15s ease;
}

.btn-filter:hover, .btn-action:hover {
  background: #f0f2f5;
  border-color: #bcc3ce;
}

.btn-filter.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

/* Badges */
.badge {
  padding: 3px 8px;
  border-radius: 4px;
  font-weight: 700;
  font-size: 0.75rem;
  text-transform: uppercase;
  color: #fff;
  display: inline-flex;
  align-items: center;
}

.badge.ok { background: var(--ok); }
.badge.bad { background: var(--bad); }
.badge.skip { background: var(--skip); }

.method-badge {
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 700;
  font-size: 0.75rem;
  letter-spacing: 0.5px;
  color: #fff;
  display: inline-flex;
  align-items: center;
}

.m-get { background: #0288d1; }
.m-post { background: #2e7d32; }
.m-put { background: #ed6c02; }
.m-patch { background: #0288d1; }
.m-delete { background: #d32f2f; }
.m-sql { background: #7b1fa2; }
.m-file { background: #00897b; }
.m-script { background: #546e7a; }
.m-other { background: #616161; }

.status-badge {
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 700;
  font-size: 0.75rem;
  display: inline-flex;
}

.st-2xx { background: #e8f5e9; color: var(--ok); border: 1px solid #c8e6c9; }
.st-3xx { background: #fff3e0; color: #e65100; border: 1px solid #ffe0b2; }
.st-4xx { background: #fbe9e7; color: #d84315; border: 1px solid #ffccbc; }
.st-5xx, .st-err { background: #ffebee; color: var(--bad); border: 1px solid #ffcdd2; }

.meta-pill {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  background: #eceff1;
  color: #455a64;
  font-weight: 600;
}

.tag {
  padding: 2px 7px;
  border-radius: 3px;
  font-size: 0.72rem;
  font-weight: 600;
}

.tag.priority-critical { background: #ffebee; color: #b71c1c; }
.tag.priority-high { background: #fff3e0; color: #e65100; }
.tag.req { background: #e3f2fd; color: #0d47a1; }
.tag.manual { background: #f3e5f5; color: #4a148c; }

/* Case Cards */
.case-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.03);
  overflow: hidden;
}

.case-card.case-bad {
  border-left: 4px solid var(--bad);
}

.case-card.case-ok {
  border-left: 4px solid var(--ok);
}

.case-summary {
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 18px;
  background: #fff;
  border-bottom: 1px solid transparent;
  user-select: none;
}

.case-card[open] > .case-summary {
  border-bottom-color: var(--border);
  background: #fafbfc;
}

.case-summary-left, .case-summary-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.case-id {
  font-weight: 700;
  color: #0d47a1;
  font-size: 0.95rem;
}

.case-title {
  font-weight: 600;
  font-size: 0.95rem;
}

.case-content {
  padding: 12px 18px 16px;
}

.iter {
  margin-bottom: 12px;
}

.iter-title {
  font-size: 0.85rem;
  margin-bottom: 8px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Step Card */
.step-card {
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  margin: 10px 0;
  box-shadow: 0 1px 2px rgba(0,0,0,0.02);
}

.step-card.step-bad {
  border-left: 3px solid var(--bad);
  background: #fffafa;
}

.step-card.step-ok {
  border-left: 3px solid var(--ok);
}

.step-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  flex-wrap: wrap;
  gap: 8px;
}

.step-main, .step-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-name {
  font-weight: 700;
  font-size: 0.95rem;
}

.step-url-bar {
  background: #f1f3f5;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 0.82rem;
  margin: 6px 0 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  word-break: break-all;
}

.url-label {
  font-weight: 600;
  color: var(--muted);
  font-size: 0.75rem;
  text-transform: uppercase;
}

.step-url-bar code {
  color: #0d47a1;
  font-family: Consolas, monospace;
}

.err-box {
  background: #ffebee;
  color: var(--bad);
  border: 1px solid #ffcdd2;
  border-radius: 4px;
  padding: 8px 12px;
  margin: 8px 0;
  font-size: 0.85rem;
  font-family: Consolas, monospace;
}

/* Assertions */
.assertions-block {
  margin: 8px 0;
  background: #fcfdfe;
  border: 1px solid #edf2f7;
  border-radius: 4px;
  padding: 8px 12px;
}

.block-title {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  margin-bottom: 6px;
  letter-spacing: 0.5px;
}

.assertions-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.test-item {
  padding: 4px 0;
  font-size: 0.85rem;
  display: flex;
  flex-direction: column;
}

.test-item.ok .t-icon { color: var(--ok); font-weight: 700; margin-right: 6px; }
.test-item.bad .t-icon { color: var(--bad); font-weight: 700; margin-right: 6px; }

.t-err {
  color: var(--bad);
  font-family: Consolas, monospace;
  font-size: 0.8rem;
  margin-left: 20px;
  margin-top: 2px;
}

/* Step Sub-details (Request/Response/Logs) */
.step-sub {
  margin-top: 8px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  background: #ffffff;
  overflow: hidden;
}

.sub-summary {
  padding: 6px 12px;
  background: #f8fafc;
  cursor: pointer;
  font-size: 0.82rem;
  display: flex;
  align-items: center;
  gap: 8px;
  user-select: none;
}

.step-sub[open] > .sub-summary {
  border-bottom: 1px solid #e2e8f0;
}

.pill-mini {
  background: #e2e8f0;
  color: #475569;
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
}

.sub-content {
  padding: 10px 14px;
}

/* Headers Table */
.headers-wrap {
  overflow-x: auto;
  margin-bottom: 8px;
}

.headers-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
  font-family: Consolas, monospace;
}

.headers-table td {
  padding: 4px 8px;
  border-bottom: 1px solid #edf2f7;
}

.h-key {
  color: #0066cc;
  font-weight: 600;
  width: 220px;
  white-space: nowrap;
}

.h-val {
  color: #334155;
  word-break: break-all;
}

/* Code / Body / Pre */
.resp-pre {
  background: var(--code-bg);
  color: var(--code-text);
  border-radius: 4px;
  padding: 12px 16px;
  font-size: 0.82rem;
  overflow-x: auto;
  max-height: 480px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0;
  font-family: Consolas, "Courier New", monospace;
  line-height: 1.45;
}

.jk { color: #9cdcfe; }
.jstr { color: #ce9178; }
.jnum { color: #b5cea8; }
.jbool { color: #569cd6; }
.jnull { color: #f44747; opacity: .85; }

.empty-hint {
  font-size: 0.82rem;
  color: var(--muted);
  font-style: italic;
  padding: 4px 0;
}

/* SQL Table */
.sql-meta {
  font-size: 0.82rem;
  color: #475569;
  margin: 4px 0 6px;
}

.sql-table-wrap {
  overflow: auto;
  max-height: 450px;
  border: 1px solid var(--border);
  border-radius: 4px;
  margin: 4px 0;
}

.sql-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.82rem;
}

.sql-table th {
  background: #2a2a2a;
  color: #eee;
  padding: 7px 12px;
  text-align: left;
  border-bottom: 2px solid #444;
  white-space: nowrap;
  position: sticky;
  top: 0;
  cursor: pointer;
  user-select: none;
}

.sql-table th:hover { background: #383838; }
.sort-icon { opacity: .6; font-size: .8em; margin-left: 4px; }

.sql-table td {
  padding: 5px 12px;
  border-bottom: 1px solid #edf2f7;
  vertical-align: top;
  word-break: break-word;
  max-width: 320px;
}

.sql-table tbody tr:hover td { background: #f0f4ff; }

/* Logs */
.logs-pre {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  padding: 10px 14px;
  font-size: 0.82rem;
  overflow-x: auto;
  max-height: 260px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0;
  font-family: Consolas, monospace;
  color: #334155;
}
</style>

<script>
function sortTable(th) {
  const table = th.closest('table'), tbody = table.querySelector('tbody');
  const cols = Array.from(th.parentElement.children), ci = cols.indexOf(th);
  const asc = table.dataset.sortCol == ci ? table.dataset.sortAsc == '1' ? -1 : 1 : 1;
  table.dataset.sortCol = ci; table.dataset.sortAsc = asc;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  rows.sort((a,b) => {
    const av = a.children[ci].textContent.trim(), bv = b.children[ci].textContent.trim();
    const an = parseFloat(av), bn = parseFloat(bv);
    return isNaN(an) || isNaN(bn) ? (av < bv ? -1 : av > bv ? 1 : 0) * asc : (an - bn) * asc;
  });
  rows.forEach(r => tbody.appendChild(r));
  cols.forEach((c, i) => {
    const icon = c.querySelector('.sort-icon');
    if (icon) icon.innerHTML = i === ci ? (asc === 1 ? '&#8593;' : '&#8595;') : '&#8597;';
  });
}

function toggleAll(open) {
  document.querySelectorAll('details.case-card, details.step-sub').forEach(d => d.open = open);
}

let activeFilter = 'all';
function setFilter(verdict) {
  activeFilter = verdict;
  document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('filter-' + verdict);
  if (btn) btn.classList.add('active');
  filterReport();
}

function filterReport() {
  const query = (document.getElementById('reportSearch')?.value || '').toLowerCase().trim();
  const cases = document.querySelectorAll('.case-card');

  cases.forEach(c => {
    const caseVerdict = c.dataset.verdict;
    const caseText = c.textContent.toLowerCase();
    const verdictMatch = activeFilter === 'all' || caseVerdict === activeFilter;
    const queryMatch = !query || caseText.includes(query);

    if (verdictMatch && queryMatch) {
      c.style.display = '';
      if (query) c.open = true;
    } else {
      c.style.display = 'none';
    }
  });
}
</script>
</head>
<body>

<header>
  <div class="header-top">
    <div class="header-title-area">
      <h1>🛡️ QAForge &bull; SQA Execution Dossier</h1>
      <div class="summary-meta">
        Target: <b>${esc(s.name)}</b>
        &middot; Environment: <span class="env-pill">${esc(s.environment ?? 'Default')}</span>
        &middot; Date: <b>${esc(s.startedAt)}</b>
      </div>
    </div>
    <div class="header-verdict">
      <span class="badge ${passed === total ? 'ok' : 'bad'}" style="font-size: 1rem; padding: 6px 14px;">
        ${passed === total ? '✔ ALL PASSED' : '✘ FAILURES DETECTED'}
      </span>
    </div>
  </div>

  <div class="kpi-row">
    <div class="kpi-card ${passed === total ? 'ok' : 'bad'}">
      <span class="kpi-label">Test Cases</span>
      <span class="kpi-val">${passed} / ${total}</span>
    </div>
    <div class="kpi-card ${passedSteps === totalSteps ? 'ok' : 'bad'}">
      <span class="kpi-label">Steps Passed</span>
      <span class="kpi-val">${passedSteps} / ${totalSteps}</span>
    </div>
    <div class="kpi-card ${passRate === 100 ? 'ok' : 'bad'}">
      <span class="kpi-label">Pass Rate</span>
      <span class="kpi-val">${passRate}%</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Total Duration</span>
      <span class="kpi-val">${s.durationMs}ms</span>
    </div>
  </div>

  <div class="progress-bar-wrap" title="${passRate}% Passed">
    <div class="progress-pass" style="width: ${passRate}%"></div>
    <div class="progress-fail" style="width: ${100 - passRate}%"></div>
  </div>
</header>

<div class="toolbar">
  <div class="toolbar-left">
    <input type="text" id="reportSearch" class="search-input" placeholder="🔍 Search steps, URLs, assertions, errors..." oninput="filterReport()" />
    <button id="filter-all" class="btn-filter active" onclick="setFilter('all')">All (${total})</button>
    <button id="filter-ok" class="btn-filter" onclick="setFilter('ok')">✔ Passed (${passed})</button>
    <button id="filter-bad" class="btn-filter" onclick="setFilter('bad')">✘ Failed (${failed})</button>
  </div>
  <div class="toolbar-right">
    <button class="btn-action" onclick="toggleAll(true)">⊞ Expand All</button>
    <button class="btn-action" onclick="toggleAll(false)">⊟ Collapse All</button>
  </div>
</div>

<div id="casesList">
${body}
</div>

</body>
</html>`;
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
