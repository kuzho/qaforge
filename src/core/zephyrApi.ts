import type { CaseResult } from './types';

export interface ZephyrPublishOptions {
  jiraBaseUrl: string;
  apiToken: string;
  projectKey: string;
  cycleName?: string;
  folder?: string;
  environment?: string;
  junitXml?: string;
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
  const isCloud = /cloud\.jira|atlassian\.net|zephyrscale\.smartbear\.com/i.test(baseUrl);

  // 1. Zephyr Scale Cloud API (SmartBear endpoint for Jira Cloud instances)
  if (isCloud) {
    const cloudApi = 'https://api.zephyrscale.smartbear.com/v2';
    try {
      if (opts.junitXml) {
        const endpoint = `${cloudApi}/automations/executions/junit?projectKey=${encodeURIComponent(opts.projectKey)}&autoCreateTestCases=true`;
        const form = new FormData();
        form.append('file', new Blob([opts.junitXml], { type: 'application/xml' }), 'junit.xml');
        form.append('testCycle', JSON.stringify({
          name: cycleName,
          description: `Automated execution from QAForge [${opts.environment ?? 'Default'}]`,
        }));

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiToken.trim()}`,
          },
          body: form,
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          const key = data?.testCycle?.key || data?.key;
          const testRunUrl = key
            ? `${baseUrl}/projects/${opts.projectKey}?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.kanoah.test-manager__main-project-page#!/testPlayer/${key}`
            : undefined;
          return {
            ok: true,
            testRunKey: key,
            testRunUrl,
            casesPublished: data?.totalTestCases ?? cases.length,
          };
        }

        const errText = await res.text();
        let hint = '';
        if (res.status === 401) {
          hint = ' (Note: Jira Cloud requires a Zephyr Scale API Access Token from Jira Profile > Zephyr Scale API Access Tokens, not a Jira PAT)';
        }
        return {
          ok: false,
          casesPublished: 0,
          error: `Zephyr Scale Cloud returned ${res.status}: ${errText.slice(0, 250)}${hint}`,
        };
      }

      // Fallback Cloud: Create Test Cycle + Test Executions directly
      const cycleRes = await fetch(`${cloudApi}/testcycles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiToken.trim()}`,
        },
        body: JSON.stringify({
          projectKey: opts.projectKey,
          name: cycleName,
          description: `Automated execution from QAForge [${opts.environment ?? 'Default'}]`,
          statusName: cases.every((c) => c.passed) ? 'Done' : 'In Progress',
        }),
      });

      if (!cycleRes.ok) {
        const errText = await cycleRes.text();
        return {
          ok: false,
          casesPublished: 0,
          error: `Zephyr Scale Cloud returned ${cycleRes.status}: ${errText.slice(0, 250)}`,
        };
      }

      const cycleData = (await cycleRes.json()) as any;
      const cycleKey = cycleData?.key;
      let count = 0;
      for (const c of cases) {
        await fetch(`${cloudApi}/testexecutions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiToken.trim()}`,
          },
          body: JSON.stringify({
            projectKey: opts.projectKey,
            testCaseKey: c.id,
            testCycleKey: cycleKey,
            statusName: c.passed ? 'Pass' : 'Fail',
            executionTime: c.durationMs,
            comment: `Duration: ${c.durationMs}ms`,
          }),
        });
        count++;
      }

      const testRunUrl = cycleKey
        ? `${baseUrl}/projects/${opts.projectKey}?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.kanoah.test-manager__main-project-page#!/testPlayer/${cycleKey}`
        : undefined;

      return {
        ok: true,
        testRunKey: cycleKey,
        testRunUrl,
        casesPublished: count,
      };
    } catch (err: any) {
      return {
        ok: false,
        casesPublished: 0,
        error: `Failed connecting to Zephyr Scale Cloud API: ${err.message}`,
      };
    }
  }

  // 2. Jira Server / Data Center (on-premise /rest/atm/1.0 endpoint)
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

  const endpoint = `${baseUrl}/rest/atm/1.0/testrun`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiToken.trim()}`,
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

