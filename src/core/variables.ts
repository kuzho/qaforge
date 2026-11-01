/**
 * Replaces {{var}} placeholders.
 * Supports:
 * - Dynamic system helpers: {{$guid}}, {{$timestamp}}, {{$randomInt}}
 * - Process environment variables: {{$env.NAME}}
 * - Environment, global, and runtime variables: {{varName}}
 * Unknown variables are left untouched.
 */
export function interpolate(text: string, vars: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w.$\-]+)\s*\}\}/g, (match, name: string) => {
    if (name === '$guid' || name === '$uuid') {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }
    if (name === '$timestamp') return String(Date.now());
    if (name === '$isoTimestamp') return new Date().toISOString();
    if (name === '$randomInt') return String(Math.floor(Math.random() * 1000000));
    if (name.startsWith('$env.')) return process.env[name.slice(5)] ?? match;
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match;
  });
}
