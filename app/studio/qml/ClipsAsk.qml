// SPDX-License-Identifier: GPL-3.0-or-later
// "Make clips?" after a recording or stream (setting: Ask me each time; the widget's askClips). Not modal: the studio
// keeps working. Make clips / Not now, and "Do this every time" saves the choice as the setting (ui/api/clips/answer).
// One question at a time; the next one opens when this one is answered. Its own window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "clipsAsk"
    required property var store
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: Math.min(480, parent ? parent.width - 40 : 480)
    title: "Make clips?"
    closePolicy: Popup.CloseOnEscape

    property var ask: null
    readonly property bool live: !!ask && ask.kind === "live"
    readonly property string message: !ask ? "" : (live ? "Your stream has ended" : "Your recording has stopped")
        + (typeof ask.minutes === "number" && ask.minutes >= 0 ? " (" + ask.minutes + " min)." : ".")
        + "\n\nShould Ujwalam find the best moments and make clips from it?"

    function put(a) { ask = a; remember.checked = false; open(); return true }
    // Escape or the X counts as Not now, as the widget's message box does.
    property bool answered: false
    onOpened: { answered = false; store.clipsAsking = true }
    onClosed: { store.clipsAsking = false; if (!answered && ask) answer(false); }
    function answer(make) {
        if (!ask) return false;
        answered = true;
        const id = ask.id, keep = remember.checked;
        ask = null;
        close();
        store.answerClips(id, make, keep);
        Qt.callLater(store.nextClipsAsk);
        return true;
    }

    // ---- probe (tests): clips-ask (put the next waiting question), clips-answer:<yes|no>[:remember] ----
    function probe() { return { open: opened, message: message, remember: remember.text } }
    function probeAction(a) {
        if (a === "clips-ask") return store.nextClipsAsk();
        if (!a.startsWith("clips-answer:") || !opened) return false;
        const p = a.slice(13).split(":");
        remember.checked = p[1] === "remember";
        return answer(p[0] === "yes");
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
        font.family: Theme.family
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    contentItem: Column {
        spacing: 10
        Text {
            width: parent.width
            text: dlg.message
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        CheckBox {
            id: remember
            objectName: "clipsAskRemember"
            text: dlg.live ? "Do this every time a stream ends" : "Do this every time I stop recording"
            font.family: Theme.family
            font.pixelSize: 13
            contentItem: Text {
                leftPadding: remember.indicator.width + 8
                text: remember.text
                color: Theme.c.text
                font: remember.font
                verticalAlignment: Text.AlignVCenter
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton { objectName: "clipsAskNo"; text: "Not now"; onClicked: dlg.answer(false) }
            UButton { objectName: "clipsAskYes"; text: "Make clips"; kind: "primary"; onClicked: dlg.answer(true) }
        }
    }
}
