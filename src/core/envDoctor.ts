import * as fs from 'fs';
import * as sql from 'mssql';
import type { Storage } from './storage';
import type { EnvironmentDiffItem, EnvironmentDiffReport, HealthCheckItem, HealthCheckReport } from './types';

/**
 * Runs a comprehensive health check on the active environment:
 * validates Cloud API endpoints, SQL Server connection, and Mule UNC share read/write access.
 */
export async function checkEnvironmentHealth(
  storage: Storage,
  envName: string | undefined,
  vars: Record<string, string>,
): Promise<HealthCheckReport> {
  const items: HealthCheckItem[] = [];
  const targetEnv = envName ?? 'Global';

  // 1. Check Cloud APIs / URLs
  const urlEntries = Object.entries(vars).filter(
    ([k, v]) => /url|api|host|endpoint/i.test(k) && typeof v === 'string' && v.startsWith('http'),
  );

  for (const [key, rawUrl] of urlEntries) {
    const t0 = performance.now();
    try {
      const parsed = new URL(rawUrl);
      const pingUrl = `${parsed.protocol}//${parsed.host}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(pingUrl, { method: 'HEAD', signal: controller.signal }).catch(async () => {
        return await fetch(pingUrl, { method: 'GET', signal: controller.signal });
      });
      clearTimeout(timeout);
      const latency = Math.round(performance.now() - t0);
      items.push({
        category: 'api',
        name: key,
        target: pingUrl,
        status: res.status < 500 ? 'pass' : 'warn',
        message: `HTTP ${res.status} (${latency}ms) - Endpoint reachable`,
        latencyMs: latency,
      });
    } catch (err: any) {
      items.push({
        category: 'api',
        name: key,
        target: rawUrl,
        status: 'fail',
        message: `Connection failed: ${err.message}`,
        latencyMs: Math.round(performance.now() - t0),
      });
    }
  }

  // 2. Check SQL Server connectivity
  const dbServer = vars.dbServer || vars.DB_SERVER;
  const dbName = vars.dbName || vars.DB_NAME;
  const dbUser = vars.dbUser || vars.DB_USER;
  const dbPassword = vars.dbPassword || vars.DB_PASSWORD;

  if (dbServer && dbUser && dbPassword) {
    const t0 = performance.now();
    let pool: sql.ConnectionPool | undefined;
    try {
      pool = await new sql.ConnectionPool({
        server: dbServer,
        database: dbName || undefined,
        user: dbUser,
        password: dbPassword,
        connectionTimeout: 8000,
        requestTimeout: 8000,
        options: { encrypt: true, trustServerCertificate: true },
      }).connect();
      const res = await pool.request().query('SELECT @@VERSION AS ver, DB_NAME() AS currentDb');
      const latency = Math.round(performance.now() - t0);
      const ver = String(res.recordset?.[0]?.ver || '').split('\n')[0].slice(0, 45);
      const connectedDb = res.recordset?.[0]?.currentDb || dbName;
      items.push({
        category: 'sql',
        name: 'SQL Database Connection',
        target: `sql://${dbServer}/${connectedDb}`,
        status: 'pass',
        message: `Connected successfully (${latency}ms). Database: [${connectedDb}], ${ver}`,
        latencyMs: latency,
      });
    } catch (err: any) {
      items.push({
        category: 'sql',
        name: 'SQL Database Connection',
        target: `sql://${dbServer}/${dbName ?? ''}`,
        status: 'fail',
        message: `Login/Connection failed: ${err.message}`,
        latencyMs: Math.round(performance.now() - t0),
      });
    } finally {
      await pool?.close().catch(() => undefined);
    }
  } else if (dbServer) {
    items.push({
      category: 'sql',
      name: 'SQL Database Credentials',
      target: dbServer,
      status: 'warn',
      message: 'Database server configured, but dbUser or dbPassword missing/empty.',
    });
  }

  // 3. Check File Shares / Mule UNC Folders
  const shareEntries = Object.entries(vars).filter(
    ([k, v]) => /inbox|share|mule|drop|unc/i.test(k) && typeof v === 'string' && (v.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(v)),
  );

  for (const [key, sharePath] of shareEntries) {
    try {
      if (fs.existsSync(sharePath)) {
        // Test write access with a dummy probe file
        const testFile = `${sharePath.replace(/[\\/]+$/, '')}/.qaforge_probe_${Date.now()}`;
        try {
          fs.writeFileSync(testFile, 'probe');
          fs.unlinkSync(testFile);
          items.push({
            category: 'share',
            name: key,
            target: sharePath,
            status: 'pass',
            message: 'Directory accessible with full Read/Write permissions',
          });
        } catch {
          items.push({
            category: 'share',
            name: key,
            target: sharePath,
            status: 'warn',
            message: 'Directory exists and is readable, but write permission test failed',
          });
        }
      } else {
        items.push({
          category: 'share',
          name: key,
          target: sharePath,
          status: 'fail',
          message: 'Path does not exist or network share is unreachable',
        });
      }
    } catch (err: any) {
      items.push({
        category: 'share',
        name: key,
        target: sharePath,
        status: 'fail',
        message: `Error inspecting path: ${err.message}`,
      });
    }
  }

  // 4. Check for unreplaced placeholders or suspicious variables
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string' && (/^\[.*\]$/.test(v.trim()) || v.includes('example.com'))) {
      items.push({
        category: 'vars',
        name: k,
        target: v,
        status: 'warn',
        message: `Variable contains placeholder or unconfigured template value: "${v}"`,
      });
    }
  }

  const passed = items.every((x) => x.status === 'pass' || x.status === 'info');
  return {
    environment: targetEnv,
    timestamp: new Date().toISOString(),
    passed,
    items,
  };
}

/**
 * Compares two environments side-by-side to detect missing variables,
 * mismatched database hostnames, or drifting endpoint configurations.
 */
export function compareEnvironments(
  storage: Storage,
  envAName: string,
  envBName: string,
): EnvironmentDiffReport {
  const envA = storage.getEnvironment(envAName);
  const envB = storage.getEnvironment(envBName);

  const varsA = envA?.variables ?? {};
  const varsB = envB?.variables ?? {};

  const allKeys = Array.from(new Set([...Object.keys(varsA), ...Object.keys(varsB)])).sort();
  const items: EnvironmentDiffItem[] = [];

  for (const key of allKeys) {
    const valA = varsA[key];
    const valB = varsB[key];

    if (valA === undefined) {
      items.push({ key, envAValue: undefined, envBValue: valB, status: 'only_in_b' });
    } else if (valB === undefined) {
      items.push({ key, envAValue: valA, envBValue: undefined, status: 'only_in_a' });
    } else if (valA === valB) {
      items.push({ key, envAValue: valA, envBValue: valB, status: 'identical' });
    } else {
      items.push({ key, envAValue: valA, envBValue: valB, status: 'different' });
    }
  }

  return {
    envA: envAName,
    envB: envBName,
    items,
  };
}

