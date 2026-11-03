import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export class RefusedPath extends Error { constructor() { super('refused path outside GBDEV_HOME'); } }
/** The pathname changed during validation. No bytes from that descriptor are read. */
export class TransientPath extends Error { constructor() { super('path changed during read'); } }
export function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''); }
/** Only regular files, validated before opening and revalidated before reading. No writes. */
export class HomeFs {
  constructor(readonly home: string) {}
  readUnderHome(rel: string, directory = false): number {
    for (let attempt = 0; ; attempt++) {
      try { return this.openChecked(rel, directory); }
      catch (error) {
        if (attempt >= 2 || !(error instanceof TransientPath || missing(error))) throw error;
      }
    }
  }
  private openChecked(rel: string, directory: boolean): number {
    const root = realpathSync(this.home), lexical = resolve(root, rel);
    const inside = (path: string) => { const r = relative(root, path); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
    if (isAbsolute(rel) || !inside(lexical)) throw new RefusedPath();
    const target = realpathSync(lexical);
    if (!inside(target)) throw new RefusedPath();
    let fd: number;
    try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new RefusedPath(); throw error; }
    try {
      const current = realpathSync(lexical);
      if (!inside(current)) throw new RefusedPath();
      const opened = fstatSync(fd), expected = statSync(current);
      // A link count cannot locate aliases: conservatively refuse all multiply-linked files.
      if (directory ? !opened.isDirectory() || !expected.isDirectory() : !opened.isFile() || !expected.isFile() || opened.nlink > 1 || expected.nlink > 1) throw new RefusedPath();
      // rename can unlink the opened inode (nlink=0) or replace the pathname with
      // another in-home inode. This is not an escape, but must still be retried.
      if (current !== target || opened.ino !== expected.ino || opened.dev !== expected.dev || (!directory && (opened.nlink === 0 || expected.nlink === 0))) throw new TransientPath();
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  exists(rel: string): boolean {
    try { const fd = this.readUnderHome(rel); closeSync(fd); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  /** Directory names only; every subsequent content read is independently guarded. */
  names(rel: string): string[] {
    let fd: number;
    try { fd = this.readUnderHome(rel, true); } catch (error) { if (missing(error)) return []; throw error; }
    try {
      const path = realpathSync(resolve(this.home, rel)), opened = fstatSync(fd), current = statSync(path);
      const relpath = relative(realpathSync(this.home), path);
      if (!relpath || relpath === '..' || relpath.startsWith(`..${sep}`) || isAbsolute(relpath)) throw new RefusedPath();
      if (opened.ino !== current.ino || opened.dev !== current.dev) throw new TransientPath();
      return readdirSync(path);
    } finally { closeSync(fd); }
  }
  json(rel: string): unknown | undefined {
    let fd: number;
    try { fd = this.readUnderHome(rel); } catch (error) { if (missing(error)) return undefined; throw error; }
    try {
      const size = fstatSync(fd).size;
      if (size > 1024 * 1024) throw new Error('metadata exceeds 1 MiB');
      const buffer = Buffer.alloc(size); const n = readSync(fd, buffer, 0, size, 0);
      return JSON.parse(buffer.toString('utf8', 0, n)) as unknown;
    } finally { closeSync(fd); }
  }
}
