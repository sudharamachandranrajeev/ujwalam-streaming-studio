// SPDX-License-Identifier: GPL-3.0-or-later
// A surface that floats over the studio window and stays open on its own (the task panel, the notification stack, the
// schedule panel), drawn above the native previews.
//
// Why not Popup.Window (2026-11-27, user report on alpha.48: "clicked Start in the task panel, nothing happened, the UI
// froze"): Qt 6.8 sends the clicks for every popup window to the newest popup window. While a notification popup opened
// after the task panel was showing, every click on the panel's Start went to the notification instead and was dropped;
// no request was sent and the GUI thread was never blocked. Reproduced on Windows with real windows and system mouse
// input in docs/evidence/2026-11-27-click-loss-fix.md (and closing the newer popup took the older one away with it).
// Popups are meant for menus and dialogs the user opens and closes in turn, not for surfaces that appear by
// themselves. These are frameless tool windows owned by the studio window instead: each gets its own clicks, they stay
// above the studio window and its previews, and they never take part in the popup chain.
//
// The hidden test mode (studioUnseen) draws the same body inside the studio window (Popup.Item): no window appears,
// and the probe reads the same items.
//
// Use: FloatSurface { shown: ...; px: ...; py: ...; pw: ...; ph: ...; <body items> }. px/py are in the coordinates of
// this item, which sits at the studio window's top-left corner (TaskCenter and ScheduleCenter are anchored there).
import QtQuick
import QtQuick.Controls.Basic

Item {
    id: fs
    property bool shown: false
    property real px: 0
    property real py: 0
    property real pw: 100
    property real ph: 100
    // A surface with a text box (the schedule panel's search) must take the keyboard; the others never take the focus
    // away from the studio window.
    property bool takesFocus: false
    default property alias body: box.data
    readonly property bool inWindow: !studioUnseen
    readonly property bool opened: inWindow ? win.visible : pop.visible
    readonly property Window studioWindow: fs.Window.window

    Item { // the body's home: moved into the popup or the window once, at start (studioUnseen never changes)
        id: box
        width: fs.pw
        height: fs.ph
    }
    Component.onCompleted: box.parent = inWindow ? win.contentItem : pop.contentItem

    Popup { // hidden test mode only
        id: pop
        popupType: Popup.Item
        visible: fs.shown && !fs.inWindow
        modal: false
        focus: false
        closePolicy: Popup.NoAutoClose
        padding: 0
        background: Item {}
        x: fs.px
        y: fs.py
        width: fs.pw
        height: fs.ph
    }
    Window {
        id: win
        objectName: fs.objectName + "Window"
        transientParent: fs.studioWindow
        flags: Qt.Tool | Qt.FramelessWindowHint | Qt.NoDropShadowWindowHint | (fs.takesFocus ? 0 : Qt.WindowDoesNotAcceptFocus)
        color: "transparent"
        // Not over the desktop while the studio window is hidden in the tray or minimised.
        visible: fs.shown && fs.inWindow && !!fs.studioWindow && fs.studioWindow.visible && fs.studioWindow.visibility !== Window.Minimized
        // Screen position: this item's corner on screen (it follows the studio window's moves) plus px/py.
        readonly property point at: {
            const w = fs.studioWindow;
            if (w) { w.x; w.y; w.width; w.height } // read so the binding runs again when the studio window moves or resizes
            return fs.mapToGlobal(fs.px, fs.py);
        }
        x: Math.round(at.x)
        y: Math.round(at.y)
        width: Math.max(1, Math.round(fs.pw))
        height: Math.max(1, Math.round(fs.ph))
    }
}
