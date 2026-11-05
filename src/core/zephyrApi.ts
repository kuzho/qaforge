import type { CaseResult } from './types';

export interface ZephyrPublishOptions {
  jiraBaseUrl: string;
  apiToken: string;
  projectKey: string;
  cycleName?: string;
  folder?: string;
  environment?: string;
}

export interface ZephyrPublishResponse {
  ok: boolean;
  testRunKey?: string;
  testRunUrl?: string;
  casesPublished: number;
  error?: string;
}

/**
 * Publishes test execution results directly to Jira Zephyr Scale via REST API.
 * Creates or appends to a Test Cycle and records PASS/FAIL statuses and durations.
 */
export async function publishResultsToZephyr(
  cases: CaseResult[],
  opts: ZephyrPublishOptions,
): Promise<ZephyrPublishResponse> {
  const baseUrl = opts.jiraBaseUrl.replace(/[\\/]+$/, '');
  const cycleName = opts.cycleName || `QAForge Automated Execution - ${new Date().toISOString().slice(0, 16)}`;

  // Construct Zephyr Scale execution payload
  const items = cases.map((c) => {
    return {
      testCaseKey: c.id,
      status: c.passed ? 'Pass' : 'Fail',
      executionTime: c.durationMs,
      executedBy: 'QAForge Automated Engine',
      comment: `Automated run in QAForge environment [${opts.environment ?? 'Default'}].\nDuration: ${c.durationMs}ms\nManual Steps: ${c.manualSteps}\nIterations: ${c.iterations.length}`,
    };
  });

  const payload = {
    projectKey: opts.projectKey,
    name: cycleName,
    folder: opts.folder || 'QAForge Automated Tests',
    status: cases.every((c) => c.passed) ? 'Pass' : 'Fail',
    items,
  };

  // Try standard Zephyr Scale / ATM endpoint
  const endpoint = `${baseUrl}/rest/atm/1.0/testrun`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const key = data.key || data.testRunKey || data.id;
      const testRunUrl = key ? `${baseUrl}/secure/Tests.jspa#/testrun/${key}` : undefined;
      return {
        ok: true,
        testRunKey: key,
        testRunUrl,
        casesPublished: cases.length,
      };
    }

    const errText = await res.text();
    return {
      ok: false,
      casesPublished: 0,
      error: `Jira Zephyr API returned ${res.status}: ${errText.slice(0, 300)}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      casesPublished: 0,
      error: `Failed connecting to Jira at "${baseUrl}": ${err.message}`,
    };
  }
}

