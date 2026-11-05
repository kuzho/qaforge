import * as sql from 'mssql';
import { interpolate } from './variables';
import type { RequestDef, ResponseResult } from './types';

function parseServer(raw: string): { server: string; port?: number } {
  const m = /^([^,:]+)[,:](\d+)$/.exec(raw.trim());
  return m ? { server: m[1], port: Number(m[2]) } : { server: raw.trim() };
}

const poolCache = new Map<string, sql.ConnectionPool>();

/**
 * Closes all cached persistent SQL Server connection pools.
 * Called on environment switch or extension deactivation.
 */
export async function closeAllSqlPools(): Promise<void> {
  for (const [key, pool] of poolCache.entries()) {
    try {
      if (pool.connected) await pool.close();
    } catch {
      /* ignore */
    }
  }
  poolCache.clear();
}

/**
 * Runs a SQL Server query. The first result set is exposed to assertions/captures as the JSON body
 * `{ rowCount, rows, recordsets? }` so `body rows[0].State eq Ready` works like any other assertion.
 * Reuses active connection pools across polling queries to achieve sub-50ms execution speed.
 */
export async function executeSql(req: RequestDef, vars: Record<string, string>): Promise<ResponseResult> {
  const def = req.sql;
  const started = performance.now();
  const base = { ok: false, status: 0, statusText: '', headers: {}, body: '', sizeBytes: 0 };
  if (!def) {
    return { ...base, durationMs: 0, resolvedUrl: 'sql://', error: 'SQL step has no connection/query configured' };
  }
  const { server, port } = parseServer(interpolate(def.server, vars));
  const database = interpolate(def.database, vars);
  const user = interpolate(def.user, vars);
  const password = interpolate(def.password, vars);
  const resolvedUrl = `sql://${server}${port ? `:${port}` : ''}/${database}`;

  const cacheKey = `${server}:${port || 1433}:${database}:${user}:${password}`;
  let pool = poolCache.get(cacheKey);

  try {
    if (!pool || !pool.connected) {
      pool = await new sql.ConnectionPool({
        server,
        port,
        database: database || undefined,
        user,
        password,
        connectionTimeout: 15000,
        requestTimeout: 60000,
        options: { encrypt: true, trustServerCertificate: true },
      }).connect();
      poolCache.set(cacheKey, pool);
    }

    const queryStr = interpolate(def.query, vars);
    const result = await pool.request().query(queryStr);
    const rows = (result.recordset ?? []) as unknown[];
    const payload: Record<string, unknown> = { rowCount: rows.length, rows };
    const sets = result.recordsets as unknown as unknown[][];
    if (sets.length > 1) payload.recordsets = sets;
    const body = JSON.stringify(payload);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      durationMs: Math.round(performance.now() - started),
      sizeBytes: Buffer.byteLength(body),
      headers: {},
      body,
      resolvedUrl,
    };
  } catch (e) {
    // If connection dropped or broke, invalidate cache
    poolCache.delete(cacheKey);
    return { ...base, durationMs: Math.round(performance.now() - started), resolvedUrl, error: (e as Error).message };
  }
}
