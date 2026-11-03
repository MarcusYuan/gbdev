/** Providers may emit one (possibly pretty-printed) JSON object or JSONL events. */
export function jsonObjects(output: string): Record<string, unknown>[] {
  const parse = (text: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(text);
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch { return null; } // Partial/malformed events do not contain usable metadata.
  };
  const single = parse(output);
  if (single) return [single];
  return output.split(/\r?\n/).map(parse).filter(value => value !== null);
}

export function lastString(objects: Record<string, unknown>[], key: string): string | null {
  const value = objects.findLast(object => typeof object[key] === 'string' && object[key].trim())?.[key];
  return typeof value === 'string' ? value : null;
}
