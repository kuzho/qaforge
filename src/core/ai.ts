import * as vscode from 'vscode';
import type { Assertion, RequestDef, ResponseResult, TestResult } from './types';

/**
 * Finds available chat models in VS Code (Copilot, Claude/Antigravity, etc.).
 * Selects Copilot/Claude/GPT families if available.
 */
export async function getAiModel(): Promise<vscode.LanguageModelChat | undefined> {
  if (typeof (vscode as any).lm?.selectChatModels !== 'function') return undefined;
  try {
    const models = await (vscode as any).lm.selectChatModels();
    if (!models || models.length === 0) return undefined;
    // Prefer Claude or GPT-4o if present, otherwise default to first available
    const preferred = models.find((m: any) =>
      /claude|gpt-4|gemini|sonnet/i.test(`${m.id} ${m.name} ${m.family}`),
    );
    return preferred || models[0];
  } catch {
    return undefined;
  }
}

async function askModel(model: vscode.LanguageModelChat, systemPrompt: string, userPrompt: string): Promise<string> {
  const messages = [
    vscode.LanguageModelChatMessage.User(`${systemPrompt}\n\nTask:\n${userPrompt}`),
  ];
  const cts = new vscode.CancellationTokenSource();
  const res = await model.sendRequest(messages, {}, cts.token);
  let text = '';
  for await (const fragment of res.text) {
    text += fragment;
  }
  return text;
}

/**
 * Uses AI to propose assertions and variables to capture from an API/SQL response.
 */
export async function aiGenerateAssertions(
  req: RequestDef,
  res: ResponseResult,
): Promise<{ assertions: Assertion[]; captures: { key: string; value: string }[] }> {
  const model = await getAiModel();
  if (!model) {
    throw new Error('No Language Model available in VS Code (ensure Copilot or Antigravity LM is active).');
  }

  const prompt = `You are a QA automation expert. Given this request and response, propose:
1. Standard & meaningful assertions (status code, key JSON properties, response time < 5000, etc.).
2. Variables that should be captured from the response (like tokens, IDs, generated numbers) for subsequent requests.

Request:
Method: ${req.method}
URL: ${req.url}

Response Status: ${res.status}
Response Body (truncated if large):
${res.body.slice(0, 4000)}

Output ONLY valid JSON in this exact schema without markdown backticks:
{
  "assertions": [
    { "enabled": true, "source": "status"|"header"|"body"|"time", "path": "json.path.or.headerName", "op": "eq"|"neq"|"gt"|"contains"|"exists"|"isNotEmpty", "expected": "value" }
  ],
  "captures": [
    { "key": "variableName", "value": "res.body.path.to.field" }
  ]
}`;

  const raw = await askModel(model, 'Respond only with raw JSON conforming to the requested schema.', prompt);
  const clean = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(clean);
    return {
      assertions: Array.isArray(parsed.assertions) ? parsed.assertions : [],
      captures: Array.isArray(parsed.captures) ? parsed.captures : [],
    };
  } catch {
    throw new Error(`Failed to parse AI output: ${raw.slice(0, 200)}`);
  }
}

/**
 * Uses AI to analyze a failure in a step (HTTP error, assertion failed, or SQL error)
 * and provide a plain-text diagnosis with actionable fix recommendation.
 */
export async function aiDiagnoseFailure(
  req: RequestDef,
  res: ResponseResult,
  failedTests: TestResult[],
): Promise<string> {
  const model = await getAiModel();
  if (!model) {
    throw new Error('No Language Model available in VS Code.');
  }

  const prompt = `Analyze this QA test failure and provide a clear diagnosis with actionable fixes:

Request:
Method/Type: ${req.kind === 'sql' ? 'SQL Query' : req.method}
URL / Query: ${req.kind === 'sql' ? req.sql?.query : req.url}

Response:
Status: ${res.status} ${res.statusText}
Error: ${res.error ?? 'None'}
Body:
${res.body.slice(0, 3000)}

Failed Tests/Assertions:
${failedTests.map((t) => `- ${t.name}: ${t.error}`).join('\n')}

Provide:
1. Root cause summary.
2. Recommended fix in payload, variables, or environment.`;

  return askModel(model, 'You are an expert QA and SQA MES architect diagnosing test failures.', prompt);
}
