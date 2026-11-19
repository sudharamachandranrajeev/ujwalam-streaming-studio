// SPDX-License-Identifier: GPL-3.0-or-later
// Start-up clock (2026-11-19, start-up time): monotonic marks for each launcher start phase, printed as one line
//   [studio] startup: main 410, core 980, ... ms since the launcher process started
// Times are cumulative (performance.now(): since this Node process started), so the gap between two marks is that
// phase. Cheap: a few numbers in memory, one log line. The studio and the host print their own "startup:" line.

export function createStartupClock(now = () => performance.now()) {
  const marks = [];
  return {
    mark(name) { marks.push({ name, ms: Math.round(now()) }); },
    marks: () => marks.map((m) => ({ ...m })),
    line: () => `startup: ${marks.map((m) => `${m.name} ${m.ms}`).join(', ')} ms since the launcher process started`,
  };
}

// The marks of a "startup:" line (any process: launcher, studio, host), in order; [] when the line has none.
export function parseStartupLine(line) {
  const m = /startup: (.*?) ms since/.exec(String(line));
  if (!m) return [];
  return m[1].split(', ').map((p) => {
    const i = p.lastIndexOf(' ');
    return { name: p.slice(0, i), ms: Number(p.slice(i + 1)) };
  }).filter((x) => x.name && Number.isFinite(x.ms));
}
