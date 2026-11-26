// SPDX-License-Identifier: GPL-3.0-or-later
// The scheduling manager in its own top-level window (the task manager's pattern, D442): the same list as the panel
// (ScheduleView.qml). "Dock", or closing the window, returns to the panel. Never shown in the hidden test mode
// (studioUnseen): the probe reads the same state.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Window {
    id: win
    objectName: "scheduleWindow"
    required property var center
    visible: center.windowOpen && !studioUnseen
    width: 980
    height: 700
    minimumWidth: 640
    minimumHeight: 420
    title: "Ujwalam - Scheduled posts"
    color: Theme.c.bg
    onClosing: (close) => { close.accepted = true; center.dockWindow() } // the window's own X: back to the panel
    function closeByUser() { return center.dockWindow() }

    Loader {
        anchors { fill: parent; margins: Theme.sp.l }
        active: win.center.windowOpen
        sourceComponent: ScheduleView { center: win.center; inWindow: true }
    }
}
