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
    // RareUI slice 0 (D384): live or recording turns Theme.fx to "plain" (no decoration while on air).
    readonly property bool onAirNow: live || recording
    onOnAirNowChanged: Theme.onAir = onAirNow
    Component.onCompleted: Theme.onAir = onAirNow
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
    property var looks: []           // D445: the realism looks (ui/api/looks: id, name, summary, swatch), read once the flag is on
    property EditOps edit: EditOps { store: store } // undo, nudge, layer and scene menu operations (plan Q4, EditOps.qml)
    property var structure: ({})     // ui/api/project/structure: what a new layer can be made from (devices, overlays, assets)
    property bool addOpen: false     // an add window is open: a device plugged in or out refreshes its lists (D329)
    property string note: ""
    property var clips: ({})         // status "clips" (D283, D284): settings, the clip job's state, questions, the last run
    property int reviewCount: 0      // Review reads waiting (flag learning-review, D340)
    // D442: unfinished jobs that wait for the user's choice (the start notice in TaskCenter)
    readonly property int waitingForYou: typeof clips.waitingForYou === "number" ? clips.waitingForYou : 0
    readonly property string clipsText: clipsWords(clips)
    readonly property string clipsTip: clipsTipWords(clips)

    readonly property var activeSceneObj: scenes.find(s => s.id === activeScene) || null
    readonly property bool bothCanvases: !!activeSceneObj && activeSceneObj.canvases.length > 1
    readonly property var selectedLayer: layers.find(l => l.id === selected) || null
    readonly property int activeTasks: tasks.filter(t => t.state === "running" || t.state === "waiting").length
    // One source for the task words (2026-11-27, user: the chip said "1 task waiting" while the status bar said
    // "1 task running"). The on-air chip (TaskCenter.chipText) and the status bar both read taskWords.
    readonly property int runningTasks: tasks.filter(t => t.state === "running").length
    readonly property int waitingTasks: tasks.filter(t => t.state === "waiting").length
    readonly property string taskWords: runningTasks > 0
        ? (runningTasks === 1 ? "1 task running" : runningTasks + " tasks running") + (waitingTasks > 0 ? ", " + waitingTasks + " waiting" : "")
        : waitingTasks > 0 ? (waitingTasks === 1 ? "1 task waiting" : waitingTasks + " tasks waiting") : ""

    signal confirmNeeded(var pending)
    signal hostRestarted()
    signal addLayerReady(string sceneId, string sceneName)
    signal addSceneReady(var canvases)
    signal addAudioReady(var choices)  // the mixer's Add audio: what can be added now (audio-routes.mjs)
    signal audioToolsReady(var info, string audio, string name) // AU2: a strip's Tools window (ranges, presets, saved tools)
    signal sceneMusicReady(var info, string scene, string mood) // MU2: a scene's Music window (moods, its music, what plays)
    signal settingsWanted(string page) // open Settings, on this page ("" = Clips)
    signal scheduleWanted()            // open the scheduling manager (the Settings > Posting button; SM1)
    signal goLiveWanted(var options)   // Go live with a YouTube output on and signed in: the chooser opens first (D389)
    signal connectionsWanted(string output) // open Settings > Connections with only this output (the chooser's "Add the key")
    signal youtubeEventsWanted()       // open the YouTube window on its Presets tab (a Go live was refused for a missing event, D386, D388)
    signal clipsAsk(var ask)           // "Make clips?" after a recording or stream (setting: Ask me each time)
    signal lookFromReferenceWanted()   // RL5: open "New look from a reference" (scene menu, Settings > Clips)
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
            "too-many-effects": "A game layer already has too many effects of its own for this look (6 at most; remove one of its effects first).",
            "unknown-look": "That look is not installed any more."
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
                let lookName = b.look ? String(b.look) : "The look";
                for (let i = 0; i < looks.length; i++) if (looks[i].id === b.look) lookName = looks[i].name;
                const left = b.dropped && b.dropped.length ? ". " + lookName + ": left out " + b.dropped.join(", ") + " to stay within 6 effects on a layer" : "";
                say((waiting ? "Layer added. " + waiting : done + left) + (b.later ? ". " + b.later + " layer(s) show after Ujwalam restarts" : "") +
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
    // B4 (2026-11-18): the strips are a ListModel of ids kept in host order (moved, inserted, removed one by one), so a
    // refresh never rebuilds a strip the user is touching; each strip reads its row from mixerById.
    property ListModel mixerIds: ListModel {}
    property var mixerById: ({})
    property bool pMixerLoading: false
    property var pLiveOnlySaid: ({})
    property int pStripsMade: 0      // probe: mixer strips built (MixerPanel counts them)
    property int pEmptyPolls: 0
    function loadMixer() {
        pMixerLoading = true;
        Api.host("mixer.list", {}, (ok, b, err) => {
            pMixerLoading = false;
            if (!ok) return say("Mixer: " + err);
            takeMixer(unwrap(b, "sources"));
            tracks = unwrap(b, "tracks");
            takePeaks(mixer);
            sayHeadphones(b && b.result ? b.result.headphones : undefined);
        });
    }
    // Headphones plugged in after the start: the host never switches the monitoring output on a running studio (Codex
    // review round 2, 2026-11-18); its plain sentence is said once.
    property string headphonesSaid: ""
    function sayHeadphones(text) {
        if (typeof text !== "string" || !text || text === headphonesSaid) return;
        headphonesSaid = text;
        say(text);
    }
    function takeMixer(list) {
        const by = {};
        for (const m of list) by[m.id] = m;
        mixerById = by;
        mixer = list;
        const want = list.map(m => m.id);
        for (let i = mixerIds.count - 1; i >= 0; i--) if (by[mixerIds.get(i).sid] === undefined) mixerIds.remove(i);
        for (let i = 0; i < want.length; i++) {
            let at = -1;
            for (let j = i; j < mixerIds.count; j++) if (mixerIds.get(j).sid === want[i]) { at = j; break; }
            if (at < 0) mixerIds.insert(i, { sid: want[i] });
            else if (at !== i) mixerIds.move(at, i, 1);
        }
    }
    // Try again (A3): every device without a picture is activated again, device sounds and missing files are looked for.
    function rescanDevices() {
        Api.post("ui/api/devices/rescan", {}, (ok, b, err) => {
            if (!ok) say("Try again: " + (b && b.text ? b.text : err));
            else say(b.retried || b.audio || b.media ? "Trying again: " + [b.retried ? b.retried + " device(s) activated again" : "", b.audio ? b.audio + " sound(s) connected" : "", b.media ? b.media + " file layer(s) added" : ""].filter(x => x).join(", ") + "."
                     : (b.connectable || []).length ? "Trying again. A waiting layer's device is connected: press Connect on it." : "Trying again. Nothing new is connected yet.");
            loadLayers();
            loadMixer();
        });
    }
    // Connect (A1): a waiting preset layer (game capture, camera) becomes the capture of its now connected device.
    function connectRole(role) {
        Api.post("ui/api/devices/connect", role ? { role: role } : {}, (ok, b, err) => {
            if (!ok) say("Not connected: " + (b && b.text ? b.text : (b && b.detail ? b.detail : err)));
            else say("Connected." + (b.saved === false ? " Not saved to the project file: the change is live only." : ""));
            loadLayers();
            loadMixer();
            pollStatus();
        });
    }
    property var connectable: []     // host.devices.connectable: [{role, layers: [ids]}] (A1)
    function connectRoleOf(layerId) {
        for (const c of connectable) if ((c.layers || []).indexOf(layerId) >= 0) return c.role;
        return "";
    }

    // In the stream mix: on track 1, the one every output encodes (D273). A host answer without mixers counts as in it.
    function inStream(m) { return typeof m.mixers === "number" ? (m.mixers & 1) !== 0 : true }

    function takePeaks(list) {
        const p = {};
        for (const m of list) p[m.id] = typeof m.peakDb === "number" ? m.peakDb : -100;
        peaks = p;
    }

    property bool paused: false      // the window is minimised: no meter polls

    // B2/B9 (2026-11-18): the meters come from mixer.levels (ids and peaks only, never waiting for a host load). An empty
    // mixer is read again every ~5 s (a strip that came late appears without a restart); a levels id set that differs
    // from the strips reloads the strips. A host without mixer.levels falls back to mixer.list.
    property bool pLevelsOk: true
    function pollMeters() {
        if (pMeterBusy || paused || pMixerLoading) return;
        if (!mixer.length) { if (++pEmptyPolls % 20 === 0) loadMixer(); return; }
        pEmptyPolls = 0;
        pMeterBusy = true;
        Api.host(pLevelsOk ? "mixer.levels" : "mixer.list", {}, (ok, b, err) => {
            pMeterBusy = false;
            if (!ok) { if (pLevelsOk && /unknown|not allowed|method/i.test(String(err))) pLevelsOk = false; return; } // a missed meter frame is harmless
            if (!pLevelsOk) return takePeaks(unwrap(b, "sources"));
            if (b && b.result && b.result.busy === true) return;
            const lv = unwrap(b, "levels");
            takePeaks(lv);
            const have = mixer.filter(m => m.waiting !== true).map(m => m.id).sort().join("|");
            if (lv.map(m => m.id).sort().join("|") !== have) loadMixer();
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
            if (!ok) { say("Volume failed: " + err); return loadMixer(); }
            // B10: the strip keeps the volume the host took (no jump back on the next refresh)
            const r = b && b.result ? b.result : {};
            const v = typeof r.volumeDb === "number" ? r.volumeDb : Math.round(db);
            const by = Object.assign({}, mixerById);
            if (by[id]) { by[id] = Object.assign({}, by[id], { volumeDb: v }); mixerById = by; mixer = mixer.map(m => m.id === id ? by[id] : m); }
            // B6: a sound with no project entry is live only (nothing to save it into); say so once per sound
            if (!(b && b.saved) && typeof r.audioSource !== "string" && !pLiveOnlySaid[id]) { const s = Object.assign({}, pLiveOnlySaid); s[id] = true; pLiveOnlySaid = s; say("Volume changed for now only: this sound is not in the project, so the change is not saved. Add it to the stream to keep it."); }
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

    // ---- Add audio, Add to stream, Remove (D393 proposed, alpha.33 feedback; audio-routes.mjs): one click each, also
    // while live (it changes what the stream hears, never the picture). Saved into the project file by the UI server.
    function audioError(b, err) {
        if (b && b.error === "host-error" && b.detail) return String(b.detail); // the host's own sentence
        return b && b.text ? String(b.text) : String(err || "error");
    }
    function openAddAudio() {
        Api.get("ui/api/audio/choices", (ok, b, err) => {
            if (!ok) return say("Add audio: " + err);
            if (!b.available) return say(b.error === "no-project-file" ? "Adding a sound needs a loaded project file." : "Add audio: the studio host is not reachable.");
            addAudioReady(b);
        });
    }
    function addAudio(key, then) {
        Api.post("ui/api/audio", { op: "add", key: key }, (ok, b, err) => {
            if (!ok) { const m = "Not added: " + audioError(b, err); if (then) then(false, m); else say(m); return; }
            const late = b.audio && b.audio.cueDelayed === true;
            say("Added " + (b.audio ? b.audio.name : "the sound") + " to the stream." +
                (late ? " Its headphone sound (CUE) comes a little late, because it comes with video. For game sound, the capture card's audio input is heard at once." : "") +
                (typeof b.warning === "string" ? " " + b.warning : "") +
                (b.saved ? "" : " Not saved to the project file: the change is live only."));
            if (then) then(true, "");
            loadMixer();
        });
    }
    function addToStream(id) {
        Api.post("ui/api/audio", { op: "stream", id: id }, (ok, b, err) => {
            if (!ok) say("Not added to the stream: " + audioError(b, err));
            else say("Added to the stream." + (b.saved === false ? " Not saved to the project file: the change is live only." : ""));
            loadMixer();
        });
    }
    // AU2 strip tools (audio-routes.mjs op 'filters'): applied on air at once, saved into the project file.
    function openAudioTools(audio, name) {
        Api.get("ui/api/audio/tools", (ok, b, err) => {
            if (!ok) return say("Tools: " + err);
            audioToolsReady(b, audio, name);
        });
    }
    function setAudioTools(audio, filters, then) {
        Api.post("ui/api/audio", { op: "filters", audio: audio, filters: filters }, (ok, b, err) => {
            if (!ok) { const m = "Not changed: " + audioError(b, err); if (then) then(false, m); else say(m); return; }
            // AU3: ducking that waits for its sound says why (the host's plain reason)
            const duck = b.duck && b.duck.on && !b.duck.active ? b.duck.reason : "";
            if (then) then(true, [duck, b.saved ? "" : "Live only: not saved to the project file."].filter(Boolean).join(" "));
        });
    }
    // MU2 scene music (music-routes.mjs): a scene's music on / mood / level, applied at once (also on air) and saved.
    function openSceneMusic(sceneId) {
        Api.get("ui/api/music", (ok, b, err) => {
            if (!ok) return say("Music: " + err);
            const sc = (b.scenes || []).find(s => s.id === sceneId);
            const n = sc ? sc.name : "";
            // the default mood for a scene that never had music, by its name (the user's choices, 2026-11-18)
            const ids = (b.moods || []).map(m => m.id);
            const rules = [[/start|soon|intro/i, "starting-soon"], [/brb|break|be right back|away/i, "brb"], [/end|outro|bye|thanks/i, "ending"],
                           [/match|game|play|live/i, "in-match"], [/lobby|chat|talk/i, "lobby"]];
            let mood = ids.indexOf("lobby") >= 0 ? "lobby" : (ids[0] || "lobby");
            for (const r of rules) if (r[0].test(n) && ids.indexOf(r[1]) >= 0) { mood = r[1]; break }
            sceneMusicReady(b, sceneId, mood);
        });
    }
    function setSceneMusic(scene, music, then) {
        Api.post("ui/api/music", { op: "scene", scene: scene, music: music }, (ok, b, err) => {
            if (!ok) { then(false, "Not changed: " + ((b && b.text) || err), b); return; }
            if (b.stripAdded) loadMixer();
            then(true, b.stripAdded ? "A Music strip was added to the mixer." : "", b);
        });
    }
    function previewSceneMusic(mood, then) {
        Api.post("ui/api/music", { op: "preview", mood: mood }, (ok, b, err) => {
            if (!ok) { then(false, (b && b.text) || err); return; }
            then(true, "");
        });
    }
    function removeAudio(audio, name) {
        Api.post("ui/api/audio", { op: "remove", audio: audio }, (ok, b, err) => {
            if (!ok) say("Not removed: " + audioError(b, err));
            else say("Removed " + (name || "the sound") + " from the mixer." + (b.saved ? "" : " Not saved to the project file: the change is live only."));
            loadMixer();
        });
    }

    // ---- stream and recording (the widget's hostAction / confirm, D332: one click) ----
    // D389: Go live asks YouTube-ready outputs first. With a YouTube output switched on and YouTube signed in the chooser opens
    // (GoLiveDialog, which then calls startPrepared); with no YouTube output, not signed in, or the options not readable,
    // Go live is the plain stream.start as before. Stop is never asked about.
    function toggleStream() {
        if (live) return hostAction("stream.stop");
        if (actionBusy) return;
        actionBusy = true; // a second click while the options are read does nothing
        Api.get("ui/api/youtube/golive/options", (ok, b) => {
            actionBusy = false;
            const yt = ok && !!b && b.signedIn === true && Array.isArray(b.outputs) && b.outputs.some(o => o.on === true);
            if (yt) goLiveWanted(b); else hostAction("stream.start");
        });
    }
    function startPrepared() { hostAction("stream.start") } // the chooser's Go live, after golive/prepare
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
            if (startRefused(b)) { actionBusy = false; return; }
            if (b.warning) say(b.warning);
            startWarnings(b);
            pollStatus(() => { actionBusy = false; });
        });
    }
    // D386: a refused start says why (detail, as the server wrote it); a missing or failed YouTube event also opens the YouTube window.
    function startRefused(b) {
        if (!b || b.verdict !== "refuse") return false;
        say(typeof b.detail === "string" && b.detail !== "" ? b.detail : "Not started: " + (b.reason || "refused"));
        if (b.reason === "youtube-event-missing" || b.reason === "youtube-event-failed") youtubeEventsWanted();
        return true;
    }
    // D386: warnings of the YouTube events a start made, shown the way a start warning is (the note line).
    function startWarnings(b) {
        const w = [];
        for (const e of (b && Array.isArray(b.youtubeEvents) ? b.youtubeEvents : []))
            for (const t of (Array.isArray(e.warnings) ? e.warnings : [])) w.push(String(t));
        if (w.length) say(w.join("  "));
    }

    // ---- clipping (D281; the widget's Save clip and Mark moment): one click each, no confirm ----
    // Save clip: the replay buffer's last 60 s of H and V as clip files. Mark moment: a marker for the clipper (source
    // api, as the widget button; the hotkey sends its own).
    function saveClip() {
        Api.host("replay.save", {}, (ok, b, err) => {
            if (!ok) return say("Clip not saved: " + err);
            const r = b ? b.result : null;
            const n = r && Array.isArray(r.saved) ? r.saved.length : 0;
            // Off air the host says why (the replay buffer runs only while live or recording, 2026-11-18).
            const why = r && Array.isArray(r.errors) && r.errors.length && r.errors[0].error ? String(r.errors[0].error) : "";
            say(n ? "Clip saved: " + n + " file(s) in the replay folder." : why.indexOf("off air") === 0 ? "Clip not saved: " + why + "." : "Clip not saved: the replay buffer is not running.");
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
            if (startRefused(r)) { actionBusy = false; return; }
            say(r.verdict === "allow" ? "Done." : "Result: " + r.verdict);
            if (r.warning) say(r.warning);
            startWarnings(r);
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
            // D432: a value that did not change is not assigned again: a new array or object on every poll re-ran every
            // binding and handler that reads it (the task panel, the tray, the alert strip) each 2 s for nothing.
            const nextOnAir = h.onAir || {};
            if (JSON.stringify(nextOnAir) !== JSON.stringify(onAir)) onAir = nextOnAir;
            statusAt = typeof s.at === "number" ? s.at : Date.now();
            const nextAlerts = Array.isArray(s.alerts) ? s.alerts : [];
            if (JSON.stringify(nextAlerts) !== JSON.stringify(alerts)) alerts = nextAlerts;
            const nextTasks = Array.isArray(s.tasks) ? s.tasks : [];
            if (JSON.stringify(nextTasks) !== JSON.stringify(tasks)) tasks = nextTasks;
            takeClips(s.clips || {});
            // A restarted host (crash supervisor) lost the previews it drew in our windows: embed them again (D280).
            const up = typeof h.uptimeMs === "number" ? h.uptimeMs : -1;
            // A5 (2026-11-18): the restarted host built its scenes, layers and sounds again: reload all three.
            if (up >= 0 && pHostUptime >= 0 && up < pHostUptime) { hostRestarted(); loadScenes(); }
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
                // B2 (2026-11-18): a device sound that came or went changes the mixer too
                if (pDevicesSeq >= 0 && dv.seq !== pDevicesSeq) { loadLayers(); loadMixer(); if (addOpen) loadStructure(); }
                pDevicesSeq = dv.seq;
            }
            const con = dv && Array.isArray(dv.connectable) ? dv.connectable : [];
            if (JSON.stringify(con) !== JSON.stringify(connectable)) connectable = con;
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
        // 2026-11-26: the queue's honest state (record-clips.mjs clipsState): a paused or waiting job is not "Making clips"
        if (cl.state === "paused") return "Clips paused";
        if (cl.state === "waiting") return "Clips wait for you";
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
        if (cl.stateText) tip += "\n" + cl.stateText + (cl.state === "waiting" ? " (Tasks)" : "");
        if (cl.reason) tip += "\n" + cl.reason;
        if (cl.fix) tip += "\n" + cl.fix;
        if (last.reason) tip += "\nLast time: " + last.reason;
        // RS4: the reel style the last clips used, and per layout what it could not change (plain words, in the tip:
        // nothing on the bar moves)
        const sty = last.styles || {};
        if ((sty.names || []).length) tip += "\nReel style: " + sty.names.join(", ");
        for (const n of (sty.notApplied || [])) tip += "\n" + n.charAt(0).toUpperCase() + n.slice(1);
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
    function answerClips(id, make, remember, look) { // look (D411): this recording's clip look, or null for Settings
        const b = { id: id, make: make, remember: remember };
        if (look) b.look = look;
        Api.post("ui/api/clips/answer", b, (ok, r, err) => {
            say(!ok ? "Answer not saved: " + err
                : make ? "Making clips. You can keep working; the Clips label shows when they are ready." : "No clips made.");
        });
    }
    // 2026-11-27 Make clips from a recording (ui/api/clips/recordings, ui/api/clips/make): a recording with no finished run
    function loadClipRecordings(done) {
        Api.get("ui/api/clips/recordings", (ok, b, err) => done(ok && b && Array.isArray(b.recordings) ? b.recordings : [], ok ? "" : String(err)));
    }
    function makeClipsFrom(name, done) {
        Api.post("ui/api/clips/make", { name: name }, (ok, r, err) => {
            say(ok ? "Making clips from " + name + ". It starts when nothing is recording or live." : "Could not queue it: " + err);
            if (done) done(ok);
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
    function loadLooks() {
        Api.get("ui/api/looks", (ok, b) => { if (ok && Array.isArray(b.looks)) looks = b.looks });
    }
    // RL5 (D445): the user's own looks. done(ok, body, err) gets the route's answer; the look list is read again after.
    function newLookFromReference() { lookFromReferenceWanted() }
    function makeLookFromReference(path, name, done) {
        Api.post("ui/api/looks", { op: "from-reference", path: path, name: name }, (ok, b, err) => {
            if (ok) { loadLooks(); say("Look saved: " + b.look.name + " (glow, grain and vignette from " + ((b.basedOn || {}).name || "the nearest look") + ")") }
            if (done) done(ok, b, err);
        });
    }
    function renameLook(id, name, done) {
        Api.post("ui/api/looks", { op: "rename", id: id, name: name }, (ok, b, err) => {
            if (ok) loadLooks(); else say("Not renamed: " + ((b && b.detail) || err));
            if (done) done(ok, b, err);
        });
    }
    function deleteLook(id, done) {
        Api.post("ui/api/looks", { op: "delete", id: id }, (ok, b, err) => {
            if (ok) { loadLooks(); say("Look deleted. Scenes made with it keep their layers but lose its colour.") } else say("Not deleted: " + ((b && b.detail) || err));
            if (done) done(ok, b, err);
        });
    }
    function takeFlags(list) {
        const f = {};
        for (const x of list) f[x.id] = x.on === true;
        let same = Object.keys(f).length === Object.keys(flags).length;
        for (const k in f) if (same && flags[k] !== f[k]) same = false;
        if (!same) {
            // RareUI slice 1 (D384): the decorated look needs rareui-look; the pack's components block (button style, spinner)
            // is read only with theme-components too. Both off: nothing changes anywhere.
            const look = f["rareui-look"] === true;
            Theme.rareui = look;
            Theme.setComponentsOn(look && f["theme-components"] === true);
            flags = f;
            if (f["realism-look"] === true && looks.length === 0) loadLooks();
        }
        // GUI load (2026-11-25): compared field by field in one pass, not by two JSON texts of the whole list on every poll
        // (7 ms a poll, up to 36 ms, in the realistic probe).
        let sig = "";
        for (const x of list) { for (const k in x) sig += k + "\u0001" + x[k] + "\u0001"; sig += "\u0002" }
        if (sig !== pFlagSig) { pFlagSig = sig; flagList = list; }
    }
    property string pFlagSig: ""

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
            mixer: mixer.map(m => ({ id: m.id, name: m.name, volumeDb: m.volumeDb, muted: !!m.muted, cue: !!m.cue, inStream: inStream(m), audioSource: m.audioSource || null, waiting: m.waiting === true, sameAs: m.sameAs || null })),
            connectable: connectable,
            mixerStripsMade: pStripsMade, // B4: strips built so far (a refresh must not build them again)
            live: live, recording: recording, canStream: canStream, canRecord: canRecord, hostUp: hostUp, note: note
        };
    }

    property Timer pStatus: Timer { interval: 2000; repeat: true; running: true; onTriggered: store.pollStatus() }
    property Timer pMeters: Timer { interval: 250; repeat: true; running: true; onTriggered: store.pollMeters() }
}
