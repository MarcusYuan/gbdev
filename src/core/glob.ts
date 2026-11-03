import { matchesGlob } from 'node:path';

/** Portable subset used when path.matchesGlob is absent: single and recursive stars. */
export function fallbackMatchesGlob(path: string, pattern: string): boolean {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      const segmentStart = i === 0 || pattern[i - 1] === '/';
      if (segmentStart && pattern[i + 1] === '*' && (pattern[i + 2] === '/' || pattern[i + 2] === undefined)) {
        i++;
        if (pattern[i + 1] === '/') { expression += '(?:(?!\\.)[^/]+/)*'; i++; }
        else expression += '(?:(?!\\.)[^/]+(?:/(?!\\.)[^/]+)*)?';
      } else expression += `${segmentStart ? '(?!\\.)' : ''}[^/]*`;
    } else expression += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`${expression}$`).test(path);
}

export function matchesAllowed(path: string, patterns: string[], useNative = typeof matchesGlob === 'function'): boolean {
  return patterns.some(pattern => useNative ? matchesGlob(path, pattern) : fallbackMatchesGlob(path, pattern));
}
