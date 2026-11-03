/** Cursor stream-json tool_call lifecycle helpers for activity / stall detection. */

export type CursorToolSignal =
  | { kind: 'started'; id: string; name: string }
  | { kind: 'completed'; id: string; name: string }
  | { kind: 'none' };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Prefer explicit call ids; otherwise one stable slot per ToolCall key (no args stored). */
export function cursorToolCallId(event: Record<string, unknown>, toolKey: string, tool: Record<string, unknown>): string {
  for (const key of ['call_id', 'tool_call_id', 'toolCallId', 'id'] as const) {
    const top = str(event[key]).trim();
    if (top) return top;
    const nested = str(tool[key]).trim();
    if (nested) return nested;
  }
  return `tool:${toolKey}`;
}

/**
 * Extract started/completed (or error) signals from a Cursor stream event.
 * Unknown shapes return none; never reads or returns tool argument bodies.
 */
export function interpretCursorToolEvent(event: Record<string, unknown>): CursorToolSignal {
  if (str(event.type) !== 'tool_call') return { kind: 'none' };
  const subtype = str(event.subtype);
  const call = record(event.tool_call);
  const key = Object.keys(call).find(k => k.endsWith('ToolCall'));
  if (!key) return { kind: 'none' };
  const tool = record(call[key]);
  const name = key.replace(/ToolCall$/, '') || key;
  const id = cursorToolCallId(event, key, tool);
  if (subtype === 'started') return { kind: 'started', id, name };
  if (subtype === 'completed' || subtype === 'error' || subtype === 'failed') {
    return { kind: 'completed', id, name };
  }
  return { kind: 'none' };
}

/** Incremental JSONL buffer: tolerate chunked lines; ignore partial / unknown JSON. */
export class JsonlEventBuffer {
  #rest = '';

  push(chunk: string): Record<string, unknown>[] {
    this.#rest += chunk;
    const events: Record<string, unknown>[] = [];
    for (;;) {
      const nl = this.#rest.indexOf('\n');
      if (nl < 0) break;
      const line = this.#rest.slice(0, nl).replace(/\r$/, '');
      this.#rest = this.#rest.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          events.push(value as Record<string, unknown>);
        }
      } catch {
        // Fragment residue belongs to a later chunk, or the line is non-JSON noise.
      }
    }
    return events;
  }

  /** Best-effort flush of a final non-newline-terminated object (does not throw). */
  flush(): Record<string, unknown>[] {
    const line = this.#rest.trim();
    this.#rest = '';
    if (!line) return [];
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return [value as Record<string, unknown>];
      }
    } catch { /* leave incomplete */ }
    return [];
  }
}
