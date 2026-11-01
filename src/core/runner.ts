import { executeRequest } from './http';
import { executeSql } from './sql';
import { evaluateAssertion } from './assertions';
import { evalExpression, runScript } from './script';
import { interpolate } from './variables';
import type { RequestDef, RunOutput, TestResult } from './types';

/**
 * Full request pipeline: pre-vars -> pre-script -> send -> captures -> assertions -> post-script -> tests.
 * `runtime` holds variables that persist across requests and is updated in place.
 */
export async function runRequest(
  def: RequestDef,
  envVars: Record<string, string>,
  runtime: Record<string, string>,
): Promise<RunOutput> {
  const req: RequestDef = JSON.parse(JSON.stringify(def));
  const vars: Record<string, string> = { ...envVars, ...runtime };
  const tests: TestResult[] = [];
  const logs: string[] = [];

  for (const v of req.preVars.filter((x) => x.enabled && x.key)) {
    const value = interpolate(v.value, vars);
    vars[v.key] = value;
    runtime[v.key] = value;
  }

  const pre = await runScript(req.preScript, { req, vars, runtime });
  tests.push(...pre.tests);
  logs.push(...pre.logs);

  let response = req.kind === 'sql' ? await executeSql(req, vars) : await executeRequest(req, vars);

  // Auto-retry / polling if configured
  if (req.retry && req.retry.enabled && req.retry.maxAttempts > 1) {
    const retry = req.retry;
    const condAssertion = {
      enabled: true,
      source: 'body' as const,
      path: retry.path,
      op: retry.op,
      expected: retry.expected,
    };
    let attempt = 1;
    let satisfied = evaluateAssertion(condAssertion, response, vars).passed;
    while (!satisfied && attempt < retry.maxAttempts) {
      logs.push(`[Retry ${attempt}/${retry.maxAttempts}] Condition "${retry.path} ${retry.op} ${retry.expected}" not met yet. Waiting ${retry.intervalMs}ms...`);
      await new Promise((r) => setTimeout(r, retry.intervalMs));
      response = req.kind === 'sql' ? await executeSql(req, vars) : await executeRequest(req, vars);
      attempt++;
      satisfied = evaluateAssertion(condAssertion, response, vars).passed;
    }
    if (satisfied) {
      logs.push(`[Retry] Condition satisfied on attempt ${attempt}`);
    } else {
      logs.push(`[Retry] Condition timed out after ${attempt} attempts`);
    }
  }

  if (!response.error) {
    for (const c of req.captures.filter((x) => x.enabled && x.key)) {
      const value = evalExpression(c.value, response, vars);
      if (value !== undefined) {
        vars[c.key] = value;
        runtime[c.key] = value;
      }
    }
    for (const a of req.assertions.filter((x) => x.enabled)) {
      tests.push(evaluateAssertion(a, response, vars));
    }
    const post = await runScript(req.postScript, { req, res: response, vars, runtime });
    tests.push(...post.tests);
    logs.push(...post.logs);
    const t = await runScript(req.tests, { req, res: response, vars, runtime });
    tests.push(...t.tests);
    logs.push(...t.logs);
  } else {
    tests.push({ name: 'request', passed: false, error: response.error });
  }

  return { response, tests, logs, passed: !response.error && tests.every((t) => t.passed) };
}

