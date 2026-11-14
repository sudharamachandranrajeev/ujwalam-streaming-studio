// SPDX-License-Identifier: GPL-3.0-or-later
// Feedback notes (D150; QML twin of the widget openFeedback, plan Q4): the moments marked with the feedback hotkey while
// streaming. Pick one, write a note with a tag and a severity, Save note. Notes stay in the gitignored feedback folder;
// the server checks every field. Its own window (Popup.Window), above the native previews.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "feedbackDlg"
    required property var store
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    width: Math.min(600, parent ? parent.width - 40 : 600)
    height: Math.min(560, parent ? parent.height - 40 : 560)
    title: "Feedback notes"
    closePolicy: Popup.CloseOnEscape

    readonly property int maxNote: 2000      // feedback.mjs
    readonly property var tags: ["bug", "annoying", "wish", "works-well"]
    readonly property var severities: ["high", "medium", "low"]
    property string info: "Loading..."
    property var moments: []
    property string selected: ""             // the picked moment's id
    property bool busy: false
    property int gen: 0

    readonly property var moment: { for (const m of moments) if (m.id === selected) return m; return null }

    function show() {
        gen++;
        info = "Loading...";
        moments = [];
        selected = "";
        busy = false;
        open();
        const g = gen;
        Api.get("ui/api/feedback", (ok, r, err) => {
            if (g !== gen) return;
            if (!ok) { info = "Feedback unavailable: " + err; return; }
            render(r.moments || []);
        });
        return true;
    }
    onClosed: gen++

    function render(list) {
        moments = list;
        if (moment === null) selected = "";
        info = moments.length === 0 ? "No feedback moments yet. Press the feedback hotkey while streaming."
             : moments.length + " moment(s). Pick one to add a note.";
    }
    function rowText(m) {
        const n = m.note || {};
        return m.id + "  " + (m.scene || "") + "   " + (n.tag ? n.tag + "/" + (n.severity || "-") : "no note");
    }
    function metaText(m) {
        if (!m) return "";
        const s = m.stats || {};
        const stats = Object.keys(s).map(k => k + "=" + s[k]).join(" ");
        return (m.timestamp === null || m.timestamp === undefined ? "" : String(m.timestamp) + "  ") + (m.scene || "") + "  " + stats;
    }
    function pick(id) {
        selected = id;
        const n = (moment && moment.note) || {};
        noteText.text = n.text || "";
        tagBox.pick(n.tag || "bug");
        sevBox.pick(n.severity || "medium");
        return moment !== null;
    }
    function save() {
        if (!moment || busy) return false;
        if (noteText.text.length > maxNote) { info = "The note is over " + maxNote + " characters."; return false; }
        busy = true;
        const g = gen;
        Api.post("ui/api/feedback/note", { id: selected, text: noteText.text, tag: tagBox.value, severity: sevBox.value }, (ok, r, err) => {
            busy = false;
            if (g !== gen) return;
            if (!ok) { info = "Save failed: " + err; return; }
            render(r.moments || []);
            info = "Saved.";
        });
        return true;
    }

    // ---- probe (tests): feedback-open, feedback-pick:<n>, feedback-text:<enc>, feedback-tag:<tag>, feedback-severity:<s>,
    // feedback-save, feedback-close ----
    function probe() {
        return { open: opened, info: info, rows: moments.map(rowText), selected: selected, meta: metaText(moment), formShown: moment !== null,
                 text: noteText.text, tag: tagBox.value === undefined ? "" : tagBox.value, severity: sevBox.value === undefined ? "" : sevBox.value };
    }
    function probeAction(a) {
        if (a === "feedback-open") return show();
        if (!opened) return false;
        if (a.startsWith("feedback-pick:")) { const n = parseInt(a.slice(14), 10); return n >= 0 && n < moments.length && pick(moments[n].id) }
        if (!moment) return a === "feedback-close" ? (close(), true) : false;
        if (a.startsWith("feedback-text:")) { noteText.text = decodeURIComponent(a.slice(14)); return true }
        if (a.startsWith("feedback-tag:")) return tagBox.pick(a.slice(13));
        if (a.startsWith("feedback-severity:")) return sevBox.pick(a.slice(18));
        if (a === "feedback-save") return save();
        if (a === "feedback-close") { close(); return true }
        return false;
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
    // Anchors: the list takes the height the form leaves.
    contentItem: Item {
        Text {
            id: infoText
            objectName: "feedbackInfo"
            anchors { left: parent.left; right: parent.right; top: parent.top }
            text: dlg.info
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        ListView {
            id: list
            objectName: "feedbackList"
            anchors { left: parent.left; right: parent.right; top: infoText.bottom; topMargin: 8; bottom: form.visible ? form.top : parent.bottom; bottomMargin: 8 }
            clip: true
            model: dlg.moments
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            delegate: Rectangle {
                id: row
                required property var modelData
                required property int index
                objectName: "feedbackItem:" + index
                width: ListView.view.width
                height: 30
                radius: Theme.radiusSmall
                color: row.modelData.id === dlg.selected ? Theme.c.accent : hover.hovered ? Theme.c.field : "transparent"
                Text {
                    anchors { left: parent.left; right: parent.right; leftMargin: 8; rightMargin: 8; verticalCenter: parent.verticalCenter }
                    text: dlg.rowText(row.modelData)
                    elide: Text.ElideRight
                    color: row.modelData.id === dlg.selected ? Theme.c.onAccent : Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: 13
                }
                HoverHandler { id: hover }
                TapHandler { onTapped: dlg.pick(row.modelData.id) }
            }
        }
        Column {
            id: form
            objectName: "feedbackForm"
            anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
            visible: dlg.moment !== null
            spacing: 8
            Text {
                width: parent.width
                text: dlg.metaText(dlg.moment)
                wrapMode: Text.Wrap
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 13
            }
            ScrollView {
                width: parent.width
                height: 110
                TextArea {
                    id: noteText
                    objectName: "feedbackText"
                    placeholderText: "What happened (up to 2000 characters)"
                    wrapMode: TextArea.Wrap
                    color: Theme.c.text
                    placeholderTextColor: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 14
                    Accessible.name: "Note"
                    background: Rectangle {
                        radius: Theme.radiusSmall
                        color: Theme.c.field
                        border.width: 1
                        border.color: noteText.activeFocus ? Theme.c.accentHi : Theme.c.border
                    }
                }
            }
            Row {
                spacing: 10
                Text { anchors.verticalCenter: parent.verticalCenter; text: "Tag"; color: Theme.c.text; font.family: Theme.family; font.pixelSize: 14 }
                UCombo {
                    id: tagBox
                    objectName: "feedbackTag"
                    label: "Tag"
                    width: 150
                    model: dlg.tags.map(t => ({ value: t, text: t }))
                }
                Text { anchors.verticalCenter: parent.verticalCenter; text: "Severity"; color: Theme.c.text; font.family: Theme.family; font.pixelSize: 14 }
                UCombo {
                    id: sevBox
                    objectName: "feedbackSeverity"
                    label: "Severity"
                    width: 120
                    model: dlg.severities.map(s => ({ value: s, text: s }))
                }
                UButton {
                    objectName: "feedbackSave"
                    text: "Save note"
                    kind: "primary"
                    enabled: !dlg.busy
                    onClicked: dlg.save()
                }
            }
        }
    }
    footer: Item {
        implicitHeight: 56
        UButton {
            objectName: "feedbackClose"
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            text: "Close"
            onClicked: dlg.close()
        }
    }
}
