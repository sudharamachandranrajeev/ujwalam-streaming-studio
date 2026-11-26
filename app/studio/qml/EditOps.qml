// SPDX-License-Identifier: GPL-3.0-or-later
// Editing in the QML studio (plan Q4, section B): undo and redo of layer edits, the arrow-key nudge, and the layer and
// scene operations of the right-click menus and keys. Each one is the QML twin of the widget studio's function of the
// same name (main_window.cpp: loadEdits, undoRedo, nudge, layerDuplicate, layerMoveTo, lookCopy, sceneRename ...): same
// routes, same words, same rules (edits are refused while live exactly as the widget refuses them, D332: the click acts,
// no question). Structure changes go through Store.structureEdit; host changes through Api.host.
import QtQuick
import Ujwalam.Core

QtObject {
    id: ops
    required property var store

    signal renameWanted(string kind, string id, string current) // the name window opens (Main.qml)

    // ---- undo and redo (D238) ----
    property int undoCount: 0
    property int redoCount: 0
    property string nextUndo: ""
    property string nextRedo: ""
    property bool undoBusy: false
    // The UI server refuses undo while live (D238), so the buttons are off then.
    readonly property bool canUndo: !store.live && !undoBusy && undoCount > 0
    readonly property bool canRedo: !store.live && !undoBusy && redoCount > 0

    function loadEdits() {
        Api.get("ui/api/edits", (ok, e) => {
            if (!ok) return;
            undoCount = e.undo || 0;
            redoCount = e.redo || 0;
            nextUndo = e.nextUndo || "";
            nextRedo = e.nextRedo || "";
        });
    }

    function undoRedo(undo) {
        if (store.live) return store.say("Live: undo and redo are off. Use the inspector.");
        if (undoBusy) return;
        undoBusy = true;
        Api.post(undo ? "ui/api/edits/undo" : "ui/api/edits/redo", {}, (ok, b, err) => {
            undoBusy = false;
            if (!ok) store.say((undo ? "Nothing undone: " : "Nothing redone: ") + err);
            else store.say((undo ? "Undone: " : "Redone: ") + (b.method || "") + " " + (b.layer || ""));
            store.loadLayers();
            loadEdits();
        });
    }

    // ---- keys of the window: the same table drives the Shortcuts in Main.qml and the tests' key: probe ----
    readonly property var windowKeys: ["Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Left", "Right", "Up", "Down", "Shift+Left", "Shift+Right", "Shift+Up", "Shift+Down"]
    function windowKey(seq) {
        const d = { "Left": [-1, 0], "Right": [1, 0], "Up": [0, -1], "Down": [0, 1] };
        if (seq === "Ctrl+Z") { undoRedo(true); return true }
        if (seq === "Ctrl+Y" || seq === "Ctrl+Shift+Z") { undoRedo(false); return true }
        const shift = seq.startsWith("Shift+");
        const v = d[shift ? seq.slice(6) : seq];
        if (!v) return false;
        return nudge(v[0] * (shift ? 10 : 1), v[1] * (shift ? 10 : 1));
    }

    // ---- arrow-key nudge (D254): only while preview editing is on and a layer with a placement is selected; off while
    // live (each press is its own live change). Presses made while a move is on its way add up into one setPlacement.
    property int nudgeDx: 0
    property int nudgeDy: 0
    property bool nudgeBusy: false

    function nudge(dx, dy) {
        const l = store.selectedLayer;
        if (!store.previewEditing || !l || !l.placement || Object.keys(l.placement).length === 0) return false;
        if (store.live) { store.say("Live: arrow keys are off. Use the inspector."); return true }
        nudgeDx += dx;
        nudgeDy += dy;
        sendNudge();
        return true;
    }

    function sendNudge() {
        if (nudgeBusy || (!nudgeDx && !nudgeDy)) return;
        const l = store.selectedLayer;
        const p = l ? l.placement : null;
        if (!p || Object.keys(p).length === 0) { nudgeDx = 0; nudgeDy = 0; return; }
        const patch = {};
        if (nudgeDx) patch.x = Math.round(((p.x || 0) + nudgeDx) * 100) / 100;
        if (nudgeDy) patch.y = Math.round(((p.y || 0) + nudgeDy) * 100) / 100;
        nudgeDx = 0;
        nudgeDy = 0;
        nudgeBusy = true;
        const layer = store.selected;
        Api.host("layers.setPlacement", store.layerArgs({ layer: layer, placement: patch }), (ok, b, err) => {
            nudgeBusy = false;
            if (ok && b.verdict === "confirm") {
                // a held answer is cancelled: arrow keys never wait for a click
                Api.post("ui/api/cancel", { pendingId: b.pending ? b.pending.pendingId : "" }, () => {});
                nudgeDx = 0;
                nudgeDy = 0;
                return store.say("Live: arrow keys are off. Use the inspector.");
            }
            if (!ok) {
                nudgeDx = 0;
                nudgeDy = 0;
                store.say("Not moved: " + err);
                return store.loadLayers();
            }
            // keep the cached placement current so the next nudge adds to it before the list reloads
            store.layers = store.layers.map(x => x.id !== layer ? x : Object.assign({}, x, { placement: Object.assign({}, x.placement, patch) }));
            if (nudgeDx || nudgeDy) return sendNudge();
            store.loadLayers();
            loadEdits();
        });
    }

    // ---- layer operations (the layer menu and its keys) ----
    function layerIndex() { return store.layers.findIndex(l => l.id === store.selected) } // host order: bottom first

    function duplicateLayer() {
        if (!store.selectedLayer) return store.say("Select a layer first.");
        if (store.live) return store.say("Not while live.");
        store.structureEdit({ op: "layer.duplicate", scene: store.activeScene, layer: store.selected });
    }

    function renameLayerWanted() {
        const l = store.selectedLayer;
        if (!l) return store.say("Select a layer first.");
        if (store.live) return store.say("Not while live.");
        renameWanted("layer", l.id, l.name || "");
    }
    function renameLayer(id, name) {
        const n = String(name).trim();
        const l = store.layers.find(x => x.id === id);
        if (n === "" || !l || n === l.name) return;
        store.structureEdit({ op: "layer.rename", scene: store.activeScene, layer: id, name: n.slice(0, 80) });
    }

    function toggleVisible() {
        const l = store.selectedLayer;
        if (!l) return;
        store.setVisible(l.id, !l.visible);
    }

    // Host order is bottom first, so a higher index is higher in the picture. Offline the move is saved into the project
    // (structure op layer.move to a target layer, D330); live, or for a layer the project does not have, it goes to the
    // host only (layers.move), on the click (D332).
    function moveTo(index) {
        const n = store.layers.length;
        const id = store.selected;
        if (id === "" || index < 0 || index >= n) return;
        // The host fallback is built now, from the layer, scene and canvas the user moved: the structure reply comes later.
        const hostArgs = store.layerArgs({ layer: id, index: index });
        const order = store.layers.filter(l => l.id !== id).map(l => l.id); // host order with the moved layer taken out
        if (!store.live && order.length === n - 1 && order.length > 0) {
            const below = index === 0; // to the bottom: under the layer that is lowest now
            const target = below ? order[0] : order[Math.min(index, order.length) - 1];
            const body = { op: "layer.move", scene: store.activeScene, layer: id, canvas: store.canvas, target: target, place: below ? "below" : "above" };
            Api.post("ui/api/project/structure", body, (ok, b, err) => {
                const e = String(err);
                if (!ok && (e.includes("unknown-layer") || e.includes("not-on-canvas") || e.includes("unknown-scene") || e.includes("no-project-file")))
                    return moveHost(hostArgs); // not a project layer: the live-only order, as before
                if (!ok) store.say("Not moved: " + store.plainStructureError(b && b.error ? b.error : err));
                else if (!b.saved) store.say("Moved. Not saved to the project file: the change is live only.");
                store.loadScenes();
                loadEdits(); // a structure edit clears the undo history
            });
            return;
        }
        moveHost(hostArgs);
    }
    function moveHost(args) {
        Api.host("layers.move", args, (ok, b, err) => {
            if (!ok) store.say("Move failed: " + err);
            else if (b.verdict === "confirm") return store.confirmNeeded(b.pending);
            store.loadLayers();
            loadEdits();
        });
    }

    // ---- copy and paste a look (effects of one layer onto another; layers.setEffects, on the click also while live) ----
    property var lookClip: []
    property bool hasLookClip: false

    function copyLook() {
        const l = store.selectedLayer;
        if (!l || l.placement === undefined) return store.say("Select a layer first.");
        lookClip = Array.isArray(l.effects) ? l.effects.slice() : [];
        hasLookClip = true;
        store.say(lookClip.length === 0 ? "Copied: this layer has no look." : "Look copied (" + lookClip.length + " effect(s)).");
    }
    function pasteLook() {
        const l = store.selectedLayer;
        if (!hasLookClip) return store.say("Copy a look first.");
        if (!l || l.placement === undefined) return store.say("Select a layer first.");
        sendLook({ scene: store.activeScene, layer: store.selected, effects: lookClip });
    }
    property bool lookSending: false
    property var lookAgain: null
    function sendLook(x) {
        if (lookSending) { lookAgain = x; return }
        lookSending = true;
        Api.host("layers.setEffects", x, (ok, b, err) => {
            lookSending = false;
            if (ok && b.verdict === "confirm") { lookAgain = null; return store.confirmNeeded(b.pending) }
            store.say(ok ? "Look applied." : "Look not applied: " + err);
            if (lookAgain) { const again = lookAgain; lookAgain = null; return sendLook(again) }
            store.loadLayers();
            loadEdits();
        });
    }

    // ---- scene operations ----
    function renameSceneWanted(id) {
        if (store.live) return store.say("Not while live.");
        const s = store.scenes.find(x => x.id === id);
        if (!s) return;
        renameWanted("scene", id, s.name || "");
    }
    function renameScene(id, name) {
        const n = String(name).trim();
        const s = store.scenes.find(x => x.id === id);
        if (n === "" || !s || n === s.name) return;
        store.structureEdit({ op: "scene.rename", scene: id, name: n.slice(0, 80) });
    }
    function duplicateScene(id) {
        if (store.live) return store.say("Not while live.");
        store.structureEdit({ op: "scene.duplicate", scene: id });
    }
    // D381, D445: one click on a look, no question (D332). The server copies the scene as "<scene> <look name>" and grades
    // its game layers with that look; the original stays.
    function realismScene(id, look) {
        if (store.live) return store.say("Not while live.");
        store.structureEdit(look ? { op: "scene.realism", scene: id, look: look } : { op: "scene.realism", scene: id });
    }

    function probe() {
        return { undo: undoCount, redo: redoCount, nextUndo: nextUndo, nextRedo: nextRedo, canUndo: canUndo, canRedo: canRedo,
                 lookClip: lookClip, hasLookClip: hasLookClip };
    }
}
