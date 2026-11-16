// SPDX-License-Identifier: GPL-3.0-or-later
// The Look panel (D290; the widget's LookPanel and applyLook): one card per effect type from the shared table
// (Api.fxTypes, fx_types.h), grouped Shape, Filters, Camera, Blend, Shadow & glow; a switch and its sliders or colours.
// It edits the selected layer's whole effects list: types it does not know, and further copies of a type, stay as they
// are. At most 6 effects. Offline a change goes to the host 250 ms after the last one (layers.setEffects, saved into the
// project, undoable); live the Apply button sends it (D332: the click acts). Shown for a layer with a placement.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    objectName: "lookPanel"
    required property var store
    title: "Look"
    visible: shown
    implicitHeight: visible ? col.implicitHeight + 56 : 0

    readonly property int max: 6
    readonly property var lyr: store.selectedLayer
    readonly property bool shown: !!lyr && !!lyr.placement && typeof lyr.placement === "object"
    readonly property bool live: store.live === true
    readonly property var groupOrder: ["shape", "filter", "camera", "compositing", "light"]
    readonly property var groupTitles: ({ shape: "Shape", filter: "Filters", camera: "Camera", compositing: "Blend", light: "Shadow & glow" })

    // The cards in group order (then any other group as first seen); "rounded" leads its group.
    readonly property var cards: {
        const types = Api.fxTypes(), order = groupOrder.slice();
        for (const t of types) if (order.indexOf(t.group) < 0) order.push(t.group);
        const out = [];
        for (const g of order) {
            const mine = types.filter(t => t.group === g);
            mine.sort((a, b) => (b.type === "rounded") - (a.type === "rounded"));
            mine.forEach((t, i) => out.push(Object.assign({ first: i === 0, groupTitle: groupTitles[g] || (g ? g.charAt(0).toUpperCase() + g.slice(1) : "Other") }, t)));
        }
        return out;
    }

    property var effects: []      // the working list (the layer's, with unsent changes)
    property bool dirty: false    // changed since the last answer from the host
    property int rev: 0
    property string key: ""       // scene/layer the working list belongs to
    property bool applyEnabled: false
    property bool sending: false
    property bool again: false
    property var sliders: ({})    // "type/key" -> UValueSlider (the probe types into the real box)

    // A new layer, or the same layer with no unsent change: take its effects (the widget's renderInspector rule).
    readonly property string source: shown ? store.activeScene + "/" + store.selected + "\n" + JSON.stringify(lyr.effects || []) : ""
    onSourceChanged: {
        if (!shown) return;
        const k = store.activeScene + "/" + store.selected;
        if (k === key && dirty) return; // a reload keeps unsent changes of the same layer
        const other = k !== key;
        key = k;
        effects = Array.isArray(lyr.effects) ? lyr.effects.slice() : [];
        dirty = false;
        if (other) { applyEnabled = false; debounce.stop(); }
    }
    onLiveChanged: if (!live) applyEnabled = false

    Timer { id: debounce; interval: 250; onTriggered: panel.apply() } // a slider drag sends once

    function indexOf(type) { for (let i = 0; i < effects.length; i++) if (effects[i].type === type) return i; return -1 }
    function isOn(type) { return indexOf(type) >= 0 }
    function valueOf(t, p) {
        const i = indexOf(t.type), e = i >= 0 ? effects[i] : {};
        if (p.colour) return typeof e[p.key] === "string" ? e[p.key] : p.cdef;
        return typeof e[p.key] === "number" ? e[p.key] : p.def;
    }
    function changed() {
        rev++;
        dirty = true;
        if (live) applyEnabled = true; else debounce.restart();
    }
    function setParam(type, k, v) {
        const i = indexOf(type);
        if (i < 0 || effects[i][k] === v) return;
        const next = effects.slice();
        next[i] = Object.assign({}, next[i]);
        next[i][k] = v;
        effects = next;
        changed();
    }
    function toggle(t, on) {
        const i = indexOf(t.type);
        if (on && i < 0) {
            if (effects.length >= max) { store.say("A layer has at most " + max + " effects. Switch one off first."); return false; }
            const e = { type: t.type };
            for (const p of t.params) e[p.key] = p.colour ? p.cdef : p.def;
            effects = effects.concat([e]);
        } else if (!on && i >= 0) {
            effects = effects.filter((x, j) => j !== i);
        } else return false;
        changed();
        return true;
    }
    function apply() {
        if (sending) { again = true; return; }
        if (!store.selected || !store.activeScene) return;
        sending = true;
        const k = store.activeScene + "/" + store.selected, r = rev;
        Api.host("layers.setEffects", { scene: store.activeScene, layer: store.selected, effects: effects }, (ok, b, err) => {
            sending = false;
            if (ok && b.verdict === "confirm") { again = false; return store.confirmNeeded(b.pending); }
            if (ok && key === k && rev === r) dirty = false; // not when the list changed or moved on while it was sent
            store.say(ok ? "Look applied." : "Look not applied: " + err);
            if (again) { again = false; return apply(); }
            store.loadLayers();
        });
    }

    // ---- Advanced effects (D260, flag effect-editor; the widget's plain list under Look) ----
    // The same working list as the cards, in its real order, every copy of a type, with Add, Up, Down and Remove and the
    // chosen effect's settings. Nothing goes out until Apply effects (the whole list, layers.setEffects); Revert drops
    // the unsent changes. At most 6 effects.
    readonly property bool advShown: store.effectEditing === true
    property int advRow: -1
    property var advSliders: ({}) // param key -> UValueSlider of the chosen effect (the probe types into the real box)
    readonly property var advType: advRow >= 0 && advRow < effects.length ? fxType(effects[advRow].type) : null
    function fxType(type) { return Api.fxTypes().find(t => t.type === type) || null }
    function summary(e) {
        const t = fxType(e.type);
        if (!t) return e.type + " (not editable here)";
        const parts = t.params.slice(0, 3).map(p => p.colour ? String(e[p.key] || "") : String(Number(Number(e[p.key] || 0).toPrecision(4))));
        return t.label + "  " + parts.join(", ");
    }
    onEffectsChanged: if (advRow >= effects.length || (advRow < 0 && effects.length)) advRow = effects.length ? Math.max(0, Math.min(advRow, effects.length - 1)) : -1
    function advEdit(next, row) {
        effects = next;
        advRow = row;
        rev++;
        dirty = true; // no automatic send: Apply effects sends the list
    }
    function advAdd(type) {
        const t = fxType(type);
        if (!t) return false;
        if (effects.length >= max) { store.say("A layer has at most " + max + " effects."); return false; }
        const e = { type: t.type };
        for (const p of t.params) e[p.key] = p.colour ? p.cdef : p.def;
        advEdit(effects.concat([e]), effects.length);
        return true;
    }
    function advRemove() {
        if (advRow < 0 || advRow >= effects.length) return false;
        const next = effects.filter((x, j) => j !== advRow);
        advEdit(next, Math.min(advRow, next.length - 1));
        return true;
    }
    function advShift(by) {
        const to = advRow + by;
        if (advRow < 0 || to < 0 || to >= effects.length) return false;
        const next = effects.slice();
        next[advRow] = effects[to];
        next[to] = effects[advRow];
        advEdit(next, to);
        return true;
    }
    function advSet(k, v) {
        if (advRow < 0 || advRow >= effects.length || effects[advRow][k] === v) return;
        const next = effects.slice();
        next[advRow] = Object.assign({}, next[advRow]);
        next[advRow][k] = v;
        advEdit(next, advRow);
    }
    function advApply() {
        if (!store.selected || !store.activeScene) return;
        const k = store.activeScene + "/" + store.selected, r = rev;
        Api.host("layers.setEffects", { scene: store.activeScene, layer: store.selected, effects: effects }, (ok, b, err) => {
            if (ok && b.verdict === "confirm") return store.confirmNeeded(b.pending);
            if (ok && key === k && rev === r) dirty = false;
            store.say(ok ? "Effects applied." : "Effects not applied: " + err);
            store.loadLayers();
        });
    }
    function advRevert() {
        dirty = false;
        effects = Array.isArray(lyr.effects) ? lyr.effects.slice() : []; // the layer's list again
        debounce.stop();
        applyEnabled = false;
    }

    // ---- probe (tests): look:<type>:<on|off>, look-set:<type>:<key>:<value> (the real number box), look-apply;
    // adv-add:<type>, adv-row:<n>, adv-up, adv-down, adv-remove, adv-set:<key>:<value>, adv-apply, adv-revert ----
    function probe() {
        const groups = [];
        for (const c of cards) if (groups.indexOf(c.group) < 0) groups.push(c.group);
        return { shown: visible, cards: cards.map(c => ({ type: c.type, group: c.group, on: isOn(c.type), params: c.params.length })),
                 groups: groups, effects: effects, live: live, applyEnabled: applyEnabled, dirty: dirty,
                 advancedShown: advShown && visible, advanced: { rows: effects.map(summary), row: advRow } };
    }
    function advAction(a) {
        const p = a.split(":");
        if (!advShown) return false;
        if (p[0] === "adv-add" && p.length === 2) { addType.pick(p[1]); if (addType.value !== p[1]) return false; addBtn.clicked(); return effects.length > 0 && effects[effects.length - 1].type === p[1] }
        if (p[0] === "adv-row" && p.length === 2) { const n = Number(p[1]); if (!(n >= 0 && n < effects.length)) return false; advRow = n; return true }
        if (a === "adv-up") { if (!upBtn.enabled) return false; upBtn.clicked(); return true }
        if (a === "adv-down") { if (!downBtn.enabled) return false; downBtn.clicked(); return true }
        if (a === "adv-remove") { if (!removeBtn.enabled) return false; removeBtn.clicked(); return true }
        if (a === "adv-apply") { advApplyBtn.clicked(); return true }
        if (a === "adv-revert") { advRevertBtn.clicked(); return true }
        if (p[0] === "adv-set" && p.length === 3) { const s = advSliders[p[1]]; return !!s && s.typeValue(p[2]) }
        return false;
    }
    function probeAction(a) {
        const p = a.split(":");
        if (!shown) return false;
        if (a.startsWith("adv-")) return advAction(a);
        if (a === "look-apply") { if (!applyBtn.enabled) return false; applyBtn.clicked(); return true }
        if (p.length === 3 && p[0] === "look") {
            const t = cards.find(c => c.type === p[1]);
            if (!t) return false;
            if (isOn(t.type) !== (p[2] === "on")) toggle(t, p[2] === "on");
            return true;
        }
        if (p.length === 4 && p[0] === "look-set") {
            const s = sliders[p[1] + "/" + p[2]];
            if (!s || !isOn(p[1])) return false;
            return s.typeValue(p[3]);
        }
        return false;
    }

    Column {
        id: col
        anchors { left: parent.left; right: parent.right; top: parent.top }
        spacing: Theme.sp.s

        // Live: no automatic sends (each slider step would be its own live change); Apply sends the whole list once.
        Item {
            visible: panel.live
            width: col.width
            height: visible ? Math.max(liveHint.implicitHeight, applyBtn.implicitHeight) : 0
            Text {
                id: liveHint
                anchors { left: parent.left; right: applyBtn.left; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                text: "You are live. Changes are sent when you press Apply."
                wrapMode: Text.Wrap
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.small
            }
            UButton {
                id: applyBtn
                objectName: "lookApply"
                anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                text: "Apply"
                kind: "primary"
                enabled: panel.applyEnabled
                onClicked: { panel.applyEnabled = false; panel.apply(); }
            }
        }
        Text {
            visible: panel.cards.length === 0
            text: "No looks are available."
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }

        Repeater {
            model: panel.cards
            delegate: Column {
                id: card
                required property var modelData
                readonly property bool on: panel.isOn(modelData.type)
                width: col.width
                spacing: Theme.sp.s
                Text {
                    visible: card.modelData.first
                    text: String(card.modelData.groupTitle).toUpperCase()
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.caption
                    font.weight: Font.DemiBold
                    font.letterSpacing: 1
                }
                Rectangle {
                    objectName: "lookCard:" + card.modelData.type
                    width: card.width
                    height: cardBody.implicitHeight + 16
                    radius: Theme.radiusMedium
                    color: Theme.c.field
                    border.width: 1
                    border.color: card.on ? Theme.c.accent : Theme.c.border
                    Column {
                        id: cardBody
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: Theme.sp.s; leftMargin: Theme.sp.m; rightMargin: Theme.sp.m }
                        spacing: Theme.sp.s
                        Item {
                            width: cardBody.width
                            height: sw.implicitHeight
                            Text {
                                anchors { left: parent.left; right: sw.left; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                                text: card.modelData.label
                                elide: Text.ElideRight
                                color: Theme.c.text
                                font.family: Theme.family
                                font.pixelSize: Theme.ty.body
                                font.weight: Font.DemiBold
                            }
                            USwitch {
                                id: sw
                                objectName: "lookSwitch:" + card.modelData.type
                                anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                                wrap: false
                                Accessible.name: "Switch " + card.modelData.label + " on or off for this layer"
                                checked: card.on
                                ToolTip.visible: hovered
                                ToolTip.text: "Switch " + card.modelData.label + " on or off for this layer"
                                ToolTip.delay: 500
                                onToggled: { const v = checked; checked = Qt.binding(() => card.on); panel.toggle(card.modelData, v); }
                            }
                        }
                        Repeater {
                            model: card.on ? card.modelData.params : []
                            delegate: Column {
                                id: prm
                                required property var modelData
                                width: cardBody.width
                                spacing: 2
                                Text { text: prm.modelData.label; color: Theme.c.muted; font.family: Theme.family; font.pixelSize: Theme.ty.caption }
                                UValueSlider {
                                    id: vsl
                                    objectName: "lookSlider:" + reg
                                    visible: !prm.modelData.colour
                                    width: prm.width
                                    from: prm.modelData.lo
                                    to: prm.modelData.hi
                                    stepSize: prm.modelData.step
                                    decimals: prm.modelData.dec
                                    label: prm.modelData.label
                                    value: prm.modelData.colour ? 0 : panel.valueOf(card.modelData, prm.modelData)
                                    onCommitted: (v) => panel.setParam(card.modelData.type, prm.modelData.key, v)
                                    readonly property string reg: card.modelData.type + "/" + prm.modelData.key
                                    Component.onCompleted: if (!prm.modelData.colour) { const m = Object.assign({}, panel.sliders); m[reg] = vsl; panel.sliders = m; }
                                    Component.onDestruction: { const m = Object.assign({}, panel.sliders); if (m[reg] === vsl) { delete m[reg]; panel.sliders = m; } }
                                }
                                Row {
                                    visible: prm.modelData.colour
                                    spacing: Theme.sp.s
                                    Button {
                                        id: swatch
                                        objectName: "swatch"
                                        width: 30; height: 24
                                        hoverEnabled: true
                                        Accessible.name: "Pick a colour"
                                        ToolTip.visible: hovered
                                        ToolTip.text: "Pick a colour"
                                        ToolTip.delay: 500
                                        background: Rectangle {
                                            radius: Theme.radiusSmall
                                            color: prm.modelData.colour ? panel.valueOf(card.modelData, prm.modelData) : "transparent"
                                            border.width: 1
                                            border.color: Theme.c.disabled
                                        }
                                        onClicked: {
                                            const c = Api.chooseColour(panel.valueOf(card.modelData, prm.modelData));
                                            if (c !== "") panel.setParam(card.modelData.type, prm.modelData.key, c.toLowerCase());
                                        }
                                    }
                                    UField {
                                        id: hexBox
                                        width: prm.width - swatch.width - 8
                                        label: prm.modelData.label
                                        maximumLength: 7
                                        validator: RegularExpressionValidator { regularExpression: /^#[0-9a-fA-F]{0,6}$/ }
                                        text: prm.modelData.colour ? panel.valueOf(card.modelData, prm.modelData) : ""
                                        onTextEdited: if (/^#[0-9a-fA-F]{6}$/.test(text)) panel.setParam(card.modelData.type, prm.modelData.key, text.toLowerCase())
                                        onEditingFinished: hexBox.text = Qt.binding(() => prm.modelData.colour ? panel.valueOf(card.modelData, prm.modelData) : "")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Advanced effects (flag effect-editor)
        Column {
            id: adv
            objectName: "lookAdvanced"
            visible: panel.advShown
            width: col.width
            spacing: Theme.sp.s
            Text {
                text: "ADVANCED EFFECTS"
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.caption
                font.weight: Font.DemiBold
                font.letterSpacing: 1
            }
            Text {
                visible: panel.effects.length === 0
                width: adv.width
                wrapMode: Text.Wrap
                text: "No effects. Pick one and press Add."
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.small
            }
            Repeater {
                model: panel.effects
                delegate: Rectangle {
                    id: advItem
                    required property var modelData
                    required property int index
                    objectName: "advRow:" + index
                    width: adv.width
                    height: 28
                    radius: Theme.radiusSmall
                    color: panel.advRow === index ? Theme.c.field : "transparent"
                    border.width: panel.advRow === index ? 1 : 0
                    border.color: Theme.c.accent
                    Text {
                        anchors { left: parent.left; right: parent.right; leftMargin: Theme.sp.s; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                        text: panel.summary(advItem.modelData)
                        elide: Text.ElideRight
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.small
                    }
                    MouseArea { anchors.fill: parent; onClicked: panel.advRow = advItem.index }
                }
            }
            Row {
                spacing: Theme.sp.s
                UCombo {
                    id: addType
                    objectName: "advType"
                    label: "Effect to add"
                    width: adv.width - addBtn.width - 6
                    model: Api.fxTypes().map(t => ({ value: t.type, text: t.label }))
                }
                UButton {
                    id: addBtn
                    objectName: "advAdd"
                    text: "Add"
                    tip: "Add this effect to the end of the list (at most 6)."
                    onClicked: panel.advAdd(addType.value)
                }
            }
            Row {
                spacing: Theme.sp.s
                UButton { id: upBtn; objectName: "advUp"; text: "Up"; enabled: panel.advRow > 0; onClicked: panel.advShift(-1) }
                UButton { id: downBtn; objectName: "advDown"; text: "Down"; enabled: panel.advRow >= 0 && panel.advRow < panel.effects.length - 1; onClicked: panel.advShift(1) }
                UButton { id: removeBtn; objectName: "advRemove"; text: "Remove"; enabled: panel.advRow >= 0 && panel.advRow < panel.effects.length; onClicked: panel.advRemove() }
            }
            Text {
                visible: panel.advRow >= 0 && panel.advRow < panel.effects.length && !panel.advType
                width: adv.width
                wrapMode: Text.Wrap
                text: "This effect type has no settings here; it is kept as it is."
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.small
            }
            Repeater {
                model: panel.advType ? panel.advType.params : []
                delegate: Column {
                    id: ap
                    required property var modelData
                    readonly property var cur: panel.advRow >= 0 && panel.advRow < panel.effects.length ? panel.effects[panel.advRow] : ({})
                    width: adv.width
                    spacing: 2
                    Text { text: ap.modelData.label; color: Theme.c.muted; font.family: Theme.family; font.pixelSize: Theme.ty.caption }
                    UValueSlider {
                        id: asl
                        visible: !ap.modelData.colour
                        width: ap.width
                        from: ap.modelData.lo
                        to: ap.modelData.hi
                        stepSize: ap.modelData.step
                        decimals: ap.modelData.dec
                        label: ap.modelData.label
                        value: ap.modelData.colour ? 0 : (typeof ap.cur[ap.modelData.key] === "number" ? ap.cur[ap.modelData.key] : ap.modelData.def)
                        onCommitted: (v) => panel.advSet(ap.modelData.key, v)
                        Component.onCompleted: if (!ap.modelData.colour) { const m = Object.assign({}, panel.advSliders); m[ap.modelData.key] = asl; panel.advSliders = m; }
                        Component.onDestruction: { const m = Object.assign({}, panel.advSliders); if (m[ap.modelData.key] === asl) { delete m[ap.modelData.key]; panel.advSliders = m; } }
                    }
                    UField {
                        id: advHex
                        visible: ap.modelData.colour
                        width: ap.width
                        label: ap.modelData.label
                        maximumLength: 7
                        validator: RegularExpressionValidator { regularExpression: /^#[0-9a-fA-F]{0,6}$/ }
                        text: ap.modelData.colour ? (typeof ap.cur[ap.modelData.key] === "string" ? ap.cur[ap.modelData.key] : ap.modelData.cdef) : ""
                        onTextEdited: if (/^#[0-9a-fA-F]{6}$/.test(text)) panel.advSet(ap.modelData.key, text.toLowerCase())
                    }
                }
            }
            Row {
                spacing: Theme.sp.s
                UButton {
                    id: advApplyBtn
                    objectName: "advApply"
                    text: "Apply effects"
                    kind: "primary"
                    tip: "Send this whole list to the layer, on every canvas of the scene."
                    onClicked: panel.advApply()
                }
                UButton {
                    id: advRevertBtn
                    objectName: "advRevert"
                    text: "Revert"
                    tip: "Drop the changes not sent yet."
                    onClicked: panel.advRevert()
                }
            }
        }
    }
}
