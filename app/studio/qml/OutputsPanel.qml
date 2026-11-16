// SPDX-License-Identifier: GPL-3.0-or-later
// The Outputs panel (D327 OS3, reworked D389): one card per destination, in plain words, in the way Meld Studio shows
// where a stream goes. A card says where ("YouTube · landscape", "Twitch"), how good ("1440p, 24 Mbps"), its state in one
// chip (Ready, Add the key, Live, Off, Problem) with the plain reason under it, and has one big "Go live here" switch.
// The switch shows the real saved state: while it saves it shows a spinner and keeps the value the user chose (it never
// flips back and forth), and the card never changes size. Two switched-on destinations that would send to the same
// platform with the same key are flagged on both cards. A line at the bottom says what Go live starts. The grid reflows
// from one to two columns with the panel width; text elides with a tooltip; nothing overlaps.
// Offline the switch is the saved choice of what Go live starts; live it starts or stops that one output on the click
// (D332). Data: ui/api/outputs/panel (states, saved choice, summary words) and, when platform-connect is on,
// ui/api/connect (key stored yes/no and its last 4 characters, never the key). No feature flag to find: the panel is on by
// default (user-requested feature); it is hidden only when the user switched outputs-panel off in Settings > Features.
// Virtual Camera (not in this host build) stays below the cards, switched off. Height follows the cards, so the layers
// list above keeps the rest.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    objectName: "outputsPanel"
    required property var store
    title: "Where you go live"
    visible: !offByUser && loaded
    implicitHeight: visible ? rows.implicitHeight + 56 : 0

    property var panelData: ({})
    property var outputs: []        // the card list: replaced only when the ids change, so the switches keep their place
    property var cardById: ({})     // every read: what each card shows
    property var connectRows: null  // ui/api/connect outputs (read now and then), or null when not available
    property bool loaded: false
    property bool offByUser: false  // the server said outputs-panel is switched off
    property bool busy: false
    property bool redo: false
    property int seq: 0             // refreshes started
    property int connectReads: 0
    property var pending: ({})      // output id -> { on, settled }: a switch the user flipped, kept on screen until a later read
    property var flips: ({})        // output id -> the values its switch took after it was drawn (a probe reads this: no flicker)
    readonly property bool live: panelData.live === true
    readonly property int cols: rows.width >= 560 ? 2 : 1
    readonly property int gap: 8
    readonly property int cardW: Math.floor((rows.width - gap * (cols - 1)) / cols)
    readonly property string summaryLine: summaryOf(outputs.map(o => cardById[o.id]).filter(c => !!c))

    Connections {
        target: panel.store
        function onFlagsRead() { panel.refresh() }
    }

    // ---- reading ----
    function refresh() {
        if (busy) { redo = true; return }
        busy = true;
        const my = ++seq;
        Api.get("ui/api/outputs/panel", (ok, b, err) => {
            if (!ok) {
                offByUser = !!b && b.error === "outputs-panel-off";
                if (!offByUser && !loaded) store.say("Outputs not available: " + err);
                return done();
            }
            offByUser = false;
            const wantKeys = store.flags["platform-connect"] === true && (connectRows === null || connectReads++ % 8 === 0);
            if (!wantKeys) return take(my, b, connectRows);
            Api.get("ui/api/connect", (ok2, c) => take(my, b, ok2 && c && Array.isArray(c.outputs) ? c.outputs : connectRows));
        });
    }
    function done() {
        busy = false;
        if (redo) { redo = false; refresh() }
    }
    function take(my, b, keyRows) {
        connectRows = store.flags["platform-connect"] === true ? keyRows : null;
        const list = Array.isArray(b.outputs) ? b.outputs : [];
        panelData = b;
        const cards = build(list, b.live === true);
        const ids = list.map(o => o.id).join("\n");
        cardById = cards; // before the list: a new card is drawn with what it shows
        const next = Object.assign({}, pending); // after the cards: the switch goes from the chosen state to the new one in one step
        for (const id in next) if (next[id].settled >= 0 && my > next[id].settled) delete next[id]; // a read made after the click
        pending = next;
        if (!loaded || ids !== outputs.map(o => o.id).join("\n")) outputs = list;
        loaded = true;
        done();
    }

    // ---- what a card says ----
    function isOn(o) {
        if (!o) return false;
        return panelData.live === true ? (o.state === "live" || o.state === "starting" || o.state === "retrying") : o.enabled === true;
    }
    function parseSummary(s) {
        const m = /^(\S+) @ \d+fps ([\d,]+) kbps/.exec(String(s || ""));
        if (!m) return { size: "", kbps: 0 };
        const x = /^(\d+)x\d+$/.exec(m[1]); // a portrait size is written 1080x1920: its quality is the short side
        return { size: x ? x[1] + "p" : m[1], kbps: parseInt(m[2].replace(/,/g, ""), 10) };
    }
    function sizeWord(s) { return s === "2160p" ? "4K" : s }
    function mbps(k) { return (Math.round(k / 100) / 10) + " Mbps" }
    function platformName(o) {
        const p = String(o.platform || "");
        return p === "youtube" ? "YouTube" : p === "twitch" ? "Twitch" : p === "kick" ? "Kick" : String(o.name || o.id);
    }
    function titleOf(o) { return platformName(o) + (o.platform === "youtube" || o.canvas === "V" ? " · " + (o.canvas === "V" ? "portrait" : "landscape") : "") }
    function shortOf(o) { return platformName(o) + (o.platform === "youtube" || o.canvas === "V" ? " " + (o.canvas === "V" ? "portrait" : "landscape") : "") }
    // Is the stream key of this output (at this size) stored? { present: true | false | null (unknown), last4 }
    function keyOf(o, size) {
        if (!connectRows) return { present: null, last4: "" };
        const own = connectRows.filter(r => r.id === o.id || r.sinkId === o.id);
        if (own.length === 0) return { present: null, last4: "" };
        let r = own.find(x => x.quality === size);
        if (!r && !own.some(x => x.quality)) r = own[0];                  // one key for every size
        if (!r && size === "1080p") r = own.find(x => !x.quality) || null; // the base key is the 1080p one (D385)
        if (!r || !r.key) return { present: null, last4: "" };
        return { present: r.key.present === true, last4: typeof r.key.last4 === "string" ? r.key.last4 : "" };
    }
    function build(list, isLive) {
        const m = {};
        const q = {};
        for (const o of list) q[o.id] = parseSummary(o.summary);
        const on = (o) => isLive ? (o.state === "live" || o.state === "starting" || o.state === "retrying") : o.enabled === true;
        // two switched-on destinations with the same platform and the same stored key (same last 4 characters)
        const dup = {};
        for (const a of list) for (const b of list) {
            if (a.id >= b.id || !on(a) || !on(b) || a.platform !== b.platform) continue;
            const ka = keyOf(a, q[a.id].size), kb = keyOf(b, q[b.id].size);
            if (ka.present === true && kb.present === true && ka.last4 !== "" && ka.last4 === kb.last4) { dup[a.id] = true; dup[b.id] = true }
        }
        for (const o of list) {
            const sz = q[o.id], key = keyOf(o, sz.size), st = typeof o.state === "string" ? o.state : "";
            let chip = "Off", token = "", reason = "", bad = false;
            if (o.inPlan !== true) { chip = "Problem"; token = "danger"; bad = true; reason = "This one needs the portrait canvas. Turn it on in Settings > Stream." }
            else if (isLive && st === "live") { chip = "Live"; token = "ok"; reason = "On air now." }
            else if (isLive && st === "starting") { chip = "Live"; token = "ok"; reason = "Starting up." }
            else if (isLive && st === "retrying") { chip = "Problem"; token = "danger"; bad = true; reason = "The connection dropped. Trying again." }
            else if (/fail|error/.test(st)) { chip = "Problem"; token = "danger"; bad = true; reason = "This one stopped with an error. Switch it off and on again." }
            else if (key.present === false) { chip = "Add the key"; token = "accent"; reason = "No stream key for " + sizeWord(sz.size) + " yet. Click Add the key." }
            else if (isLive) { reason = "Not part of this stream. It can be added at the next Go live." }
            else if (o.enabled === true) { chip = "Ready"; reason = "Go live will start this one." }
            else reason = "Left out when you press Go live.";
            if (dup[o.id] && on(o)) { chip = "Problem"; token = "danger"; bad = true; reason = "Both go to the same " + platformName(o) + " stream: only one will work. Switch one off." }
            m[o.id] = {
                id: o.id, title: titleOf(o), shortName: shortOf(o), platform: String(o.platform || ""), badge: badgeOf(o.platform),
                quality: sz.size !== "" ? sizeWord(sz.size) + (sz.kbps > 0 ? ", " + mbps(sz.kbps) : "") : "",
                size: sz.size, chip: chip, token: token, reason: reason, bad: bad, dup: dup[o.id] === true,
                on: on(o), canSwitch: o.inPlan === true && (!isLive || st !== ""), keyMissing: key.present === false,
                tip: o.inPlan !== true ? "Portrait outputs need Main + portrait canvas (Settings > Stream)."
                    : isLive ? "Live: switching starts or stops this output only, at once." : "Whether Go live starts this output."
            };
        }
        return m;
    }
    function badgeOf(p) { return p === "youtube" ? "YT" : p === "twitch" ? "TW" : p === "kick" ? "K" : String(p || "?").charAt(0).toUpperCase() }
    function summaryOf(cards) {
        const on = cards.filter(c => c.on);
        const names = on.map(c => c.shortName + (c.platform === "youtube" && c.size !== "" ? " (" + sizeWord(c.size) + ")" : ""));
        if (live) return names.length ? "On air now: " + names.join(", ") + "." : "Nothing is on air from here.";
        return names.length ? "Go live starts: " + names.join(", ") + "." : "Go live starts nothing. Switch at least one destination on.";
    }

    // ---- switching ----
    function shown(c) { return pending[c.id] !== undefined ? pending[c.id].on : c.on }
    function toggle(id, on) {
        const p = Object.assign({}, pending);
        p[id] = { on: on, settled: -1 };
        pending = p;
        Api.post("ui/api/outputs/toggle", { id: id, on: on }, (ok, b, err) => {
            if (!ok) store.say("Output not switched: " + (b && b.detail ? b.detail : err));
            else if (b.verdict === "confirm") store.confirmNeeded(b.pending);
            const q = Object.assign({}, pending);
            if (q[id]) q[id] = { on: on, settled: seq };
            pending = q;
            refresh(); // the next read decides what the switch shows (a refused or unconfirmed switch goes back once)
        });
    }
    function addKey(id) { store.connectionsWanted(id); return true }
    function noteFlip(id, v) { const f = Object.assign({}, flips); f[id] = (f[id] || []).concat([v]); flips = f }

    // ---- probe (tests): outputs-toggle:<id>:<on|off>, outputs-key:<id>, outputs-width:<px>, outputs-add ----
    function probe() {
        const r = [];
        for (let i = 0; i < rowRep.count; i++) {
            const it = rowRep.itemAt(i);
            if (!it) continue;
            const c = it.c;
            r.push({ id: it.oid, on: it.sw.checked, enabled: it.sw.enabled, title: c.title, quality: c.quality, chip: c.chip, reason: c.reason, dup: c.dup,
                     busy: pending[it.oid] !== undefined, keyMissing: c.keyMissing, flips: flips[it.oid] || [] });
        }
        return { shown: visible, rows: r, live: live, virtualCamera: vcSwitch.enabled, summary: summaryLine, cols: cols, width: width, cardW: cardW,
                 title: panel.title };
    }
    function probeAction(a) {
        if (!visible) return false;
        if (a === "outputs-add") { addBtn.clicked(); return true }
        const p = a.split(":");
        if (p[0] === "outputs-width" && p.length === 2) { panel.width = parseInt(p[1], 10); return true }
        if (p[0] === "outputs-key" && p.length === 2) { const c = cardById[p[1]]; return !!c && c.keyMissing && addKey(p[1]) }
        if (p.length !== 3 || p[0] !== "outputs-toggle") return false;
        for (let i = 0; i < rowRep.count; i++) {
            const it = rowRep.itemAt(i);
            if (!it || it.oid !== p[1]) continue;
            const on = p[2] === "on";
            if (!it.sw.enabled || it.sw.checked === on) return false;
            it.sw.toggle();
            it.sw.toggled();
            return true;
        }
        return false;
    }

    tools: UIconButton {
        id: addBtn
        objectName: "outputsAdd"
        iconName: "plus"
        tip: "Add a destination (Settings > Stream)"
        onClicked: panel.store.settingsWanted("Stream")
    }

    Column {
        id: rows
        anchors { left: parent.left; right: parent.right; top: parent.top }
        spacing: panel.gap
        Flow {
            id: grid
            width: rows.width
            spacing: panel.gap
            Repeater {
                id: rowRep
                model: panel.outputs
                delegate: Rectangle {
                    id: card
                    required property var modelData
                    readonly property string oid: modelData.id
                    readonly property var c: panel.cardById[oid] || ({ id: oid, title: String(modelData.name || oid), quality: "", chip: "Off", token: "", reason: "", bad: false, on: false, canSwitch: false, tip: "", badge: "?", dup: false, keyMissing: false })
                    property alias sw: sw
                    objectName: "outputCard:" + oid
                    width: panel.cardW
                    height: 140
                    radius: Theme.radiusMedium
                    color: Theme.c.field
                    border.width: 1
                    border.color: card.c.bad ? Theme.c.danger : Theme.c.border
                    HoverHandler { id: hov }
                    ToolTip.visible: hov.hovered && card.c.tip !== ""
                    ToolTip.text: card.c.tip + (card.c.reason !== "" ? "\n" + card.c.reason : "")
                    ToolTip.delay: 500

                    Rectangle {
                        id: badgeBox
                        objectName: "outputBadge:" + card.oid
                        anchors { left: parent.left; top: parent.top; leftMargin: Theme.sp.m; topMargin: Theme.sp.m }
                        width: 30; height: 22
                        radius: Theme.radiusSmall
                        color: Theme.c.panel
                        border.width: 1
                        border.color: Theme.c.border
                        Text {
                            anchors.centerIn: parent
                            text: card.c.badge
                            color: Theme.c.text
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.caption
                            font.weight: Font.Bold
                        }
                    }
                    UChip {
                        id: chip
                        objectName: "outputChip:" + card.oid
                        anchors { right: parent.right; top: parent.top; rightMargin: Theme.sp.m; topMargin: Theme.sp.s }
                        text: card.c.chip
                        on: card.c.token !== ""
                        token: card.c.token !== "" ? card.c.token : "danger"
                        tip: card.c.chip === "Add the key" ? "Click to add the stream key" : ""
                        MouseArea {
                            anchors.fill: parent
                            enabled: card.c.keyMissing
                            cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                            onClicked: panel.addKey(card.oid)
                        }
                    }
                    Text {
                        id: titleText
                        objectName: "outputTitle:" + card.oid
                        anchors { left: badgeBox.right; right: chip.left; verticalCenter: badgeBox.verticalCenter; leftMargin: Theme.sp.s; rightMargin: Theme.sp.s }
                        text: card.c.title
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.body
                        font.weight: Font.DemiBold
                    }
                    Text {
                        id: qualityText
                        objectName: "outputQuality:" + card.oid
                        anchors { left: parent.left; right: parent.right; top: badgeBox.bottom; leftMargin: Theme.sp.m; rightMargin: Theme.sp.m; topMargin: Theme.sp.s }
                        height: 18
                        text: card.c.quality
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.small
                    }
                    USwitch {
                        id: sw
                        objectName: "outputSwitch:" + card.oid
                        anchors { left: parent.left; top: qualityText.bottom; leftMargin: Theme.sp.m; topMargin: Theme.sp.s }
                        wrap: false
                        text: "Go live here"
                        font.pixelSize: Theme.ty.body
                        font.weight: Font.DemiBold
                        checked: panel.shown(card.c)
                        enabled: card.c.canSwitch
                        Accessible.name: "Go live here: " + card.c.title
                        // A click: remember what the user chose and show it, send it, then follow the server (the read decides).
                        onToggled: { const on = checked; panel.toggle(card.oid, on); checked = Qt.binding(() => panel.shown(card.c)); }
                        onCheckedChanged: if (card.visible && panel.loaded && card.c.id === card.oid) panel.noteFlip(card.oid, checked)
                    }
                    Item {   // the spinner: only while the switch is being saved
                        id: spin
                        objectName: "outputSpinner:" + card.oid
                        anchors { right: parent.right; verticalCenter: sw.verticalCenter; rightMargin: Theme.sp.l }
                        width: 18; height: 18
                        visible: panel.pending[card.oid] !== undefined
                        Rectangle { anchors.fill: parent; radius: Theme.radiusSmall; color: "transparent"; border.width: 2; border.color: Theme.c.border }
                        Item {
                            id: orbit
                            anchors.fill: parent
                            Rectangle { width: 6; height: 6; radius: 3; color: Theme.c.accent; x: 6; y: -1 }
                            RotationAnimator on rotation { running: spin.visible && Theme.motion; from: 0; to: 360; duration: 900; loops: Animation.Infinite }
                        }
                    }
                    Text {
                        id: reasonText
                        objectName: "outputReason:" + card.oid
                        anchors { left: parent.left; right: parent.right; top: sw.bottom; bottom: parent.bottom; leftMargin: Theme.sp.m; rightMargin: Theme.sp.m; topMargin: Theme.sp.s; bottomMargin: Theme.sp.s }
                        text: card.c.reason
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        maximumLineCount: 2
                        elide: Text.ElideRight
                        color: card.c.bad ? Theme.c.danger : Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.small
                    }
                }
            }
        }
        Text {
            objectName: "outputsSummary"
            width: rows.width
            height: 36
            text: panel.summaryLine
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 2
            elide: Text.ElideRight
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
            HoverHandler { id: sumHover }
            ToolTip.visible: sumHover.hovered
            ToolTip.text: panel.summaryLine
            ToolTip.delay: 500
        }
        // Virtual Camera: not in this host build (no virtual camera method); shown, switched off.
        Item {
            width: rows.width
            height: vcSwitch.implicitHeight
            visible: panel.panelData.outputs !== undefined
            HoverHandler { id: vcHover }
            ToolTip.visible: vcHover.hovered && ToolTip.text !== ""
            ToolTip.text: (panel.panelData.virtualCamera || {}).reason || ""
            ToolTip.delay: 500
            USwitch {
                id: vcSwitch
                objectName: "virtualCameraSwitch"
                anchors { left: parent.left; right: parent.right }
                text: "Virtual Camera"
                hint: "Not available in this build"
                checked: false
                enabled: (panel.panelData.virtualCamera || {}).available === true
            }
        }
    }
}
