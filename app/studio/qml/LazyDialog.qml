// SPDX-License-Identifier: GPL-3.0-or-later
// A dialog or window made on its first use (start-up time, 2026-11-19): the main window paints without creating the
// Settings, YouTube, Go live and other windows nobody sees at start (about a third of the QML load). The Loader stands
// in for the dialog: the same calls (show, ask, put, probe, probeAction, openAt, ...) make it once, then pass through.
// It fills the window, so the dialog's parent has the window's size, as when it was declared in Main.qml directly.
// What is made is never unloaded again (a closed dialog keeps its state, as before).
import QtQuick

Loader {
    id: lazy
    anchors.fill: parent
    active: false

    // The dialog, made now if it was not made yet (synchronous: it is there when this returns).
    function get() { if (!active) active = true; return item }
    readonly property bool made: status === Loader.Ready
    readonly property bool opened: item ? item.opened === true : false
    readonly property bool ready: item ? item.ready === true : false

    function show(a) { return get().show(a) }
    function ask(a, b, c) { return get().ask(a, b, c) }
    function put(a) { return get().put(a) }
    function probe() { return get().probe() }
    function probeAction(a) { return get().probeAction(a) }
    function openAt(p) { return get().openAt(p) }
    function openConnections(id) { return get().openConnections(id) }
    function guideProbe(a) { return get().guideProbe(a) }
    function openScenarios() { return get().openScenarios() }
}
