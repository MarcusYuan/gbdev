export const REDACTED = '‹redacted›';
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|xox[abprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}/g, REDACTED)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, REDACTED)
    .replace(/((?:api[_-]?key|secret|token|password|passwd|authorization)["']?\s*[:=]\s*)\S{6,}/gi, `$1${REDACTED}`);
}
