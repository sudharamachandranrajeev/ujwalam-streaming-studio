// SPDX-License-Identifier: GPL-3.0-or-later
// Closing with tasks still running or waiting (D311 proposed, as the widget closeEvent): nothing may go on unseen after
// the window is gone, so the user picks: keep them running in the tray (icon, progress, time left), stop them and close,
// or keep the window. Stop: the window ends with exit 0 and the launcher ends every task's whole process tree. Each
// choice acts on its click (D332).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "closeTasks"
    required property var store
    signal stopAndClose()
    signal keepInTray()
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: Math.min(560, parent ? parent.width - 80 : 560)
    title: "Close Ujwalam"
    closePolicy: Popup.CloseOnEscape

    // The question as asked (fixed when the window opens, so the probe reads what the user read) and the answer.
    property string asked: ""
    property string choice: ""
    function question() {
        const running = store.tasks.filter(t => t.state === "running" || t.state === "waiting");
        const n = running.length;
        return n + (n === 1 ? " task is" : " tasks are") + " still running:\n" +
               running.slice(0, 8).map(t => "- " + (t.title || t.id) + " (" + TaskText.lines(t).text + ")").join("\n") +
               "\n\nWhat should happen to " + (n === 1 ? "it" : "them") + "?";
    }
    onAboutToShow: { asked = question(); choice = "" }

    // close-choice:<tray|stop|cancel> (probe): the same as a click on that button.
    function choose(c) {
        if (!opened) return false;
        if (c === "tray") trayBtn.click();
        else if (c === "stop") stopBtn.click();
        else if (c === "cancel") keep.click();
        else return false;
        return true;
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: 18
        bottomPadding: 6
        color: Theme.c.text
        font.family: "Barlow"
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    contentItem: Text {
        objectName: "closeQuestion"
        text: dlg.asked
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 14
        lineHeight: 1.2
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                id: keep
                objectName: "closeCancel"
                text: "Do not close"
                onClicked: { dlg.choice = "cancel"; dlg.close(); dlg.store.say("Ujwalam was not closed; the tasks keep running.") }
            }
            UButton {
                id: stopBtn
                objectName: "closeStop"
                text: "Stop them and close"
                kind: "danger"
                onClicked: { dlg.choice = "stop"; dlg.close(); dlg.stopAndClose() }
            }
            UButton {
                id: trayBtn
                objectName: "closeTray"
                text: "Keep running in the tray"
                kind: "primary"
                onClicked: { dlg.choice = "tray"; dlg.close(); dlg.keepInTray() }
            }
        }
    }
    onOpened: trayBtn.forceActiveFocus() // the widget's default button; Escape is "Do not close"
    onRejected: if (choice === "") { choice = "cancel"; store.say("Ujwalam was not closed; the tasks keep running.") }
}
