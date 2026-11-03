import { closeSync, fstatSync, readSync } from 'node:fs';
import { HomeFs, missing } from './homeFs.js';
export const CHUNK_BYTES = 64 * 1024, MAX_LINE_BYTES = 1024 * 1024, BACKFILL_BYTES = 256 * 1024 * 1024;
export type ReadLine = { kind: 'line'; text: string } | { kind: 'truncated'; bytes: number; text: string } | { kind: 'rotated' | 'skip'; bytes: number };
/** Pollable bounded JSONL reader. Offsets are bytes, not decoded character counts. */
export class LineReader {
  offset = 0;
  skippedBytes = 0;
  truncatedLines = 0;
  private identity = '';
  private pending = Buffer.alloc(CHUNK_BYTES);
  private length = 0;
  private dropping = false;
  private skipFirst = false;
  constructor(readonly fs: HomeFs, readonly rel: string, readonly fromStart = false) {}
  *read(final = false): Generator<ReadLine> {
    let fd: number;
    try { fd = this.fs.readUnderHome(this.rel); } catch (error) { if (missing(error)) return; throw error; }
    try {
      const stat = fstatSync(fd), identity = `${stat.dev}:${stat.ino}`;
      if (this.identity && (this.identity !== identity || stat.size < this.offset)) {
        this.identity = ''; this.offset = 0; this.length = 0; this.dropping = false; this.skipFirst = false;
        yield { kind: 'rotated', bytes: 0 };
      }
      if (!this.identity && !this.fromStart && stat.size > BACKFILL_BYTES) {
        this.offset = stat.size - BACKFILL_BYTES;
        // If the cutoff falls exactly at a line boundary, retain the next complete line.
        const previous = Buffer.alloc(1); readSync(fd, previous, 0, 1, this.offset - 1);
        this.skipFirst = previous[0] !== 10; this.skippedBytes += this.offset;
        yield { kind: 'skip', bytes: this.offset };
      }
      this.identity = identity;
      const chunk = Buffer.alloc(CHUNK_BYTES);
      while (this.offset < stat.size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - this.offset), this.offset);
        if (!n) break;
        this.offset += n;
        let start = 0;
        while (start < n) {
          const found = chunk.indexOf(10, start), end = found >= 0 && found < n ? found : n;
          const len = end - start;
          if (this.skipFirst) this.skippedBytes += len + (end < n ? 1 : 0);
          else if (!this.dropping) {
            const needed = Math.min(MAX_LINE_BYTES, this.length + len);
            if (needed > this.pending.length) { const grown = Buffer.alloc(Math.min(MAX_LINE_BYTES, Math.max(needed, this.pending.length * 2))); this.pending.copy(grown, 0, 0, this.length); this.pending = grown; }
            if (this.length + len > MAX_LINE_BYTES) {
              // Retain the bounded prefix (T21); discard only the remainder until newline.
              chunk.copy(this.pending, this.length, start, start + MAX_LINE_BYTES - this.length);
              const text = new TextDecoder().decode(this.pending, { stream: true });
              this.length = 0; this.dropping = true; this.truncatedLines++;
              yield { kind: 'truncated', bytes: MAX_LINE_BYTES, text };
            } else { chunk.copy(this.pending, this.length, start, end); this.length += len; }
          }
          if (end < n) {
            if (!this.skipFirst && !this.dropping) yield { kind: 'line', text: this.pending.toString('utf8', 0, this.length) };
            this.length = 0; this.dropping = false; this.skipFirst = false;
          }
          start = end + 1;
        }
      }
      if (final && this.length && !this.dropping && !this.skipFirst) {
        const text = this.pending.toString('utf8', 0, this.length); this.length = 0;
        yield { kind: 'line', text };
      }
    } finally { closeSync(fd); }
  }
}
