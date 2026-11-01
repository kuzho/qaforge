import * as sql from 'mssql';
import { interpolate } from './variables';
import type { RequestDef, ResponseResult } from './types';

function parseServer(raw: string): { server: string; port?: number } {
  const m = /^([^,:]+)[,:](\d+)$/.exec(raw.trim());
  return m ? { server: m[1], port: Number(m[2]) } : { server: raw.trim() };
}

/**
 * Runs a SQL Server query. The first result set is exposed to assertions/captures as the JSON body
 * `{ rowCount, rows, recordsets? }` so `body rows[0].State eq Ready` works like any other assertion.
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
  const resolvedUrl = `sql://${server}${port ? `:${port}` : ''}/${database}`;
  let pool: sql.ConnectionPool | undefined;
  try {
    pool = await new sql.ConnectionPool({
      server,
      port,
      database: database || undefined,
      user: interpolate(def.user, vars),
      password: interpolate(def.password, vars),
      connectionTimeout: 15000,
      requestTimeout: 60000,
      options: { encrypt: true, trustServerCertificate: true },
    }).connect();
    const result = await pool.request().query(interpolate(def.query, vars));
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
    return { ...base, durationMs: Math.round(performance.now() - started), resolvedUrl, error: (e as Error).message };
  } finally {
    await pool?.close().catch(() => undefined);
  }
}
