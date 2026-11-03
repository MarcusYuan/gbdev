import { line, safeText, type RenderLine } from './format.js';
import { sanitizeForTerminal } from './sanitize.js';
/** Backfill coalesces a whole thinking turn; live mode also flushes at 400 chars / 2s idle. */
export class ThinkingBuffer {
  private text = '';
  private at = '';
  private lastDelta = 0;
  private secretContinuation = false;
  private privateKey = false;
  private keyTail = '';
  private protect(): string {
    const clean = sanitizeForTerminal(this.text);
    const begin = clean.lastIndexOf('-----BEGIN '), end = clean.lastIndexOf('-----END ');
    if (begin > end && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(clean.slice(begin))) this.privateKey = true;
    const safe = safeText(clean);
    // If a flush splits a recognized credential, suppress its continuation until a delimiter.
    this.secretContinuation ||= safe.endsWith('‹redacted›') && !clean.endsWith('‹redacted›') && !this.privateKey;
    return safe;
  }
  add(text: string, at: string, now: number, backfill: boolean): RenderLine[] {
    this.at ||= at; this.lastDelta = now;
    if (this.privateKey) {
      const combined = this.keyTail + text, end = /-----END [A-Z ]*PRIVATE KEY-----/.exec(combined);
      if (!end) { this.keyTail = combined.slice(-80); return []; }
      text = combined.slice(end.index + end[0].length); this.privateKey = false; this.keyTail = '';
    }
    if (this.secretContinuation) {
      const continuation = /^\S*/.exec(text)![0];
      text = text.slice(continuation.length);
      if (!text) return [];
      this.secretContinuation = false;
    }
    this.text += text;
    // Redact before shortening: retaining the tail of a long key would otherwise expose it.
    if (Buffer.byteLength(this.text) > 4096) {
      const safe = this.protect();
      const bytes = Buffer.from(safe);
      if (bytes.length > 4096) {
        const head = Array.from(safe.slice(0, 400)).slice(0, 200).join('') + ' … ';
        let start = Math.max(bytes.length - 3800, bytes.length - (4096 - Buffer.byteLength(head)));
        while ((bytes[start]! & 0xc0) === 0x80) start++;
        this.text = head + bytes.toString('utf8', start);
      } else this.text = safe;
    }
    return !backfill && this.text.length >= 400 ? this.flush(false) : [];
  }
  idle(now: number): RenderLine[] { return this.text && now - this.lastDelta >= 2000 ? this.flush(false) : []; }
  /** Explicit flush ends the turn; automatic threshold/idle/backfill emissions preserve protection. */
  flush(boundary = true): RenderLine[] {
    if (!this.text) { if (boundary) this.clear(); return []; }
    const result = [line({ at: this.at, worktree: '' }, 'THINK', this.protect().replace(/\s+/g, ' ').trim())];
    this.text = ''; this.at = ''; if (boundary) this.clear(); return result;
  }
  /** An explicit provider turn boundary ends any suppressed partial credential too. */
  clear(): void { this.text = ''; this.at = ''; this.secretContinuation = false; this.privateKey = false; this.keyTail = ''; }
}
