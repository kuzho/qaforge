import * as fs from 'fs';
import * as path from 'path';
import type { Storage } from './storage';
import type { TestCaseDef } from './types';

export interface ZephyrExportOptions {
  status?: string;
  folder?: string;
}

function escapeCsv(val: any): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Converts QAForge Test Cases into Jira Zephyr Scale / Squad compliant CSV format.
 * Includes UTF-8 BOM for seamless Microsoft Excel rendering on Windows.
 */
export function testCasesToZephyrCsv(
  cases: TestCaseDef[],
  storage?: Storage,
  options?: ZephyrExportOptions,
): string {
  const headers = [
    'Test Case Key',
    'Name',
    'Objective',
    'Precondition',
    'Priority',
    'Status',
    'Folder',
    'Component',
    'Labels',
    'Issue Links',
    'Step Description',
    'Test Data',
    'Expected Result',
  ];

  const rows: string[][] = [headers];

  const mapPriority = (p?: string): string => {
    switch (p?.toLowerCase()) {
      case 'critical': return 'Critical';
      case 'high': return 'High';
      case 'low': return 'Low';
      default: return 'Normal';
    }
  };

  for (const tc of cases) {
    let objective = tc.objective || tc.description || '';
    if (tc.criteria) {
      const gherkin = [
        tc.criteria.given ? `Given: ${tc.criteria.given}` : '',
        tc.criteria.when ? `When: ${tc.criteria.when}` : '',
        tc.criteria.then ? `Then: ${tc.criteria.then}` : '',
      ].filter(Boolean).join('\n');
      objective = objective ? `${objective}\n\n${gherkin}` : gherkin;
    }

    const priority = mapPriority(tc.priority);
    const status = options?.status || 'Approved';
    const folder = options?.folder || '/QAForge';
    const component = tc.tags?.[0] || 'API';
    const labels = (tc.tags || []).join(', ');
    const issueLinks = tc.requirement || '';
    const precondition = tc.preconditions || '';

    if (!tc.steps || tc.steps.length === 0) {
      rows.push([
        tc.id,
        tc.title,
        objective,
        precondition,
        priority,
        status,
        folder,
        component,
        labels,
        issueLinks,
        '',
        '',
        '',
      ]);
      continue;
    }

    for (let i = 0; i < tc.steps.length; i++) {
      const step = tc.steps[i];
      let stepDesc = step.name;
      if (step.layer) {
        stepDesc += ` [${step.layer}]`;
      }

      let testData = '';
      let expectedResult = step.expected || '';

      // If request file exists, pull method, URL/SQL, and assertions
      if (step.request && storage) {
        try {
          const reqPath = path.isAbsolute(step.request)
            ? step.request
            : path.join(storage.collectionsDir, step.request);
          if (fs.existsSync(reqPath)) {
            const req = storage.readRequest(reqPath);
            if (req.kind === 'sql') {
              const q = req.sql?.query?.trim().replace(/\s+/g, ' ');
              stepDesc += `\nSQL: ${q ? q.slice(0, 120) : 'Query'}`;
            } else {
              stepDesc += `\n${req.method || 'GET'} ${req.url || ''}`;
            }

            if (req.body?.content) {
              testData = req.body.content.slice(0, 250);
            }

            if (req.assertions && req.assertions.length > 0) {
              const asserts = req.assertions
                .filter((a) => a.enabled)
                .map((a) => `${a.source}${a.path ? '.' + a.path : ''} ${a.op} ${a.expected ?? ''}`.trim())
                .join('; ');
              expectedResult = expectedResult ? `${expectedResult} | Assertions: ${asserts}` : asserts;
            }
          }
        } catch {
          // ignore lookup failure, keep step.name and step.expected
        }
      }

      rows.push([
        tc.id,
        tc.title,
        objective,
        precondition,
        priority,
        status,
        folder,
        component,
        labels,
        issueLinks,
        stepDesc,
        testData,
        expectedResult,
      ]);
    }
  }

  // UTF-8 BOM for Microsoft Excel compatibility
  const bom = '\uFEFF';
  const csvBody = rows.map((r) => r.map(escapeCsv).join(',')).join('\r\n');
  return bom + csvBody;
}
