// SPDX-License-Identifier: GPL-3.0-or-later
// The QML studio's state and its calls to the UI server (D355). Same routes, same order of loads and the same rules as
// the widget studio (main_window.cpp: loadScenes, loadLayers, loadMixer, pollStatus, pollMeters, hostAction, confirm),
// so both windows behave the same while they live side by side.
import QtQuick
import Ujwalam.Core

QtObject {
    id: store

    // ---- state ----
    property var scenes: []          // merged by id: {id, name, canvases: ["h","v"], active}
    property string activeScene: ""
    property string canvas: "h"      // the canvas the layer list shows
    property var layers: []          // host order: bottom first
    property string selected: ""     // layer id
    property var mixer: []           // mixer.list sources
    property var tracks: []          // project audio tracks (D273)
    property var peaks: ({})         // source id -> peak dB, refreshed every 250 ms
    property bool routeBusy: false
    property bool live: false
    property bool recording: false
    property bool hostUp: false
    property bool uiUp: true          // the last status read reached the UI server (the status line tells the two apart)
    property bool coreUp: false
    property bool fake: false
    property int dropped: 0
    property real fps: 0
    property real cpu: 0
    property real gpu: 0
    property bool canStream: false
    property bool canRecord: false
    property var onAir: ({})         // status host.onAir: liveForMs, recordForMs, kbps, sinks
    property var tasks: []
    property real statusAt: 0        // the status snapshot's own clock ("at"): task times and toasts use it
    property var alerts: []          // status "alerts" (flag live-test-kit): the alert strip
    property bool previewEditing: false
    property bool effectEditing: false // status host.effectEditing (flag effect-editor): the Advanced effects list
    property var flags: ({})         // flag id -> on (ui/api/flags), read after each status poll as the widget does
    property var flagList: []        // the same answer in full: {id, label, summary, page, on} for Settings
    readonly property bool routing: flags["mixer-routing"] === true && tracks.length > 0
    readonly property bool sceneEdit: flags["scene-edit"] === true // deleting scenes needs it (D240); adding does not
    readonly property bool realism: flags["realism-look"] === true // "Make realism scene" in the scene menu (D381)
    property EditOps edit: EditOps { store: store } // undo, nudge, layer and scene menu operations (plan Q4, EditOps.qml)
    property var structure: ({})     // ui/api/project/structure: what a new layer can be made from (devices, overlays, assets)
    property bool addOpen: false     // an add window is open: a device plugged in or out refreshes its lists (D329)
    property string note: ""
    property var clips: ({})         // status "clips" (D283, D284): settings, the clip job's state, questions, the last run
    property int reviewCount: 0      // Review reads waiting (flag learning-review, D340)
    readonly property string clipsText: clipsWords(clips)
    readonly property string clipsTip: clipsTipWords(clips)

    readonly property var activeSceneObj: scenes.find(s => s.id === activeScene) || null
    readonly property bool bothCanvases: !!activeSceneObj && activeSceneObj.canvases.length > 1
    readonly property var selectedLayer: layers.find(l => l.id === selected) || null
    readonly property int activeTasks: tasks.filter(t => t.state === "running" || t.state === "waiting").length

    signal confirmNeeded(var pending)
    signal hostRestarted()
    signal addLayerReady(string sceneId, string sceneName)
    signal addSceneReady(var canvases)
    signal settingsWanted(string page) // open Settings, on this page ("" = Clips)
    signal clipsAsk(var ask)           // "Make clips?" after a recording or stream (setting: Ask me each time)
    signal flagsRead()                 // after each flag read (every status poll)
    signal statusRead(var s)           // each status that came back (the guide's hints follow what changed)

    // ---- private ----
    property real pHostUptime: -1
    property int pPreviewSeq: -1
    property int pDevicesSeq: -1
    property var pSelSeqs: ({})
    property string pSelSent: ""
    property var pSelWant: null        // a refused preview.select, sent once more when that preview is not dragging
    property int pSelGen: 0            // only the newest preview.select's answer counts
    property var pSelLast: ({})        // the host's last previewSelection {H, V, seqs, dragging}
    property bool pMeterBusy: false
    property int pFlagReads: 0
    property var pAsked: ({})          // question ids already put to the user
    property bool pFirstRunAsked: false

    function say(text) { note = text; Api.log("studio note: " + text) }

    function unwrap(body, key) {
        const r = body ? body.result : undefined;
        if (Array.isArray(r)) return r;
        return r && Array.isArray(r[key]) ? r[key] : [];
    }
    function canvasesOf(s) {
        if (Array.isArray(s.canvases)) return s.canvases.map(c => String(c).toLowerCase());
        return s.canvas !== undefined ? [String(s.canvas).toLowerCase()] : [];
    }
    function layerArgs(extra) {
        const o = { scene: activeScene };
        if (bothCanvases) o.canvas = canvas;
        for (const k in (extra || {})) o[k] = extra[k];
        return o;
    }

    function start() {
        loadUiSettings();
        loadScenes();
        pollStatus();
    }

    // ---- scenes ----
    function loadScenes() {
        Api.host("scenes.list", {}, (ok, b, err) => {
            if (!ok) return say("Scenes: " + err);
            // the host lists a scene once per canvas; merge by id
            const merged = [], at = {};
            for (const s of unwrap(b, "scenes")) {
                const cv = canvasesOf(s);
                if (at[s.id] === undefined) {
                    at[s.id] = merged.length;
                    merged.push({ id: s.id, name: s.name || s.id, canvases: cv, active: !!s.active });
                } else {
                    const e = merged[at[s.id]];
                    for (const c of cv) if (!e.canvases.includes(c)) e.canvases.push(c);
                    if (s.active) e.active = true;
                }
            }
            scenes = merged;
            if (!merged.some(s => s.id === activeScene)) {
                const a = merged.find(s => s.active);
                activeScene = a ? a.id : (merged.length ? merged[0].id : "");
            }
            if (!bothCanvases && activeSceneObj && activeSceneObj.canvases.length === 1) canvas = activeSceneObj.canvases[0];
            loadLayers();
            loadMixer();
        });
    }

    function activateScene(id) {
        Api.host("scenes.activate", { scene: id }, (ok, b, err) => {
            if (!ok) return say("Scene switch failed: " + err);
            activeScene = id;
            selected = "";
            loadScenes();
        });
    }

    function showCanvas(c) {
        if (c === canvas) return;
        canvas = c;
        selected = "";
        loadLayers();
    }

    // ---- layers ----
    // Only the newest layers.list answer counts (Codex review of Q2): an older one for another scene or canvas that
    // arrives last is dropped, so layer ids always belong to the scene and canvas the next call sends.
    property int pLayersGen: 0
    function loadLayers() {
        const gen = ++pLayersGen;
        if (!activeScene) { layers = []; return; }
        const want = activeScene + "/" + canvas;
        Api.host("layers.list", layerArgs(), (ok, b, err) => {
            if (gen !== pLayersGen || want !== activeScene + "/" + canvas) return;
            if (!ok) return say("Layers: " + err);
            layers = unwrap(b, "layers");
            if (selected && !layers.some(l => l.id === selected)) selected = "";
            syncPreviewSelection();
        });
    }

    function select(id) {
        selected = id;
        syncPreviewSelection();
    }

    function setVisible(id, visible) {
        Api.host("layers.setVisible", layerArgs({ layer: id, visible: visible }), (ok, b, err) => {
            if (!ok) say("Show/hide failed: " + err);
            loadLayers();
            edit.loadEdits(); // it is an undoable edit: Undo is ready at once, not at the next status poll
        });
    }

    // ---- adding and deleting scenes and layers (the widget's openAddLayer, openAddScene, layerDelete, sceneDelete and
    // structureEdit): the windows only build the body; one structure route sends it and the project file is saved too.
    // Adding and deleting a layer need no flag, only "not live" (D330); deleting a scene needs scene editing (D240).
    function plainStructureError(code) {
        const words = {
            "live-locked": "Not while live.",
            "scene-edit-off": "Turn on scene editing in Settings > Editing first.",
            "scene-active": "That scene is the one the project starts with; make another scene the start scene first.",
            "last-scene": "The last scene cannot be deleted.",
            "layer-copied": "Another layer shows this one; delete that copy first.",
            "layer-has-audio": "Its sound is in the mixer, so it cannot be deleted here.",
            "bad-name": "Type a name of 1 to 80 characters.",
            "no-project-file": "No project file is open, so nothing can be saved.",
            "too-many-layers": "This scene has the most layers it can hold.",
            "too-many-scenes": "The project has the most scenes it can hold.",
            "host-unavailable": "The studio host is not reachable.",
            "realism-look-off": "Turn on Realism scene in Settings > Editing first.",
            "no-game-capture": "This scene shows no game capture, so there is nothing to grade.",
            "too-many-effects": "A game layer already has too many effects for the realism grade (6 at most)."
        };
        return words[code] || code;
    }

    // The choices are read fresh each time a window opens (new assets, devices).
    function loadStructure(then) {
        Api.get("ui/api/project/structure", (ok, b, err) => {
            if (!ok) return say("Cannot add: " + err);
            if (!b.available) return say("Adding needs a loaded project file.");
            structure = b;
            if (then) then(b);
        });
    }

    function addLayer(sceneId) {
        if (live) return say("Not while live.");
        const id = sceneId || activeScene;
        if (!id) return say("Pick a scene first.");
        const s = scenes.find(x => x.id === id);
        loadStructure(() => addLayerReady(id, s ? s.name : id));
    }

    function addScene() {
        if (live) return say("Not while live.");
        loadStructure((b) => addSceneReady(Array.isArray(b.canvases) ? b.canvases : []));
    }

    function deleteLayer() {
        if (!selectedLayer) return say("Select a layer first.");
        if (live) return say("Not while live.");
        structureEdit({ op: "layer.remove", scene: activeScene, layer: selected });
    }

    function deleteScene(id) {
        if (live) return say("Not while live.");
        if (!sceneEdit) return say("Turn on scene editing in Settings > Editing to delete scenes.");
        structureEdit({ op: "scene.remove", scene: id });
    }

    function structureEdit(body) {
        if (live) return say("Live: scenes and layers cannot be added or removed.");
        Api.post("ui/api/project/structure", body, (ok, b, err) => {
            if (!ok) {
                const detail = b && b.detail ? String(b.detail) : "";
                // The host's refusals are full sentences (D329): show them alone, not behind an HTTP code.
                if (b && b.error === "host-error" && detail) say("Not done: " + detail);
                else say("Not done: " + plainStructureError(b && b.error ? String(b.error) : err) + (detail ? " (" + detail + ")" : ""));
            } else {
                if ((b.op === "layer.add" || b.op === "layer.duplicate") && b.layer && b.layer.id) selected = b.layer.id; // the new layer
                const waiting = b.waiting ? String(b.waiting) : ""; // a capture layer added without its device
                const done = b.op === "scene.realism" ? "Realism scene made: " + (b.scene ? b.scene.name : "") + " (" + (b.graded || 0) + " game layer(s) graded)" : "Done: " + b.op;
                say((waiting ? "Layer added. " + waiting : done) +
                    (b.saved ? "" : ". Not saved to the project file: the change is live only."));
            }
            loadScenes();
            edit.loadEdits(); // a structure edit clears the undo history
        });
    }

    // D335 F8: the layer selected in the list is the one the mouse edits on that canvas's preview (a hidden layer, or
    // one without a placement, selects none). Sent once per change. The host refuses while live or mid-drag: the selection
    // is kept and sent again from pollStatus once that preview is not dragging (a newer selection replaces it; a refused
    // retry puts the list back to the host's), as the widget does.
    function syncPreviewSelection() {
        if (!previewEditing || !activeScene) return;
        const l = selectedLayer;
        const layer = l && l.placement !== undefined && l.visible ? selected : "";
        const key = canvas + "/" + activeScene + "/" + layer;
        if (key === pSelSent) return;
        pSelSent = key;
        const p = { canvas: canvas };
        if (layer) p.layer = layer;
        sendPreviewSelection(p, false);
    }
    function sendPreviewSelection(p, retry) {
        pSelWant = null; // this one replaces any selection still waiting for a retry
        const gen = ++pSelGen;
        Api.host("preview.select", p, (ok) => {
            if (gen !== pSelGen || ok) return; // a newer selection went out meanwhile, or it worked
            if (!retry) { pSelWant = p; return; } // refused (a drag on that preview, live): again from pollStatus
            followPreview(pSelLast, p.canvas); // refused again: the list shows what the preview edits
        });
    }

    // The list follows the preview's selection (sel: the host's previewSelection; only: that canvas's own answer).
    function followPreview(sel, only) {
        pSelWant = null;
        pSelGen++; // an answer still on its way no longer counts
        if (only && only !== canvas) return; // the list shows another canvas now; it sends its own selection
        const cur = sel ? sel[canvas.toUpperCase()] : null;
        if (!cur || cur.scene !== activeScene) return;
        const layer = cur.layer || "";
        pSelSent = canvas + "/" + activeScene + "/" + layer; // no echo
        if (layer !== selected) selected = layer;
    }

    // ---- mixer ----
    function loadMixer() {
        Api.host("mixer.list", {}, (ok, b, err) => {
            if (!ok) return say("Mixer: " + err);
            mixer = unwrap(b, "sources");
            tracks = unwrap(b, "tracks");
            takePeaks(mixer);
        });
    }

    function takePeaks(list) {
        const p = {};
        for (const m of list) p[m.id] = typeof m.peakDb === "number" ? m.peakDb : -100;
        peaks = p;
    }

    property bool paused: false      // the window is minimised: no meter polls

    function pollMeters() {
        if (pMeterBusy || paused || !mixer.length) return;
        pMeterBusy = true;
        Api.host("mixer.list", {}, (ok, b) => {
            pMeterBusy = false;
            if (ok) takePeaks(unwrap(b, "sources")); // a missed meter frame is harmless
        });
    }

    // The preview's own host window (D280): open it, or bring it to the front (the widget's Own window / To front).
    function previewWindow(canvas, front) {
        Api.host(front ? "preview.focus" : "preview.open", { canvas: canvas }, (ok, b, err) => {
            if (!ok) say("Preview failed: " + err);
            else if (!front) say("Preview opened.");
        });
    }
    function setVolume(id, db) {
        Api.host("mixer.setVolume", { id: id, db: Math.round(db) }, (ok, b, err) => {
            if (!ok) { say("Volume failed: " + err); loadMixer(); }
        });
    }
    function setMute(id, muted) {
        Api.host("mixer.setMute", { id: id, muted: muted }, (ok, b, err) => {
            if (!ok) say("Mute failed: " + err);
            loadMixer();
        });
    }
    function setCue(id, cue) {
        Api.host("mixer.setCue", { id: id, cue: cue }, (ok, b, err) => {
            if (!ok) say("CUE failed: " + err);
            loadMixer();
        });
    }
    function setTracks(id, list) {
        if (routeBusy) { say("A track change is still on its way; try again in a moment."); return loadMixer(); }
        routeBusy = true;
        Api.host("mixer.setTracks", { id: id, tracks: list }, (ok, b, err) => {
            routeBusy = false;
            if (ok && b.verdict === "confirm") confirmNeeded(b.pending); // a held action (D332)
            else if (!ok) say("Tracks not changed: " + err);
            else say(b.saved === "pending" ? "Tracks changed." : "Tracks changed, live only: not saved to the project file.");
            loadMixer();
        });
    }

    // ---- stream and recording (the widget's hostAction / confirm, D332: one click) ----
    function toggleStream() { hostAction(live ? "stream.stop" : "stream.start") }
    function toggleRecord() { hostAction(recording ? "record.stop" : "record.start") }

    // One stream or record action at a time (Codex review of Q2): the buttons stay off from the click until the action
    // answered and a status poll after it came back, so a second quick click can never stop what the first started.
    property bool actionBusy: false
    function hostAction(method) {
        if (actionBusy) return;
        actionBusy = true;
        Api.host(method, {}, (ok, b, err) => {
            if (!ok) { actionBusy = false; return say("Not done: " + err); }
            if (b.verdict === "confirm" || b.verdict === "readiness-failed") { actionBusy = false; return confirmNeeded(b.pending); }
            if (b.warning) say(b.warning);
            pollStatus(() => { actionBusy = false; });
        });
    }

    // ---- clipping (D281; the widget's Save clip and Mark moment): one click each, no confirm ----
    // Save clip: the replay buffer's last 60 s of H and V as clip files. Mark moment: a marker for the clipper (source
    // api, as the widget button; the hotkey sends its own).
    function saveClip() {
        Api.host("replay.save", {}, (ok, b, err) => {
            if (!ok) return say("Clip not saved: " + err);
            const r = b ? b.result : null;
            const n = r && Array.isArray(r.saved) ? r.saved.length : 0;
            say(n ? "Clip saved: " + n + " file(s) in the replay folder." : "Clip not saved: the replay buffer is not running.");
        });
    }
    function markMoment() {
        Api.host("marker.add", { source: "api" }, (ok, b, err) => say(ok ? "Moment marked." : "Moment not marked: " + err));
    }

    function answer(pendingId, allow) {
        if (!allow) {
            Api.post("ui/api/cancel", { pendingId: pendingId }, () => {});
            return say("Cancelled.");
        }
        if (actionBusy) return;
        actionBusy = true;
        Api.post("ui/api/confirm", { pendingId: pendingId }, (ok, r, err) => {
            if (!ok) { actionBusy = false; return say("Not done: " + err); }
            if (r.verdict === "confirm" || r.verdict === "readiness-failed") { actionBusy = false; return confirmNeeded(r.pending); }
            say(r.verdict === "allow" ? "Done." : "Result: " + r.verdict);
            if (r.warning) say(r.warning);
            pollStatus(() => { actionBusy = false; });
            loadScenes();
        });
    }

    // ---- status, every 2 s ----
    // then (optional) runs once this poll has answered, whether it worked or not.
    function pollStatus(then) {
        Api.get("ui/api/status", (ok, s, err) => {
            if (then) then();
            // No status: no stream or record click on a state that may be stale.
            if (!ok) { uiUp = false; hostUp = false; canStream = false; canRecord = false; return say("Status: " + err); }
            uiUp = true;
            const h = s.host || {}, c = s.core || {};
            live = h.live === true;
            recording = h.recording === true;
            hostUp = h.available === true;
            fake = h.blockedOnHost === true;
            coreUp = c.available === true;
            dropped = h.droppedFrames || 0;
            fps = h.fps || 0;
            cpu = h.cpuPct || 0;
            gpu = h.gpuPct || 0;
            const ready = h.outputsReady || {};
            canStream = ready.stream === true;
            canRecord = ready.record === true;
            onAir = h.onAir || {};
            statusAt = typeof s.at === "number" ? s.at : Date.now();
            alerts = Array.isArray(s.alerts) ? s.alerts : [];
            tasks = Array.isArray(s.tasks) ? s.tasks : [];
            takeClips(s.clips || {});
            // A restarted host (crash supervisor) lost the previews it drew in our windows: embed them again (D280).
            const up = typeof h.uptimeMs === "number" ? h.uptimeMs : -1;
            if (up >= 0 && pHostUptime >= 0 && up < pHostUptime) hostRestarted();
            if (up >= 0) pHostUptime = up;
            const pe = h.previewEditing === true;
            if (pe !== previewEditing) { previewEditing = pe; pSelSent = ""; syncPreviewSelection(); }
            // D335 F8: a click on this canvas's preview picked another layer: the list follows.
            const ps = h.previewSelection || {};
            const seqs = ps.seqs || {};
            const cv = canvas.toUpperCase();
            if (typeof seqs[cv] === "number" && pSelSeqs[cv] !== undefined && seqs[cv] !== pSelSeqs[cv] && previewEditing) followPreview(ps);
            const nextSeqs = {};
            for (const k of ["H", "V"]) if (typeof seqs[k] === "number") nextSeqs[k] = seqs[k];
            pSelSeqs = nextSeqs;
            pSelLast = ps;
            // A refused selection waits until that preview is not dragging (and not live), then goes out once more.
            if (pSelWant && previewEditing && !live && !(ps.dragging || {})[String(pSelWant.canvas).toUpperCase()])
                sendPreviewSelection(pSelWant, true);
            effectEditing = h.effectEditing === true;
            // A layer moved or resized with the mouse on the preview (D230): select it and reload the layers.
            const ed = h.previewEdit;
            if (ed && typeof ed.seq === "number") {
                if (pPreviewSeq >= 0 && ed.seq !== pPreviewSeq && ed.scene === activeScene) { selected = ed.layer || selected; loadLayers(); }
                pPreviewSeq = ed.seq;
            }
            // A device was plugged in or out (D329): the layer list shows waiting or connected again.
            const dv = h.devices;
            if (dv && typeof dv.seq === "number") {
                if (pDevicesSeq >= 0 && dv.seq !== pDevicesSeq) { loadLayers(); if (addOpen) loadStructure(); }
                pDevicesSeq = dv.seq;
            }
            loadFlags();
            edit.loadEdits();
            statusRead(s);
        });
    }

    // ---- clips (D283, D284; the widget's updateClips, askClips, answerClips) ----
    readonly property var clipModes: ({
        ask: ["Ask me each time I stop recording", "Ask me each time a stream ends"],
        after: ["Make clips automatically when I stop recording", "Make clips automatically when the stream ends"],
        "while": ["Find the best moments while I record, then edit them into clips", "Find the best moments while I'm live, then edit them into clips"],
        off: ["Don't make clips", "Don't make clips"]
    })
    function modeWords(id, live) { const m = clipModes[id]; return m ? m[live ? 1 : 0] : String(id === undefined ? "" : id) }
    function clipsWords(cl) {
        if (!cl || Object.keys(cl).length === 0) return "Clips: -";
        const set = cl.settings || {}, last = cl.last || {};
        if (cl.running) return "Making clips...";
        if ((cl.asks || []).length) return "Make clips? (" + cl.asks.length + ")";
        const q = Array.isArray(cl.queued) ? cl.queued.length : (cl.queued || 0); // a count from the server, a list from the job's file
        if (q > 0) return "Clips waiting: " + q;
        if (set.recording === "off" && set.live === "off") return "Clips: off";
        if (cl.available === false) return cl.missing === "python" ? "Clips: Python not found" : "Clips: not set up";
        if (last.result === "done") return (last.clips || 0) + " new clip(s)";
        if (last.result === "failed") return "Clips: last try failed";
        return "Clips: ready";
    }
    function clipsTipWords(cl) {
        if (!cl || Object.keys(cl).length === 0) return "";
        const set = cl.settings || {}, last = cl.last || {};
        let tip = "Recording: " + modeWords(set.recording, false) + "\nLive: " + modeWords(set.live, true) + "\nClips folder: " + (cl.folder || "");
        if (cl.reason) tip += "\n" + cl.reason;
        if (cl.fix) tip += "\n" + cl.fix;
        if (last.reason) tip += "\nLast time: " + last.reason;
        return tip;
    }
    // Questions open only on a window the user sees (the widget's rule); the tests ask with clips-ask instead.
    function takeClips(cl) {
        if (JSON.stringify(cl) !== JSON.stringify(clips)) clips = cl;
        if (studioUnseen) return;
        if (!pFirstRunAsked && cl.settingsSaved === false) { pFirstRunAsked = true; settingsWanted(""); return; }
        nextClipsAsk();
    }
    property bool clipsAsking: false   // a question is open (ClipsAsk.qml): the next waits for its answer
    function nextClipsAsk() {
        if (clipsAsking) return false;
        for (const a of (clips.asks || [])) {
            if (pAsked[a.id]) continue;
            const m = Object.assign({}, pAsked);
            m[a.id] = true;
            pAsked = m;
            clipsAsk(a);
            return true;
        }
        return false;
    }
    function answerClips(id, make, remember) {
        Api.post("ui/api/clips/answer", { id: id, make: make, remember: remember }, (ok, r, err) => {
            say(!ok ? "Answer not saved: " + err
                : make ? "Making clips. You can keep working; the Clips label shows when they are ready." : "No clips made.");
        });
    }
    function openClipsFolder() {
        Api.post("ui/api/clips/open", {}, (ok, r, err) => { if (!ok) say("Could not open the clips folder: " + err) });
    }

    function loadFlags() {
        Api.get("ui/api/flags", (ok, b) => {
            if (ok && Array.isArray(b.flags)) takeFlags(b.flags);
            flagsRead(); // the Outputs panel reads on each flag read, the Bots box on every 5th (the widget's rule)
            // LL3 (D340): the Review reads queue, read every 5th flag read (the widget's rule) while its flag is on
            if (flags["learning-review"] !== true) { reviewCount = 0; return; }
            if (pFlagReads++ % 5 !== 0) return;
            Api.get("ui/api/learning/review", (ok2, r) => { reviewCount = ok2 && typeof r.total === "number" ? r.total : 0 });
        });
    }
    function takeFlags(list) {
        const f = {};
        for (const x of list) f[x.id] = x.on === true;
        if (JSON.stringify(f) !== JSON.stringify(flags)) flags = f;
        if (JSON.stringify(list) !== JSON.stringify(flagList)) flagList = list;
    }

    // ---- Settings (the widget's saveSettings and setFlag) ----
    // An older server that does not know the match filter refuses the whole change (400): everything else is saved again
    // without it, so one new option never blocks the other settings.
    function saveSettings(body, retried) {
        Api.post("ui/api/settings", body, (ok, r, err) => {
            if (!ok) {
                const c = body.clips || {};
                if (String(err).startsWith("HTTP 400") && c.matchGate !== undefined && !retried) {
                    const rest = Object.assign({}, body), cc = Object.assign({}, c);
                    delete cc.matchGate;
                    if (Object.keys(cc).length) rest.clips = cc; else delete rest.clips;
                    if (Object.keys(rest).length) return saveSettings(rest, true);
                    return say("The match filter was not saved: this version of Ujwalam does not support it yet.");
                }
                return say("Settings not saved: " + err);
            }
            say(retried ? "Settings saved, except the match filter: this version of Ujwalam does not support it yet." : "Settings saved.");
            pollStatus();
        });
    }

    // A feature switch, on the Save click (D332: no phrase). A held answer waits for the user's click (ConfirmDialog).
    function setFlag(id, on, label) {
        Api.post("ui/api/flags/set", { id: id, on: on }, (ok, b, err) => {
            if (!ok) say("Not changed: " + (label || id) + ": " + err);
            else if (b.verdict === "confirm") confirmNeeded(b.pending);
            else { say((label || id) + (on ? ": on." : ": off.")); loadFlags(); }
            pollStatus();
        });
    }

    // The saved animation choice (settings.json ui.motion) applies from the start, as in the widget studio.
    function loadUiSettings() {
        Api.get("ui/api/settings", (ok, b) => {
            const m = ok && b.settings && b.settings.ui ? b.settings.ui.motion : undefined;
            if (m === "system" || m === "on" || m === "off") Theme.setMotionMode(m);
        });
    }

    function probeState() {
        return {
            scenes: scenes.map(s => s.name), activeScene: activeScene, canvas: canvas,
            layers: layers.map(l => ({ id: l.id, name: l.name, visible: !!l.visible })), selected: selected,
            mixer: mixer.map(m => ({ id: m.id, name: m.name, volumeDb: m.volumeDb, muted: !!m.muted, cue: !!m.cue })),
            live: live, recording: recording, canStream: canStream, canRecord: canRecord, hostUp: hostUp, note: note
        };
    }

    property Timer pStatus: Timer { interval: 2000; repeat: true; running: true; onTriggered: store.pollStatus() }
    property Timer pMeters: Timer { interval: 250; repeat: true; running: true; onTriggered: store.pollMeters() }
}
