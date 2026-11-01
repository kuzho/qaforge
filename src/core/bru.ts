import { emptyRequest, type Assertion, type AssertOp, type AssertSource, type HttpMethod, type KV, type RequestDef } from './types';

interface Block {
  name: string;
  lines: string[];
  list: boolean;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function parseBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w:\-]+)\s*(\{|\[)\s*$/.exec(lines[i]);
    if (!m) continue;
    const close = m[2] === '{' ? '}' : ']';
    const body: string[] = [];
    i++;
    while (i < lines.length && lines[i].trimEnd() !== close) body.push(lines[i++]);
    blocks.push({ name: m[1], lines: body, list: m[2] === '[' });
  }
  return blocks;
}

/** `key: value` or `key=value` lines; `~` prefix marks a disabled entry. */
function parseDict(lines: string[]): KV[] {
  const out: KV[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(~?)([^:=\s]+)\s*([:=])\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({ key: m[2], value: m[4], enabled: m[1] !== '~' });
  }
  return out;
}

const dedent = (lines: string[]) => lines.map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n').trim();

const ASSERT_SOURCE_OPS: Record<string, AssertOp> = {
  eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
  contains: 'contains', notContains: 'notContains', startsWith: 'startsWith', endsWith: 'endsWith',
  matches: 'matches', in: 'in', length: 'length',
  isDefined: 'exists', isNotEmpty: 'isNotEmpty', isEmpty: 'isEmpty', isUndefined: 'notExists', isNull: 'notExists',
};

function toAssertion(kv: KV): Assertion | undefined {
  const [opWord, ...rest] = kv.value.trim().split(/\s+/);
  const op = ASSERT_SOURCE_OPS[opWord];
  if (!op) return undefined;
  const lhs = kv.key;
  let source: AssertSource;
  let path = '';
  if (lhs === 'res.status') source = 'status';
  else if (lhs === 'res.responseTime') source = 'time';
  else if (lhs.startsWith('res.headers.')) { source = 'header'; path = lhs.slice('res.headers.'.length); }
  else if (lhs === 'res.body') source = 'body';
  else if (lhs.startsWith('res.body.')) { source = 'body'; path = lhs.slice('res.body.'.length); }
  else if (lhs.startsWith('res.body[')) { source = 'body'; path = lhs.slice('res.body'.length); }
  else return undefined;
  return { enabled: kv.enabled, source, path, op, expected: rest.join(' ') };
}

export interface ParsedBru {
  request: RequestDef;
  warnings: string[];
}

export function parseBruRequest(text: string, fallbackName: string): ParsedBru | undefined {
  const blocks = parseBlocks(text);
  const req = emptyRequest(fallbackName);
  const warnings: string[] = [];
  let found = false;

  for (const b of blocks) {
    const n = b.name;
    if (n === 'meta') {
      const meta = parseDict(b.lines);
      req.name = meta.find((k) => k.key === 'name')?.value || fallbackName;
      const seq = Number(meta.find((k) => k.key === 'seq')?.value);
      if (!Number.isNaN(seq)) req.seq = seq;
    } else if (METHODS.includes(n)) {
      found = true;
      req.method = n.toUpperCase() as HttpMethod;
      req.url = parseDict(b.lines).find((k) => k.key === 'url')?.value ?? '';
    } else if (n === 'params:query') {
      req.params = parseDict(b.lines);
    } else if (n === 'headers') {
      req.headers = parseDict(b.lines);
    } else if (n === 'auth:bearer') {
      req.auth = { ...req.auth, type: 'bearer', token: parseDict(b.lines).find((k) => k.key === 'token')?.value ?? '' };
    } else if (n === 'auth:basic') {
      const d = parseDict(b.lines);
      req.auth = {
        ...req.auth, type: 'basic',
        username: d.find((k) => k.key === 'username')?.value ?? '',
        password: d.find((k) => k.key === 'password')?.value ?? '',
      };
    } else if (n === 'body:json') {
      req.body = { type: 'json', content: dedent(b.lines) };
    } else if (n === 'body:text' || n === 'body:xml') {
      req.body = { type: 'text', content: dedent(b.lines) };
    } else if (n === 'body:formencoded') {
      req.body = { type: 'form', content: parseDict(b.lines).filter((k) => k.enabled).map((k) => `${k.key}=${k.value}`).join('\n') };
    } else if (n === 'body:multipart-form') {
      warnings.push(`${fallbackName}: multipart body not supported yet`);
    } else if (n === 'vars:pre-request') {
      req.preVars = parseDict(b.lines);
    } else if (n === 'vars:post-response') {
      req.captures = parseDict(b.lines);
    } else if (n === 'script:pre-request') {
      req.preScript = dedent(b.lines);
    } else if (n === 'script:post-response') {
      req.postScript = dedent(b.lines);
    } else if (n === 'tests') {
      req.tests = dedent(b.lines);
    } else if (n === 'assert') {
      for (const kv of parseDict(b.lines)) {
        const a = toAssertion(kv);
        if (a) req.assertions.push(a);
        else warnings.push(`${fallbackName}: unsupported assertion "${kv.key}: ${kv.value}"`);
      }
    }
  }

  // Bruno mirrors query params inside the URL; avoid duplicating them.
  if (req.url.includes('?')) req.params = [];
  return found ? { request: req, warnings } : undefined;
}

export function parseBruEnvironment(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const b of parseBlocks(text)) {
    if (b.name === 'vars') for (const kv of parseDict(b.lines)) vars[kv.key] = kv.value;
    else if (b.name === 'vars:secret') {
      for (const l of b.lines) {
        const key = l.trim().replace(/,$/, '');
        if (key && !(key in vars)) vars[key] = '';
      }
    }
  }
  return vars;
}

