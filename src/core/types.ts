export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type BodyType = 'none' | 'json' | 'text' | 'form' | 'file';

export interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;
  intervalMs: number;
  /** JSON path in response body, e.g. "status" or "verdict" */
  path: string;
  op: AssertOp;
  expected: string;
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2_cc';

export interface OAuth2ClientCredentials {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  autoFetch?: boolean;
}

export interface AuthConfig {
  type: AuthType;
  token: string;
  username: string;
  password: string;
  // ApiKey
  apiKeyName?: string;
  apiKeyValue?: string;
  apiKeyIn?: 'header' | 'query';
  // OAuth2 Client Credentials
  oauth2?: OAuth2ClientCredentials;
}

export type AssertSource = 'status' | 'header' | 'body' | 'time';

export type AssertOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'matches'
  | 'in' | 'length' | 'exists' | 'notExists' | 'isEmpty' | 'isNotEmpty';

export interface Assertion {
  enabled: boolean;
  source: AssertSource;
  /** header name for `header`, JSON path for `body` (empty = whole body) */
  path: string;
  op: AssertOp;
  expected: string;
}

export interface SqlDef {
  /** host or host,port - supports {{variables}} */
  server: string;
  database: string;
  user: string;
  password: string;
  query: string;
}

export interface RequestDef {
  name: string;
  seq?: number;
  /** `sql` steps run `sql.query` against SQL Server; the result is exposed as the JSON body `{ rowCount, rows }` */
  kind?: 'http' | 'sql';
  sql?: SqlDef;
  method: HttpMethod;
  url: string;
  params: KV[];
  headers: KV[];
  body: { type: BodyType; content: string; filePath?: string };
  auth: AuthConfig;
  retry?: RetryConfig;
  /** variables set before the request is sent: key = value */
  preVars: KV[];
  /** variables captured from the response: key = expression (e.g. res.body.access_token) */
  captures: KV[];
  assertions: Assertion[];
  preScript: string;
  postScript: string;
  tests: string;
}

export interface Environment {
  name: string;
  variables: Record<string, string>;
  /** names of variables whose values live in VS Code SecretStorage (or QAFORGE_SECRET_<NAME> in CI) */
  secrets?: string[];
}

export interface Globals {
  variables: Record<string, string>;
  secrets: string[];
}

export interface TestCaseStep {
  name: string;
  /** Layer tag for architecture mapping: e.g. 'Cloud API', 'JBoss EJB', 'SQL Server', 'Manual' */
  layer?: 'Cloud API' | 'JBoss EJB' | 'SQL Server' | 'Robot Desktop' | 'Manual' | string;
  /** request file or folder, relative to .qaforge/collections (omit for manual steps) */
  request?: string;
  expected?: string;
  manual?: boolean;
}

export interface GherkinCriteria {
  given: string;
  when: string;
  then: string;
}

export interface TestCaseDef {
  id: string;
  title: string;
  description?: string;
  objective?: string;
  requirement?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
  preconditions?: string;
  criteria?: GherkinCriteria;
  variables?: Record<string, string>;
  /** inline rows: the case runs once per row, row values become variables */
  data?: Record<string, string>[];
  /** CSV or JSON file (relative to .qaforge) with data rows */
  dataFile?: string;
  stopOnFailure?: boolean;
  steps: TestCaseStep[];
}

export interface RequestResult {
  name: string;
  file: string;
  passed: boolean;
  skipped?: boolean;
  status: number;
  durationMs: number;
  tests: TestResult[];
  logs: string[];
  error?: string;
}

export interface CaseIteration {
  index: number;
  data: Record<string, string>;
  steps: RequestResult[];
  passed: boolean;
}

export interface CaseResult {
  id: string;
  title: string;
  requirement?: string;
  priority?: string;
  passed: boolean;
  durationMs: number;
  manualSteps: number;
  iterations: CaseIteration[];
}

export interface SuiteResult {
  name: string;
  environment?: string;
  startedAt: string;
  durationMs: number;
  cases: CaseResult[];
}

export interface ResponseResult {
  ok: boolean;
  status: number;
  statusText: string;
  durationMs: number;
  sizeBytes: number;
  headers: Record<string, string>;
  body: string;
  error?: string;
  resolvedUrl: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface RunOutput {
  response: ResponseResult;
  tests: TestResult[];
  logs: string[];
  passed: boolean;
}

export function emptyRequest(name: string): RequestDef {
  return {
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { type: 'none', content: '' },
    auth: { type: 'none', token: '', username: '', password: '' },
    preVars: [],
    captures: [],
    assertions: [],
    preScript: '',
    postScript: '',
    tests: '',
  };
}

export function emptySql(): SqlDef {
  return { server: '{{DB_SERVER}}', database: '{{DB_NAME}}', user: '{{DB_USER}}', password: '{{DB_PASSWORD}}', query: '' };
}
