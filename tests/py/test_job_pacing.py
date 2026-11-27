# SPDX-License-Identifier: GPL-3.0-or-later
"""Background job pacing (2026-11-27, docs/plan/2026-11-27-background-job-pacing.md): choose_pace from the user's
state, the PaceGate duty cycle and running-time clock, the settings switch, and run_tool with a small Python child
(no ffmpeg): a held child is not killed as stalled, stop() still wins, the child is resumed before it is ended."""

import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402

PY = sys.executable
CFG = cc.pacing_config()


def sig(idle=None, state=None, battery=None, pct=None):
    return {"idleSec": idle, "state": state, "onBattery": battery, "batteryPercent": pct}


class ChoosePaceTests(unittest.TestCase):
    def test_committed_values(self):
        self.assertEqual((CFG["awaySec"], CFG["runSec"], CFG["pauseSec"]), (300.0, 1.0, 3.0))
        self.assertTrue(CFG["batteryHold"])

    def test_paces(self):
        self.assertEqual(cc.choose_pace(sig(idle=400, battery=False), CFG), "full")
        self.assertEqual(cc.choose_pace(sig(idle=5, battery=False), CFG), "gentle")
        self.assertEqual(cc.choose_pace(sig(idle=400, state="fullscreen"), CFG), "hold-fullscreen")
        self.assertEqual(cc.choose_pace(sig(idle=1, state="presentation"), CFG), "hold-presentation")
        self.assertEqual(cc.choose_pace(sig(idle=1, state="busy"), CFG), "hold-busy")
        self.assertEqual(cc.choose_pace(sig(idle=400, battery=True, pct=90), CFG), "hold-battery")

    def test_unknown_never_holds_and_never_full(self):
        self.assertEqual(cc.choose_pace(sig(), CFG), "gentle")

    def test_battery_level_rule(self):
        cfg = dict(CFG, batteryBelowPercent=30)
        self.assertEqual(cc.choose_pace(sig(idle=400, battery=True, pct=50), cfg), "full")
        self.assertEqual(cc.choose_pace(sig(idle=400, battery=True, pct=20), cfg), "hold-battery")
        self.assertEqual(cc.choose_pace(sig(idle=400, battery=True, pct=20), dict(CFG, batteryHold=False)), "full")

    def test_bad_config_keeps_defaults(self):
        d = tempfile.mkdtemp(prefix="ujw-pace-")
        p = os.path.join(d, "pacing.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"awaySec": -1, "gentle": {"runSec": "x"}, "holdOn": ["nope"]}, f)
        self.assertEqual(cc.pacing_config(p), cc.PACING_DEFAULTS)


class PaceGateTests(unittest.TestCase):
    def test_gentle_duty_cycle_is_a_quarter(self):
        g = cc.PaceGate(CFG, lambda: sig(idle=1, battery=False), t0=0.0)
        susp, t = False, 0.0
        while t < 40.0:
            want = g.step(t)
            g.set_suspended(want, t)
            t += 0.05
        self.assertAlmostEqual(g.run_time(t) / t, 0.25, delta=0.03)

    def test_hold_freezes_running_time_and_full_resumes(self):
        s = {"v": sig(idle=1, state="fullscreen")}
        g = cc.PaceGate(CFG, lambda: s["v"], t0=0.0)
        g.set_suspended(g.step(0.0), 0.0)
        self.assertTrue(g.suspended)
        g.set_suspended(g.step(100.0), 100.0)
        self.assertAlmostEqual(g.run_time(100.0), 0.0)
        s["v"] = sig(idle=999, battery=False)
        g.set_suspended(g.step(101.0), 101.0)
        self.assertFalse(g.suspended)
        self.assertAlmostEqual(g.run_time(111.0), 10.0)

    def test_unreadable_signals_mean_gentle(self):
        def boom():
            raise OSError("no")
        g = cc.PaceGate(CFG, boom, t0=0.0)
        g.step(0.0)
        self.assertEqual(g.pace, "gentle")


class SwitchTests(unittest.TestCase):
    def test_go_easy_default_on_and_off(self):
        d = tempfile.mkdtemp(prefix="ujw-pace-")
        self.assertTrue(cc.pacing_on(d))
        with open(os.path.join(d, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"clips": {"goEasy": False}}, f)
        self.assertFalse(cc.pacing_on(d))
        self.assertFalse(cc.enable_pacing(d))
        self.assertIsNone(cc._PACING)


@unittest.skipUnless(os.name == "nt", "pacing suspends children on Windows only")
class RunToolPacingTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ujw-pace-")
        cc._LAST_PACE = None

    def test_held_child_is_not_stalled_and_finishes_when_hold_ends(self):
        s = {"v": sig(idle=1, state="fullscreen")}
        t0 = time.monotonic()

        def read():
            if time.monotonic() - t0 > 2.5:
                s["v"] = sig(idle=999, battery=False)
            return s["v"]
        body = "import time\nf=open('out.part','wb')\nfor i in range(4):\n f.write(b'x'); f.flush(); time.sleep(0.2)\nprint('done')"
        r = cc.run_tool([PY, "-I", "-c", body], cwd=self.dir, timeout=60, watch="out.part", stall_sec=1.0, setup_sec=1.0,
                        poll_sec=0.2, pacing={"cfg": CFG, "read": read})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("done", r.stdout)
        self.assertGreater(time.monotonic() - t0, 2.5, "held while full screen")

    def test_stop_wins_while_held(self):
        r = cc.run_tool([PY, "-I", "-c", "import time; time.sleep(60)"], cwd=self.dir, timeout=60, poll_sec=0.2,
                        stop=lambda: True, pacing={"cfg": CFG, "read": lambda: sig(state="fullscreen")})
        self.assertEqual(r.returncode, cc.STOPPED_RC)

    def test_gentle_child_still_finishes(self):
        cfg = dict(CFG, runSec=0.3, pauseSec=0.3)
        body = "import time\nfor i in range(5): time.sleep(0.1)\nprint('ok')"
        r = cc.run_tool([PY, "-I", "-c", body], cwd=self.dir, timeout=60, poll_sec=0.2,
                        pacing={"cfg": cfg, "read": lambda: sig(idle=1, battery=False)})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_pace_line_once_per_change(self):
        self.assertIsNotNone(cc.pace_line("gentle"))
        self.assertIsNone(cc.pace_line("gentle"))
        self.assertIsNone(cc.pace_line("bogus"))


if __name__ == "__main__":
    unittest.main()
