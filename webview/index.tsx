import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { KV, RequestDef, RunOutput, HttpMethod, BodyType, AuthType, Assertion, AssertOp, AssertSource } from '../src/core/types';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
type ReqTab = 'params' | 'headers' | 'body' | 'auth' | 'vars' | 'assertions' | 'retry' | 'pre' | 'post' | 'tests';
const REQ_TABS: ReqTab[] = ['params', 'headers', 'body', 'auth', 'vars', 'assertions', 'retry', 'pre', 'post', 'tests'];
const TAB_LABEL: Record<ReqTab, string> = { params: 'Params', headers: 'Headers', body: 'Body', auth: 'Auth', vars: 'Vars', assertions: 'Assertions', retry: 'Retry / Polling', pre: 'Pre-script', post: 'Post-script', tests: 'Tests' };
const OPS: AssertOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'in', 'length', 'exists', 'notExists', 'isEmpty', 'isNotEmpty'];
const SOURCES: AssertSource[] = ['status', 'header', 'body', 'time'];
type ResTab = 'tests' | 'body' | 'headers' | 'logs';

const css = `
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px;margin:0}
input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);padding:5px 8px;font-family:inherit;font-size:inherit;box-sizing:border-box}
textarea{width:100%;min-height:160px;font-family:var(--vscode-editor-font-family);resize:vertical}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 14px;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
button.ghost{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border,#555)}
.row{display:flex;gap:6px;margin-bottom:10px;align-items:center}
.grow{flex:1}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--vscode-panel-border);margin:10px 0}
.tab{padding:6px 12px;cursor:pointer;opacity:.7;border-bottom:2px solid transparent}
.tab.active{opacity:1;border-color:var(--vscode-focusBorder)}
.kv{display:flex;gap:6px;margin-bottom:4px}
.kv input[type=text]{flex:1}
pre{background:var(--vscode-textCodeBlock-background);padding:10px;overflow:auto;max-height:55vh;white-space:pre-wrap;word-break:break-all;font-family:var(--vscode-editor-font-family)}
.badge{padding:2px 8px;border-radius:3px;font-weight:600;margin-right:10px}
.ok{background:#2e7d32;color:#fff}.bad{background:#c62828;color:#fff}
.muted{opacity:.7;margin-right:12px}
.name{font-size:1.2em;font-weight:600;background:transparent;border-color:transparent}
.name:focus{border-color:var(--vscode-focusBorder)}
.sql-table-wrap{overflow:auto;max-height:55vh}
table{border-collapse:collapse;width:100%;font-size:.9em}
th{background:var(--vscode-editor-lineHighlightBackground,#2a2a2a);padding:6px 10px;text-align:left;border-bottom:2px solid var(--vscode-panel-border);white-space:nowrap;position:sticky;top:0}
td{padding:5px 10px;border-bottom:1px solid var(--vscode-panel-border,#333);vertical-align:top;word-break:break-word;max-width:320px}
tr:hover td{background:var(--vscode-list-hoverBackground)}
.sql-meta{font-size:.85em;opacity:.7;margin-bottom:6px}
.jk{color:var(--vscode-symbolIcon-variableForeground,#9cdcfe)}
.jstr{color:var(--vscode-debugTokenExpression-string,#ce9178)}
.jnum{color:var(--vscode-debugTokenExpression-number,#b5cea8)}
.jbool{color:var(--vscode-debugTokenExpression-boolean,#569cd6)}
.jnull{color:var(--vscode-debugTokenExpression-error,#f44747);opacity:.8}
`;

function KVEditor({ rows, onChange }: { rows: KV[]; onChange: (r: KV[]) => void }) {
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((r, i) => (
        <div className="kv" key={i}>
          <input type="checkbox" checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />
          <input type="text" placeholder="key" value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
          <input type="text" placeholder="value" value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button className="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>{'x'}</button>
        </div>
      ))}
      <button className="ghost" onClick={() => onChange([...rows, { key: '', value: '', enabled: true }])}>+ Add</button>
    </div>
  );
}

