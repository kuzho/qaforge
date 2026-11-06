import * as fs from 'fs';
import * as path from 'path';
import { interpolate } from './variables';
import type { RequestDef, ResponseResult } from './types';

/**
 * Executes a native File Drop / Simulator step (e.g. Mule simulator UNC drop).
 * Injects SO, PID, Lot, MTP Version ID, and automatically wraps in transferMESOrders (TMO)
 * envelope when target directory is an in_multi inbox.
 */
export async function executeFileDrop(
  req: RequestDef,
  vars: Record<string, string>,
  runtime: Record<string, string>,
  workspaceRoot: string,
): Promise<ResponseResult> {
  const started = performance.now();
  const base = { ok: false, status: 0, statusText: '', headers: {}, body: '', sizeBytes: 0, durationMs: 0, resolvedUrl: 'file://' };

  const def = req.fileDrop;
  if (!def) {
    return { ...base, error: 'File drop step has no configuration defined' };
  }

  const allVars = { ...vars, ...runtime };
  const targetDirRaw = interpolate(def.targetDir, allVars);
  const targetDir = path.isAbsolute(targetDirRaw) ? targetDirRaw : path.resolve(workspaceRoot, targetDirRaw);

  const so = allVars.SO || allVars.new_SO || allVars.salesOrderId || '';
  const pid = allVars.PID || allVars.new_PID || allVars.patientId || '';
  const versionId = allVars.versionId || allVars.new_versionId || '';

  // 1. Resolve Template File
  let templatePath = path.resolve(workspaceRoot, def.templateFile);
  if (!fs.existsSync(templatePath)) {
    templatePath = path.resolve(workspaceRoot, '.qaforge', 'testfiles', def.templateFile);
  }
  if (!fs.existsSync(templatePath)) {
    templatePath = path.resolve(workspaceRoot, '.qaforge', 'testfiles', path.basename(def.templateFile));
  }
  if (!fs.existsSync(templatePath)) {
    return { ...base, error: `File drop template not found at "${def.templateFile}" (checked workspace and .qaforge/testfiles)` };
  }

  let template: any;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch (err: any) {
    return { ...base, error: `Failed to parse template JSON "${templatePath}": ${err.message}` };
  }

  // 2. Generate Lot / EventId
  const generateLot = def.generateLot !== false;
  const lot = generateLot ? Math.floor(Math.random() * 600000000) + 100000000 : (parseInt(allVars.lot, 10) || 100000000);
  const eventId = `00000000${lot}`;

  // 3. Resolve Filename
  let filename = def.filename ? interpolate(def.filename, { ...allVars, lot: String(lot), SO: so }) : '';
  if (!filename) {
    filename = so ? `${so}_PALATAL_EXPANDER.json` : `order_${lot}.json`;
  }

  // 4. Inject Order Properties
  const soNum = parseInt(so, 10) || so;
  template.eventId = eventId;
  template.inFileName = filename;
  if (so) template.salesOrderId = soNum;
  template.productionOrder = lot;
  if (!template.siteId) template.siteId = 'QAS';

  // 5. Inject Parameters
  if (!Array.isArray(template.parameters)) template.parameters = [];

  const paramMap = new Map<string, any>();
  for (const p of template.parameters) {
    if (p && p.name) paramMap.set(p.name, p);
  }

  if (pid) {
    if (!paramMap.has('PatientId')) template.parameters.push({ name: 'PatientId', value: String(pid) });
    else paramMap.get('PatientId').value = String(pid);

    if (!paramMap.has('VIPOrderId')) template.parameters.push({ name: 'VIPOrderId', value: `VOI9${pid}` });
    else paramMap.get('VIPOrderId').value = `VOI9${pid}`;
  }

  if (versionId) {
    if (!paramMap.has('TX_PLAN_VER_ID_U')) template.parameters.push({ name: 'TX_PLAN_VER_ID_U', value: String(versionId) });
    else paramMap.get('TX_PLAN_VER_ID_U').value = String(versionId);
  }

  // Explicit user parameters override
  if (def.parameters && Array.isArray(def.parameters)) {
    for (const kv of def.parameters) {
      const val = interpolate(kv.value, allVars);
      if (paramMap.has(kv.key)) paramMap.get(kv.key).value = val;
      else template.parameters.push({ name: kv.key, value: val });
    }
  }

  // 6. Update Component Production Orders
  if (Array.isArray(template.components)) {
    for (let c = 0; c < template.components.length; c++) {
      template.components[c].productionOrder = lot + (c + 1) * 10;
    }
  }

  // 7. Determine Envelope Mode
  const isMulti = targetDir.toLowerCase().includes('in_multi') || (def.envelope === 'tmo');
  let payload = template;
  if (isMulti && !template.transferMESOrders && def.envelope !== 'none') {
    payload = {
      verb: 'CREATE',
      eventId,
      inFileName: filename,
      siteNumber: 0,
      siteId: template.siteId || 'QAS',
      transferMESOrders: [template],
    };
  }

  // 8. Ensure directory and write file
  const destPath = path.join(targetDir, filename);
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const jsonStr = JSON.stringify(payload, null, 2);
    fs.writeFileSync(destPath, jsonStr, 'utf8');

    // Auto-capture standard variables into runtime
    runtime['mule_filename'] = filename;
    runtime['lot'] = String(lot);
    runtime['eventId'] = eventId;
    if (so) runtime['SO'] = String(so);

    const bodyObj = {
      ok: true,
      filename,
      destPath,
      lot,
      eventId,
      salesOrderId: soNum,
      isTmoEnvelope: isMulti,
      sizeBytes: Buffer.byteLength(jsonStr),
    };
    const bodyText = JSON.stringify(bodyObj);

    const dropReqHeaders = { TargetDir: targetDir, Filename: filename };
    return {
      ok: true,
      status: 200,
      statusText: 'File Dropped',
      durationMs: Math.round(performance.now() - started),
      sizeBytes: Buffer.byteLength(bodyText),
      headers: { 'content-type': 'application/json' },
      body: bodyText,
      resolvedUrl: `file://${destPath.replace(/\\/g, '/')}`,
      requestHeaders: dropReqHeaders,
      requestBody: jsonStr,
    };
  } catch (err: any) {
    return {
      ...base,
      durationMs: Math.round(performance.now() - started),
      resolvedUrl: `file://${destPath.replace(/\\/g, '/')}`,
      error: `Failed writing drop file to "${destPath}": ${err.message}`,
      requestHeaders: { TargetDir: targetDir, Filename: filename },
      requestBody: typeof payload !== 'undefined' ? JSON.stringify(payload, null, 2) : undefined,
    };
  }
}

