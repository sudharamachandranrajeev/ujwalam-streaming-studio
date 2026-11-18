// SPDX-License-Identifier: GPL-3.0-or-later
// A value read from a small file, read again only when the file changed (idle load, 2026-11-18): the status loops ran
// synchronous reads and JSON parses of unchanged files every second. A change is a different mtime, size or file id
// (an atomic rename-replace gives a new id); a file that appears or disappears is a change too. Node stdlib only.
//   const cached = createStatCache();
//   cached(file, () => readSettings(dataDir))   // read() runs on the first call and after each change of file
// read() must depend on the file only (plus values that never change for this cache). A value read while the file
// was being replaced is read again on the next call, because the file then has a newer stat than the one stored.
import { statSync } from 'node:fs';

export function statKey(file) {
  try {
    const s = statSync(file, { bigint: true });
    return `${s.mtimeNs}:${s.size}:${s.ino}`;
  } catch {
    return 'missing';
  }
}

export function createStatCache({ keyOf = statKey } = {}) {
  const entries = new Map();
  return function cached(file, read) {
    const key = keyOf(file);
    const e = entries.get(file);
    if (e && e.key === key) return e.value;
    const value = read();
    entries.set(file, { key, value });
    return value;
  };
}
