// SPDX-License-Identifier: GPL-3.0-or-later
// "Make clips?" after a recording or stream (setting: Ask me each time; the widget's askClips). Not modal: the studio
// keeps working. Make clips / Not now, and "Do this every time" saves the choice as the setting (ui/api/clips/answer).
// One question at a time; the next one opens when this one is answered. Its own window (Popup.Window).
// D411: a music, transition and name style for this one recording only ("As in Settings" by default; nothing is saved).
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

    // D411 the clip look for this recording: { group: option id or "off" }; groups from GET ui/api/settings (look)
    property var lookGroups: []
    property var lookPick: ({})
    function loadLook() {
        Api.get("ui/api/settings", (ok, b) => {
            const g = ok && b && b.look ? b.look.groups : null;
            lookGroups = !g ? [] : [{ g: "music", title: "Music" }, { g: "transitions", title: "Transitions" }, { g: "name", title: "Your name" }]
                .filter(x => g[x.g]).map(x => ({ g: x.g, title: x.title, options: g[x.g].options }));
        });
    }
    function pickLook(g, v) { const m = Object.assign({}, lookPick); if (v === "") delete m[g]; else m[g] = v; lookPick = m }
    function put(a) { ask = a; remember.checked = false; lookPick = ({}); loadLook(); open(); return true }
    // Escape or the X counts as Not now, as the widget's message box does.
    property bool answered: false
    onOpened: { answered = false; store.clipsAsking = true }
    onClosed: { store.clipsAsking = false; if (!answered && ask) answer(false); }
    function answer(make) {
        if (!ask) return false;
        answered = true;
        const id = ask.id, keep = remember.checked, look = Object.keys(lookPick).length ? lookPick : null;
        ask = null;
        close();
        store.answerClips(id, make, keep, make ? look : null);
        Qt.callLater(store.nextClipsAsk);
        return true;
    }

    // ---- probe (tests): clips-ask (put the next waiting question), clips-answer:<yes|no>[:remember] ----
    function probe() { return { open: opened, message: message, remember: remember.text, lookGroups: lookGroups.map(x => x.g), look: lookPick } }
    function probeAction(a) {
        if (a === "clips-ask") return store.nextClipsAsk();
        if (a.startsWith("clips-look:") && opened) { const q = a.slice(11).split(":"); pickLook(q[0], q[1] || ""); return true } // clips-look:<group>:<id|off|>
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
        Text {
            visible: dlg.lookGroups.length > 0
            width: parent.width
            text: "Style for this recording (optional)"
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        Repeater {
            model: dlg.lookGroups
            delegate: Row {
                id: lr
                required property var modelData
                spacing: 8
                Text {
                    width: 96
                    anchors.verticalCenter: parent.verticalCenter
                    text: lr.modelData.title
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: 13
                }
                UCombo {
                    objectName: "clipsAskLook_" + lr.modelData.g
                    width: 260
                    label: lr.modelData.title + " for this recording"
                    model: [{ value: "", text: "As in Settings" }].concat(lr.modelData.options.map(o => ({ value: o.id, text: o.label }))).concat([{ value: "off", text: "None" }])
                    currentIndex: Math.max(0, model.findIndex(m => m.value === (dlg.lookPick[lr.modelData.g] || "")))
                    onChose: (v) => dlg.pickLook(lr.modelData.g, v)
                }
            }
        }
        UCheckbox {
            id: remember
            objectName: "clipsAskRemember"
            text: dlg.live ? "Do this every time a stream ends" : "Do this every time I stop recording"
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
