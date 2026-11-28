// SPDX-License-Identifier: GPL-3.0-or-later
// "Make clips?" after a recording or stream (setting: Ask me each time; the widget's askClips). Not modal: the studio
// keeps working. Make clips / Not now, and "Do this every time" saves the choice as the setting (ui/api/clips/answer).
// One question at a time; the next one opens when this one is answered.
// It opens by itself (the store's poll, once a stream or recording has ended), so it is a FloatSurface tool window and
// never a Popup.Window: a popup window opened without a click takes the clicks of the popup the user is using
// (FloatSurface.qml, docs/evidence/2026-11-28-float-self-open.md).
// D411: a music, transition and name style for this one recording only ("As in Settings" by default; nothing is saved).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Item {
    id: dlg
    objectName: "clipsAsk"
    required property var store
    readonly property string title: "Make clips?"
    readonly property bool opened: surface.opened

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
    function put(a) { ask = a; remember.checked = false; lookPick = ({}); loadLook(); store.clipsAsking = true; surface.shown = true; return true }
    // Escape counts as Not now, as the widget's message box does.
    function answer(make) {
        if (!ask) return false;
        const id = ask.id, keep = remember.checked, look = Object.keys(lookPick).length ? lookPick : null;
        ask = null;
        surface.shown = false;
        store.clipsAsking = false;
        store.answerClips(id, make, keep, make ? look : null);
        Qt.callLater(store.nextClipsAsk);
        return true;
    }

    // ---- probe (tests): clips-ask (put the next waiting question), clips-answer:<yes|no>[:remember] ----
    function probe() { return { open: opened, message: message, remember: remember.text, lookGroups: lookGroups.map(x => x.g), look: lookPick,
                                inWindow: surface.inWindow, surfaceOpened: surface.opened } }
    function probeAction(a) {
        if (a === "clips-ask") return store.nextClipsAsk();
        if (a.startsWith("clips-look:") && opened) { const q = a.slice(11).split(":"); pickLook(q[0], q[1] || ""); return true } // clips-look:<group>:<id|off|>
        if (a.startsWith("clips-click:") && opened) { // the real button: its click handler is what answers
            const b = a.slice(12) === "yes" ? yesBtn : noBtn;
            if (!b.enabled) return false;
            b.clicked();
            return true;
        }
        if (!a.startsWith("clips-answer:") || !opened) return false;
        const p = a.slice(13).split(":");
        remember.checked = p[1] === "remember";
        return answer(p[0] === "yes");
    }

    // The look the Dialog had: panel with a border, a title row (18 px inset), 12 px round the content, a 60 px footer.
    FloatSurface {
        id: surface
        objectName: "clipsAskSurface"
        anchors.fill: parent
        takesFocus: true // Escape = Not now needs the keys
        pw: Math.min(480, dlg.width - 40)
        ph: head.height + col.implicitHeight + 24 + foot.implicitHeight
        px: Math.round((dlg.width - pw) / 2)
        py: Math.round((dlg.height - ph) / 2)
        onShownChanged: if (shown) keys.forceActiveFocus()
        Rectangle {
            anchors.fill: parent
            color: Theme.c.panel
            radius: Theme.radiusLarge
            border.width: 1
            border.color: Theme.c.border
        }
        FocusScope {
            id: keys
            anchors.fill: parent
            focus: true
            Shortcut { sequence: "Escape"; enabled: dlg.opened; onActivated: dlg.answer(false) } // Escape = Not now
            Text {
                id: head
                text: dlg.title
                padding: 18
                bottomPadding: 6
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: 18
                font.weight: Font.DemiBold
            }
            Column {
                id: col
                x: 12
                y: head.height + 12
                width: parent.width - 24
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
            Item {
                id: foot
                y: parent.height - implicitHeight
                width: parent.width
                implicitHeight: 60
                Row {
                    anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
                    spacing: 10
                    UButton { id: noBtn; objectName: "clipsAskNo"; text: "Not now"; onClicked: dlg.answer(false) }
                    UButton { id: yesBtn; objectName: "clipsAskYes"; text: "Make clips"; kind: "primary"; onClicked: dlg.answer(true) }
                }
            }
        }
    }
}
