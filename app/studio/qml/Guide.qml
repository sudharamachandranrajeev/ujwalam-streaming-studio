// SPDX-License-Identifier: GPL-3.0-or-later
// Tips, tours and help for new users (D294; the widget's Guide, Coach, Hints and HelpPanel: guide.cpp, coach.cpp,
// hints.cpp, help_panel.cpp). The text comes from data/guide (ui/api/guide); the choices (tips on, tour done, the
// "Don't show again" list) from settings.json ui.guide (ui/api/settings), written at once. A tour step points at a named
// part of the window; a step whose part is not on screen is skipped. A hint shows once per run the first time its thing
// happens, one at a time, never during a tour or with help open, and hides itself after 8 s (not while hovered). The welcome
// tour starts by itself once, on a window the user sees. Nothing here blocks a click: the dimming lets clicks through.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Item {
    id: guide
    objectName: "guide"
    required property var store
    required property Item root        // the window's content: the parts a step points at are found under it
    property bool unseen: false        // never on a screen (hidden and probe modes): no welcome tour by itself
    signal settingsChanged()           // tips / tour / dismissed changed here (Settings > Help & tips shows them)

    // ---- data and choices ----
    property var tours: []
    property var hintDefs: []
    property bool textLoaded: false
    property bool settingsLoaded: false
    property bool tips: true
    property bool tourDone: false
    property var dismissed: []
    property var seen: []              // hints shown in this run
    property bool saveFailed: false
    property bool welcomeTried: false

    // The window's parts by anchor name (the widget's guide_->anchor calls); several names make one area.
    readonly property var anchorNames: ({
        scenes: ["scenesPanel"], layers: ["layersPanel"], sceneAdd: ["addScene"], layerAdd: ["addLayer"],
        previewH: ["previewH"], previewV: ["previewV"], look: ["lookPanel"], mixer: ["mixerPanel"],
        ctlStream: ["streamBtn"], ctlRecord: ["recordBtn"], ctlClip: ["clipBtn"], ctlMark: ["markBtn"],
        chips: ["chipLive", "chipBitrate", "chipRec", "chipClips"], chipClips: ["chipClips"], taskChip: ["taskChip"],
        taskBar: ["onAirBar"], myClips: ["clipsFolderBtn"], settings: ["settingsBtn"], more: ["moreBtn"], help: ["helpBtn"]
    })
    function rectOf(name) {
        const names = anchorNames[name] || [name];
        const r = Api.itemRect(root, names);
        if (r.width <= 0 && name === "taskChip") return rectOf("taskBar"); // the chip is hidden while nothing runs
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    function shownRect(r) { return r.width > 0 && r.height > 0 }
    function previewRects() { return ["previewH", "previewV"].map(rectOf).filter(shownRect) }
    function bounds() { return { x: 6, y: 6, width: width - 12, height: height - 12 } }

    function start() {
        Api.get("ui/api/guide", (ok, b) => {
            if (ok) { tours = Array.isArray(b.tours) ? b.tours : []; hintDefs = Array.isArray(b.hints) ? b.hints : [] }
            textLoaded = true; // an older server has no such route: no tips then, nothing else changes
            maybeWelcome(0);
        });
        Api.get("ui/api/settings", (ok, b) => {
            const g = ok && b.settings && b.settings.ui && b.settings.ui.guide;
            if (g) {
                tips = g.tips !== false;
                tourDone = g.tourDone === true;
                dismissed = Array.isArray(g.dismissed) ? g.dismissed.map(String) : [];
            }
            settingsLoaded = true;
            maybeWelcome(0);
        });
    }
    function save(part) {
        Api.post("ui/api/settings", { ui: { guide: part } }, (ok) => { saveFailed = !ok });
        settingsChanged();
    }
    function setTips(on) {
        if (tips === on) return;
        tips = on;
        save({ tips: on });
        if (!on) hideHint();
    }
    function resetDismissed() {
        dismissed = [];
        tourDone = false;
        seen = [];
        save({ dismissed: [], tourDone: false });
    }
    // Settings > Help & tips saved these itself: take them over.
    function takeChoices(part) {
        if (part.tips !== undefined) { tips = part.tips === true; if (!tips) hideHint() }
        if (part.tourDone !== undefined) tourDone = part.tourDone === true;
        if (Array.isArray(part.dismissed)) { dismissed = part.dismissed.slice(); if (!dismissed.length) seen = [] }
    }
    function addDismissed(id) {
        if (!id || dismissed.indexOf(id) >= 0) return;
        const d = dismissed.concat([id]);
        while (d.length > 200) d.shift();
        dismissed = d;
        save({ dismissed: d });
    }

    // The welcome tour starts by itself once, on a shown window, for a user who has not finished or hidden it. Not over a
    // window that waits for an answer (the first-run clip question comes first): it looks again every 2 s, at most 30 times.
    property int welcomeTries: 0
    Timer { id: welcomeRetry; interval: 2000; onTriggered: guide.maybeWelcome(guide.welcomeTries + 1) }
    Timer { id: welcomeGo; interval: 600; onTriggered: if (guide.tips && !guide.tourDone && !coach.active) guide.startTour("welcome") }
    function popupOpen() {
        const o = Overlay.overlay;
        if (!o) return false;
        for (const c of o.children) if (c.visible && c.width > 0 && c.objectName !== "toolTip") return true;
        return false;
    }
    function maybeWelcome(tries) {
        if (!textLoaded || !settingsLoaded || !tips || tourDone || unseen || (welcomeTried && tries === 0)) return;
        welcomeTried = true;
        if (popupOpen() || coach.active) {
            if (tries < 30) { welcomeTries = tries; welcomeRetry.restart() }
            return;
        }
        welcomeGo.restart();
    }

    function tourById(id) { return tours.find(t => t.id === id) || null }
    function startTour(id) {
        const t = tourById(id);
        if (!t) return false;
        hideHint();
        help.open = false;
        return coach.begin(t, id === "welcome");
    }
    function replayWelcome() {
        tourDone = false;
        startTour("welcome");
    }
    function toggleHelp() {
        if (coach.active) coach.stop(false);
        hideHint();
        if (help.open) { help.open = false; return }
        placeHelp();
        help.open = true;
    }
    function placeHelp() {
        const a = rectOf("help");
        help.place(width, height, shownRect(a) ? a.y + a.height + 10 : 60, previewRects());
    }

    // ---- hints ----
    function trigger(trig) {
        if (!tips || !textLoaded || coach.active || help.open) return false;
        const h = hintDefs.find(x => x.trigger === trig);
        if (!h || dismissed.indexOf(h.id) >= 0 || seen.indexOf(h.id) >= 0) return false;
        if (!hint.put(h)) return false;
        seen = seen.concat([h.id]);
        return true;
    }
    function hideHint() { hint.dismiss(false) }

    // What changed since the last status decides which hint to show (the widget's onStatus).
    property bool havePrev: false
    property bool prevLive: false
    property bool prevRec: false
    property bool prevRunning: false
    property var skipSeen: []
    property bool firstTaskSeen: false
    function onStatus(s) {
        const h = s.host || {}, cl = s.clips || {};
        const live = h.live === true, rec = h.recording === true;
        const running = !!cl.running && Object.keys(cl.running).length > 0;
        const set = cl.settings || {};
        if (havePrev) {
            const mode = set[(prevLive || live) ? "live" : "recording"];
            if (prevRec && !rec && mode === "ask") trigger("recording-stopped-ask");
            if (!prevLive && live) trigger("went-live");
            if (!prevRunning && running) trigger("clip-run-started");
        }
        prevLive = live; prevRec = rec; prevRunning = running; havePrev = true;
        const tasks = Array.isArray(s.tasks) ? s.tasks : [];
        // The clipper reports each match's verdict as a task note ("match 2: skipped", stage "gate"); the live review says "N skipped".
        const skipped = /^match \d+: skipped|(^|[^0-9])[1-9][0-9]* skipped/;
        for (const t of tasks) {
            const key = t.id + "|" + t.note;
            if (t.stage === "gate" && skipped.test(String(t.note || "")) && skipSeen.indexOf(key) < 0) {
                if (trigger("match-skipped")) skipSeen = skipSeen.concat([key]);
                break;
            }
        }
        // "Ujwalam just started a job": a job that runs or waits. The previews this window opens at start finish at once
        // (done "Opening the ... preview" tasks): they are not a job, so the tip does not greet every start.
        const working = tasks.some(t => t.state === "running" || t.state === "waiting");
        if (working && !firstTaskSeen && trigger("first-task")) firstTaskSeen = true;
    }
    Connections {
        target: guide.store
        function onStatusRead(s) { guide.onStatus(s) }
        function onFlagsRead() { help.postingOn = guide.store.flags["posting"] === true; help.autoOn = guide.store.flags["auto-post"] === true }
    }
    // A selected layer that has effects: point at Look once (the widget's onLayerEffects).
    readonly property bool layerHasEffects: !!store.selectedLayer && Array.isArray(store.selectedLayer.effects) && store.selectedLayer.effects.length > 0 && !store.live
    onLayerHasEffectsChanged: if (layerHasEffects) Qt.callLater(trigger, "layer-with-effects")

    // A window resize moves what is shown with it.
    onWidthChanged: Qt.callLater(refresh)
    onHeightChanged: Qt.callLater(refresh)
    function refresh() {
        coach.refresh();
        hint.refresh();
        if (help.open) placeHelp();
    }

    // ---- the tour (coach marks) ----
    QtObject {
        id: coach
        property bool active: false
        property var tour: null
        property var steps: []
        property int idx: -1
        property int total: 0
        property int position: 0
        property bool offerNever: false
        property var overlaps: []
        function available(i) { return i >= 0 && i < steps.length && guide.shownRect(guide.rectOf(steps[i].anchor)) }
        function step(from, dir) {
            for (let i = from + dir; i >= 0 && i < steps.length; i += dir) if (available(i)) return i;
            return -1;
        }
        function begin(t, never) {
            overlaps = [];
            tour = t;
            steps = Array.isArray(t.steps) ? t.steps : [];
            let n = 0;
            for (let i = 0; i < steps.length; i++) if (available(i)) n++;
            total = n;
            if (!n) { active = false; card.shown = false; return false }
            offerNever = never;
            neverBox.checked = false;
            active = true;
            show(step(-1, 1), false);
            card.shown = true;
            return true;
        }
        function show(i, animate) {
            idx = i;
            const s = steps[i];
            let p = 0;
            for (let k = 0; k <= i; k++) if (available(k)) p++;
            position = p;
            cardCount.text = "STEP " + p + " OF " + total;
            cardTitle.text = s.title || "";
            cardText.text = s.text || "";
            backBtn.enabled = step(i, -1) >= 0;
            const last = step(i, 1) < 0;
            nextBtn.text = last ? "Done" : "Next";
            skipBtn.visible = !last;
            const r = guide.rectOf(s.anchor);
            spot.animate = animate;
            spot.hole = r;
            const want = ["left", "right", "above", "below"].indexOf(s.side) >= 0 ? s.side : "";
            const at = card.pointAt(r, want, guide.bounds(), guide.previewRects());
            if (guide.shownRect(r) && card.inter(at, r) && overlaps.indexOf(s.id) < 0) overlaps = overlaps.concat([s.id]);
        }
        function next() { if (!active) return; const n = step(idx, 1); if (n < 0) stop(true); else show(n, true) }
        function back() { if (!active) return; const n = step(idx, -1); if (n >= 0) show(n, true) }
        function stop(completed) {
            if (!active) return;
            active = false;
            card.shown = false;
            const never = offerNever && neverBox.checked;
            const id = tour ? tour.id : "";
            if (id === "welcome" && (completed || never)) { guide.tourDone = true; guide.save({ tourDone: true }) }
        }
        function refresh() {
            if (!active) return;
            if (!available(idx)) {
                const n = step(idx, 1) >= 0 ? step(idx, 1) : step(idx, -1);
                if (n < 0) return stop(true);
                idx = n;
            }
            show(idx, false);
        }
        function probe() {
            const o = { active: active };
            if (!active && idx < 0) return o;
            const s = idx >= 0 && idx < steps.length ? steps[idx] : {};
            return Object.assign(o, { tour: tour ? tour.id : "", step: position, of: total, stepId: s.id || "", anchor: s.anchor || "",
                title: cardTitle.text, count: cardCount.text, next: nextBtn.text, backEnabled: backBtn.enabled, neverOffered: offerNever,
                neverTicked: neverBox.checked, arrow: card.side, overlaps: overlaps,
                hole: { x: Math.round(spot.hole.x), y: Math.round(spot.hole.y), w: Math.round(spot.hole.width), h: Math.round(spot.hole.height) } });
        }
    }

    // The dimming with a lit hole round the step's part (the widget's CoachOverlay). Clicks pass through.
    Item {
        id: spot
        anchors.fill: parent
        property var hole: ({ x: 0, y: 0, width: 0, height: 0 })
        property bool animate: false
        readonly property bool has: hole.width > 0 && hole.height > 0
        property real hx: has ? hole.x - 8 : 0
        property real hy: has ? hole.y - 8 : 0
        property real hw: has ? hole.width + 16 : 0
        property real hh: has ? hole.height + 16 : 0
        Behavior on hx { enabled: Theme.motion && spot.animate; NumberAnimation { duration: 280; easing.type: Easing.InOutCubic } }
        Behavior on hy { enabled: Theme.motion && spot.animate; NumberAnimation { duration: 280; easing.type: Easing.InOutCubic } }
        Behavior on hw { enabled: Theme.motion && spot.animate; NumberAnimation { duration: 280; easing.type: Easing.InOutCubic } }
        Behavior on hh { enabled: Theme.motion && spot.animate; NumberAnimation { duration: 280; easing.type: Easing.InOutCubic } }
        visible: opacity > 0
        opacity: coach.active ? 1 : 0
        Behavior on opacity { enabled: Theme.motion; NumberAnimation { duration: coach.active ? 240 : 200 } }
        readonly property color dim: Qt.rgba(6 / 255, 4 / 255, 14 / 255, 150 / 255)
        Rectangle { color: spot.dim; x: 0; y: 0; width: spot.width; height: Math.max(0, spot.hy) }
        Rectangle { color: spot.dim; x: 0; y: spot.hy + spot.hh; width: spot.width; height: Math.max(0, spot.height - spot.hy - spot.hh) }
        Rectangle { color: spot.dim; x: 0; y: spot.hy; width: Math.max(0, spot.hx); height: spot.hh }
        Rectangle { color: spot.dim; x: spot.hx + spot.hw; y: spot.hy; width: Math.max(0, spot.width - spot.hx - spot.hw); height: spot.hh }
        Rectangle {
            visible: spot.has
            x: spot.hx - 3; y: spot.hy - 3; width: spot.hw + 6; height: spot.hh + 6
            radius: 17
            color: "transparent"
            border.width: 7
            border.color: Qt.rgba(Theme.c.accent.r, Theme.c.accent.g, Theme.c.accent.b, 70 / 255)
        }
        Rectangle {
            visible: spot.has
            x: spot.hx; y: spot.hy; width: spot.hw; height: spot.hh
            radius: 14
            color: "transparent"
            border.width: 2
            border.color: Qt.rgba(Theme.c.accent.r, Theme.c.accent.g, Theme.c.accent.b, 230 / 255)
        }
    }

    component Words: Text {
        wrapMode: Text.Wrap
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 13
    }
    component NeverBox: CheckBox {
        id: nb
        text: "Don't show this again"
        focusPolicy: Qt.NoFocus
        padding: 0
        spacing: 7
        font.family: Theme.family
        font.pixelSize: 12
        indicator: Rectangle {
            x: 0; y: (nb.height - height) / 2
            width: 14; height: 14; radius: 4
            color: nb.checked ? Theme.c.accent : Theme.c.field
            border.color: nb.checked ? Theme.c.accent : Theme.c.border
            Text { anchors.centerIn: parent; visible: nb.checked; text: "✓"; color: Theme.c.onAccent; font.pixelSize: 11 }
        }
        contentItem: Text {
            leftPadding: 21
            text: nb.text
            font: nb.font
            color: nb.hovered ? Theme.c.text : Theme.c.muted
            verticalAlignment: Text.AlignVCenter
        }
    }

    GuideBubble {
        id: card
        objectName: "guideCard"
        baseW: 380
        z: 2
        Item {
            width: parent.width
            height: 28
            Text {
                id: cardCount
                anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 11
                font.weight: Font.DemiBold
            }
            GuideClose { anchors { right: parent.right; verticalCenter: parent.verticalCenter } objectName: "guideTourClose"; tip: "Close the tour"; onClicked: coach.stop(false) }
        }
        Words { id: cardTitle; width: parent.width; font.pixelSize: 16; font.weight: Font.DemiBold }
        Words { id: cardText; width: parent.width }
        NeverBox { id: neverBox; objectName: "guideTourNever"; visible: coach.offerNever }
        Item {
            width: parent.width
            height: 32
            UButton { id: skipBtn; objectName: "guideTourSkip"; anchors.left: parent.left; text: "Skip tour"; implicitHeight: 30; onClicked: coach.stop(false) }
            Row {
                anchors.right: parent.right
                spacing: 8
                UButton { id: backBtn; objectName: "guideTourBack"; text: "Back"; implicitHeight: 30; onClicked: coach.back() }
                UButton { id: nextBtn; objectName: "guideTourNext"; text: "Next"; kind: "primary"; implicitHeight: 30; onClicked: coach.next() }
            }
        }
    }

    // ---- the hint (the widget's HintBubble) ----
    GuideBubble {
        id: hint
        objectName: "guideHint"
        baseW: 340
        z: 1
        property string hid: ""
        property string anchorName: ""
        property int count: 0
        readonly property bool showing: hid !== ""
        function put(h) {
            if (showing) return false;
            const r = guide.rectOf(h.anchor);
            if (!guide.shownRect(r)) return false;
            hid = h.id;
            anchorName = h.anchor;
            count++;
            hintTitle.text = h.title || "";
            hintText.text = h.text || "";
            hintNever.checked = false;
            pointAt(r, "", guide.bounds(), guide.previewRects());
            shown = true;
            // A window nobody sees (the headless probe) keeps the hint until it is dismissed, so a test can look at it;
            // UJWALAM_GUIDE_HINT_MS (tests) sets the time instead and applies there too.
            const ms = Api.guideHintMs();
            if (ms > 0) { hintTimer.interval = ms; hintTimer.restart() }
            else if (!guide.unseen) { hintTimer.interval = 8000; hintTimer.restart() }
            return true;
        }
        function dismiss(never) {
            if (!showing) return;
            const id = hid;
            hid = "";
            shown = false;
            hintTimer.stop();
            if (never) guide.addDismissed(id);
        }
        function refresh() {
            if (!showing) return;
            const r = guide.rectOf(anchorName);
            if (!guide.shownRect(r)) return dismiss(false);
            pointAt(r, "", guide.bounds(), guide.previewRects());
        }
        function click(what, tick) {
            if (!showing) return;
            if (tick) hintNever.checked = true;
            (what === "close" ? hintClose : gotIt).clicked();
        }
        Timer { id: hintTimer; onTriggered: hint.dismiss(false) }
        HoverHandler {
            onHoveredChanged: {
                if (hovered) hintTimer.stop(); // hovered: it stays
                else if (hint.showing && !guide.unseen) { hintTimer.interval = 3000; hintTimer.restart() } // a moment to finish reading
            }
        }
        Item {
            width: parent.width
            height: Math.max(hintTitle.implicitHeight, 28)
            Words { id: hintTitle; anchors { left: parent.left; right: hintClose.left; rightMargin: 6; top: parent.top } font.pixelSize: 15; font.weight: Font.DemiBold }
            GuideClose { id: hintClose; objectName: "guideHintClose"; anchors { right: parent.right; top: parent.top } tip: "Close this tip"; onClicked: hint.dismiss(hintNever.checked) }
        }
        Words { id: hintText; width: parent.width }
        Item {
            width: parent.width
            height: 32
            NeverBox { id: hintNever; objectName: "guideHintNever"; anchors { left: parent.left; verticalCenter: parent.verticalCenter } }
            UButton { id: gotIt; objectName: "guideHintGotIt"; anchors.right: parent.right; text: "Got it"; kind: "primary"; implicitHeight: 30; onClicked: hint.dismiss(hintNever.checked) }
        }
    }

    HelpPanel {
        id: help
        z: 3
        onShowMe: (tour) => { help.open = false; guide.startTour(tour) }
        onReplayTour: { help.open = false; guide.replayWelcome() }
    }

    // ---- headless probe (the widget's names): guide-tour:start[:id] | next | back | skip | close | tick;
    // guide-hint:<trigger> | gotit | close | tick-gotit; guide-help:open | show-clips | show-posting | replay | close;
    // guide-tips:on|off. Settings > Help & tips (guide-settings:*) is in SettingsDialog.
    function probeAction(a) {
        const p = String(a).split(":");
        if (p[0] === "guide-tour" && p.length >= 2) {
            if (p[1] === "start") { startTour(p[2] || "welcome"); return coach.active }
            if (!coach.active) return false;
            const b = { next: nextBtn, back: backBtn, skip: skipBtn }[p[1]];
            if (p[1] === "tick") { if (coach.offerNever) neverBox.checked = true; return true }
            if (p[1] === "close") { coach.stop(false); return true }
            if (!b || !b.enabled || !b.visible) return false;
            b.clicked();
            return true;
        }
        if (p[0] === "guide-hint" && p.length === 2) {
            if (["gotit", "close", "tick-gotit"].indexOf(p[1]) >= 0) {
                if (!hint.showing) return false;
                hint.click(p[1] === "close" ? "close" : "got-it", p[1] === "tick-gotit");
                return true;
            }
            return trigger(p[1]);
        }
        if (p[0] === "guide-help" && p.length === 2) {
            if (p[1] === "open") { if (!help.open) toggleHelp(); return help.open }
            if (!help.open) return false;
            help.click(p[1]);
            return true;
        }
        if (p[0] === "guide-tips" && p.length === 2) { setTips(p[1] === "on"); return true }
        return false;
    }
    function probe() {
        const names = [];
        for (const k in anchorNames) if (shownRect(rectOf(k))) names.push(k);
        return { ready: textLoaded && settingsLoaded, tips: tips, tourDone: tourDone, dismissed: dismissed, tours: tours.map(t => t.id),
                 hintDefs: hintDefs.length, anchors: names, saveFailed: saveFailed, coach: coach.probe(),
                 hint: Object.assign({ showing: hint.showing, id: hint.hid, seen: hint.count }, hint.showing ? { anchor: hint.anchorName, arrow: hint.side } : {}),
                 help: help.probe() };
    }
}
