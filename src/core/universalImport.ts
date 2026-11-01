import * as fs from 'fs';
import * as path from 'path';
import { importBruno } from './import';
import { importThunderFiles } from './thunder';
import type { Storage } from './storage';
import type { ImportSummary } from './import';

/**
 * Universal importer: auto-detects folder/file format (Bruno, Thunder Client, Postman, OpenAPI, QAForge export)
 */
export function importUniversal(targetPath: string, storage: Storage): ImportSummary {
  const stat = fs.statSync(targetPath);

  // If it's a directory
  if (stat.isDirectory()) {
    // Check if it's a Bruno directory (has bruno.json or *.bru files inside)
    const hasBrunoJson = fs.existsSync(path.join(targetPath, 'bruno.json'));
    const entries = fs.readdirSync(targetPath);
    const hasBruFiles = entries.some((e) => e.endsWith('.bru'));
    if (hasBrunoJson || hasBruFiles) {
      return importBruno(targetPath, storage);
    }

    // Check if it's a folder containing Thunder JSON exports
    const jsonFiles = entries.filter((e) => e.endsWith('.json')).map((e) => path.join(targetPath, e));
    if (jsonFiles.length > 0) {
      return importThunderFiles(jsonFiles, storage);
    }

    // Default fallback to Bruno walk if generic folder
    return importBruno(targetPath, storage);
  }

  // If it's a file
  if (targetPath.endsWith('.bru')) {
    // Single bru file: import folder containing it
    return importBruno(path.dirname(targetPath), storage);
  }

  if (targetPath.endsWith('.json')) {
    return importThunderFiles([targetPath], storage);
  }

  return {
    collection: path.basename(targetPath),
    requests: 0,
    environments: 0,
    warnings: [`Unrecognized format for ${targetPath}`],
  };
}

