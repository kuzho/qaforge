import * as fs from 'fs';
import * as path from 'path';
import type { Storage } from './storage';
import type { TestCaseDef } from './types';

export interface ZephyrExportOptions {
  status?: string;
  folder?: string;
  projectKey?: string;
  projectId?: string;
  resolvedVariables?: Record<string, string>;
  useEnvironmentValues?: boolean;
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);
}

/** Maps QAForge priority → Zephyr custom field value (P0–P3) */
function mapPriorityCustom(p?: string): string {
  switch (p?.toLowerCase()) {
    case 'critical': return 'P0';
    case 'high':     return 'P1';
    case 'medium':   return 'P2';
    default:         return 'P3';
  }
}

/** Maps QAForge priority → Zephyr <priority> element value */
function mapPriorityLabel(p?: string): string {
  switch (p?.toLowerCase()) {
    case 'critical': return 'Critical';
    case 'high':     return 'High';
    case 'low':      return 'Low';
    default:         return 'Normal';
  }
}

/** Maps QAForge executionType → Zephyr valid option string */
function mapExecutionType(exec?: string): string {
  if (!exec) return 'Manual - To Be Automated';
  const low = exec.toLowerCase().trim();
  if (low.includes('manual') && low.includes('not')) return 'Manual - Not To Be Automated';
  if (low.includes('automated') && low.includes('maintained')) return 'Automated - To Be Maintained';
  if (low === 'manual - to be automated' || low === 'automated' || low === 'manual') return 'Manual - To Be Automated';
  return exec;
}

/** Maps QAForge layer → Zephyr Test Layer custom field value */
function mapTestLayer(layers: string[]): string {
  const hasApi   = layers.some((l) => /cloud|api/i.test(l));
  const hasJboss = layers.some((l) => /jboss|ejb/i.test(l));
  const hasSql   = layers.some((l) => /sql/i.test(l));
  // Mixed (API+SQL, JBoss+SQL, etc.) or any API/JBoss = E2E; pure SQL only = Integration
  if (hasApi || hasJboss) return 'End-to-End Acceptance Tests';
  if (hasSql) return 'Integration Tests';
  return 'End-to-End Acceptance Tests';
}

/** Converts {{paramName}} and {paramName} to Zephyr Scale native parameter badge <var contenteditable="false">paramName</var> */
function formatZephyrVars(html: string, paramNames?: string[]): string {
  let res = html.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, '<var contenteditable="false">$1</var>');
  if (paramNames && paramNames.length > 0) {
    for (const p of paramNames) {
      const regex = new RegExp(`(?<![a-zA-Z0-9_])\\{${p}\\}(?![a-zA-Z0-9_])`, 'g');
      res = res.replace(regex, `<var contenteditable="false">${p}</var>`);
    }
  }
  return res;
}

/** Builds a rich step description for Zephyr with native parameter badges */
function buildStepHtml(stepName: string, req: any | null, paramNames?: string[]): string {
  const lines: string[] = [`<p><strong>${formatZephyrVars(esc(stepName), paramNames)}</strong></p>`];
  if (req) {
    if (req.kind === 'sql') {
      const q = req.sql?.query?.trim().replace(/\s+/g, ' ') ?? '';
      lines.push(`<ol><li>Type: <strong>SQL Query</strong></li>`);
      if (q) lines.push(`<li>Query: <code>${formatZephyrVars(esc(q.slice(0, 2000)), paramNames)}</code></li>`);
      lines.push(`</ol>`);
    } else {
      lines.push(`<ol><li>Method: <strong>${esc(req.method || 'GET')}</strong></li>`);
      if (req.url) lines.push(`<li>URL: <code>${formatZephyrVars(esc(req.url), paramNames)}</code></li>`);
      if (req.body?.content && req.body.type !== 'none') {
        lines.push(`<li>Body: <code>${formatZephyrVars(esc(req.body.content.slice(0, 1000)), paramNames)}</code></li>`);
      }
      lines.push(`</ol>`);
    }
  }
  return lines.join('');
}

function buildExpectedHtml(req: any | null, stepExpected?: string, paramNames?: string[]): string {
  const parts: string[] = [];
  if (stepExpected) parts.push(`<p>${formatZephyrVars(esc(stepExpected), paramNames)}</p>`);
  if (req?.assertions?.length) {
    const asserts = req.assertions
      .filter((a: any) => a.enabled)
      .map((a: any) => `<li>${formatZephyrVars(esc(`${a.source}${a.path ? '.' + a.path : ''} ${a.op} ${a.expected ?? ''}`.trim()), paramNames)}</li>`)
      .join('');
    if (asserts) parts.push(`<ol>${asserts}</ol>`);
  }
  return parts.length ? parts.join('') : '<p>Response Status: 200</p>';
}

