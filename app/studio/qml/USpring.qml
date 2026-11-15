// SPDX-License-Identifier: GPL-3.0-or-later
// Design after RareUI (MIT, Swapnil Kalambe). Rebuilt natively; not the original code.
// The shared exact spring (RareUI slice 0, D384): a damped spring  m x'' = -k (x - to) - c x'  integrated with a fixed
// small step (semi-implicit Euler, 1/240 s) inside a FrameAnimation, so the result does not depend on the frame rate.
// Stiffness k, damping c and mass m default to the pack's motion.spring (300 / 30 / 1). It stops at rest (no frame
// callbacks while idle) and, in Theme.fx "plain" (on air or High performance), jumps straight to the target.
// Not used by a screen yet.
//
//   USpring { id: sp; to: open ? 1 : 0 }        // sp.value follows `to`; bind sp.value to a property
//   sp.value = 0.5; sp.velocity = 0             // start from here; the spring pulls it back to `to`
import QtQuick
import Ujwalam.Core

Item {
    id: spring
    visible: false
    width: 0
    height: 0

    property real to: 0
    property real value: 0
    property real velocity: 0
    property real stiffness: Theme.spring.stiffness
    property real damping: Theme.spring.damping
    property real mass: Theme.spring.mass
    // The value counts as at rest inside these bounds (units of value, and per second).
    property real restDelta: 0.001
    property real restSpeed: 0.01
    readonly property bool moving: anim.running

    // Jump to the target now, with no motion.
    function snap() {
        value = to
        velocity = 0
        anim.running = false
    }

    // Move the whole spring on by dt seconds (also used by the tests). Returns true while it is still moving.
    function advance(dt) {
        const k = Math.max(stiffness, 0.0001), c = Math.max(damping, 0), m = Math.max(mass, 0.0001)
        const h = 1 / 240
        let t = Math.min(dt, 0.1) // a stalled frame does not blow the spring up
        let x = value, v = velocity
        while (t > 0) {
            const step = Math.min(h, t)
            const a = (-k * (x - to) - c * v) / m
            v += a * step
            x += v * step
            t -= step
        }
        if (Math.abs(v) < restSpeed && Math.abs(x - to) < restDelta) {
            value = to
            velocity = 0
            return false
        }
        value = x
        velocity = v
        return true
    }

    onToChanged: {
        if (Theme.fx === "plain") snap()
        else if (value !== to || velocity !== 0) anim.running = true
    }

    FrameAnimation {
        id: anim
        running: false
        onTriggered: if (!spring.advance(frameTime)) running = false
    }
}
