// SPDX-License-Identifier: GPL-3.0-or-later
// Report a problem (flag report-button; QML twin of the widget report(), plan Q4): a title and what happened. The UI
// server builds a prefilled GitHub issue link from them plus the studio's state (report.mjs: no keys, no chat, no
// names); the browser opens it and the user reviews and submits it there. Nothing is sent from the studio. Only an
// https://github.com/ link is opened (Api.openLink checks it again). Its own window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "reportDlg"
    required property var store
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: Math.min(560, parent ? parent.width - 40 : 560)
    title: "Report a problem"
    closePolicy: Popup.CloseOnEscape

    readonly property int maxTitle: 120     // report.mjs MAX_TITLE / MAX_NOTE
    readonly property int maxNote: 1500
    property bool busy: false
    property string outcome: ""             // the last result, for the probe and the status line

    function show() {
        titleField.text = "";
        noteText.text = "";
        busy = false;
        outcome = "";
        open();
        titleField.forceActiveFocus();
        return true;
    }
    function send() {
        if (busy) return false;
        busy = true;
        const q = "title=" + encodeURIComponent(titleField.text.slice(0, maxTitle)) + "&note=" + encodeURIComponent(noteText.text.slice(0, maxNote));
        Api.get("ui/api/report-url?" + q, (ok, r, err) => {
            busy = false;
            close();
            if (!ok) return done("Report failed: " + err);
            if (r.configured !== true) return done(r.message || "Report: set links.issues_url in the profile");
            const how = Api.openLink(String(r.url || ""));
            if (how === "refused") return done("Report: the link was refused");
            if (how === "failed") return done("Report: no browser opened the link");
            done((r.truncated === true ? "Shortened to fit: attach the diag bundle. " : "") + "Review it in your browser, then submit." + (how === "headless" ? " (test mode: not opened)" : ""));
        });
        return true;
    }
    function done(text) { outcome = text; store.say(text) }

    // ---- probe (tests): report-open, report-title:<enc>, report-note:<enc>, report-send, report-cancel ----
    function probe() { return { open: opened, title: titleField.text, note: noteText.text, result: outcome } }
    function probeAction(a) {
        if (a === "report-open") return show();
        if (!opened) return false;
        if (a.startsWith("report-title:")) { titleField.text = decodeURIComponent(a.slice(13)); return true }
        if (a.startsWith("report-note:")) { noteText.text = decodeURIComponent(a.slice(12)); return true }
        if (a === "report-send") return send();
        if (a === "report-cancel") { close(); return true }
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
    contentItem: Column {
        spacing: 8
        Text {
            width: parent.width
            text: "Your browser opens a prefilled GitHub issue to review and submit. Nothing is sent from here."
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        UField {
            id: titleField
            objectName: "reportTitle"
            width: parent.width
            label: "Title"
            placeholderText: "Title"
            maximumLength: dlg.maxTitle
        }
        ScrollView {
            width: parent.width
            height: 160
            TextArea {
                id: noteText
                objectName: "reportNote"
                placeholderText: "What happened"
                wrapMode: TextArea.Wrap
                color: Theme.c.text
                placeholderTextColor: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 14
                Accessible.name: "What happened"
                background: Rectangle {
                    radius: Theme.radiusSmall
                    color: Theme.c.field
                    border.width: 1
                    border.color: noteText.activeFocus ? Theme.c.accentHi : Theme.c.border
                }
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                objectName: "reportCancel"
                text: "Cancel"
                onClicked: dlg.close()
            }
            UButton {
                objectName: "reportSend"
                text: "Open in browser"
                kind: "primary"
                enabled: !dlg.busy && titleField.text.trim() !== ""
                onClicked: dlg.send()
            }
        }
    }
}