function ScriptBox({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <div>
      <div className="muted" style={{ marginBottom: 6 }}>{hint}</div>
      <textarea spellCheck={false} style={{ minHeight: 220 }} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function AssertionEditor({ rows, onChange }: { rows: Assertion[]; onChange: (r: Assertion[]) => void }) {
  const set = (i: number, patch: Partial<Assertion>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const unary = (op: AssertOp) => ['exists', 'notExists', 'isEmpty', 'isNotEmpty'].includes(op);
  return (
    <div>
      {rows.map((r, i) => (
        <div className="kv" key={i}>
          <input type="checkbox" checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />
          <select value={r.source} onChange={(e) => set(i, { source: e.target.value as AssertSource })}>
            {SOURCES.map((s) => <option key={s}>{s}</option>)}
          </select>
          {(r.source === 'header' || r.source === 'body') && (
            <input type="text" placeholder={r.source === 'header' ? 'header name' : 'json path e.g. data[0].id'} value={r.path} onChange={(e) => set(i, { path: e.target.value })} />
          )}
          <select value={r.op} onChange={(e) => set(i, { op: e.target.value as AssertOp })}>
            {OPS.map((o) => <option key={o}>{o}</option>)}
          </select>
          {!unary(r.op) && <input type="text" placeholder="expected" value={r.expected} onChange={(e) => set(i, { expected: e.target.value })} />}
          <button className="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>{'x'}</button>
        </div>
      ))}
      <button className="ghost" onClick={() => onChange([...rows, { enabled: true, source: 'status', path: '', op: 'eq', expected: '200' }])}>+ Add assertion</button>
    </div>
  );
}

function tryParseJson(body: string, headers: Record<string, string>): unknown | null {
  if ((headers['content-type'] ?? '').includes('json') || /^\s*[{[]/.test(body)) {
    try { return JSON.parse(body); } catch { /* not json */ }
  }
  return null;
}

function JsonHighlight({ text }: { text: string }) {
  const html = text.replace(
    /"((?:[^"\\]|\\.)*?)"\s*:/g, '<span class="jk">"$1"</span>:'
  ).replace(
    /:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="jstr">$1</span>'
  ).replace(
    /:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, ': <span class="jnum">$1</span>'
  ).replace(
    /:\s*(true|false)/g, ': <span class="jbool">$1</span>'
  ).replace(
    /:\s*(null)/g, ': <span class="jnull">$1</span>'
  );
  return <pre dangerouslySetInnerHTML={{ __html: html }} />;
}

function SqlTable({ parsed }: { parsed: unknown }) {
  const obj = parsed as { rowCount?: number; rows?: Record<string, unknown>[] };
  const rows = obj?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      <div>
        <div className="sql-meta">rowCount: {obj?.rowCount ?? 0} — no rows returned</div>
        <pre>{JSON.stringify(parsed, null, 2)}</pre>
      </div>
    );
  }
  const cols = Object.keys(rows[0]);
  const fmt = (v: unknown) => {
    if (v === null || v === undefined) return <span className="jnull">null</span>;
    if (typeof v === 'boolean') return <span className="jbool">{String(v)}</span>;
    if (typeof v === 'number') return <span className="jnum">{String(v)}</span>;
    const s = String(v);
    return s.length > 80 ? <span title={s}>{s.slice(0, 80)}…</span> : s;
  };
  return (
    <div>
      <div className="sql-meta">{obj.rowCount ?? rows.length} row{rows.length !== 1 ? 's' : ''} · {cols.length} column{cols.length !== 1 ? 's' : ''}</div>
      <div className="sql-table-wrap">
        <table>
          <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{rows.map((row, i) => (
            <tr key={i}>{cols.map((c) => <td key={c}>{fmt(row[c])}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function MdView({ text }: { text: string }) {
  const lines = text.split('\n');
  const nodes: JSX.Element[] = [];
  let i = 0;
  const inlineFormat = (s: string, key: number) => {
    const parts: (string | JSX.Element)[] = [];
    let rest = s;
    let k = 0;
    // bold **text** or __text__, inline code `code`
    const re = /(\*\*|__)(.*?)\1|`([^`]+)`/g;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = re.exec(rest)) !== null) {
      if (m.index > last) parts.push(rest.slice(last, m.index));
      if (m[3] !== undefined) parts.push(<code key={k++} style={{ background: 'var(--vscode-textCodeBlock-background)', padding: '1px 4px', borderRadius: 3 }}>{m[3]}</code>);
      else parts.push(<strong key={k++}>{m[2]}</strong>);
      last = m.index + m[0].length;
    }
    if (last < rest.length) parts.push(rest.slice(last));
    return <span key={key}>{parts}</span>;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) codeLines.push(lines[i++]);
      nodes.push(<pre key={i} style={{ background: 'var(--vscode-textCodeBlock-background)', padding: '8px 10px', borderRadius: 4, overflowX: 'auto', margin: '6px 0' }}>{codeLines.join('\n')}</pre>);
    } else if (/^#{1,3} /.test(line)) {
      const lvl = line.match(/^(#{1,3}) /)![1].length;
      const txt = line.replace(/^#{1,3} /, '');
      const Tag = `h${lvl + 2}` as 'h3' | 'h4' | 'h5';
      nodes.push(<Tag key={i} style={{ margin: '8px 0 4px' }}>{inlineFormat(txt, i)}</Tag>);
    } else if (/^[-*] /.test(line)) {
      nodes.push(<li key={i} style={{ marginLeft: 18 }}>{inlineFormat(line.slice(2), i)}</li>);
    } else if (/^\d+\. /.test(line)) {
      nodes.push(<li key={i} style={{ marginLeft: 18 }}>{inlineFormat(line.replace(/^\d+\. /, ''), i)}</li>);
    } else if (line.trim() === '') {
      nodes.push(<br key={i} />);
    } else {
      nodes.push(<p key={i} style={{ margin: '4px 0' }}>{inlineFormat(line, i)}</p>);
    }
    i++;
  }
  return <div style={{ lineHeight: 1.6 }}>{nodes}</div>;
}

function App() {
  const [req, setReq] = useState<RequestDef | null>(null);
  const [env, setEnv] = useState<string | null>(null);
  const [res, setRes] = useState<RunOutput | null>(null);
  const [sending, setSending] = useState(false);
  const [aiLoading, setAiLoading] = useState<'assertions' | 'diagnosis' | null>(null);
  const [aiDiagnosis, setAiDiagnosis] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [reqTab, setReqTab] = useState<ReqTab>('params');
  const [resTab, setResTab] = useState<ResTab>('body');

  const generateAiAssertions = () => {
    if (!req || !res) return;
    setAiLoading('assertions');
    vscode.postMessage({ type: 'ai-generate-assertions', request: req, response: res.response });
  };

  const diagnoseAiFailure = () => {
    if (!req || !res) return;
    setAiLoading('diagnosis');
    vscode.postMessage({
      type: 'ai-diagnose',
      request: req,
      response: res.response,
      failedTests: res.tests.filter((t) => !t.passed),
    });
  };

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'init') {
        setReq(m.request);
        setEnv(m.environment);
      } else if (m.type === 'env-changed') {
        setEnv(m.environment);
      } else if (m.type === 'response') {
        setRes(m.result);
        setSending(false);
        setAiDiagnosis(null);
      } else if (m.type === 'ai-assertions') {
        setAiLoading(null);
        setReq((prev) => {
          if (!prev) return prev;
          const newAssertions = [...prev.assertions, ...m.data.assertions];
          const newCaptures = [...prev.captures, ...m.data.captures.map((c: any) => ({ key: c.key, value: c.value, enabled: true }))];
          return { ...prev, assertions: newAssertions, captures: newCaptures };
        });
        setDirty(true);
        setReqTab('assertions');
      } else if (m.type === 'ai-diagnosis') {
        setAiLoading(null);
        setAiDiagnosis(m.text);
      } else if (m.type === 'ai-error') {
        setAiLoading(null);
      } else if (m.type === 'saved') setDirty(false);
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const send = () => {
    if (!req) return;
    setSending(true);
    vscode.postMessage({ type: 'send', request: req });
  };
  const save = () => req && vscode.postMessage({ type: 'save', request: req });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const parsedBody = useMemo(() => (res ? tryParseJson(res.response.body, res.response.headers) : null), [res]);
  const shown = useMemo(() => {
    if (!res) return '';
    if (parsedBody !== null) return JSON.stringify(parsedBody, null, 2);
    return res.response.body;
  }, [res, parsedBody]);
  if (!req) return <div>Loading...</div>;
  const r = res?.response as RunOutput['response'];

  const update = (patch: Partial<RequestDef>) => {
    setReq({ ...req, ...patch });
    setDirty(true);
  };
  const isSql = req.kind === 'sql';
  const sql = req.sql ?? { server: '', database: '', user: '', password: '', query: '' };
  const updateSql = (patch: Partial<typeof sql>) => update({ sql: { ...sql, ...patch } });
  // when a SQL step is opened, start on a tab that exists for SQL
  const activeReqTab: ReqTab = isSql && !['vars', 'assertions', 'pre', 'post', 'tests'].includes(reqTab) ? 'assertions' : reqTab;

  return (
    <div>
      <style>{css}</style>
      <div className="row">
        <input className="name grow" value={req.name} onChange={(e) => update({ name: e.target.value })} />
        <span className="muted">Env: {env ?? 'none'}</span>
      </div>
      {isSql ? (
        <div>
          <div className="row">
            <input className="grow" placeholder="server (host or host,port)" value={sql.server} onChange={(e) => updateSql({ server: e.target.value })} />
            <input className="grow" placeholder="database" value={sql.database} onChange={(e) => updateSql({ database: e.target.value })} />
          </div>
          <div className="row">
            <input className="grow" placeholder="user" value={sql.user} onChange={(e) => updateSql({ user: e.target.value })} />
            <input className="grow" placeholder="password, use {{DB_PASSWORD}} (secret variable)" value={sql.password} onChange={(e) => updateSql({ password: e.target.value })} />
            <button onClick={send} disabled={sending}>{sending ? 'Running...' : 'Run'}</button>
            <button className="ghost" onClick={save}>{dirty ? 'Save *' : 'Save'}</button>
          </div>
          <textarea
            spellCheck={false}
            style={{ minHeight: 200 }}
            placeholder={"SELECT state_name FROM STATE WHERE ... '{{SO}}'\nAssert on: body rowCount / rows[0].column"}
            value={sql.query}
            onChange={(e) => updateSql({ query: e.target.value })}
          />
        </div>
      ) : (
        <div className="row">
          <select value={req.method} onChange={(e) => update({ method: e.target.value as HttpMethod })}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
          <input
            className="grow"
            placeholder="{{baseUrl}}/endpoint"
            value={req.url}
            onChange={(e) => update({ url: e.target.value })}
          />
          <button onClick={send} disabled={sending}>{sending ? 'Sending...' : 'Send'}</button>
          <button className="ghost" onClick={save}>{dirty ? 'Save *' : 'Save'}</button>
        </div>
      )}

      <div className="tabs">
        {REQ_TABS.filter((t) => !isSql || ['vars', 'assertions', 'pre', 'post', 'tests'].includes(t)).map((t) => (
          <div key={t} className={`tab ${activeReqTab === t ? 'active' : ''}`} onClick={() => setReqTab(t)}>
            {TAB_LABEL[t]}
          </div>
        ))}
      </div>

      {activeReqTab === 'vars' && (
        <div>
          <h4>Pre-request variables <span className="muted">(set before sending)</span></h4>
          <KVEditor rows={req.preVars} onChange={(preVars) => update({ preVars })} />
          <h4>Captures <span className="muted">(variable = expression, e.g. res.body.access_token)</span></h4>
          <KVEditor rows={req.captures} onChange={(captures) => update({ captures })} />
        </div>
      )}
      {activeReqTab === 'assertions' && (
        <AssertionEditor rows={req.assertions} onChange={(assertions) => update({ assertions })} />
      )}
      {activeReqTab === 'retry' && (
        <div>
          <h4>Automatic Retry / Polling (for async MES states)</h4>
          <div className="row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={req.retry?.enabled ?? false}
                onChange={(e) => update({ retry: { enabled: e.target.checked, maxAttempts: req.retry?.maxAttempts ?? 5, intervalMs: req.retry?.intervalMs ?? 3000, path: req.retry?.path ?? 'status', op: req.retry?.op ?? 'eq', expected: req.retry?.expected ?? 'APPROVED' } })}
              />
              Enable Polling / Retry until condition passes
            </label>
          </div>
          {req.retry?.enabled && (
            <div>
              <div className="row">
                <span className="muted">Max attempts:</span>
                <input
                  type="number"
                  style={{ width: 80 }}
                  value={req.retry.maxAttempts}
                  onChange={(e) => update({ retry: { ...req.retry!, maxAttempts: Number(e.target.value) || 1 } })}
                />
                <span className="muted" style={{ marginLeft: 12 }}>Interval (ms):</span>
                <input
                  type="number"
                  style={{ width: 100 }}
                  value={req.retry.intervalMs}
                  onChange={(e) => update({ retry: { ...req.retry!, intervalMs: Number(e.target.value) || 1000 } })}
                />
              </div>
              <div className="muted" style={{ margin: '8px 0 4px' }}>Poll condition (stops when satisfied):</div>
              <div className="kv">
                <input
                  type="text"
                  placeholder="JSON path, e.g. status or verdict"
                  value={req.retry.path}
                  onChange={(e) => update({ retry: { ...req.retry!, path: e.target.value } })}
                />
                <select
                  value={req.retry.op}
                  onChange={(e) => update({ retry: { ...req.retry!, op: e.target.value as AssertOp } })}
                >
                  {OPS.map((o) => <option key={o}>{o}</option>)}
                </select>
                <input
                  type="text"
                  placeholder="Expected value, e.g. APPROVED"
                  value={req.retry.expected}
                  onChange={(e) => update({ retry: { ...req.retry!, expected: e.target.value } })}
                />
              </div>
            </div>
          )}
        </div>
      )}
      {activeReqTab === 'pre' && <ScriptBox value={req.preScript} onChange={(preScript) => update({ preScript })} hint="Runs before sending. Use bru.setVar(k, v), req.setHeader(k, v), req.setUrl(u)..." />}
      {activeReqTab === 'post' && <ScriptBox value={req.postScript} onChange={(postScript) => update({ postScript })} hint="Runs after the response. Use res.getBody(), res.getStatus(), bru.setVar(k, v)..." />}
      {activeReqTab === 'tests' && <ScriptBox value={req.tests} onChange={(tests) => update({ tests })} hint={'test("name", () => { expect(res.getStatus()).to.equal(200); });'} />}

      {activeReqTab === 'params' && <KVEditor rows={req.params} onChange={(params) => update({ params })} />}
      {activeReqTab === 'headers' && <KVEditor rows={req.headers} onChange={(headers) => update({ headers })} />}
      {activeReqTab === 'body' && (
        <div>
          <div className="row">
            <select value={req.body.type} onChange={(e) => update({ body: { ...req.body, type: e.target.value as BodyType } })}>
              <option value="none">None</option>
              <option value="json">JSON</option>
              <option value="text">Text</option>
              <option value="form">Form (key=value per line)</option>
              <option value="file">Binary / File Upload</option>
            </select>
          </div>
          {req.body.type === 'file' && (
            <div>
              <div className="muted" style={{ marginBottom: 4 }}>Absolute or relative file path to upload (supports variables like S:\Dev\files\{'{'}{'{'}filename{'}'}{'}'}):</div>
              <input
                className="grow"
                style={{ width: '100%' }}
                placeholder="C:\path\to\model.adf or relative/path/file.bin"
                value={req.body.filePath ?? ''}
                onChange={(e) => update({ body: { ...req.body, filePath: e.target.value } })}
              />
            </div>
          )}
          {req.body.type !== 'none' && req.body.type !== 'file' && (
            <textarea value={req.body.content} onChange={(e) => update({ body: { ...req.body, content: e.target.value } })} />
          )}
        </div>
      )}
      {activeReqTab === 'auth' && (
        <div>
          <div className="row">
            <select value={req.auth.type} onChange={(e) => update({ auth: { ...req.auth, type: e.target.value as AuthType } })}>
              <option value="none">None</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
              <option value="apikey">API Key</option>
              <option value="oauth2_cc">OAuth 2.0 (Client Credentials / Azure AD)</option>
            </select>
          </div>
          {req.auth.type === 'bearer' && (
            <input className="grow" style={{ width: '100%' }} placeholder="token or {{access_token}}" value={req.auth.token}
              onChange={(e) => update({ auth: { ...req.auth, token: e.target.value } })} />
          )}
          {req.auth.type === 'basic' && (
            <div className="row">
              <input className="grow" placeholder="username" value={req.auth.username}
                onChange={(e) => update({ auth: { ...req.auth, username: e.target.value } })} />
              <input className="grow" type="password" placeholder="password" value={req.auth.password}
                onChange={(e) => update({ auth: { ...req.auth, password: e.target.value } })} />
            </div>
          )}
          {req.auth.type === 'apikey' && (
            <div className="row">
              <input
                style={{ width: 180 }}
                placeholder="Header / param name (e.g. X-API-Key)"
                value={req.auth.apiKeyName ?? 'X-API-Key'}
                onChange={(e) => update({ auth: { ...req.auth, apiKeyName: e.target.value } })}
              />
              <input
                className="grow"
                placeholder="Key value or {{apiKey}}"
                value={req.auth.apiKeyValue ?? ''}
                onChange={(e) => update({ auth: { ...req.auth, apiKeyValue: e.target.value } })}
              />
              <select
                value={req.auth.apiKeyIn ?? 'header'}
                onChange={(e) => update({ auth: { ...req.auth, apiKeyIn: e.target.value as 'header' | 'query' } })}
              >
                <option value="header">Header</option>
                <option value="query">Query param</option>
              </select>
            </div>
          )}
          {req.auth.type === 'oauth2_cc' && (
            <div>
              <div className="muted" style={{ marginBottom: 6 }}>Automates OAuth2 token retrieval (e.g. login.microsoftonline.com / Azure AD):</div>
              <div className="row">
                <input
                  className="grow"
                  placeholder="Token URL, e.g. https://login.microsoftonline.com/.../token"
                  value={req.auth.oauth2?.tokenUrl ?? ''}
                  onChange={(e) => update({ auth: { ...req.auth, oauth2: { ...req.auth.oauth2!, tokenUrl: e.target.value } } })}
                />
              </div>
              <div className="row">
                <input
                  className="grow"
                  placeholder="Client ID or {{CLIENT_ID}}"
                  value={req.auth.oauth2?.clientId ?? ''}
                  onChange={(e) => update({ auth: { ...req.auth, oauth2: { ...req.auth.oauth2!, clientId: e.target.value } } })}
                />
                <input
                  className="grow"
                  type="password"
                  placeholder="Client Secret or {{CLIENT_SECRET}}"
                  value={req.auth.oauth2?.clientSecret ?? ''}
                  onChange={(e) => update({ auth: { ...req.auth, oauth2: { ...req.auth.oauth2!, clientSecret: e.target.value } } })}
                />
              </div>
              <div className="row">
                <input
                  className="grow"
                  placeholder="Scope, e.g. https://graph.microsoft.com/.default"
                  value={req.auth.oauth2?.scope ?? ''}
                  onChange={(e) => update({ auth: { ...req.auth, oauth2: { ...req.auth.oauth2!, scope: e.target.value } } })}
                />
              </div>
            </div>
          )}
        </div>
      )}

      <h3>Response</h3>
      {!res && <div className="muted">Press Send (Ctrl+Enter) to run the request.</div>}
      {res && (
        <div>
          <div className="row">
            <span className={`badge ${res.passed ? 'ok' : 'bad'}`}>{res.passed ? 'PASSED' : 'FAILED'}</span>
            <span className={`badge ${r.ok ? 'ok' : 'bad'}`}>{r.status ? `${r.status} ${r.statusText}` : 'ERROR'}</span>
            <span className="muted">{r.durationMs} ms</span>
            <span className="muted">{r.sizeBytes} B</span>
            <span className="muted">{r.resolvedUrl}</span>
            <button className="ghost" onClick={generateAiAssertions} disabled={aiLoading !== null} title="Analyze response and automatically create assertions and variable captures">
              {aiLoading === 'assertions' ? 'AI Thinking...' : '✨ AI Assertions'}
            </button>
            {!res.passed && (
              <button className="ghost" onClick={diagnoseAiFailure} disabled={aiLoading !== null} title="Analyze why this request or assertion failed">
                {aiLoading === 'diagnosis' ? 'AI Thinking...' : '🩺 Diagnose Failure'}
              </button>
            )}
          </div>
          {aiDiagnosis && (
            <div style={{ background: 'var(--vscode-editor-inactiveSelectionBackground)', padding: '10px 14px', borderRadius: 4, margin: '8px 0', borderLeft: '3px solid var(--vscode-focusBorder)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>🤖 AI Diagnosis</span>
                <button className="ghost" style={{ padding: '2px 10px', fontSize: '0.85em' }}
                  onClick={() => navigator.clipboard.writeText(aiDiagnosis)}>Copy</button>
              </div>
              <MdView text={aiDiagnosis} />
            </div>
          )}
          {r.error && <pre>{r.error}</pre>}
          <div className="tabs">
            {(['tests', 'body', 'headers', 'logs'] as ResTab[]).map((t) => (
              <div key={t} className={`tab ${resTab === t ? 'active' : ''}`} onClick={() => setResTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
                {t === 'tests' && ` (${res.tests.filter((x) => x.passed).length}/${res.tests.length})`}
              </div>
            ))}
          </div>
          {resTab === 'tests' && (
            <div>
              {res.tests.length === 0 && <div className="muted">No assertions or tests defined.</div>}
              {res.tests.map((t, i) => (
                <div key={i} style={{ marginBottom: 4 }}>
                  <span style={{ color: t.passed ? '#4caf50' : '#f44336' }}>{t.passed ? 'PASS' : 'FAIL'}</span> {t.name}
                  {t.error && <div className="muted" style={{ marginLeft: 18 }}>{t.error}</div>}
                </div>
              ))}
            </div>
          )}
          {resTab === 'body' && (
            isSql && parsedBody !== null
              ? <SqlTable parsed={parsedBody} />
              : parsedBody !== null
                ? <JsonHighlight text={shown} />
                : <pre>{shown}</pre>
          )}
          {resTab === 'headers' && <pre>{Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>}
          {resTab === 'logs' && <pre>{res.logs.join('\n') || '(no console output)'}</pre>}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

