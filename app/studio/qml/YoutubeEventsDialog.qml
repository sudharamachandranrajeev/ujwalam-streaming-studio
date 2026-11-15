// SPDX-License-Identifier: GPL-3.0-or-later
// YouTube event picker (flag youtube-events, D386): before each Go live, per YouTube output (H and V separately), pick a
// previous YouTube broadcast as the template and edit the title. The server (ui/api/youtube/*) keeps the choice; Go live
// makes the new event from it. The list of broadcasts is read when this window opens (it costs YouTube quota), never at
// app start. Nothing is typed to confirm and nothing asks "are you sure": Save is one click. Its own window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "youtubeEventsDlg"
    required property var store
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: Math.min(640, parent ? parent.width - 40 : 640)
    title: "YouTube event"
    closePolicy: Popup.CloseOnEscape

    readonly property bool flagOn: store.flags["youtube-events"] === true
    property bool loaded: false          // the events answer came
    property bool signedIn: false
    property var outputs: []             // [{ id, label, canvas, quality, choice }]
    property var templates: []           // [{ id, title, when, privacy, lifeCycle }]
    property bool busy: false
    property string errorText: ""        // why the list or a save failed, in the server's words
    property var drafts: ({})            // output id -> { templateId, title, note }
    property int gen: 0
    onClosed: gen++

    readonly property int maxTitle: 100
    readonly property var qualityWords: ({ "1080p": "1080p", "1440p": "2K", "2160p": "4K" })

    function show() {
        if (!flagOn) return false;
        gen++;
        loaded = false;
        errorText = "";
        templates = [];
        drafts = ({});
        open();
        load(false);
        return true;
    }

    function load(refresh) {
        const g = ++gen;
        busy = true;
        Api.get("ui/api/youtube/events", (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { busy = false; loaded = true; outputs = []; return fail(b, err) }
            signedIn = b.signedIn === true;
            takeOutputs(b.outputs);
            loaded = true;
            if (!signedIn || outputs.length === 0) { busy = false; return }
            Api.post("ui/api/youtube/templates", refresh ? { refresh: true } : {}, (ok2, t, err2) => {
                if (g !== gen) return;
                busy = false;
                if (!ok2) return fail(t, err2);
                errorText = "";
                templates = Array.isArray(t.templates) ? t.templates : [];
                syncDrafts();
            });
        });
    }
    function fail(b, err) { errorText = b && typeof b.message === "string" && b.message !== "" ? b.message : String(err) }

    function takeOutputs(list) {
        outputs = Array.isArray(list) ? list : [];
        const d = Object.assign({}, drafts);
        for (const o of outputs) {
            const c = o.choice;
            d[o.id] = { templateId: c ? c.templateId : null, title: c ? (c.title || c.templateTitle || "") : "" };
        }
        drafts = d;
    }
    function syncDrafts() { drafts = Object.assign({}, drafts) } // the boxes re-read after the templates came

    function draftOf(id) { return drafts[id] || ({ templateId: null, title: "" }) }
    function outputOf(id) { return outputs.find(o => o.id === id) || null }
    function templateOf(id) { return templates.find(t => t.id === id) || null }
    function qualityText(q) { return qualityWords[q] || String(q || "") }
    function rowTitle(o) { return o.label + (o.quality ? " · " + qualityText(o.quality) : "") }
    function dateText(w) {
        if (!w) return "";
        const d = new Date(w);
        return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    }
    // [{value, text}]: "Choose..." first, then the broadcasts (newest first). A saved template that fell out of the list
    // (older than the 25 shown) stays pickable under its saved title.
    function modelFor(o) {
        const m = [{ value: null, text: "Choose a previous broadcast" }];
        let seen = false;
        const cur = o.choice ? o.choice.templateId : null;
        for (const t of templates) {
            if (t.id === cur) seen = true;
            const dt = dateText(t.when);
            m.push({ value: t.id, text: t.title + (dt !== "" ? "  (" + dt + ")" : "") });
        }
        if (cur && !seen) m.splice(1, 0, { value: cur, text: o.choice.templateTitle + "  (saved)" });
        return m;
    }
    function indexFor(o) {
        const m = modelFor(o), id = draftOf(o.id).templateId;
        return Math.max(0, m.findIndex(x => x.value === id));
    }

    // Why Save is off ("" = it is on). The title rules are the server's: 1 to 100 characters, no < or >.
    function titleProblem(t) {
        const s = String(t);
        if (s.trim() === "") return "Type a title (1 to 100 characters).";
        if (s.length > maxTitle) return "The title is longer than 100 characters.";
        if (s.indexOf("<") >= 0 || s.indexOf(">") >= 0) return "The title cannot contain < or >.";
        return "";
    }
    function saveProblem(o) {
        if (busy) return "Wait for the list to load.";
        const d = draftOf(o.id);
        if (d.templateId === null) return o.choice ? "" : "Pick a previous broadcast first."; // none picked: Save clears a saved one
        return titleProblem(d.title);
    }
    function statusText(o) {
        const d = draftOf(o.id), c = o.choice;
        if (d.note) return d.note;
        if (!c) return "Not chosen. Go live will stop until you pick one.";
        const same = d.templateId === c.templateId && d.title === (c.title || c.templateTitle);
        return (same ? "Saved: " : "Not saved yet. Saved: ") + "\"" + c.title + "\", made from \"" + c.templateTitle + "\".";
    }

    function setDraft(id, patch) {
        const d = Object.assign({}, drafts);
        d[id] = Object.assign({}, draftOf(id), patch, { note: "" });
        drafts = d;
    }
    function pick(id, templateId) {
        const t = templateId === null ? null : templateOf(templateId);
        const o = outputOf(id);
        const savedTitle = o && o.choice && o.choice.templateId === templateId ? (o.choice.title || o.choice.templateTitle) : "";
        setDraft(id, { templateId: templateId, title: t ? (savedTitle !== "" ? savedTitle : String(t.title).slice(0, maxTitle)) : (savedTitle !== "" ? savedTitle : "") });
        return true;
    }
    function setTitle(id, text) { setDraft(id, { title: text }); return true }

    function save(id) {
        const o = outputOf(id);
        if (!o || saveProblem(o) !== "") return false;
        const d = draftOf(id), g = gen;
        busy = true;
        Api.post("ui/api/youtube/event/set", { output: id, templateId: d.templateId, title: d.templateId === null ? null : d.title }, (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) return fail(b, err);
            errorText = "";
            takeOutputs(b.outputs);
            store.say(d.templateId === null ? "YouTube event choice cleared." : "YouTube event saved.");
        });
        return true;
    }
    function refresh() { if (busy || !signedIn) return false; load(true); return true }

    // ---- probe (tests): yte-open, yte-refresh, yte-pick:<output>:<template id or none>, yte-title:<output>:<enc>, yte-save:<output>, yte-close ----
    function probe() {
        return {
            open: opened, flagOn: flagOn, loaded: loaded, signedIn: signedIn, busy: busy, error: errorText, templates: templates.length,
            rows: outputs.map(o => ({ id: o.id, label: rowTitle(o), template: draftOf(o.id).templateId, title: draftOf(o.id).title,
                saveEnabled: saveProblem(o) === "", why: saveProblem(o), status: statusText(o), choice: o.choice }))
        };
    }
    function probeAction(a) {
        if (a === "yte-open") return show();
        if (!opened) return false;
        const p = a.split(":");
        if (a === "yte-refresh") return refresh();
        if (a === "yte-close") { close(); return true }
        if (p[0] === "yte-pick") return outputOf(p[1]) !== null && pick(p[1], p[2] === "none" ? null : p[2]);
        if (p[0] === "yte-title") return outputOf(p[1]) !== null && setTitle(p[1], decodeURIComponent(p.slice(2).join(":")));
        if (p[0] === "yte-save") return save(p[1]);
        return false;
    }

    component Words: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
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
        Words { text: "Go live makes a new YouTube event for each YouTube output, copied from the broadcast you pick here, with the title you set." }
        Words {
            objectName: "yteSignin"
            visible: dlg.loaded && !dlg.signedIn
            color: Theme.c.danger
            text: "Not signed in to YouTube. Sign in under Settings > Connections > Sign in with YouTube."
        }
        Words {
            objectName: "yteError"
            visible: dlg.errorText !== ""
            color: Theme.c.danger
            text: dlg.errorText
        }
        Words { objectName: "yteLoading"; visible: dlg.busy; text: "Loading..." }
        Repeater {
            model: dlg.outputs
            delegate: UCard {
                id: row
                required property var modelData
                objectName: "yteRow:" + modelData.id
                title: dlg.rowTitle(modelData).toUpperCase()
                UCombo {
                    objectName: "yteTemplate:" + row.modelData.id
                    width: parent.width
                    label: "Template for " + row.modelData.label
                    enabled: !dlg.busy && dlg.signedIn
                    model: dlg.modelFor(row.modelData)
                    currentIndex: dlg.indexFor(row.modelData)
                    onChose: (v) => dlg.pick(row.modelData.id, v)
                }
                UField {
                    objectName: "yteTitle:" + row.modelData.id
                    width: parent.width
                    label: "Title for " + row.modelData.label
                    placeholderText: "Title"
                    enabled: dlg.draftOf(row.modelData.id).templateId !== null
                    text: dlg.draftOf(row.modelData.id).title
                    onTextEdited: dlg.setTitle(row.modelData.id, text)
                }
                Row {
                    spacing: 10
                    UButton {
                        objectName: "yteSave:" + row.modelData.id
                        text: "Save"
                        kind: "primary"
                        enabled: dlg.saveProblem(row.modelData) === ""
                        onClicked: dlg.save(row.modelData.id)
                    }
                    Text {
                        objectName: "yteWhy:" + row.modelData.id
                        visible: dlg.saveProblem(row.modelData) !== "" && !dlg.busy
                        anchors.verticalCenter: parent.verticalCenter
                        text: dlg.saveProblem(row.modelData)
                        color: Theme.c.danger
                        font.family: Theme.family
                        font.pixelSize: 13
                    }
                }
                Words { objectName: "yteStatus:" + row.modelData.id; text: dlg.statusText(row.modelData) }
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                objectName: "yteRefresh"
                text: "Refresh list"
                enabled: !dlg.busy && dlg.signedIn
                onClicked: dlg.refresh()
            }
            UButton {
                objectName: "yteClose"
                text: "Close"
                onClicked: dlg.close()
            }
        }
    }
}
