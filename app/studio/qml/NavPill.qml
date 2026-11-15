// SPDX-License-Identifier: GPL-3.0-or-later
// Design after RareUI (MIT, Swapnil Kalambe). Rebuilt natively; not the original code.
// The pill that follows an item (RareUI slice 2, D384): the sliding active pill of Animated Tab (item 1), and the hover
// disc of Floating Navigation (item 2). It sits behind the items, in the same coordinate frame as `host`, and takes the
// place and size of `target`. With `animate` it moves by a USpring (no overshoot clamp; stiffness and damping as the
// plan gives them); without it the pill jumps (calm and plain: no motion). No target = the pill fades out.
//
//   NavPill { host: col; target: currentButton; fill: Theme.c.field; radius: height / 2; animate: look-is-full }
import QtQuick
import Ujwalam.Core

Item {
    id: np
    property Item target: null
    property Item host: parent
    property bool animate: false
    property color fill: Theme.c.field
    property real fillOpacity: 1
    property real radius: height / 2
    property real stiffness: 320
    property real damping: 32
    property real mass: 0.9
    property real inset: 0
    property int fadeMs: 90 // a hover or press change stays under 100 ms (the plan says 150; the brief wins)
    readonly property bool moving: sp.moving

    // Where the target is, in the host's frame. Re-read when the target or the host changes size or place.
    property rect goal: Qt.rect(0, 0, 0, 0)
    function sync() {
        if (!target || !host) { goal = Qt.rect(goal.x, goal.y, goal.width, goal.height); return }
        const p = target.mapToItem(host, 0, 0)
        goal = Qt.rect(p.x + inset, p.y + inset, Math.max(0, target.width - 2 * inset), Math.max(0, target.height - 2 * inset))
    }
    onTargetChanged: sync()
    onHostChanged: sync()
    Connections { target: np.target; ignoreUnknownSignals: true
        function onXChanged() { np.sync() } function onYChanged() { np.sync() }
        function onWidthChanged() { np.sync() } function onHeightChanged() { np.sync() } }
    Connections { target: np.host; ignoreUnknownSignals: true
        function onWidthChanged() { np.sync() } function onHeightChanged() { np.sync() } }

    // The rect now shown: the goal, or a spring blend from where the pill was.
    property rect from: Qt.rect(0, 0, 0, 0)
    property bool flip: false
    readonly property real t: !animate ? 1 : (flip ? sp.value : 1 - sp.value)
    readonly property rect shown: Qt.rect(from.x + (goal.x - from.x) * t, from.y + (goal.y - from.y) * t,
                                          from.width + (goal.width - from.width) * t, from.height + (goal.height - from.height) * t)
    property bool placed: false // the first goal puts the pill there at once; it only slides between two places
    onGoalChanged: {
        if (!placed || !animate || goal.width <= 0) {
            from = goal
            placed = goal.width > 0
            return
        }
        from = shown
        flip = !flip
        sp.velocity = 0
        sp.value = flip ? 0 : 1
        sp.to = flip ? 1 : 0
    }
    onAnimateChanged: if (!animate) from = goal

    USpring {
        id: sp
        value: 1
        to: 1
        stiffness: np.stiffness
        damping: np.damping
        mass: np.mass
    }

    x: shown.x
    y: shown.y
    width: shown.width
    height: shown.height
    opacity: target !== null && goal.width > 0 ? 1 : 0
    visible: opacity > 0
    Behavior on opacity { enabled: Theme.motion; NumberAnimation { duration: np.fadeMs } }

    Rectangle {
        anchors.fill: parent
        radius: np.radius
        color: np.fill
        opacity: np.fillOpacity
    }
}