/**
 * Exports QAForge test cases as Zephyr Scale XML (ATM importer format).
 * Matches the structure of atm-exporter.xml exactly.
 */
export function testCasesToZephyrXml(
  cases: TestCaseDef[],
  storage?: Storage,
  options?: ZephyrExportOptions,
): string {
  const projectKey = options?.projectKey ?? 'MES';
  const projectId  = options?.projectId  ?? '10310';
  const folder     = options?.folder     ?? 'QAForge/Automated';
  const status     = options?.status     ?? 'Approved';
  const exportDate = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const folderXml = `  <folders>\n    <folder fullPath="${esc(folder)}" index="0"/>\n  </folders>`;

  const tcXmls = cases.map((tc, tcIdx) => {
    // Collect unique layers across steps
    const layers = [...new Set(tc.steps.map((s) => s.layer ?? '').filter(Boolean))];
    const testLayer = mapTestLayer(layers);
    const execType = mapExecutionType((tc as any).executionType);
    const type     = (tc as any).type ?? 'Functional';

    // Build objective + Gherkin
    let objective = tc.objective || tc.description || '';
    if (tc.criteria) {
      const gherkin = [
        tc.criteria.given ? `<strong>Given:</strong> ${esc(tc.criteria.given)}` : '',
        tc.criteria.when  ? `<strong>When:</strong> ${esc(tc.criteria.when)}`   : '',
        tc.criteria.then  ? `<strong>Then:</strong> ${esc(tc.criteria.then)}`   : '',
      ].filter(Boolean).join('<br>');
      objective = objective
        ? `${esc(objective)}<br><br>${gherkin}`
        : gherkin;
    } else {
      objective = esc(objective);
    }

    const precondition = esc(tc.preconditions ?? '');
    const labels = (tc.tags ?? []).map((t) => `    <label>${cdata(t)}</label>`).join('\n');
    const issueLink = tc.requirement
      ? `    <issueLink>${cdata(tc.requirement)}</issueLink>`
      : '';

    // Build steps XML
    // Build parameters XML
    const tcParams: any[] = (tc as any).parameters ?? [];
    const paramsXml = tcParams.map((p: any, pIdx: number) => {
      let defaultValue = p.defaultValue ?? '';
      const envVal = options?.resolvedVariables?.[p.name];
      if (options?.useEnvironmentValues) {
        if (envVal !== undefined && envVal !== '') {
          defaultValue = envVal;
        }
      } else {
        const isPlaceholder = !defaultValue || defaultValue.trim() === '' || /^\[Place\s+/i.test(defaultValue.trim());
        if (isPlaceholder && envVal !== undefined && envVal !== '') {
          defaultValue = envVal;
        }
      }
      if (defaultValue && defaultValue.includes('{{') && options?.resolvedVariables) {
        defaultValue = defaultValue.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_: string, k: string) => {
          return options.resolvedVariables?.[k] !== undefined ? options.resolvedVariables[k] : `{{${k}}}`;
        });
      }
      return `                <parameter index="${pIdx}">\n                    <defaultValue>${cdata(defaultValue)}</defaultValue>\n                    <name>${cdata(p.name)}</name>\n                </parameter>`;
    }).join('\n');

    const stepsXml = tc.steps.map((step, idx) => {
      let req: any = null;
      if (step.request && storage) {
        try {
          const reqPath = path.isAbsolute(step.request)
            ? step.request
            : path.join(storage.collectionsDir, step.request);
          if (fs.existsSync(reqPath) && fs.statSync(reqPath).isFile()) {
            req = storage.readRequest(reqPath);
          }
        } catch { /* ignore */ }
      }
      const paramNames = tcParams.map((p: any) => p.name);
      const desc     = buildStepHtml(step.name, req, paramNames);
      const expected = buildExpectedHtml(req, step.expected, paramNames);
      return `          <step index="${idx}">
            <customFields/>
            <description>${cdata(desc)}</description>
            <expectedResult>${cdata(expected)}</expectedResult>
          </step>`;
    }).join('\n');

    return `    <testCase id="${tcIdx + 1}" key="${esc(tc.id)}" paramType="PARAMETER">
      <attachments/>
      <confluencePageLinks/>
      <customFields>
        <customField name="Execution Type" type="SINGLE_CHOICE_SELECT_LIST">
          <value>${cdata(execType)}</value>
        </customField>
        <customField name="Type" type="SINGLE_CHOICE_SELECT_LIST">
          <value>${cdata(type)}</value>
        </customField>
        <customField name="Priority" type="SINGLE_CHOICE_SELECT_LIST">
          <value>${cdata(mapPriorityCustom(tc.priority))}</value>
        </customField>
        <customField name="Test Layer" type="MULTI_CHOICE_SELECT_LIST">
          <value>${cdata(testLayer)}</value>
        </customField>
      </customFields>
      <folder>${cdata(folder)}</folder>
      <issues/>
      <labels>
${labels}
      </labels>
      <name>${cdata(tc.title)}</name>
      <objective>${cdata(objective)}</objective>
      <precondition>${cdata(precondition)}</precondition>
      <priority>${cdata(mapPriorityLabel(tc.priority))}</priority>
      <status>${cdata(status)}</status>
      <parameters>
${paramsXml}
      </parameters>
      <testDataWrapper/>
      <testScript type="steps">
        <steps>
${stepsXml}
        </steps>
      </testScript>
    </testCase>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<project>
  <projectId>${projectId}</projectId>
  <projectKey>${projectKey}</projectKey>
  <exportDate>${exportDate}</exportDate>
${folderXml}
  <testCases>
${tcXmls}
  </testCases>
</project>
`;
}

// ---------------------------------------------------------------------------
// Zephyr Scale Excel/CSV export (ATM Excel importer format)
// Columns match atm-exporter.xlsx exactly:
// Key | Name | Status | Precondition | Objective | Folder | Priority(label) |
// Component | Labels | Owner | EstTime | Coverage(Issues) | Coverage(Pages) |
// Execution Type | Priority(P0-P3) | Test Layer | Type |
// Step | Test Data | Expected Result | Plain Text | BDD
// ---------------------------------------------------------------------------
export function testCasesToZephyrExcel(
  cases: TestCaseDef[],
  storage?: Storage,
  options?: ZephyrExportOptions,
): string {
  const folder     = '/' + (options?.folder ?? 'QAForge/Automated');
  const status     = options?.status ?? 'Approved';

  // 23 columns — added Parameters after Labels
  const headers = [
    'Key', 'Name', 'Status', 'Precondition', 'Objective', 'Folder',
    'Priority', 'Component', 'Labels', 'Parameters', 'Owner', 'Estimated Time',
    'Coverage (Issues)', 'Coverage (Pages)',
    'Execution Type', 'Priority (P0-P3)', 'Test Layer', 'Type',
    'Test Script (Step-by-Step) - Step',
    'Test Script (Step-by-Step) - Test Data',
    'Test Script (Step-by-Step) - Expected Result',
    'Test Script (Plain Text)', 'Test Script (BDD)',
  ];

  const rows: string[][] = [headers];

  for (const tc of cases) {
    let objective = tc.objective || tc.description || '';
    if (tc.criteria) {
      const g = [
        tc.criteria.given ? `Given: ${tc.criteria.given}` : '',
        tc.criteria.when  ? `When: ${tc.criteria.when}`   : '',
        tc.criteria.then  ? `Then: ${tc.criteria.then}`   : '',
      ].filter(Boolean).join('\n');
      objective = objective ? `${objective}\n\n${g}` : g;
    }

    const execType   = mapExecutionType((tc as any).executionType);
    const type       = (tc as any).type ?? 'Functional';
    const layers     = [...new Set(tc.steps.map((s) => s.layer ?? '').filter(Boolean))];
    const testLayer  = mapTestLayer(layers);
    const labels     = (tc.tags ?? []).join(', ');
    const issueLink  = tc.requirement ?? '';
    const paramNames = ((tc as any).parameters ?? []).map((p: any) => p.name).join(', ');

    const steps = tc.steps.length ? tc.steps : [{ name: '(no steps)', layer: '', request: undefined, expected: '' }];

    steps.forEach((step, idx) => {
      let stepDesc = step.name;
      let testData = '';
      let expectedResult = (step as any).expected || '';

      if (step.request && storage) {
        try {
          const reqPath = path.isAbsolute(step.request)
            ? step.request
            : path.join(storage.collectionsDir, step.request);
          if (fs.existsSync(reqPath) && fs.statSync(reqPath).isFile()) {
            const req = storage.readRequest(reqPath);
            if (req.kind === 'sql') {
              stepDesc += `\nSQL: ${req.sql?.query?.trim().replace(/\s+/g, ' ').slice(0, 2000) ?? ''}`;
            } else {
              stepDesc += `\n${req.method || 'GET'} ${req.url || ''}`;
              if (req.body?.content && req.body.type !== 'none') testData = req.body.content.slice(0, 1000);
            }
            if (req.assertions?.length) {
              const asserts = req.assertions
                .filter((a: any) => a.enabled)
                .map((a: any) => `${a.source}${a.path ? '.' + a.path : ''} ${a.op} ${a.expected ?? ''}`.trim())
                .join('\n');
              expectedResult = expectedResult ? `${expectedResult}\n${asserts}` : asserts;
            }
          }
        } catch { /* ignore */ }
      }

      if (idx === 0) {
        // First step row: full metadata
        rows.push([
          tc.id, tc.title, status, tc.preconditions ?? '', objective, folder,
          mapPriorityLabel(tc.priority), '', labels, paramNames, '', '', issueLink, '',
          execType, mapPriorityCustom(tc.priority), testLayer, type,
          stepDesc, testData, expectedResult, '', '',
        ]);
      } else {
        // Subsequent step rows: only step columns, rest empty
        rows.push([
          '', '', '', '', '', '', '', '', '', '', '', '', '', '',
          '', '', '', '',
          stepDesc, testData, expectedResult, '', '',
        ]);
      }
    });
  }

  return '\uFEFF' + rows.map((r) => r.map(escapeCsv).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------
// Keep CSV export for backwards compatibility (used by CLI --format csv)
// ---------------------------------------------------------------------------
function escapeCsv(val: any): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function testCasesToZephyrCsv(
  cases: TestCaseDef[],
  storage?: Storage,
  options?: ZephyrExportOptions,
): string {
  const headers = ['Test Case Key','Name','Objective','Precondition','Priority','Status','Folder','Component','Labels','Issue Links','Step Description','Test Data','Expected Result'];
  const rows: string[][] = [headers];
  const mapPriority = (p?: string) => { switch (p?.toLowerCase()) { case 'critical': return 'Critical'; case 'high': return 'High'; case 'low': return 'Low'; default: return 'Normal'; } };

  for (const tc of cases) {
    let objective = tc.objective || tc.description || '';
    if (tc.criteria) {
      const g = [tc.criteria.given ? `Given: ${tc.criteria.given}` : '', tc.criteria.when ? `When: ${tc.criteria.when}` : '', tc.criteria.then ? `Then: ${tc.criteria.then}` : ''].filter(Boolean).join('\n');
      objective = objective ? `${objective}\n\n${g}` : g;
    }
    const priority = mapPriority(tc.priority);
    const status = options?.status || 'Approved';
    const folder = options?.folder || '/QAForge';
    const component = tc.tags?.[0] || 'API';
    const labels = (tc.tags || []).join(', ');
    const issueLinks = tc.requirement || '';
    const precondition = tc.preconditions || '';

    if (!tc.steps?.length) {
      rows.push([tc.id, tc.title, objective, precondition, priority, status, folder, component, labels, issueLinks, '', '', '']);
      continue;
    }
    for (const step of tc.steps) {
      let stepDesc = step.name + (step.layer ? ` [${step.layer}]` : '');
      let testData = '';
      let expectedResult = step.expected || '';
      if (step.request && storage) {
        try {
          const reqPath = path.isAbsolute(step.request) ? step.request : path.join(storage.collectionsDir, step.request);
          if (fs.existsSync(reqPath)) {
            const req = storage.readRequest(reqPath);
            stepDesc += req.kind === 'sql' ? `\nSQL: ${req.sql?.query?.trim().replace(/\s+/g, ' ').slice(0, 120)}` : `\n${req.method || 'GET'} ${req.url || ''}`;
            if (req.body?.content) testData = req.body.content.slice(0, 250);
            if (req.assertions?.length) {
              const asserts = req.assertions.filter((a: any) => a.enabled).map((a: any) => `${a.source}${a.path ? '.' + a.path : ''} ${a.op} ${a.expected ?? ''}`.trim()).join('; ');
              expectedResult = expectedResult ? `${expectedResult} | ${asserts}` : asserts;
            }
          }
        } catch { /* ignore */ }
      }
      rows.push([tc.id, tc.title, objective, precondition, priority, status, folder, component, labels, issueLinks, stepDesc, testData, expectedResult]);
    }
  }
  return '\uFEFF' + rows.map((r) => r.map(escapeCsv).join(',')).join('\r\n');
}
