// SPDX-License-Identifier: GPL-3.0-or-later
// Review reads (LL3, D340, flag learning-review; QML twin of the widget openReview, plan Q4): the reads the clip maker
// was not sure of (a banner at an odd height, a low-confidence OCR read, an unknown game mode). The user confirms or
// corrects the ones they know; each answer is saved only on this PC (one "confirmed" label row) and helps the next game
// pack. Its own window (Popup.Window), above the native previews.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "reviewDlg"
    required property var store
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    width: Math.min(820, parent ? parent.width - 40 : 820)
    height: Math.min(680, parent ? parent.height - 40 : 680)
    title: "Review reads"
    closePolicy: Popup.CloseOnEscape

    property string info: "Loading..."
    property var items: []
    property int total: 0
    property int current: -1
    property bool busy: false
    property string picText: ""
    property string picSource: ""
    property int gen: 0               // a close or a new open drops the answers of the old one
    property int frameGen: 0          // a newer pick drops the picture of the older one

    readonly property var item: current >= 0 && current < items.length ? items[current] : null
    readonly property var choices: item ? (item.choices || []) : []

    function show() {
        gen++;
        info = "Loading...";
        items = [];
        current = -1;
        busy = false;
        open();
        load();
        return true;
    }
    onClosed: gen++

    function mmss(t) { const s = Math.floor(t); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") }
    function titleOf(it) {
        const when = it.at ? Qt.formatDateTime(new Date(it.at), "d MMM HH:mm") : "";
        const t = it.kind === "unclassified-banner" ? "Banner: round end or match end?"
                : it.kind === "ocr-low" ? "Unsure read: " + (it.label || "")
                : "Game mode of match " + (it.match || 0) + "?";
        return when + "  " + t;
    }
    function question(it) {
        if (!it) return "";
        if (it.kind === "unclassified-banner")
            return "A " + it.label + " banner sat at a height that fits neither a round end nor a match end. Which was it?";
        if (it.kind === "ocr-low")
            return "Read as \"" + it.label + "\" with confidence " + Number(it.ocrScore || 0).toFixed(2) + ", below the game pack's " +
                   Number(it.threshold || 0).toFixed(2) + ". Is it right? Pick it, pick \"wrong read\", or type what it says.";
        const ev = (it.modeEvidence || []).map(e => e.text);
        let text = "Match " + (it.match || 0) + " of the recording: the game mode could not be told (" + (it.modeReason || "") + "). Which mode was it?";
        if (ev.length > 0) text += " Seen: " + ev.join(", ") + ".";
        if (typeof it.t === "number") text += " The picture is from its end screen, " + mmss(it.t) + " into the recording.";
        return text;
    }

    function load() {
        const g = gen;
        Api.get("ui/api/learning/review", (ok, b, err) => {
            if (g !== gen) return;
            const keep = current;
            items = ok ? (b.items || []) : [];
            total = ok ? (b.total || 0) : 0;
            info = !ok ? "Not available: " + err
                 : total === 0 ? "Nothing to review. Thank you."
                 : total + " read(s) the clip maker was not sure of. Confirm or correct the ones you know; each answer is saved only on this PC and helps the next game pack. Skip any you like.";
            pick(items.length === 0 ? -1 : Math.max(0, Math.min(keep, items.length - 1)));
        });
    }
    function pick(i) {
        current = i;
        typed.text = "";
        answer.currentIndex = choices.length > 0 ? 0 : -1;
        picSource = "";
        const it = item;
        if (!it) { picText = ""; return; }
        if (!it.hasFrame) { picText = "No picture for this one."; return; }
        picText = "Loading the picture...";
        const fg = ++frameGen, g = gen;
        Api.get("ui/api/learning/frame?session=" + encodeURIComponent(it.session || "") + "&id=" + encodeURIComponent(it.id || ""), (ok, b, err) => {
            if (g !== gen || fg !== frameGen) return;
            if (!ok || !b.jpeg) { picText = "The picture could not be shown" + (ok ? "" : ": " + err); return; }
            picText = "";
            picSource = "data:image/jpeg;base64," + b.jpeg;
        });
    }
    function confirm(value) {
        const it = item;
        value = String(value || "").trim();
        if (!it || value === "" || busy) return false;
        busy = true;
        const g = gen;
        Api.post("ui/api/learning/confirm", { session: it.session, id: it.id, value: value }, (ok, b, err) => {
            busy = false;
            store.say(ok ? "Saved: " + value + "." : "Answer not saved: " + err);
            if (g === gen) load();
        });
        return true;
    }

    // ---- probe (tests): review-open, review-pick:<n>, review-confirm:<answer index>, review-type:<text>, review-close ----
    function probe() {
        return { open: opened, info: info, items: items.length, total: total, current: current, titles: items.map(titleOf),
                 question: question(item), choices: choices, picture: picText !== "" ? picText : picSource !== "" ? "shown" : "", busy: busy };
    }
    function probeAction(a) {
        if (a === "review-open") return show();
        if (!opened) return false;
        if (a.startsWith("review-pick:")) { const n = parseInt(a.slice(12), 10); if (!(n >= 0 && n < items.length)) return false; pick(n); return true }
        if (a.startsWith("review-confirm:")) { const n = parseInt(a.slice(15), 10); return n >= 0 && n < choices.length && confirm(choices[n]) }
        if (a.startsWith("review-type:")) return item !== null && item.kind === "ocr-low" && confirm(decodeURIComponent(a.slice(12)));
        if (a === "review-close") { close(); return true }
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
    // Anchors, not one Column: the picture takes the height the rest leaves.
    contentItem: Item {
        Text {
            id: infoText
            objectName: "reviewInfo"
            anchors { left: parent.left; right: parent.right; top: parent.top }
            text: dlg.info
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        ListView {
            id: list
            objectName: "reviewList"
            anchors { left: parent.left; right: parent.right; top: infoText.bottom; topMargin: 8 }
            height: Math.min(150, contentHeight)
            visible: dlg.items.length > 0
            clip: true
            model: dlg.items
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            delegate: Rectangle {
                id: row
                required property var modelData
                required property int index
                objectName: "reviewItem:" + index
                width: ListView.view.width
                height: 30
                radius: Theme.radiusSmall
                color: index === dlg.current ? Theme.c.accent : hover.hovered ? Theme.c.field : "transparent"
                Text {
                    anchors { left: parent.left; right: parent.right; leftMargin: 8; rightMargin: 8; verticalCenter: parent.verticalCenter }
                    text: dlg.titleOf(row.modelData)
                    elide: Text.ElideRight
                    color: row.index === dlg.current ? Theme.c.onAccent : Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: 13
                }
                HoverHandler { id: hover }
                TapHandler { onTapped: dlg.pick(row.index) }
            }
        }
        Item {
            id: picBox
            anchors { left: parent.left; right: parent.right; top: list.visible ? list.bottom : infoText.bottom; topMargin: 8; bottom: whatText.top; bottomMargin: 8 }
            Image {
                objectName: "reviewPicture"
                anchors.fill: parent
                fillMode: Image.PreserveAspectFit
                source: dlg.picSource
                visible: dlg.picSource !== ""
            }
            Text {
                anchors.centerIn: parent
                text: dlg.picText
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 13
            }
        }
        Text {
            id: whatText
            objectName: "reviewQuestion"
            anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
            text: dlg.question(dlg.item)
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
    }
    footer: Item {
        implicitHeight: 60
        Row {
            anchors { left: parent.left; leftMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "Answer"
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: 14
            }
            UCombo {
                id: answer
                objectName: "reviewAnswer"
                width: 220
                model: dlg.choices.map(c => ({ value: c, text: c }))
                enabled: dlg.item !== null
            }
            // An unsure read can also be typed as it really says (wins over the pick when not empty).
            UField {
                id: typed
                objectName: "reviewTyped"
                width: 200
                visible: dlg.item !== null && dlg.item.kind === "ocr-low"
                label: "Or type what it says"
                placeholderText: "Or type what it says"
            }
            UButton {
                objectName: "reviewConfirm"
                text: "Confirm"
                kind: "primary"
                enabled: dlg.item !== null && !dlg.busy
                onClicked: dlg.confirm(typed.visible && typed.text.trim() !== "" ? typed.text : answer.value)
            }
        }
        UButton {
            objectName: "reviewClose"
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            text: "Close"
            onClicked: dlg.close()
        }
    }
}
