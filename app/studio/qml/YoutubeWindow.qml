// SPDX-License-Identifier: GPL-3.0-or-later
// The YouTube window (D388): quality presets, the event (template and details), live status, live chat and past streams,
// in one window with five tabs. It replaces the D386 event picker dialog (the picker is the Event tab now). No feature
// flag: the button on the On Air bar is always there. Everything that writes to YouTube happens on a click (D332): no typed
// phrase, no "are you sure". A preset used while live is saved and applies at the next Go live (the server says so).
// Chat text, authors and broadcast titles are untrusted: shown as plain text only (textFormat PlainText), kept in memory
// only (the last 200 per output), never logged, never written anywhere. Polls: the live status every 30 s (only while
// live and the tab is shown), the chat every 3 s (only while the tab is shown). Its own window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "youtubeWindow"
    required property var store
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    width: Math.min(940, parent ? parent.width - 40 : 940)
    height: Math.min(700, parent ? parent.height - 40 : 700)
    title: "YouTube"
    closePolicy: Popup.CloseOnEscape

    // ---- state ----
    property string tab: "presets"       // presets | event | live | chat | streams
    property var account: ({ signedIn: false, canSignIn: true })
    property bool accountLoaded: false
    property bool signingIn: false
    property int signinTicks: 0
    property string errorText: ""
    property bool busy: false
    property int gen: 0
    onClosed: { gen++; signingIn = false }

    readonly property bool signedIn: account.signedIn === true
    readonly property var qualityWords: ({ "1080p": "1080p", "1440p": "2K", "2160p": "4K" })
    readonly property var tabs: [{ id: "presets", text: "Presets" }, { id: "event", text: "Event" }, { id: "live", text: "Live" },
                                 { id: "chat", text: "Chat" }, { id: "streams", text: "Streams" }]
    readonly property int pollLiveMs: 30000
    readonly property int pollChatMs: 3000

    // presets
    property bool presetsLoaded: false
    property var presets: []
    property string activeId: ""
    property var sizes: ({})
    property var limits: ({})
    property var keys: ({})
    property bool setupInUse: true
    property var useAnswer: null         // the last preset/use answer
    property string useText: ""
    property var missingKeys: []
    property bool editing: false
    property var draft: ({ id: null, name: "", outputs: ({}) })
    // event
    property var events: ({ outputs: [] })
    property bool eventsLoaded: false
    property bool autoEvent: true
    property var templates: []
    property var categories: []
    property var drafts: ({})            // output id -> the Event tab's boxes
    // live
    property var liveOuts: []
    property bool liveLoaded: false
    property string liveNote: ""
    property string watched: ""          // the last link opened (tests read it; in hidden test mode nothing opens)
    // chat
    property string chatOutput: ""
    property var chatMsgs: ({})          // output id -> [{ id, author, text, kind, amount }], newest last, at most 200
    property var chatCursor: ({})
    property bool chatLive: false
    property bool chatBusy: false
    property bool chatSending: false
    property string chatText: ""
    property string chatNote: ""
    // streams
    property string filter: "all"
    property var items: []
    property var nextToken: null
    property var pageStack: []           // tokens of the pages before this one ("" = the first)
    property string pageToken: ""
    property bool streamsLoaded: false
    property string streamsNote: ""
    property string streamBusyId: ""

    // ---- small helpers ----
    function errText(b, err) { return b && typeof b.message === "string" && b.message !== "" ? b.message : String(err) }
    function errCode(b, err) { return b && typeof b.error === "string" ? b.error : String(err) }
    function fail(b, err) { errorText = errText(b, err) }
    // Titles from YouTube are shown as plain text; a stray angle bracket is swapped for a look-alike so no markup can form.
    function safe(s) { return String(s === null || s === undefined ? "" : s).replace(/</g, "‹").replace(/>/g, "›") }
    function qualityText(q) { return qualityWords[q] || String(q || "") }
    function dateText(w) {
        if (!w) return "";
        const d = new Date(w);
        return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    }
    function outLabel(id) {
        const o = (events.outputs || []).find(x => x.id === id);
        if (o && o.label) return String(o.label);
        return /-v$/.test(String(id)) ? "YouTube V" : "YouTube H";
    }
    readonly property var outputIds: {
        const ids = Object.keys(sizes || {});
        return ids.length > 0 ? ids : ["youtube-h", "youtube-v"];
    }
    function shown() { return opened && signedIn }

    function show(t) {
        gen++;
        if (t && tabs.some(x => x.id === t)) tab = t;
        errorText = "";
        open();
        loadAccount();
        return true;
    }
    function setTab(t) {
        if (!tabs.some(x => x.id === t)) return false;
        tab = t;
        if (signedIn) loadTab(t);
        return true;
    }
    function loadAccount() {
        const g = ++gen;
        Api.get("ui/api/youtube/account", (ok, b, err) => {
            if (g !== gen) return;
            accountLoaded = true;
            if (!ok) { account = ({ signedIn: false, canSignIn: false }); return fail(b, err) }
            account = b;
            if (signedIn) { signingIn = false; loadTab(tab) }
        });
    }
    function loadTab(t) {
        if (t === "presets") loadPresets();
        else if (t === "event") { loadEvents(); loadCategories(); if (store.live) pollLive() }
        else if (t === "live") { if (store.live) pollLive() }
        else if (t === "chat") ensureEvents(() => pollChat());
        else if (t === "streams") loadStreams(false);
    }
    function signIn() {
        if (signingIn) return false;
        const g = gen;
        signingIn = true;
        signinTicks = 0;
        Api.post("ui/api/youtube/signin", {}, (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { signingIn = false; return fail(b, err) }
            errorText = "";
        });
        return true;
    }
    Timer {
        interval: 3000
        repeat: true
        running: dlg.opened && dlg.signingIn
        onTriggered: { dlg.signinTicks++; if (dlg.signinTicks > 40) dlg.signingIn = false; else dlg.loadAccount() }
    }

    // ---- presets ----
    function loadPresets() {
        const g = gen;
        busy = true;
        Api.get("ui/api/youtube/presets", (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) return fail(b, err);
            errorText = "";
            takePresets(b);
            presetsLoaded = true;
        });
    }
    function takePresets(b) {
        if (Array.isArray(b.presets)) presets = b.presets;
        if (b.activeId !== undefined) activeId = b.activeId ? String(b.activeId) : "";
        if (b.sizes) sizes = b.sizes;
        if (b.limits) limits = b.limits;
        if (b.keys) keys = b.keys;
        if (typeof b.setupInUse === "boolean") setupInUse = b.setupInUse;
    }
    function keyPresent(o, size) { return !!(keys[o] && keys[o][size] === true) }
    function limitOf(o, size) {
        const l = limits[o] && limits[o][size] ? limits[o][size] : null;
        return l && typeof l.min === "number" ? l : ({ min: 500, max: 60000, default: 6000 });
    }
    function sizeList(o) { return Array.isArray(sizes[o]) ? sizes[o] : [] }
    function presetLine(p, o) {
        const c = p.outputs ? p.outputs[o] : null;
        if (!c) return outLabel(o) + ": not set";
        if (c.enabled === false) return outLabel(o) + ": off";
        return outLabel(o) + ": " + qualityText(c.size) + ", " + c.bitrateKbps + " kbps, template \"" + safe(c.templateTitle || "none") + "\"";
    }
    function appliesWords(a) {
        if (a === "now") return "Applied now.";
        if (a === "next-go-live") return "Saved. It applies at the next Go live.";
        if (a === "next-start") return "Saved. It applies at the next start.";
        if (a === "not-used") return "Only the templates were set.";
        return "";
    }
    function usePreset(id) {
        if (busy || !presets.some(p => p.id === id)) return false;
        const g = gen;
        busy = true;
        Api.post("ui/api/youtube/preset/use", { id: id }, (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) { useAnswer = null; useText = ""; missingKeys = []; return fail(b, err) }
            errorText = "";
            useAnswer = b;
            activeId = b.activeId ? String(b.activeId) : id;
            missingKeys = Array.isArray(b.missingKeys) ? b.missingKeys.map(String) : [];
            const hasDetail = typeof b.detail === "string" && b.detail !== "";
            const parts = [b.appliesAt === "not-used" && hasDetail ? "" : appliesWords(b.appliesAt)];
            if (hasDetail) parts.push(b.detail);
            useText = parts.filter(x => x !== "").join(" ");
            if (b.events && Array.isArray(b.events.outputs)) takeOutputs(b.events);
        });
        return true;
    }
    function missingWords() {
        if (missingKeys.length === 0) return "";
        return "No stream key stored for: " + missingKeys.join(", ") + ". Set it in Settings > Connections. Go live refuses that output until then.";
    }
    function deletePreset(id) {
        if (busy || !presets.some(p => p.id === id)) return false;
        const g = gen;
        busy = true;
        Api.post("ui/api/youtube/preset/delete", { id: id }, (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) return fail(b, err);
            errorText = "";
            takePresets(b);
            if (editing && draft.id === id) editing = false;
        });
        return true;
    }
    function blankOut(o) {
        const list = sizeList(o);
        const size = list.indexOf("1080p") >= 0 ? "1080p" : (list.length ? String(list[0]) : "1080p");
        return { enabled: true, size: size, bitrateKbps: limitOf(o, size).default, templateId: null, templateTitle: "", title: null };
    }
    function newPreset() {
        const outs = {};
        for (const o of outputIds) outs[o] = blankOut(o);
        draft = { id: null, name: "", outputs: outs };
        editing = true;
        ensureTemplates();
        return true;
    }
    function editPreset(id) {
        const p = presets.find(x => x.id === id);
        if (!p) return false;
        const outs = {};
        for (const o of outputIds) outs[o] = Object.assign(blankOut(o), p.outputs ? p.outputs[o] : {});
        draft = { id: p.id, name: String(p.name || ""), outputs: outs };
        editing = true;
        ensureTemplates();
        return true;
    }
    function setDraftName(t) { draft = Object.assign({}, draft, { name: t }); return true }
    function setDraftOut(o, patch) {
        if (!editing || outputIds.indexOf(o) < 0) return false;
        const outs = Object.assign({}, draft.outputs);
        const cur = Object.assign({}, outs[o], patch);
        const l = limitOf(o, cur.size);
        if (patch.size !== undefined && patch.bitrateKbps === undefined) cur.bitrateKbps = l.default; // a new size starts at its own default
        outs[o] = cur;
        draft = Object.assign({}, draft, { outputs: outs });
        return true;
    }
    function pickDraftTemplate(o, tid) {
        const t = tid === null ? null : templates.find(x => x.id === tid);
        if (tid !== null && !t && !(draft.outputs[o] && draft.outputs[o].templateId === tid)) return false;
        return setDraftOut(o, { templateId: tid, templateTitle: t ? String(t.title) : (tid === null ? "" : draft.outputs[o].templateTitle) });
    }
    function presetProblem() {
        const n = String(draft.name).trim();
        if (n === "") return "Type a name (1 to 40 characters).";
        if (String(draft.name).length > 40) return "The name is longer than 40 characters.";
        if (n.indexOf("<") >= 0 || n.indexOf(">") >= 0) return "The name cannot contain < or >.";
        if (!draft.id && presets.length >= 12) return "There are 12 presets already. Delete one first.";
        for (const o of outputIds) {
            const c = draft.outputs[o];
            if (!c || c.enabled === false) continue;
            const l = limitOf(o, c.size);
            if (c.bitrateKbps < l.min || c.bitrateKbps > l.max) return outLabel(o) + ": the bitrate must be " + l.min + " to " + l.max + " kbps.";
        }
        return "";
    }
    function savePreset() {
        if (busy || !editing || presetProblem() !== "") return false;
        const g = gen;
        const outs = {};
        for (const o of outputIds) {
            const c = draft.outputs[o];
            outs[o] = { enabled: c.enabled !== false, size: c.size, bitrateKbps: Math.round(c.bitrateKbps), templateId: c.templateId, templateTitle: c.templateTitle, title: c.title === undefined ? null : c.title };
        }
        const preset = { name: String(draft.name).trim(), outputs: outs };
        if (draft.id) preset.id = draft.id;
        busy = true;
        Api.post("ui/api/youtube/preset/save", { preset: preset }, (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) return fail(b, err);
            errorText = "";
            takePresets(b);
            editing = false;
            store.say("YouTube preset saved.");
        });
        return true;
    }
    function ensureTemplates() {
        if (templates.length > 0 || !signedIn) return;
        const g = gen;
        Api.post("ui/api/youtube/templates", {}, (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) return fail(b, err);
            templates = Array.isArray(b.templates) ? b.templates : [];
            drafts = Object.assign({}, drafts); // the boxes re-read after the templates came
            draft = Object.assign({}, draft);
        });
    }
    // [{value, text}] for a template box: "none" first, then the broadcasts; a saved one that fell out of the list stays.
    function templateModel(curId, curTitle, noneText) {
        const m = [{ value: null, text: noneText }];
        let seen = false;
        for (const t of templates) {
            if (t.id === curId) seen = true;
            const dt = dateText(t.when);
            m.push({ value: t.id, text: safe(t.title) + (dt !== "" ? "  (" + dt + ")" : "") });
        }
        if (curId && !seen) m.splice(1, 0, { value: curId, text: safe(curTitle) + "  (saved)" });
        return m;
    }
    function indexOfValue(m, v) { return Math.max(0, m.findIndex(x => x.value === v)) }

    // ---- event ----
    function ensureEvents(then) {
        if (eventsLoaded) { if (then) then(); return }
        loadEvents(then);
    }
    function loadEvents(then) {
        const g = gen;
        busy = true;
        Api.get("ui/api/youtube/events", (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { busy = false; return fail(b, err) }
            errorText = "";
            takeOutputs(b);
            eventsLoaded = true;
            if (then) then();
            Api.post("ui/api/youtube/templates", {}, (ok2, t, err2) => {
                if (g !== gen) return;
                busy = false;
                if (!ok2) return fail(t, err2);
                templates = Array.isArray(t.templates) ? t.templates : [];
                drafts = Object.assign({}, drafts);
            });
        });
    }
    function loadCategories() {
        if (categories.length > 0) return;
        const g = gen;
        Api.get("ui/api/youtube/categories", (ok, b) => {
            if (g !== gen || !ok) return;
            categories = Array.isArray(b.categories) ? b.categories : [];
        });
    }
    function takeOutputs(b) {
        events = b && Array.isArray(b.outputs) ? b : events;
        if (b && typeof b.autoEvent === "boolean") autoEvent = b.autoEvent;
        const d = Object.assign({}, drafts);
        for (const o of (events.outputs || [])) {
            const c = o.choice;
            const old = d[o.id];
            if (old && old.dirty) continue;
            d[o.id] = {
                templateId: c ? c.templateId : null,
                title: c ? (c.title || c.templateTitle || "") : "",
                description: c && typeof c.description === "string" ? c.description : "",
                privacy: c && typeof c.privacy === "string" ? c.privacy : "",
                tags: c && Array.isArray(c.tags) ? c.tags.join(", ") : "",
                categoryId: c && c.categoryId ? String(c.categoryId) : "",
                thumb: old ? old.thumb : "", note: "", dirty: false
            };
        }
        drafts = d;
    }
    function setAuto(on) {
        const g = gen;
        Api.post("ui/api/youtube/event/auto", { on: on === true }, (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { fail(b, err); autoSwitch.checked = autoEvent; return }
            errorText = "";
            autoEvent = b && typeof b.autoEvent === "boolean" ? b.autoEvent : on === true;
            autoSwitch.checked = autoEvent;
        });
        return true;
    }
    function eventOf(id) { return (events.outputs || []).find(o => o.id === id) || null }
    function draftOf(id) { return drafts[id] || ({ templateId: null, title: "", description: "", privacy: "", tags: "", categoryId: "", thumb: "", note: "", dirty: false }) }
    function setDraft(id, patch) {
        const d = Object.assign({}, drafts);
        d[id] = Object.assign({}, draftOf(id), patch, { note: "", dirty: true });
        drafts = d;
        return true;
    }
    // The running event of an output (while it is live), from the live answer.
    function liveOf(id) {
        if (!store.live) return null;
        return liveOuts.find(o => o.output === id && typeof o.broadcastId === "string" && o.broadcastId !== "") || null;
    }
    function editingLive(id) { return liveOf(id) !== null }
    function titleProblem(t) {
        const s = String(t);
        if (s.trim() === "") return "Type a title (1 to 100 characters).";
        if (s.length > 100) return "The title is longer than 100 characters.";
        if (s.indexOf("<") >= 0 || s.indexOf(">") >= 0) return "The title cannot contain < or >.";
        return "";
    }
    function tagList(s) { return String(s).split(",").map(x => x.trim()).filter(x => x !== "") }
    function detailsProblem(d) {
        if (String(d.description).length > 5000) return "The description is longer than 5000 characters.";
        const tl = tagList(d.tags);
        if (tl.length > 30) return "Use at most 30 tags.";
        for (const t of tl) {
            if (t.length > 100) return "A tag is longer than 100 characters.";
            if (t.indexOf("<") >= 0 || t.indexOf(">") >= 0) return "Tags cannot contain < or >.";
        }
        return "";
    }
    function saveProblem(o) {
        if (busy) return "Wait for the list to load.";
        const d = draftOf(o.id);
        const dp = detailsProblem(d);
        if (dp !== "") return dp;
        if (editingLive(o.id)) {
            if (String(d.title).trim() !== "") { const tp = titleProblem(d.title); if (tp !== "") return tp }
            return "";
        }
        if (d.templateId === null) return o.choice ? "" : "Pick a previous broadcast first.";
        return titleProblem(d.title);
    }
    function statusText(o) {
        const d = draftOf(o.id), c = o.choice, lv = liveOf(o.id);
        if (d.note) return d.note;
        if (lv) return "Live now. Saving changes the running event on YouTube.";
        if (!c) return autoEvent ? "Not chosen. Go live will stop until you pick one." : "No event will be made at Go live (the new event switch is off).";
        const same = d.templateId === c.templateId && d.title === (c.title || c.templateTitle);
        return (same ? "Saved: " : "Not saved yet. Saved: ") + "\"" + safe(c.title) + "\", made from \"" + safe(c.templateTitle) + "\".";
    }
    function saveEvent(id) {
        const o = eventOf(id);
        if (!o || saveProblem(o) !== "") return false;
        const d = draftOf(id), g = gen, lv = liveOf(id);
        const body = lv ? { broadcastId: lv.broadcastId } : { output: id, templateId: d.templateId, title: d.templateId === null ? null : d.title };
        if (lv && String(d.title).trim() !== "") body.title = d.title;
        if (String(d.description) !== "" && (lv || d.templateId !== null)) body.description = d.description;
        if (d.privacy !== "" && (lv || d.templateId !== null)) body.privacy = d.privacy;
        if (tagList(d.tags).length > 0 && (lv || d.templateId !== null)) body.tags = tagList(d.tags);
        if (d.categoryId !== "" && (lv || d.templateId !== null)) body.categoryId = d.categoryId;
        busy = true;
        Api.post(lv ? "ui/api/youtube/details" : "ui/api/youtube/event/set", body, (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) return fail(b, err);
            errorText = "";
            if (lv) {
                const w = b && Array.isArray(b.warnings) && b.warnings.length ? " " + b.warnings.map(String).join(" ") : "";
                setNote(id, "The running event was updated." + w);
                store.say("YouTube event updated.");
            } else {
                takeOutputs(b);
                const d2 = Object.assign({}, drafts);
                if (d2[id]) d2[id] = Object.assign({}, d2[id], { dirty: false });
                drafts = d2;
                store.say(d.templateId === null ? "YouTube event choice cleared." : "YouTube event saved.");
            }
        });
        return true;
    }
    function setNote(id, text) {
        const d = Object.assign({}, drafts);
        d[id] = Object.assign({}, draftOf(id), { note: text });
        drafts = d;
    }
    function thumbProblem(id) {
        if (!editingLive(id)) return "A thumbnail can be set once the event exists, after Go live.";
        if (String(draftOf(id).thumb) === "") return "Choose a picture first (PNG or JPEG, up to 2 MB).";
        return "";
    }
    function chooseThumb(id) {
        const p = Api.chooseImage("Choose a thumbnail (PNG or JPEG)");
        if (p === "") return false;
        const d = Object.assign({}, drafts);
        d[id] = Object.assign({}, draftOf(id), { thumb: p, note: "" });
        drafts = d;
        return true;
    }
    function setThumbPath(id, p) {
        const d = Object.assign({}, drafts);
        d[id] = Object.assign({}, draftOf(id), { thumb: p, note: "" });
        drafts = d;
        return true;
    }
    function setThumb(id) {
        const lv = liveOf(id);
        if (!lv || thumbProblem(id) !== "") return false;
        const g = gen;
        busy = true;
        Api.post("ui/api/youtube/thumbnail", { broadcastId: lv.broadcastId, path: draftOf(id).thumb }, (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) return fail(b, err);
            errorText = "";
            setNote(id, "The thumbnail was set.");
        });
        return true;
    }

    // ---- live ----
    function pollLive() {
        if (!signedIn) return false;
        const g = gen;
        Api.get("ui/api/youtube/live", (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { liveNote = errText(b, err); return }
            liveNote = "";
            liveOuts = Array.isArray(b.outputs) ? b.outputs : [];
            liveLoaded = true;
            // The running event's title fills a title box nobody has touched.
            const d = Object.assign({}, drafts);
            for (const lo of liveOuts) {
                if (d[lo.output] && !d[lo.output].dirty && typeof lo.title === "string") d[lo.output] = Object.assign({}, d[lo.output], { title: lo.title });
            }
            drafts = d;
        });
        return true;
    }
    function healthWords(h) {
        const s = h ? h.status : null;
        return s === "good" ? "Good" : s === "ok" ? "OK" : s === "bad" ? "Bad" : s === "noData" ? "No data yet" : "Unknown";
    }
    function healthColor(h) {
        const s = h ? h.status : null;
        return s === "good" ? Theme.c.ok : s === "ok" ? Theme.c.accent : s === "bad" ? Theme.c.danger : Theme.c.muted;
    }
    function num(x) { return typeof x === "number" ? String(Math.trunc(x)) : "-" }
    function watchLink(id) { return /^[A-Za-z0-9_-]{1,64}$/.test(String(id)) ? "https://www.youtube.com/watch?v=" + id : "" }
    function openWatch(id) {
        const u = watchLink(id);
        if (u === "") return false;
        watched = u;
        if (!studioHidden) Qt.openUrlExternally(u); // tests (hidden mode): the link is checked, never opened
        return true;
    }
    Connections {
        target: dlg.store
        function onLiveChanged() {
            if (!dlg.shown()) return;
            if (dlg.store.live) { if (dlg.tab === "live" || dlg.tab === "event") dlg.pollLive() }
            else { dlg.liveOuts = []; dlg.liveLoaded = false }
        }
    }
    Timer {
        id: liveTimer
        interval: dlg.pollLiveMs
        repeat: true
        running: dlg.opened && dlg.signedIn && dlg.tab === "live" && dlg.store.live
        onTriggered: dlg.pollLive()
    }

    // ---- chat ----
    function chatList() { return chatMsgs[chatOutput] || [] }
    function chooseChatOutput(id) {
        if (!(events.outputs || []).some(o => o.id === id)) return false;
        chatOutput = id;
        chatNote = "";
        pollChat();
        return true;
    }
    function pollChat() {
        if (!signedIn) return false;
        if (chatOutput === "" && (events.outputs || []).length > 0) chatOutput = events.outputs[0].id;
        if (chatOutput === "" || chatBusy) return false;
        const g = gen, o = chatOutput;
        const after = chatCursor[o] ? "&after=" + encodeURIComponent(chatCursor[o]) : "";
        chatBusy = true;
        Api.get("ui/api/youtube/chat?output=" + encodeURIComponent(o) + after, (ok, b, err) => {
            chatBusy = false;
            if (g !== gen) return;
            if (!ok) { chatNote = errText(b, err); return }
            chatNote = "";
            chatLive = b.live === true;
            if (typeof b.cursor === "string") { const c = Object.assign({}, chatCursor); c[o] = b.cursor; chatCursor = c }
            const incoming = Array.isArray(b.messages) ? b.messages : [];
            if (incoming.length === 0) return;
            const have = chatMsgs[o] ? chatMsgs[o].slice() : [];
            const ids = new Set(have.map(m => m.id));
            for (const m of incoming) {
                const id = String(m.id);
                if (ids.has(id)) continue;
                ids.add(id);
                have.push({ id: id, author: String(m.author || ""), text: String(m.text || ""), kind: String(m.kind || "text"), amount: m.amount === undefined || m.amount === null ? "" : String(m.amount) });
            }
            const all = Object.assign({}, chatMsgs);
            all[o] = have.slice(-200);
            chatMsgs = all;
        });
        return true;
    }
    function sendProblem() {
        const t = chatText.trim();
        if (chatSending) return "Sending...";
        if (t === "") return "Type a message.";
        if (chatText.length > 200) return "A message is at most 200 characters.";
        return "";
    }
    function sendChat() {
        if (sendProblem() !== "" || chatOutput === "") return false;
        const g = gen, o = chatOutput, text = chatText.trim();
        chatSending = true;
        Api.post("ui/api/youtube/chat/send", { output: o, text: text }, (ok, b, err) => {
            chatSending = false;
            if (g !== gen) return;
            if (!ok) { chatNote = errText(b, err); return }
            chatNote = "";
            if (chatText.trim() === text) chatText = "";
            pollChat();
        });
        return true;
    }
    Timer {
        id: chatTimer
        interval: dlg.pollChatMs
        repeat: true
        running: dlg.opened && dlg.signedIn && dlg.tab === "chat"
        onTriggered: dlg.pollChat()
    }

    // ---- streams ----
    function loadStreams(refresh) {
        if (!signedIn) return false;
        const g = gen;
        busy = true;
        const page = pageToken !== "" ? "&page=" + encodeURIComponent(pageToken) : "";
        Api.get("ui/api/youtube/broadcasts?status=" + filter + page, (ok, b, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) return fail(b, err);
            errorText = "";
            items = Array.isArray(b.items) ? b.items : [];
            nextToken = b.next ? String(b.next) : null;
            streamsLoaded = true;
        });
        return true;
    }
    function setFilter(f) {
        if (["all", "upcoming", "active", "completed"].indexOf(f) < 0) return false;
        filter = f;
        pageToken = "";
        pageStack = [];
        streamsNote = "";
        return loadStreams(false);
    }
    function nextPage() {
        if (!nextToken) return false;
        pageStack = pageStack.concat([pageToken]);
        pageToken = nextToken;
        return loadStreams(false);
    }
    function prevPage() {
        if (pageStack.length === 0) return false;
        pageToken = pageStack[pageStack.length - 1];
        pageStack = pageStack.slice(0, -1);
        return loadStreams(false);
    }
    function outputForCanvas(c) {
        const o = (events.outputs || []).find(x => String(x.canvas).toUpperCase() === c);
        return o ? o.id : (c === "H" ? "youtube-h" : "youtube-v");
    }
    function useAsTemplate(id, canvas) {
        const it = items.find(x => x.id === id);
        if (!it || streamBusyId !== "") return false;
        const g = gen, o = outputForCanvas(canvas);
        streamBusyId = id;
        Api.post("ui/api/youtube/event/set", { output: o, templateId: id, title: String(it.title || "").slice(0, 100) }, (ok, b, err) => {
            streamBusyId = "";
            if (g !== gen) return;
            if (!ok) { streamsNote = errText(b, err); return }
            takeOutputs(b);
            streamsNote = "\"" + safe(it.title) + "\" is now the " + canvas + " template. Edit the title in the Event tab.";
        });
        return true;
    }
    function streamRefusal(b, err) {
        if (errCode(b, err).indexOf("output-live") >= 0)
            return "That event is on air in an output that is streaming. End the stream first, then End or Delete the event.";
        return errText(b, err);
    }
    function endStream(id) {
        const it = items.find(x => x.id === id);
        if (!it || streamBusyId !== "" || it.lifeCycle === "complete") return false;
        const g = gen;
        streamBusyId = id;
        Api.post("ui/api/youtube/broadcast/end", { id: id }, (ok, b, err) => {
            streamBusyId = "";
            if (g !== gen) return;
            if (!ok) { streamsNote = streamRefusal(b, err); return }
            streamsNote = "The event was ended.";
            loadStreams(true);
        });
        return true;
    }
    function deleteStream(id) {
        if (!items.some(x => x.id === id) || streamBusyId !== "") return false;
        const g = gen;
        streamBusyId = id;
        Api.post("ui/api/youtube/broadcast/delete", { id: id }, (ok, b, err) => {
            streamBusyId = "";
            if (g !== gen) return;
            if (!ok) { streamsNote = streamRefusal(b, err); return }
            streamsNote = "The event was deleted.";
            items = items.filter(x => x.id !== id);
            loadStreams(true);
        });
        return true;
    }

    // ---- probe (tests) ----
    // yt-open[:<tab>], yt-close, yt-tab:<tab>, yt-signin,
    // presets: yt-preset-use:<id>, yt-preset-new, yt-preset-edit:<id>, yt-preset-delete:<id>, yt-preset-name:<enc>,
    //   yt-preset-size:<output>:<size>, yt-preset-bitrate:<output>:<kbps>, yt-preset-on:<output>:<on|off>,
    //   yt-preset-tpl:<output>:<id|none>, yt-preset-save, yt-preset-cancel
    // event: yt-auto:<on|off>, yt-pick:<output>:<id|none>, yt-title|yt-desc|yt-tags:<output>:<enc>, yt-privacy:<output>:<v|none>,
    //   yt-category:<output>:<id|none>, yt-save:<output>, yt-thumb:<output>:<enc path>, yt-thumb-set:<output>
    // live: yt-live-refresh, yt-watch:<output>; chat: yt-chat-output:<id>, yt-chat-text:<enc>, yt-chat-send;
    // timers: yt-tick:<live|chat>; streams: yt-filter:<f>, yt-page:<next|prev>, yt-stream-template:<id>:<H|V>,
    //   yt-stream-end:<id>, yt-stream-delete:<id>
    function probe() {
        const ch = chatList();
        let first = null;
        const kids = chatList_.contentItem.children;
        for (let i = 0; i < kids.length; i++) if (kids[i].plainOk !== undefined) { first = kids[i]; break }
        return {
            open: opened, tab: tab, accountLoaded: accountLoaded, signedIn: signedIn, canSignIn: account.canSignIn !== false, signingIn: signingIn,
            error: errorText, busy: busy, liveTimer: liveTimer.running, chatTimer: chatTimer.running,
            presets: presets.map(p => ({ id: p.id, name: p.name, active: p.id === activeId, h: presetLine(p, "youtube-h"), v: presetLine(p, "youtube-v") })),
            activeId: activeId, setupInUse: setupInUse, useText: useText, missingKeys: missingKeys, missingText: missingWords(),
            editing: editing, draft: editing ? draft : null, presetWhy: editing ? presetProblem() : "",
            autoEvent: autoEvent, templates: templates.length, categories: categories.length,
            rows: (events.outputs || []).map(o => ({ id: o.id, label: o.label, template: draftOf(o.id).templateId, title: draftOf(o.id).title,
                description: draftOf(o.id).description, privacy: draftOf(o.id).privacy, tags: draftOf(o.id).tags, categoryId: draftOf(o.id).categoryId,
                thumb: draftOf(o.id).thumb, saveEnabled: saveProblem(o) === "", why: saveProblem(o), status: statusText(o), live: editingLive(o.id),
                thumbEnabled: thumbProblem(o.id) === "" })),
            live: liveOuts.map(o => ({ output: o.output, title: o.title, health: healthWords(o.health), viewers: num(o.viewers), likes: num(o.likes), link: watchLink(o.broadcastId) })),
            liveLoaded: liveLoaded, liveNote: liveNote, watched: watched,
            chat: { output: chatOutput, count: ch.length, live: chatLive, messages: ch.map(m => ({ id: m.id, author: m.author, text: m.text, kind: m.kind })),
                    text: chatText, sendWhy: sendProblem(), note: chatNote, plain: first ? first.plainOk === true : null },
            streams: { filter: filter, items: items.map(i => ({ id: i.id, title: i.title, lifeCycle: i.lifeCycle, current: i.current === true })), next: nextToken, hasPrev: pageStack.length > 0,
                       note: streamsNote, busyId: streamBusyId }
        };
    }
    function probeAction(a) {
        if (a === "yt-open") return show();
        if (a.startsWith("yt-open:")) return show(a.slice(8));
        if (!opened) return false;
        const p = a.split(":");
        const dec = (i) => decodeURIComponent(p.slice(i).join(":"));
        const none = (v) => v === "none" ? null : v;
        if (a === "yt-close") { close(); return true }
        if (p[0] === "yt-tab") return setTab(p[1]);
        if (a === "yt-signin") return signIn();
        if (p[0] === "yt-preset-use") return usePreset(p[1]);
        if (a === "yt-preset-new") return newPreset();
        if (p[0] === "yt-preset-edit") return editPreset(p[1]);
        if (p[0] === "yt-preset-delete") return deletePreset(p[1]);
        if (p[0] === "yt-preset-name") return editing && setDraftName(dec(1));
        if (p[0] === "yt-preset-size") return setDraftOut(p[1], { size: p[2] });
        if (p[0] === "yt-preset-bitrate") return setDraftOut(p[1], { bitrateKbps: parseInt(p[2], 10) });
        if (p[0] === "yt-preset-on") return setDraftOut(p[1], { enabled: p[2] === "on" });
        if (p[0] === "yt-preset-tpl") return pickDraftTemplate(p[1], none(p[2]));
        if (a === "yt-preset-save") return savePreset();
        if (a === "yt-preset-cancel") { editing = false; return true }
        if (a === "yt-auto:on" || a === "yt-auto:off") { autoSwitch.checked = p[1] === "on"; return setAuto(p[1] === "on") }
        if (p[0] === "yt-pick") return eventOf(p[1]) !== null && pickEvent(p[1], none(p[2]));
        if (p[0] === "yt-title") return eventOf(p[1]) !== null && setDraft(p[1], { title: dec(2) });
        if (p[0] === "yt-desc") return eventOf(p[1]) !== null && setDraft(p[1], { description: dec(2) });
        if (p[0] === "yt-tags") return eventOf(p[1]) !== null && setDraft(p[1], { tags: dec(2) });
        if (p[0] === "yt-privacy") return eventOf(p[1]) !== null && setDraft(p[1], { privacy: p[2] === "none" ? "" : p[2] });
        if (p[0] === "yt-category") return eventOf(p[1]) !== null && setDraft(p[1], { categoryId: p[2] === "none" ? "" : p[2] });
        if (p[0] === "yt-save") return saveEvent(p[1]);
        if (p[0] === "yt-thumb") return eventOf(p[1]) !== null && setThumbPath(p[1], dec(2));
        if (p[0] === "yt-thumb-set") return setThumb(p[1]);
        if (a === "yt-live-refresh") return store.live && pollLive();
        if (p[0] === "yt-watch") { const lo = liveOuts.find(o => o.output === p[1]); return !!lo && openWatch(lo.broadcastId) }
        if (p[0] === "yt-chat-output") return chooseChatOutput(p[1]);
        if (p[0] === "yt-chat-text") { chatText = dec(1); return true }
        if (a === "yt-chat-send") return sendChat();
        if (a === "yt-tick:live") return liveTimer.running && (pollLive(), true);
        if (a === "yt-tick:chat") return chatTimer.running && (pollChat(), true);
        if (p[0] === "yt-filter") return setFilter(p[1]);
        if (p[0] === "yt-page") return p[1] === "next" ? nextPage() : prevPage();
        if (p[0] === "yt-stream-template") return useAsTemplate(p[1], p[2]);
        if (p[0] === "yt-stream-end") return endStream(p[1]);
        if (p[0] === "yt-stream-delete") return deleteStream(p[1]);
        return false;
    }
    function pickEvent(id, templateId) {
        const t = templateId === null ? null : templates.find(x => x.id === templateId);
        const o = eventOf(id);
        if (templateId !== null && !t) return false;
        const savedTitle = o && o.choice && o.choice.templateId === templateId ? (o.choice.title || o.choice.templateTitle) : "";
        return setDraft(id, { templateId: templateId, title: t ? (savedTitle !== "" ? savedTitle : String(t.title).slice(0, 100)) : savedTitle });
    }

    // ---- look ----
    component Words: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
    }
    component Scroller: Flickable {
        default property alias content: col.data
        clip: true
        contentHeight: col.implicitHeight + 12
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Column {
            id: col
            width: parent.width - 14
            spacing: 10
        }
    }
    component KeyDot: Row {
        property bool present: false
        property string label: ""
        spacing: 6
        Rectangle { width: 10; height: 10; radius: 5; anchors.verticalCenter: parent.verticalCenter; color: parent.present ? Theme.c.ok : Theme.c.danger }
        Text {
            text: parent.label + (parent.present ? ": key set" : ": no key for this size")
            textFormat: Text.PlainText
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
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
    contentItem: Item {
        Row {
            id: tabRow
            anchors { left: parent.left; top: parent.top }
            spacing: 8
            Repeater {
                model: dlg.tabs
                delegate: UButton {
                    required property var modelData
                    objectName: "ytTab:" + modelData.id
                    text: modelData.text
                    kind: dlg.tab === modelData.id ? "primary" : "normal"
                    onClicked: dlg.setTab(modelData.id)
                }
            }
        }
        Column {
            id: head
            anchors { left: parent.left; right: parent.right; top: tabRow.bottom; topMargin: 10 }
            spacing: 8
            Row {
                objectName: "ytSignin"
                visible: dlg.accountLoaded && !dlg.signedIn
                spacing: 12
                UButton {
                    objectName: "ytSigninBtn"
                    text: "Sign in with YouTube"
                    kind: "primary"
                    enabled: dlg.account.canSignIn !== false && !dlg.signingIn
                    onClicked: dlg.signIn()
                }
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 13
                    text: dlg.signingIn ? "Finish the sign-in in your browser. This window updates when it is done." : "Not signed in to YouTube."
                }
            }
            Words { objectName: "ytChannel"; visible: dlg.signedIn && text !== ""; text: dlg.account.channelTitle ? "Signed in as " + dlg.account.channelTitle : "" }
            Words { objectName: "ytError"; visible: dlg.errorText !== ""; color: Theme.c.danger; text: dlg.errorText }
        }
        Item {
            id: pages
            anchors { left: parent.left; right: parent.right; top: head.bottom; bottom: parent.bottom; topMargin: 8 }
            visible: dlg.signedIn

            // ===== Presets =====
            Scroller {
                objectName: "ytPagePresets"
                anchors.fill: parent
                visible: dlg.tab === "presets"
                Words { objectName: "ytSetupOff"; visible: dlg.presetsLoaded && !dlg.setupInUse; text: "Sizes and bitrates are used once Settings > Stream is on." }
                Words { objectName: "ytUseText"; visible: dlg.useText !== ""; color: Theme.c.text; text: dlg.useText }
                Words { objectName: "ytMissingKeys"; visible: dlg.missingKeys.length > 0; color: Theme.c.danger; text: dlg.missingWords() }
                Words { objectName: "ytNoPresets"; visible: dlg.presetsLoaded && dlg.presets.length === 0; text: "No presets yet. Click New preset." }
                Repeater {
                    model: dlg.presets
                    delegate: UCard {
                        id: pc
                        required property var modelData
                        objectName: "ytPreset:" + modelData.id
                        title: String(modelData.name).toUpperCase() + (modelData.id === dlg.activeId ? "   IN USE" : "")
                        Words { objectName: "ytPresetH:" + pc.modelData.id; color: Theme.c.text; text: dlg.presetLine(pc.modelData, "youtube-h") }
                        Words { objectName: "ytPresetV:" + pc.modelData.id; color: Theme.c.text; text: dlg.presetLine(pc.modelData, "youtube-v") }
                        Row {
                            spacing: 18
                            Repeater {
                                model: dlg.outputIds
                                delegate: KeyDot {
                                    required property string modelData
                                    readonly property var c: pc.modelData.outputs ? pc.modelData.outputs[modelData] : null
                                    visible: c !== null && c !== undefined && c.enabled !== false
                                    label: dlg.outLabel(modelData)
                                    present: c ? dlg.keyPresent(modelData, c.size) : false
                                }
                            }
                        }
                        Row {
                            spacing: 10
                            UButton { objectName: "ytUse:" + pc.modelData.id; text: "Use"; kind: "primary"; enabled: !dlg.busy; onClicked: dlg.usePreset(pc.modelData.id) }
                            UButton { objectName: "ytEdit:" + pc.modelData.id; text: "Edit"; onClicked: dlg.editPreset(pc.modelData.id) }
                            UButton { objectName: "ytDelete:" + pc.modelData.id; text: "Delete"; kind: "danger"; enabled: !dlg.busy; onClicked: dlg.deletePreset(pc.modelData.id) }
                        }
                    }
                }
                UButton { objectName: "ytNew"; text: "New preset"; visible: !dlg.editing; enabled: dlg.presetsLoaded; onClicked: dlg.newPreset() }
                UCard {
                    objectName: "ytEditor"
                    visible: dlg.editing
                    title: dlg.draft.id ? "EDIT PRESET" : "NEW PRESET"
                    UField {
                        objectName: "ytPresetName"
                        width: parent.width
                        label: "Preset name"
                        placeholderText: "Name"
                        maximumLength: 40
                        text: dlg.draft.name
                        onTextEdited: dlg.setDraftName(text)
                    }
                    Repeater {
                        model: dlg.outputIds
                        delegate: Column {
                            id: oc
                            required property string modelData
                            readonly property var c: dlg.draft.outputs && dlg.draft.outputs[modelData] ? dlg.draft.outputs[modelData] : null
                            readonly property var lim: c ? dlg.limitOf(modelData, c.size) : ({ min: 0, max: 1, default: 0 })
                            width: parent.width
                            spacing: 8
                            visible: c !== null
                            USwitch {
                                objectName: "ytPresetOn:" + oc.modelData
                                text: dlg.outLabel(oc.modelData) + " on"
                                checked: oc.c ? oc.c.enabled !== false : false
                                onToggled: dlg.setDraftOut(oc.modelData, { enabled: checked })
                            }
                            UCombo {
                                objectName: "ytPresetSize:" + oc.modelData
                                width: parent.width
                                label: "Size for " + dlg.outLabel(oc.modelData)
                                enabled: oc.c ? oc.c.enabled !== false : false
                                model: dlg.sizeList(oc.modelData).map(s => ({ value: s, text: dlg.qualityText(s) }))
                                currentIndex: oc.c ? dlg.indexOfValue(model, oc.c.size) : 0
                                onChose: (v) => dlg.setDraftOut(oc.modelData, { size: v })
                            }
                            Words { color: Theme.c.text; text: "Bitrate: " + (oc.c ? Math.round(oc.c.bitrateKbps) : 0) + " kbps (allowed " + oc.lim.min + " to " + oc.lim.max + ")" }
                            USlider {
                                objectName: "ytPresetBitrate:" + oc.modelData
                                width: parent.width
                                enabled: oc.c ? oc.c.enabled !== false : false
                                from: oc.lim.min
                                to: oc.lim.max
                                stepSize: 250
                                value: oc.c ? oc.c.bitrateKbps : oc.lim.default
                                onMoved: dlg.setDraftOut(oc.modelData, { bitrateKbps: Math.round(value) })
                            }
                            UCombo {
                                objectName: "ytPresetTpl:" + oc.modelData
                                width: parent.width
                                label: "Template for " + dlg.outLabel(oc.modelData)
                                enabled: oc.c ? oc.c.enabled !== false : false
                                model: dlg.templateModel(oc.c ? oc.c.templateId : null, oc.c ? oc.c.templateTitle : "", "No template")
                                currentIndex: oc.c ? dlg.indexOfValue(model, oc.c.templateId) : 0
                                onChose: (v) => dlg.pickDraftTemplate(oc.modelData, v)
                            }
                            KeyDot {
                                label: dlg.outLabel(oc.modelData)
                                present: oc.c ? dlg.keyPresent(oc.modelData, oc.c.size) : false
                            }
                        }
                    }
                    Words { objectName: "ytPresetWhy"; visible: dlg.presetProblem() !== ""; color: Theme.c.danger; text: dlg.presetProblem() }
                    Row {
                        spacing: 10
                        UButton { objectName: "ytPresetSave"; text: "Save preset"; kind: "primary"; enabled: !dlg.busy && dlg.presetProblem() === ""; onClicked: dlg.savePreset() }
                        UButton { objectName: "ytPresetCancel"; text: "Cancel"; onClicked: dlg.editing = false }
                    }
                }
            }

            // ===== Event =====
            Scroller {
                objectName: "ytPageEvent"
                anchors.fill: parent
                visible: dlg.tab === "event"
                USwitch {
                    id: autoSwitch
                    objectName: "ytAuto"
                    width: parent.width
                    text: "New YouTube event at every Go live"
                    hint: "Off: Go live streams to your keys and makes no event, as before."
                    checked: dlg.autoEvent
                    onToggled: dlg.setAuto(checked)
                }
                Words { visible: dlg.store.live; color: Theme.c.text; text: "You are live: Save changes the running event on YouTube." }
                Repeater {
                    model: dlg.events.outputs || []
                    delegate: UCard {
                        id: ec
                        required property var modelData
                        objectName: "ytEventRow:" + modelData.id
                        title: (String(modelData.label || modelData.id) + (modelData.quality ? " · " + dlg.qualityText(modelData.quality) : "")).toUpperCase()
                        UCombo {
                            objectName: "ytTemplate:" + ec.modelData.id
                            width: parent.width
                            label: "Template for " + ec.modelData.label
                            enabled: !dlg.busy && !dlg.editingLive(ec.modelData.id)
                            model: dlg.templateModel(dlg.draftOf(ec.modelData.id).templateId, ec.modelData.choice ? ec.modelData.choice.templateTitle : "", "Choose a previous broadcast")
                            currentIndex: dlg.indexOfValue(model, dlg.draftOf(ec.modelData.id).templateId)
                            onChose: (v) => dlg.pickEvent(ec.modelData.id, v)
                        }
                        UField {
                            objectName: "ytTitle:" + ec.modelData.id
                            width: parent.width
                            label: "Title for " + ec.modelData.label
                            placeholderText: "Title"
                            enabled: dlg.draftOf(ec.modelData.id).templateId !== null || dlg.editingLive(ec.modelData.id)
                            text: dlg.draftOf(ec.modelData.id).title
                            onTextEdited: dlg.setDraft(ec.modelData.id, { title: text })
                        }
                        UField {
                            objectName: "ytDesc:" + ec.modelData.id
                            width: parent.width
                            label: "Description for " + ec.modelData.label
                            placeholderText: "Description (empty = from the template)"
                            enabled: dlg.draftOf(ec.modelData.id).templateId !== null || dlg.editingLive(ec.modelData.id)
                            text: dlg.draftOf(ec.modelData.id).description
                            onTextEdited: dlg.setDraft(ec.modelData.id, { description: text })
                        }
                        UCombo {
                            objectName: "ytPrivacy:" + ec.modelData.id
                            width: parent.width
                            label: "Privacy for " + ec.modelData.label
                            enabled: dlg.draftOf(ec.modelData.id).templateId !== null || dlg.editingLive(ec.modelData.id)
                            model: [{ value: "", text: "Privacy: from the template" }, { value: "public", text: "Public" }, { value: "unlisted", text: "Unlisted" }, { value: "private", text: "Private" }]
                            currentIndex: dlg.indexOfValue(model, dlg.draftOf(ec.modelData.id).privacy)
                            onChose: (v) => dlg.setDraft(ec.modelData.id, { privacy: v })
                        }
                        UField {
                            objectName: "ytTags:" + ec.modelData.id
                            width: parent.width
                            label: "Tags for " + ec.modelData.label
                            placeholderText: "Tags, separated by commas (empty = from the template)"
                            enabled: dlg.draftOf(ec.modelData.id).templateId !== null || dlg.editingLive(ec.modelData.id)
                            text: dlg.draftOf(ec.modelData.id).tags
                            onTextEdited: dlg.setDraft(ec.modelData.id, { tags: text })
                        }
                        UCombo {
                            objectName: "ytCategory:" + ec.modelData.id
                            width: parent.width
                            label: "Category for " + ec.modelData.label
                            enabled: dlg.draftOf(ec.modelData.id).templateId !== null || dlg.editingLive(ec.modelData.id)
                            model: [{ value: "", text: "Category: from the template" }].concat(dlg.categories.map(c => ({ value: String(c.id), text: dlg.safe(c.title) })))
                            currentIndex: dlg.indexOfValue(model, dlg.draftOf(ec.modelData.id).categoryId)
                            onChose: (v) => dlg.setDraft(ec.modelData.id, { categoryId: v })
                        }
                        Row {
                            spacing: 10
                            UButton {
                                objectName: "ytSaveEvent:" + ec.modelData.id
                                text: dlg.editingLive(ec.modelData.id) ? "Save to the running event" : "Save"
                                kind: "primary"
                                enabled: dlg.saveProblem(ec.modelData) === ""
                                onClicked: dlg.saveEvent(ec.modelData.id)
                            }
                            Text {
                                objectName: "ytWhy:" + ec.modelData.id
                                visible: dlg.saveProblem(ec.modelData) !== "" && !dlg.busy
                                anchors.verticalCenter: parent.verticalCenter
                                textFormat: Text.PlainText
                                text: dlg.saveProblem(ec.modelData)
                                color: Theme.c.danger
                                font.family: Theme.family
                                font.pixelSize: 13
                            }
                        }
                        Row {
                            spacing: 10
                            UButton {
                                objectName: "ytThumbPick:" + ec.modelData.id
                                text: "Choose thumbnail..."
                                enabled: dlg.editingLive(ec.modelData.id)
                                onClicked: dlg.chooseThumb(ec.modelData.id)
                            }
                            UButton {
                                objectName: "ytThumbSet:" + ec.modelData.id
                                text: "Set thumbnail"
                                enabled: dlg.thumbProblem(ec.modelData.id) === ""
                                onClicked: dlg.setThumb(ec.modelData.id)
                            }
                        }
                        Words { objectName: "ytThumbInfo:" + ec.modelData.id; text: dlg.thumbProblem(ec.modelData.id) !== "" ? dlg.thumbProblem(ec.modelData.id) : "Picture: " + dlg.draftOf(ec.modelData.id).thumb }
                        Words { objectName: "ytStatus:" + ec.modelData.id; text: dlg.statusText(ec.modelData) }
                    }
                }
            }

            // ===== Live =====
            Scroller {
                objectName: "ytPageLive"
                anchors.fill: parent
                visible: dlg.tab === "live"
                Words { objectName: "ytNotLive"; visible: !dlg.store.live; text: "Not live. This shows your stream's health, viewers and likes once you go live." }
                Words { objectName: "ytLiveNote"; visible: dlg.liveNote !== ""; color: Theme.c.danger; text: dlg.liveNote }
                Words { objectName: "ytLiveEmpty"; visible: dlg.store.live && dlg.liveLoaded && dlg.liveOuts.length === 0; text: "No YouTube event is on air." }
                Repeater {
                    model: dlg.store.live ? dlg.liveOuts : []
                    delegate: UCard {
                        id: lc
                        required property var modelData
                        objectName: "ytLive:" + modelData.output
                        title: String(modelData.label || modelData.output).toUpperCase()
                        Words { color: Theme.c.text; text: dlg.safe(lc.modelData.title) }
                        Row {
                            spacing: 10
                            Rectangle {
                                objectName: "ytHealth:" + lc.modelData.output
                                readonly property string words: dlg.healthWords(lc.modelData.health)
                                width: pillText.implicitWidth + 24
                                height: 26
                                radius: 13
                                color: dlg.healthColor(lc.modelData.health)
                                Text {
                                    id: pillText
                                    anchors.centerIn: parent
                                    text: "Health: " + parent.words
                                    textFormat: Text.PlainText
                                    color: Theme.c.onAccent
                                    font.family: Theme.family
                                    font.pixelSize: 13
                                    font.weight: Font.DemiBold
                                }
                            }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                textFormat: Text.PlainText
                                color: Theme.c.text
                                font.family: Theme.family
                                font.pixelSize: 14
                                text: "Viewers: " + dlg.num(lc.modelData.viewers) + "     Likes: " + dlg.num(lc.modelData.likes)
                            }
                        }
                        Repeater {
                            model: lc.modelData.health && Array.isArray(lc.modelData.health.issues) ? lc.modelData.health.issues : []
                            delegate: Words { required property var modelData; text: dlg.safe(modelData) }
                        }
                        UButton {
                            objectName: "ytWatch:" + lc.modelData.output
                            text: "Open on YouTube"
                            enabled: dlg.watchLink(lc.modelData.broadcastId) !== ""
                            onClicked: dlg.openWatch(lc.modelData.broadcastId)
                        }
                    }
                }
                UButton { objectName: "ytLiveRefresh"; text: "Refresh now"; enabled: dlg.store.live; onClicked: dlg.pollLive() }
            }

            // ===== Chat =====
            Item {
                objectName: "ytPageChat"
                anchors.fill: parent
                visible: dlg.tab === "chat"
                Row {
                    id: chatTop
                    anchors { left: parent.left; top: parent.top }
                    spacing: 8
                    Repeater {
                        model: dlg.events.outputs || []
                        delegate: UButton {
                            required property var modelData
                            objectName: "ytChatOut:" + modelData.id
                            text: String(modelData.label || modelData.id)
                            kind: dlg.chatOutput === modelData.id ? "primary" : "normal"
                            onClicked: dlg.chooseChatOutput(modelData.id)
                        }
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        textFormat: Text.PlainText
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: 13
                        text: dlg.chatLive ? "Chat is live." : "Chat shows once this output is live."
                    }
                }
                ListView {
                    id: chatList_
                    objectName: "ytChatList"
                    anchors { left: parent.left; right: parent.right; top: chatTop.bottom; bottom: chatBottom.top; topMargin: 8; bottomMargin: 8 }
                    clip: true
                    spacing: 6
                    model: dlg.chatList()
                    boundsBehavior: Flickable.StopAtBounds
                    ScrollBar.vertical: ScrollBar {}
                    onCountChanged: if (atYEnd || count < 3) Qt.callLater(positionViewAtEnd)
                    delegate: Column {
                        id: msg
                        required property var modelData
                        readonly property bool plainOk: who.textFormat === Text.PlainText && what.textFormat === Text.PlainText
                        width: chatList_.width - 12
                        spacing: 1
                        Text {
                            id: who
                            width: parent.width
                            textFormat: Text.PlainText
                            wrapMode: Text.Wrap
                            color: msg.modelData.kind === "superChat" ? Theme.c.accentHi : Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: 12
                            font.weight: Font.DemiBold
                            text: msg.modelData.author + (msg.modelData.kind === "superChat" ? "  (Super Chat " + msg.modelData.amount + ")" : msg.modelData.kind === "membership" ? "  (member)" : "")
                        }
                        Text {
                            id: what
                            objectName: "ytChatText:" + msg.modelData.id
                            width: parent.width
                            textFormat: Text.PlainText
                            wrapMode: Text.Wrap
                            color: Theme.c.text
                            font.family: Theme.family
                            font.pixelSize: 14
                            text: msg.modelData.text
                        }
                    }
                }
                Column {
                    id: chatBottom
                    anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
                    spacing: 6
                    Text {
                        objectName: "ytChatNote"
                        visible: dlg.chatNote !== ""
                        width: parent.width
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Theme.c.danger
                        font.family: Theme.family
                        font.pixelSize: 13
                        text: dlg.chatNote
                    }
                    Row {
                        spacing: 8
                        UField {
                            objectName: "ytChatInput"
                            width: chatBottom.width - sendBtn.width - 8
                            label: "Chat message"
                            placeholderText: "Say something to the chat (200 characters at most)"
                            maximumLength: 200
                            text: dlg.chatText
                            onTextEdited: dlg.chatText = text
                            onAccepted: dlg.sendChat() // Enter
                        }
                        UButton {
                            id: sendBtn
                            objectName: "ytChatSend"
                            text: "Send"
                            kind: "primary"
                            enabled: dlg.sendProblem() === "" && dlg.chatOutput !== ""
                            onClicked: dlg.sendChat()
                        }
                    }
                }
            }

            // ===== Streams =====
            Scroller {
                objectName: "ytPageStreams"
                anchors.fill: parent
                visible: dlg.tab === "streams"
                Row {
                    spacing: 8
                    Repeater {
                        model: ["all", "upcoming", "active", "completed"]
                        delegate: UButton {
                            required property string modelData
                            objectName: "ytFilter:" + modelData
                            text: modelData.charAt(0).toUpperCase() + modelData.slice(1)
                            kind: dlg.filter === modelData ? "primary" : "normal"
                            onClicked: dlg.setFilter(modelData)
                        }
                    }
                }
                Words { objectName: "ytStreamsNote"; visible: dlg.streamsNote !== ""; color: Theme.c.text; text: dlg.streamsNote }
                Words { objectName: "ytStreamsEmpty"; visible: dlg.streamsLoaded && dlg.items.length === 0; text: "No events in this list." }
                Repeater {
                    model: dlg.items
                    delegate: UCard {
                        id: sc
                        required property var modelData
                        objectName: "ytStream:" + modelData.id
                        title: String(modelData.lifeCycle || "").toUpperCase() + (modelData.current ? "   CURRENT" : "")
                        Words { color: Theme.c.text; text: dlg.safe(sc.modelData.title) }
                        Words { text: dlg.dateText(sc.modelData.when) + (sc.modelData.privacy ? "  ·  " + sc.modelData.privacy : "") }
                        Flow {
                            width: parent.width
                            spacing: 8
                            UButton { objectName: "ytUseH:" + sc.modelData.id; text: "Use as H template"; enabled: dlg.streamBusyId === ""; onClicked: dlg.useAsTemplate(sc.modelData.id, "H") }
                            UButton { objectName: "ytUseV:" + sc.modelData.id; text: "Use as V template"; enabled: dlg.streamBusyId === ""; onClicked: dlg.useAsTemplate(sc.modelData.id, "V") }
                            UButton { objectName: "ytEnd:" + sc.modelData.id; text: "End"; enabled: dlg.streamBusyId === "" && sc.modelData.lifeCycle !== "complete"; onClicked: dlg.endStream(sc.modelData.id) }
                            UButton { objectName: "ytDeleteStream:" + sc.modelData.id; text: "Delete"; kind: "danger"; enabled: dlg.streamBusyId === ""; onClicked: dlg.deleteStream(sc.modelData.id) }
                        }
                    }
                }
                Row {
                    spacing: 8
                    UButton { objectName: "ytPrev"; text: "Previous page"; enabled: dlg.pageStack.length > 0 && !dlg.busy; onClicked: dlg.prevPage() }
                    UButton { objectName: "ytNext"; text: "Next page"; enabled: dlg.nextToken !== null && !dlg.busy; onClicked: dlg.nextPage() }
                    UButton { objectName: "ytStreamsRefresh"; text: "Refresh list"; enabled: !dlg.busy; onClicked: dlg.loadStreams(true) }
                }
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        UButton {
            objectName: "ytClose"
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            text: "Close"
            onClicked: dlg.close()
        }
    }
}
