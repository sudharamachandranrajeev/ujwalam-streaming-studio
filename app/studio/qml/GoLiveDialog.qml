// SPDX-License-Identifier: GPL-3.0-or-later
// The Go live chooser (D389). Opens when Go live is pressed with a YouTube output switched on and YouTube signed in
// (Store.toggleStream reads ui/api/youtube/golive/options first; anything else goes straight to stream.start as before).
// One choice for the whole start: use an event on the channel, pick from past streams, a new stream like the last one,
// or set up a new stream (optionally with "Help me write it", local model only). Then one quality per YouTube output
// (a size without a stored key is greyed with "Add the key") and one Go live button. Go live posts ui/api/youtube/golive/prepare
// and then hands over to the unchanged stream.start path (readiness checks, refusals and toasts stay where they were).
// Cancel or Esc sends nothing. No typed phrase and no "are you sure" (D332). The last choice is pre-selected.
// Titles and descriptions from YouTube are untrusted: shown as plain text, never logged. Every route shape this file
// assumes is read in one place: ask() (options), prepareBody() (prepare), help() (suggest).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "goLiveDialog"
    required property var store
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: Math.min(900, parent ? parent.width - 40 : 900)
    height: Math.min(780, parent ? parent.height - 40 : 780)
    title: "Go live"
    closePolicy: Popup.CloseOnEscape

    // ---- state ----
    property var options: ({})           // golive/options
    property string mode: "last"         // existing | copy | last | new
    property var picks: ({})             // output id -> { size, broadcastId, templateId }
    property var fields: ({ title: "", description: "", privacy: "public", categoryId: "", tags: "", thumb: "" })
    property string hint: ""
    property bool busy: false
    property bool helping: false
    property string errorText: ""
    property string helpSource: ""       // "" | local-model | smart-fill
    property string helpNote: ""
    property var categories: []
    property var others: []              // plain names of the other switched-on outputs ("Twitch", "Kick")
    property int gen: 0

    readonly property var modes: [
        { id: "existing", title: "Use an event on your channel", text: "Go live in an upcoming or running YouTube event you already made.", icon: "flag" },
        { id: "copy", title: "Pick from your past streams", text: "Make a new event from one of your earlier streams.", icon: "folder" },
        { id: "last", title: "New stream like the last one", text: "Same title, description and picture as your latest stream.", icon: "redo" },
        { id: "new", title: "Set up a new stream", text: "Write the title and details yourself.", icon: "plus" }
    ]
    readonly property var active: (options.outputs || []).filter(o => o.on === true)
    readonly property var existing: Array.isArray(options.existing) ? options.existing : []
    readonly property var past: Array.isArray(options.past) ? options.past : []
    readonly property bool sizesUsable: options.setupInUse !== false
    readonly property var sizeWords: ({ "1080p": "1080p", "1440p": "1440p", "2160p": "4K" })

    // ---- helpers ----
    function safe(s) { return String(s === null || s === undefined ? "" : s).replace(/</g, "‹").replace(/>/g, "›") }
    function errText(b, err) { return b && typeof b.message === "string" && b.message !== "" ? b.message : (b && typeof b.detail === "string" && b.detail !== "" ? b.detail : "That did not work (" + String(err) + ").") }
    function dateText(w) {
        if (!w) return "";
        const d = new Date(w);
        return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    }
    function sizeWord(s) { return sizeWords[s] || String(s || "") }
    function mbps(kbps) { return typeof kbps === "number" ? (Math.round(kbps / 100) / 10) + " Mbps" : "" }
    function outName(o) { return "YouTube " + (o.orientation === "portrait" ? "portrait" : "landscape") }
    function outOf(id) { return active.find(o => o.id === id) || null }
    function sizeOf(id) { return picks[id] ? picks[id].size : "" }
    function pickOf(id) { return picks[id] || ({ size: "", broadcastId: null, templateId: null }) }
    function lastOf(id) { return options.last && options.last[id] ? options.last[id] : null }
    function inList(list, id) { return typeof id === "string" && list.some(x => x.id === id) ? id : null }
    function indexOfValue(m, v) { return Math.max(0, m.findIndex(x => x.value === v)) }
    function tagList(s) { return String(s).split(",").map(x => x.trim()).filter(x => x !== "") }
    function sizeEntry(o, size) { return (o.sizes || []).find(x => x.size === size) || null }
    function firstSize(o, want) {
        const ok = (s) => { const e = sizeEntry(o, s); return !!e && e.key === true };
        if (ok(want)) return want;
        if (ok(o.size)) return o.size;
        const f = (o.sizes || []).find(x => x.key === true);
        return f ? f.size : (o.size || "");
    }

    // ---- open ----
    function ask(o) {
        gen++;
        options = o && typeof o === "object" ? o : ({});
        errorText = ""; helpSource = ""; helpNote = ""; busy = false; helping = false; hint = "";
        const ch = options.choice && typeof options.choice === "object" ? options.choice : null;
        const co = ch && ch.outputs && typeof ch.outputs === "object" ? ch.outputs : ({});
        let m = ch ? (modes.some(x => x.id === ch.mode) ? ch.mode : "copy") : (past.length > 0 ? "last" : "new");
        if ((m === "copy" || m === "last") && past.length === 0) m = "new";
        if (m === "existing" && existing.length === 0) m = past.length > 0 ? "last" : "new";
        mode = m;
        const p = {};
        let f0 = null;
        for (const out of active) {
            const c = co[out.id] || ({});
            if (!f0 && c.fields && typeof c.fields === "object") f0 = c.fields;
            const last = lastOf(out.id);
            p[out.id] = {
                size: firstSize(out, c.size),
                broadcastId: inList(existing, c.broadcastId),
                templateId: inList(past, c.templateId) || (last && inList(past, last.id)) || (past.length > 0 ? past[0].id : null)
            };
        }
        picks = p;
        const f = f0 || ({});
        fields = {
            title: typeof f.title === "string" ? f.title : "", description: typeof f.description === "string" ? f.description : "",
            privacy: ["public", "unlisted", "private"].includes(f.privacy) ? f.privacy : "public",
            categoryId: f.categoryId ? String(f.categoryId) : "", tags: Array.isArray(f.tags) ? f.tags.join(", ") : "", thumb: ""
        };
        loadCategories();
        loadOthers();
        open();
        return true;
    }
    function loadCategories() {
        if (categories.length > 0) return;
        const g = gen;
        Api.get("ui/api/youtube/categories", (ok, b) => {
            if (g !== gen || !ok) return;
            categories = Array.isArray(b.categories) ? b.categories : [];
        });
    }
    // "...and on Twitch and Kick as usual": the other outputs switched on (best effort; the sentence is right without it)
    function loadOthers() {
        const g = gen;
        others = [];
        Api.get("ui/api/outputs/panel", (ok, b) => {
            if (g !== gen || !ok || !b || !Array.isArray(b.outputs)) return;
            others = b.outputs.filter(o => o.enabled === true && o.platform !== "youtube").map(o => String(o.name || o.id));
        });
    }

    // ---- choices ----
    function setMode(m) {
        if (!modes.some(x => x.id === m)) return false;
        mode = m; errorText = "";
        return true;
    }
    function setPick(id, patch) {
        if (!outOf(id)) return false;
        const p = Object.assign({}, picks);
        p[id] = Object.assign({}, pickOf(id), patch);
        picks = p; errorText = "";
        return true;
    }
    function setSize(id, size) {
        const o = outOf(id);
        const e = o ? sizeEntry(o, size) : null;
        if (!e || e.key !== true || !sizesUsable) return false;
        return setPick(id, { size: size });
    }
    function setField(patch) { fields = Object.assign({}, fields, patch); errorText = ""; return true }
    function addKey(id) {
        if (!outOf(id)) return false;
        close();
        store.connectionsWanted(id);
        return true;
    }
    function chooseThumb() {
        const p = Api.chooseImage("Choose a thumbnail (PNG or JPEG)");
        if (p === "") return false;
        return setField({ thumb: p });
    }

    // ---- checks: what stops Go live, said in plain words ----
    function fieldProblem() {
        const t = String(fields.title).trim();
        if (t === "") return "Type a title (1 to 100 characters).";
        if (t.length > 100) return "The title is longer than 100 characters.";
        if (/[<>]/.test(fields.title) || /[<>]/.test(fields.description) || /[<>]/.test(fields.tags)) return "The title, description and tags cannot contain < or >.";
        if (String(fields.description).length > 5000) return "The description is longer than 5000 characters.";
        if (tagList(fields.tags).length > 15) return "Use at most 15 tags.";
        return "";
    }
    function problem() {
        if (active.length === 0) return "Switch on a YouTube output first.";
        if (sizesUsable) {
            for (const o of active) {
                const e = sizeEntry(o, sizeOf(o.id));
                if (e && e.key !== true) return outName(o) + " has no stream key for " + sizeWord(e.size) + " yet. Add the key, or pick another size.";
            }
        }
        if (mode === "existing") {
            const seen = {};
            for (const o of active) {
                const id = pickOf(o.id).broadcastId;
                if (!id) return "Pick an event for " + outName(o) + ".";
                const ev = existing.find(x => x.id === id);
                if (ev && ev.boundToOther === true) return "'" + safe(ev.title) + "' is already on air with another stream, so it cannot be used. Pick another event.";
                if (seen[id]) return "Landscape and portrait cannot use the same event. Pick a different event for " + outName(o) + ".";
                seen[id] = true;
            }
        } else if (mode === "copy") {
            for (const o of active) if (!pickOf(o.id).templateId) return past.length === 0 ? "You have no earlier streams to copy yet. Pick another way." : "Pick a past stream for " + outName(o) + ".";
        } else if (mode === "last") {
            if (past.length === 0) return "You have no earlier streams to copy yet. Pick another way.";
        } else if (mode === "new") {
            return fieldProblem();
        }
        return "";
    }
    function titleOfEvent(id) { const e = existing.find(x => x.id === id); return e ? safe(e.title) : "" }
    function titleOfPast(id) { const e = past.find(x => x.id === id); return e ? safe(e.title) : "" }
    function listWords(a) { return a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1] }
    function summaryText() {
        if (active.length === 0) return "";
        const where = listWords(active.map(o => outName(o) + (sizesUsable && sizeOf(o.id) !== "" ? " in " + sizeWord(sizeOf(o.id)) : "")));
        let into = "";
        if (mode === "existing") into = " into " + listWords(active.map(o => "'" + titleOfEvent(pickOf(o.id).broadcastId) + "'"));
        else if (mode === "copy") into = " as a new event made from " + listWords(active.map(o => "'" + titleOfPast(pickOf(o.id).templateId) + "'"));
        else if (mode === "last") { const l = lastOf(active[0].id) || past[0]; into = " as a new event like " + (l ? "'" + safe(l.title) + "'" : "your last stream") }
        else into = " as a new event '" + safe(String(fields.title).trim()) + "'";
        return "Goes live on " + where + into + (others.length > 0 ? ", and on " + listWords(others) + " as usual." : ".");
    }

    // ---- the call ----
    // The prepare body: { mode, outputs: { <output>: { size, broadcastId | templateId | fields } } } (contract 2026-11-15).
    function prepareBody() {
        const outs = {};
        for (const o of active) {
            const pk = pickOf(o.id);
            const e = {};
            if (sizesUsable && pk.size !== "") e.size = pk.size;
            if (mode === "existing") e.broadcastId = pk.broadcastId;
            else if (mode === "copy") e.templateId = pk.templateId;
            else if (mode === "new") {
                const f = { title: String(fields.title).trim(), description: String(fields.description), privacy: fields.privacy, tags: tagList(fields.tags) };
                if (fields.categoryId !== "") f.categoryId = fields.categoryId;
                if (fields.thumb !== "") f.thumbnail = fields.thumb;
                e.fields = f;
            }
            outs[o.id] = e;
        }
        return { mode: mode, outputs: outs };
    }
    function go() {
        if (busy || !opened || problem() !== "") return false;
        busy = true;
        errorText = "";
        const g = gen;
        Api.post("ui/api/youtube/golive/prepare", prepareBody(), (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) { errorText = errText(b, err); return }
            if (b && Array.isArray(b.missingKeys) && b.missingKeys.length > 0) { errorText = "A stream key is missing for a size you picked. Add it in Settings > Connections."; return }
            if (b && (b.ok === false || b.ready === false)) { errorText = typeof b.detail === "string" && b.detail !== "" ? b.detail : "That could not be set up. Check the choices and try again."; return }
            close();
            store.startPrepared();
        });
        return true;
    }
    // "Help me write it": title, description and tags from the local model (or smart fill from earlier streams).
    function help() {
        if (helping || !opened) return false;
        helping = true; helpNote = "";
        const g = gen;
        const req = {};
        if (active.length > 0) req.output = active[0].id;
        const h = hint.trim().slice(0, 200);
        if (h !== "") req.hint = h;
        Api.post("ui/api/youtube/golive/suggest", req, (ok, b, err) => {
            if (g !== gen) return;
            helping = false;
            if (!ok) { helpNote = errText(b, err); return }
            setField({ title: String(b.title || "").slice(0, 100), description: String(b.description || "").slice(0, 5000),
                       tags: Array.isArray(b.tags) ? b.tags.join(", ") : fields.tags });
            helpSource = b.source === "local-model" ? "local-model" : "smart-fill";
        });
        return true;
    }
    function sourceText() {
        if (helpSource === "local-model") return "Written by the model on this PC. Change anything you like.";
        if (helpSource === "smart-fill") return "Filled in from your earlier streams (the model on this PC was not running). Change anything you like.";
        return "";
    }
    onClosed: { gen++; busy = false; helping = false }

    // ---- probe (tests) ----
    function probe() {
        return {
            open: opened, mode: mode, busy: busy, helping: helping, error: errorText, problem: problem(), summary: summaryText(),
            goEnabled: goBtn.enabled, active: active.map(o => o.id),
            outputs: active.map(o => ({ id: o.id, size: sizeOf(o.id), sizes: (o.sizes || []).map(s => ({ size: s.size, key: s.key === true })) })),
            picks: picks, fields: fields, hint: hint, helpSource: helpSource, helpNote: helpNote, categories: categories.length,
            events: existing.map(e => e.id), past: past.map(e => e.id), others: others
        };
    }
    function probeAction(a) {
        if (a === "gl-open") return false;
        if (!opened) return false;
        const p = a.split(":");
        const dec = (i) => decodeURIComponent(p.slice(i).join(":"));
        if (p[0] === "gl-mode") return setMode(p[1]);
        if (p[0] === "gl-size") return setSize(p[1], p[2]);
        if (p[0] === "gl-event") return outOf(p[1]) !== null && setPick(p[1], { broadcastId: inList(existing, p[2]) });
        if (p[0] === "gl-past") return outOf(p[1]) !== null && setPick(p[1], { templateId: inList(past, p[2]) });
        if (p[0] === "gl-title") return setField({ title: dec(1) });
        if (p[0] === "gl-desc") return setField({ description: dec(1) });
        if (p[0] === "gl-tags") return setField({ tags: dec(1) });
        if (p[0] === "gl-privacy") return setField({ privacy: p[1] });
        if (p[0] === "gl-category") return setField({ categoryId: p[1] === "none" ? "" : p[1] });
        if (p[0] === "gl-thumb") return setField({ thumb: dec(1) });
        if (p[0] === "gl-hint") { hint = dec(1); return true }
        if (a === "gl-help") return help();
        if (a === "gl-go") return go();
        if (a === "gl-cancel") { close(); return true }
        return false;
    }

    // ---- look ----
    component Words: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }
    component Heading: Text {
        width: parent ? parent.width : 0
        textFormat: Text.PlainText
        elide: Text.ElideRight
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: Theme.ty.body
        font.weight: Font.DemiBold
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: "Go live on YouTube"
        padding: Theme.sp.l
        bottomPadding: Theme.sp.s
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: Theme.ty.subtitle
        font.weight: Font.DemiBold
    }
    contentItem: Item {
        id: root
        Keys.onReturnPressed: dlg.go()
        Keys.onEnterPressed: dlg.go()

        Flow {
            id: modeRow
            objectName: "glModes"
            anchors { left: parent.left; right: parent.right; top: parent.top }
            spacing: Theme.sp.m
            readonly property int cols: width >= 720 ? 4 : 2
            Repeater {
                model: dlg.modes
                delegate: Button {
                    id: mc
                    required property var modelData
                    objectName: "glMode:" + modelData.id
                    readonly property bool chosen: dlg.mode === modelData.id
                    width: Math.floor((modeRow.width - modeRow.spacing * (modeRow.cols - 1)) / modeRow.cols)
                    height: 104
                    hoverEnabled: true
                    focusPolicy: Qt.StrongFocus
                    Accessible.name: modelData.title
                    onClicked: dlg.setMode(modelData.id)
                    background: Rectangle {
                        radius: Theme.radiusMedium
                        color: mc.chosen || mc.hovered ? Theme.c.field : Theme.c.panel
                        border.width: mc.chosen ? 2 : 1
                        border.color: mc.chosen || mc.visualFocus ? Theme.c.accent : Theme.c.border
                    }
                    contentItem: Item {
                        Image {
                            id: ic
                            anchors { left: parent.left; top: parent.top; leftMargin: Theme.sp.xs; topMargin: 2 }
                            width: 18
                            height: 18
                            source: Theme.icon(mc.modelData.icon, mc.chosen ? "accentHi" : "text", 18)
                        }
                        Text {
                            anchors { left: ic.right; leftMargin: Theme.sp.s; right: parent.right; verticalCenter: ic.verticalCenter }
                            text: mc.modelData.title
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            color: Theme.c.text
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.body
                            font.weight: Font.DemiBold
                        }
                        Text {
                            anchors { left: parent.left; right: parent.right; top: ic.bottom; bottom: parent.bottom; leftMargin: Theme.sp.xs; topMargin: Theme.sp.s }
                            text: mc.modelData.text
                            textFormat: Text.PlainText
                            wrapMode: Text.Wrap
                            elide: Text.ElideRight
                            color: Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.small
                        }
                    }
                }
            }
        }

        Flickable {
            id: scroll
            objectName: "glScroll"
            anchors { left: parent.left; right: parent.right; top: modeRow.bottom; bottom: tail.top; topMargin: Theme.sp.m; bottomMargin: Theme.sp.s }
            clip: true
            contentWidth: width
            contentHeight: body.implicitHeight
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            Column {
                id: body
                width: scroll.width - 12
                spacing: Theme.sp.m

                // existing: one event per output
                Column {
                    objectName: "glExistingBox"
                    visible: dlg.mode === "existing"
                    width: parent.width
                    spacing: Theme.sp.m
                    Words { visible: dlg.existing.length === 0; objectName: "glNoEvents"; text: "No upcoming or running events found on your channel. Make one in YouTube Studio, or pick another way above." }
                    Repeater {
                        model: dlg.existing.length > 0 ? dlg.active : []
                        delegate: Column {
                            id: ex
                            required property var modelData
                            width: parent.width
                            spacing: Theme.sp.xs
                            Heading { text: "Event for " + dlg.outName(ex.modelData) }
                            UCombo {
                                objectName: "glEvent:" + ex.modelData.id
                                width: parent.width
                                label: "Event for " + dlg.outName(ex.modelData)
                                model: [{ value: null, text: "Choose an event" }].concat(dlg.existing.map(e => ({ value: e.id,
                                    text: dlg.safe(e.title) + "  (" + (e.lifeCycle === "live" ? "on air now" : dlg.dateText(e.when)) + (e.boundToOther === true ? ", on another stream" : "") + ")" })))
                                currentIndex: dlg.indexOfValue(model, dlg.pickOf(ex.modelData.id).broadcastId)
                                onChose: (v) => dlg.setPick(ex.modelData.id, { broadcastId: v })
                            }
                        }
                    }
                }

                // copy: one past stream per output
                Column {
                    objectName: "glCopyBox"
                    visible: dlg.mode === "copy"
                    width: parent.width
                    spacing: Theme.sp.m
                    Words { visible: dlg.past.length === 0; text: "You have no earlier streams to copy yet. Pick another way above." }
                    Repeater {
                        model: dlg.past.length > 0 ? dlg.active : []
                        delegate: Column {
                            id: cp
                            required property var modelData
                            width: parent.width
                            spacing: Theme.sp.xs
                            Heading { text: "Copy from, for " + dlg.outName(cp.modelData) }
                            UCombo {
                                objectName: "glPast:" + cp.modelData.id
                                width: parent.width
                                label: "Past stream for " + dlg.outName(cp.modelData)
                                model: [{ value: null, text: "Choose a past stream" }].concat(dlg.past.map(e => ({ value: e.id, text: dlg.safe(e.title) + "  (" + dlg.dateText(e.when) + ")" })))
                                currentIndex: dlg.indexOfValue(model, dlg.pickOf(cp.modelData.id).templateId)
                                onChose: (v) => dlg.setPick(cp.modelData.id, { templateId: v })
                            }
                        }
                    }
                }

                // last: a plain line per output
                Column {
                    objectName: "glLastBox"
                    visible: dlg.mode === "last"
                    width: parent.width
                    spacing: Theme.sp.s
                    Words { visible: dlg.past.length === 0; text: "You have no earlier streams to copy yet. Pick another way above." }
                    Repeater {
                        model: dlg.past.length > 0 ? dlg.active : []
                        delegate: Text {
                            id: ls
                            required property var modelData
                            readonly property var l: dlg.lastOf(modelData.id) || dlg.past[0]
                            objectName: "glLast:" + modelData.id
                            width: parent.width
                            wrapMode: Text.Wrap
                            textFormat: Text.PlainText
                            color: Theme.c.text
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.body
                            text: dlg.outName(modelData) + ": a new event like '" + dlg.safe(l ? l.title : "") + "'" + (l && dlg.dateText(l.when) !== "" ? " (" + dlg.dateText(l.when) + ")" : "")
                                  + ". The title, description, privacy, category, tags and picture are copied."
                        }
                    }
                }

                // new: the form
                Column {
                    objectName: "glNewBox"
                    visible: dlg.mode === "new"
                    width: parent.width
                    spacing: Theme.sp.s
                    Row {
                        spacing: Theme.sp.m
                        UField {
                            objectName: "glHint"
                            width: Math.max(180, body.width - helpBtn.width - 10)
                            label: "What is the stream about"
                            placeholderText: "What is the stream about? (optional, helps the writing)"
                            maximumLength: 200
                            text: dlg.hint
                            onTextEdited: dlg.hint = text
                        }
                        UButton {
                            id: helpBtn
                            objectName: "glHelp"
                            text: dlg.helping ? "Writing..." : "Help me write it"
                            enabled: !dlg.helping && !dlg.busy
                            onClicked: dlg.help()
                        }
                    }
                    Words { objectName: "glHelpSource"; visible: text !== ""; text: dlg.helpNote !== "" ? dlg.helpNote : dlg.sourceText(); color: dlg.helpNote !== "" ? Theme.c.danger : Theme.c.muted }
                    UField {
                        objectName: "glTitle"
                        width: parent.width
                        label: "Title"
                        placeholderText: "Title"
                        text: dlg.fields.title
                        onTextEdited: dlg.setField({ title: text })
                        onAccepted: dlg.go()
                    }
                    UField {
                        objectName: "glDesc"
                        width: parent.width
                        label: "Description"
                        placeholderText: "Description"
                        text: dlg.fields.description
                        onTextEdited: dlg.setField({ description: text })
                        onAccepted: dlg.go()
                    }
                    Row {
                        spacing: Theme.sp.m
                        UCombo {
                            objectName: "glPrivacy"
                            width: Math.floor((body.width - 10) / 2)
                            label: "Privacy"
                            model: [{ value: "public", text: "Public" }, { value: "unlisted", text: "Unlisted" }, { value: "private", text: "Private" }]
                            currentIndex: dlg.indexOfValue(model, dlg.fields.privacy)
                            onChose: (v) => dlg.setField({ privacy: v })
                        }
                        UCombo {
                            objectName: "glCategory"
                            width: Math.floor((body.width - 10) / 2)
                            label: "Category"
                            model: [{ value: "", text: "Category: not set" }].concat(dlg.categories.map(c => ({ value: String(c.id), text: dlg.safe(c.title) })))
                            currentIndex: dlg.indexOfValue(model, dlg.fields.categoryId)
                            onChose: (v) => dlg.setField({ categoryId: v })
                        }
                    }
                    UField {
                        objectName: "glTags"
                        width: parent.width
                        label: "Tags"
                        placeholderText: "Tags, separated by commas"
                        text: dlg.fields.tags
                        onTextEdited: dlg.setField({ tags: text })
                        onAccepted: dlg.go()
                    }
                    Row {
                        spacing: Theme.sp.m
                        UButton { objectName: "glThumb"; text: "Choose a picture"; onClicked: dlg.chooseThumb() }
                        Text {
                            objectName: "glThumbName"
                            anchors.verticalCenter: parent.verticalCenter
                            width: Math.max(0, body.width - 160)
                            textFormat: Text.PlainText
                            elide: Text.ElideMiddle
                            color: Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.small
                            text: dlg.fields.thumb !== "" ? dlg.fields.thumb : "No picture chosen (PNG or JPEG, up to 2 MB)."
                        }
                    }
                }

                // quality: one row per YouTube output
                Heading { text: "Quality" }
                Words { objectName: "glQualityOff"; visible: !dlg.sizesUsable; text: "The video quality follows your current settings. Choosing a size here needs Settings > Stream to be switched on." }
                Repeater {
                    model: dlg.sizesUsable ? dlg.active : []
                    delegate: Column {
                        id: ql
                        required property var modelData
                        objectName: "glQuality:" + modelData.id
                        width: body.width
                        spacing: Theme.sp.s
                        Text {
                            width: parent.width
                            text: dlg.outName(ql.modelData)
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            color: Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.small
                        }
                        Flow {
                            width: parent.width
                            spacing: Theme.sp.m
                            Repeater {
                                model: ql.modelData.sizes || []
                                delegate: Column {
                                    id: tile
                                    required property var modelData
                                    readonly property bool has: modelData.key === true
                                    spacing: Theme.sp.xs
                                    UButton {
                                        objectName: "glSize:" + ql.modelData.id + ":" + tile.modelData.size
                                        width: 110
                                        text: dlg.sizeWord(tile.modelData.size)
                                        kind: dlg.sizeOf(ql.modelData.id) === tile.modelData.size ? "primary" : "normal"
                                        enabled: tile.has
                                        onClicked: dlg.setSize(ql.modelData.id, tile.modelData.size)
                                    }
                                    Text {
                                        visible: tile.has
                                        width: 110
                                        horizontalAlignment: Text.AlignHCenter
                                        text: dlg.mbps(tile.modelData.bitrateKbps)
                                        color: Theme.c.muted
                                        font.family: Theme.family
                                        font.pixelSize: Theme.ty.caption
                                    }
                                    UButton {
                                        objectName: "glAddKey:" + ql.modelData.id + ":" + tile.modelData.size
                                        visible: !tile.has
                                        width: 110
                                        text: "Add the key"
                                        onClicked: dlg.addKey(ql.modelData.id)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Column {
            id: tail
            anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
            spacing: Theme.sp.s
            Text {
                objectName: "glSummary"
                width: parent.width
                wrapMode: Text.Wrap
                maximumLineCount: 3
                elide: Text.ElideRight
                textFormat: Text.PlainText
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: Theme.ty.body
                text: dlg.summaryText()
            }
            Text {
                objectName: "glProblem"
                width: parent.width
                wrapMode: Text.Wrap
                textFormat: Text.PlainText
                visible: text !== ""
                color: Theme.c.danger
                font.family: Theme.family
                font.pixelSize: Theme.ty.small
                text: dlg.errorText !== "" ? dlg.errorText : dlg.problem()
            }
        }
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            spacing: Theme.sp.m
            UButton {
                objectName: "glCancel"
                text: "Cancel"
                onClicked: dlg.close()
            }
            UButton {
                id: goBtn
                objectName: "glGo"
                text: dlg.busy ? "Getting ready..." : "Go live"
                kind: "primary"
                enabled: !dlg.busy && dlg.problem() === ""
                onClicked: dlg.go()
                Keys.onReturnPressed: dlg.go()
            }
        }
    }
}
