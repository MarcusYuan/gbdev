/** Remove whole terminal control strings, including unterminated ones (fail closed). */
export function sanitizeForTerminal(text: string): string {
  return text
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/g, '')
    .replace(/\x1b[ -/]*[0-~]?/g, '')
    .replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/g, '');
}
