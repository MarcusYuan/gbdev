import { type Provider } from '../contracts/brief.js';
import { codex, codexSessionId } from './codex.js';
import { cursor, cursorMetadata } from './cursor.js';
import { fake } from './fake.js';
import { type ProviderAdapter } from './types.js';

export function providerAdapter(name: Provider): ProviderAdapter {
  return { codex, cursor, fake }[name];
}

/** Best-effort metadata from flushed stdout; tolerate partial output and legacy filenames. */
export function providerSessionId(name: Provider, jobDir: string): string | null {
  if (name === 'fake') return null;
  const files = name === 'cursor' ? ['raw.json', 'raw.jsonl', 'events.jsonl'] : ['raw.jsonl', 'raw.json', 'events.jsonl'];
  for (const file of files) {
    try {
      const id = name === 'cursor' ? cursorMetadata(jobDir, file).session_id : codexSessionId(jobDir, file);
      if (id !== null) return id;
    } catch { /* Missing/unreadable metadata must not prevent crash recovery. */ }
  }
  return null;
}
