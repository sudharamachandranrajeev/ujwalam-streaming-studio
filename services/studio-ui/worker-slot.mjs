// SPDX-License-Identifier: GPL-3.0-or-later
// One supervised worker process (the live clipper, the face worker) that the launcher switches on and off while the
// studio runs (idle load 2026-11-18; Codex review). The slot keeps:
//   active  the running process;
//   ending  a process that was told to stop and has not exited yet: it may still be saving (a replay clip), so no
//           replacement starts until it has exited and the next sync has checked again that the worker is wanted;
//   timer   a pending crash restart, bound to the generation it was scheduled in. stop() bumps the generation and
//           cancels the timer, so a restart scheduled before a switch-off (or off and on again) never fires.
//   const slot = createWorkerSlot({ end: (child) => void });
//   slot.launch(() => child | null, (code, gen) => { ...unplanned exit...; slot.retry(gen, () => { recheck, launch again }) });
//   slot.stop();   // true when a running process was told to stop
//   slot.busy();   // running, stopping or a restart pending: do not start another
// A child is an EventEmitter with 'exit'; end() sets child.endedOnPurpose (its exit is then not a crash).
export function createWorkerSlot({ end, delayMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = null;
  let ending = null;
  let timer = null;
  let gen = 0;
  return {
    active: () => active,
    ending: () => ending,
    busy: () => !!(active || ending || timer),
    generation: () => gen,
    launch(start, onCrash) {
      if (active || ending) return null;
      const c = start();
      if (!c) return null;
      active = c;
      const g = gen;
      c.once('exit', (code) => {
        if (active === c) active = null;
        if (ending === c) ending = null;
        if (c.endedOnPurpose) return;
        onCrash?.(code, g);
      });
      return c;
    },
    stop() {
      gen += 1;
      if (timer) { clearTimer(timer); timer = null; }
      if (!active) return false;
      ending = active;
      active = null;
      end(ending);
      return true;
    },
    retry(g, fn) {
      if (g !== gen || timer) return false;
      timer = setTimer(() => { timer = null; if (g === gen) fn(); }, delayMs);
      timer?.unref?.();
      return true;
    },
  };
}
