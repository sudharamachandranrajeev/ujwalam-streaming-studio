// SPDX-License-Identifier: GPL-3.0-or-later
// The inspector (the widget's INSPECTOR box: renderInspector, applyInspector): X, Y, width, height, rotation and the four
// crop boxes of the selected layer, Apply and Undo changes. Apply sends only what changed (host layers.setPlacement); a
// held answer waits for one click (D332). The boxes follow the layer again when the selection or its placement changes.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    objectName: "inspectorPanel"
    required property var store
    title: "Inspector"
    implicitHeight: (editable ? form.implicitHeight : empty.implicitHeight) + 56

    readonly property var lyr: store.selectedLayer
    readonly property var place: lyr && lyr.placement && typeof lyr.placement === "object" ? lyr.placement : null
    readonly property bool editable: !!lyr && !!place
    // name, lo, hi, decimals; crop boxes are whole numbers from 0
    readonly property var specs: ({ x: [-16384, 16384, 0], y: [-16384, 16384, 0], width: [1, 16384, 0], height: [1, 16384, 0], rotation: [-360, 360, 1],
                                    left: [0, 16384, 0], top: [0, 16384, 0], right: [0, 16384, 0], bottom: [0, 16384, 0] })
    readonly property var boxes: ({ x: fx, y: fy, width: fw, height: fh, rotation: frot, left: cl, top: ct, right: cr, bottom: cb })

    // A new layer or a new placement from the host: show it (the widget renders on each layer read).
    readonly property string shown: editable ? store.activeScene + "/" + store.selected + "/" + JSON.stringify(place) : ""
    onShownChanged: render()

    function fmt(k, v) { return Number(v || 0).toFixed(specs[k][2]) }
    // The box's value as the widget's spin box keeps it: clamped to its range, rounded to its decimals.
    function value(k) {
        const s = specs[k];
        let v = parseFloat(String(boxes[k].text).replace(",", "."));
        if (!isFinite(v)) v = s[0] > 0 ? s[0] : 0;
        v = Math.min(s[1], Math.max(s[0], v));
        const f = Math.pow(10, s[2]);
        return Math.round(v * f) / f;
    }
    function render() {
        if (!editable) return;
        const p = place, c = p.crop || {};
        for (const k of ["x", "y", "width", "height"]) boxes[k].text = fmt(k, p[k]);
        frot.text = fmt("rotation", p.rotation);
        for (const k of ["left", "top", "right", "bottom"]) boxes[k].text = fmt(k, c[k]);
    }
    function apply() {
        if (!editable) return false;
        const p = place, c = p.crop || {}, patch = {}, crop = {};
        for (const k of ["x", "y", "width", "height", "rotation"]) {
            const v = value(k);
            if (Math.abs(v - (Number(p[k]) || 0)) > 1e-6) patch[k] = v;
        }
        for (const k of ["left", "top", "right", "bottom"]) {
            const v = value(k);
            if (v !== (Number(c[k]) || 0)) crop[k] = v;
        }
        if (Object.keys(crop).length) patch.crop = crop;
        if (!Object.keys(patch).length) { store.say("Nothing changed."); return true; }
        Api.host("layers.setPlacement", store.layerArgs({ layer: store.selected, placement: patch }), (ok, b, err) => {
            if (ok && b.verdict === "confirm") return store.confirmNeeded(b.pending); // a held action (D332)
            store.say(ok ? "Applied." : "Not applied: " + err);
            store.loadLayers();
        });
        return true;
    }

    // ---- probe (tests): inspector-set:<box>:<text>, inspector-apply, inspector-undo ----
    function probe() {
        const v = {};
        for (const k in boxes) v[k] = boxes[k].text;
        return { editable: editable, title: title1.text, sub: sub1.text, empty: editable ? "" : empty.text, values: v };
    }
    function probeAction(a) {
        if (a === "inspector-apply") return apply();
        if (a === "inspector-undo") { if (!editable) return false; render(); return true }
        const p = a.split(":");
        if (p.length < 3 || p[0] !== "inspector-set" || !editable || !boxes[p[1]]) return false;
        boxes[p[1]].text = decodeURIComponent(p.slice(2).join(":"));
        return true;
    }

    component Box: Column {
        property alias text: f.text
        property alias caption: cap.text
        property alias field: f
        spacing: 2
        Text { id: cap; color: Theme.c.muted; font.family: Theme.family; font.pixelSize: Theme.ty.caption }
        UField {
            id: f
            width: parent.width
            label: cap.text
            validator: RegularExpressionValidator { regularExpression: /-?[0-9]*([.,][0-9]*)?/ }
        }
    }

    Text {
        id: empty
        objectName: "inspectorEmpty"
        visible: !panel.editable
        anchors { left: parent.left; right: parent.right; top: parent.top }
        text: panel.lyr ? panel.lyr.name + " has no editable placement." : "Select a layer to edit its position, size and crop."
        wrapMode: Text.Wrap
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }

    Column {
        id: form
        visible: panel.editable
        anchors { left: parent.left; right: parent.right; top: parent.top }
        spacing: Theme.sp.s
        readonly property real cell4: (width - 3 * 8) / 4
        Text {
            id: title1
            width: form.width
            text: panel.lyr ? panel.lyr.name : ""
            elide: Text.ElideRight
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.body
            font.weight: Font.DemiBold
        }
        Text {
            id: sub1
            width: form.width
            text: panel.store.canvas.toUpperCase() + " canvas" + (panel.lyr && panel.lyr.width > 0 ? ", source " + panel.lyr.width + "x" + panel.lyr.height : "")
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.caption
        }
        Row {
            spacing: Theme.sp.s
            Box { id: fx; caption: "X"; width: form.cell4; field.objectName: "inspX" }
            Box { id: fy; caption: "Y"; width: form.cell4; field.objectName: "inspY" }
            Box { id: fw; caption: "Width"; width: form.cell4; field.objectName: "inspW" }
            Box { id: fh; caption: "Height"; width: form.cell4; field.objectName: "inspH" }
        }
        Box { id: frot; caption: "Rotation"; width: form.cell4 * 2 + 8; field.objectName: "inspRot" }
        Row {
            spacing: Theme.sp.s
            Box { id: cl; caption: "Crop left"; width: form.cell4; field.objectName: "inspCropL" }
            Box { id: ct; caption: "Crop top"; width: form.cell4; field.objectName: "inspCropT" }
            Box { id: cr; caption: "Crop right"; width: form.cell4; field.objectName: "inspCropR" }
            Box { id: cb; caption: "Crop bottom"; width: form.cell4; field.objectName: "inspCropB" }
        }
        Row {
            spacing: Theme.sp.s
            UButton { objectName: "inspApply"; text: "Apply"; kind: "primary"; onClicked: panel.apply() }
            UButton { objectName: "inspUndo"; text: "Undo changes"; tip: "Show the layer's current values again."; onClicked: panel.render() }
        }
    }
}
