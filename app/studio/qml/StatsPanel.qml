// SPDX-License-Identifier: GPL-3.0-or-later
// Stream stats (the widget's StatsCards, D287): the session clock while live or recording (the host's clock), and GPU, CPU and FPS each with
// its value and a line of the last 3 minutes (one sample per status read, every 2 s). Under the side column, always in view.
import QtQuick
import Ujwalam.Core

Item {
    id: stats
    objectName: "statsPanel"
    required property var store
    // Short windows (Main.qml) use a lower card so the side column keeps room for the layer list; the content never changes size when live starts.
    property bool compact: false
    readonly property int cardH: compact ? 44 : 58
    implicitHeight: 3 * cardH + 2 * Theme.sp.s // the session and FPS cards take a row each (their words need the width), GPU and CPU share one

    readonly property int keep: 90 // 3 minutes at one sample per 2 s
    property var cpu: []
    property var gpu: []
    property var fps: []
    property int dropped: 0
    property bool active: false
    property real since: 0
    property string session: "Not live"
    readonly property string sessionNote: store.live ? "On air" : store.recording ? "Recording" : "Session time"

    function push(list, v) { const l = list.concat([Number(v) || 0]); while (l.length > keep) l.shift(); return l }
    function sample(s) {
        const h = s.host || {};
        cpu = push(cpu, h.cpuPct);
        gpu = push(gpu, h.gpuPct);
        fps = push(fps, h.fps);
        dropped = h.droppedFrames || 0;
        const on = h.live === true || h.recording === true;
        if (on) {
            // The host's session clock (host.status streamMs while live, else recordMs): a window opened again (a restart
            // after a crash) shows the real session time, not the time since it opened. It ticks here between reads and is
            // set again only when it drifts more than 1.5 s (no jumps from the request's own delay). An older host without
            // the clocks: the time since this window first saw the session.
            const ms = h.live === true ? h.streamMs : h.recordMs;
            const hostSince = typeof ms === "number" && ms >= 0 ? Date.now() - ms : -1;
            if (hostSince >= 0 && (!active || Math.abs(hostSince - since) > 1500)) since = hostSince;
            else if (hostSince < 0 && !active) since = Date.now();
            tick();
            if (!active) clock.start(); // the only timer here, and only while on air or recording
        } else if (active) { clock.stop(); session = "Not live" }
        active = on;
    }
    function two(n) { return (n < 10 ? "0" : "") + n }
    function tick() {
        const t = Math.max(0, Math.floor((Date.now() - since) / 1000));
        session = two(Math.floor(t / 3600)) + ":" + two(Math.floor(t / 60) % 60) + ":" + two(t % 60);
    }
    Timer { id: clock; interval: 1000; repeat: true; onTriggered: stats.tick() }
    Connections {
        target: stats.store
        function onStatusRead(s) { stats.sample(s) }
    }
    function last(l) { return l.length ? l[l.length - 1] : 0 }
    function probe() {
        return { samples: cpu.length, session: session, note: sessionNote, gpu: gpuCard.value, cpu: cpuCard.value, fps: fpsCard.value };
    }

    component Card: Rectangle {
        radius: Theme.radiusMedium
        color: Theme.c.panel
        border.color: Theme.c.border
        border.width: 1
        // Molten Stone (2026-11-27, D449): flat on purpose. The stone card's rim crossed the labels at these heights
        // (44-58 px; seen in the 150% specimen shot), so the stats keep the flat panel in every theme.
    }
    component Spark: Card {
        id: sc
        property string name: ""
        property string value: "-"
        property var points: []
        property real lo: 0
        property real hi: 100
        Text {
            anchors { left: parent.left; top: parent.top; leftMargin: Theme.sp.m; topMargin: Theme.sp.s }
            text: sc.name
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.caption
            font.weight: Font.DemiBold
        }
        Text {
            objectName: "statValue:" + sc.name
            anchors { right: parent.right; top: parent.top; rightMargin: Theme.sp.m; topMargin: Theme.sp.s }
            width: Math.min(implicitWidth, sc.width - 2 * Theme.sp.m - 40)
            horizontalAlignment: Text.AlignRight
            elide: Text.ElideLeft
            text: sc.value
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        Canvas {
            id: line
            anchors { left: parent.left; right: parent.right; bottom: parent.bottom; leftMargin: Theme.sp.m; rightMargin: Theme.sp.m; bottomMargin: Theme.sp.s }
            height: Math.max(12, sc.height - 32)
            Connections { target: sc; function onPointsChanged() { line.requestPaint() } }
            Connections { target: Theme; function onChanged() { line.requestPaint() } }
            onPaint: {
                const p = getContext("2d");
                p.reset();
                const v = sc.points;
                if (v.length < 2) return;
                const top = 3, bot = height - 2, w = width - 2, span = Math.max(1e-6, sc.hi - sc.lo), k = stats.keep;
                const xy = (i) => [1 + w * i / (k - 1) + w * (k - v.length) / (k - 1), bot - (bot - top) * Math.max(0, Math.min(1, (v[i] - sc.lo) / span))];
                p.beginPath();
                const first = xy(0);
                p.moveTo(first[0], first[1]);
                for (let i = 1; i < v.length; i++) { const q = xy(i); p.lineTo(q[0], q[1]) }
                const lastX = xy(v.length - 1)[0];
                p.lineTo(lastX, bot); p.lineTo(first[0], bot); p.closePath();
                const g = p.createLinearGradient(0, top, 0, bot);
                g.addColorStop(0, Qt.rgba(Theme.c.accent.r, Theme.c.accent.g, Theme.c.accent.b, 0.35));
                g.addColorStop(1, Qt.rgba(Theme.c.accent.r, Theme.c.accent.g, Theme.c.accent.b, 0));
                p.fillStyle = g;
                p.fill();
                p.beginPath();
                p.moveTo(first[0], first[1]);
                for (let i = 1; i < v.length; i++) { const q = xy(i); p.lineTo(q[0], q[1]) }
                p.strokeStyle = String(Theme.c.accentHi);
                p.lineWidth = 1.6;
                p.lineCap = "round";
                p.lineJoin = "round";
                p.stroke();
            }
        }
    }

    Column {
        anchors.fill: parent
        spacing: Theme.sp.s
        readonly property real cw: (width - Theme.sp.s) / 2
        Card {
            objectName: "statSession"
            width: parent.width
            height: stats.cardH
            Text {
                anchors { left: parent.left; top: parent.top; leftMargin: Theme.sp.m; topMargin: Theme.sp.s }
                visible: !stats.compact
                text: "STREAM STATS"
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.caption
                font.weight: Font.DemiBold
            }
            Text {
                objectName: "statSessionTime"
                x: Theme.sp.m
                y: stats.compact ? (parent.height - height) / 2 : parent.height - height - Theme.sp.xs
                text: stats.session
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: stats.compact ? Theme.ty.subtitle : Theme.ty.title
                font.weight: Font.DemiBold
            }
            Text {
                x: parent.width - width - Theme.sp.m
                y: stats.compact ? (parent.height - height) / 2 : parent.height - height - Theme.sp.s
                text: stats.sessionNote
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.caption
            }
        }
        Spark {
            id: fpsCard
            width: parent.width; height: stats.cardH
            name: "FPS"
            hi: 75
            points: stats.fps
            value: stats.fps.length ? stats.last(stats.fps).toFixed(1) + " fps, " + stats.dropped + " dropped" : "-"
        }
        Row {
            spacing: Theme.sp.s
            Spark {
                id: gpuCard
                width: parent.parent.cw; height: stats.cardH
                name: "GPU"
                points: stats.gpu
                value: stats.gpu.length ? stats.last(stats.gpu).toFixed(0) + "%" : "-"
            }
            Spark {
                id: cpuCard
                width: parent.parent.cw; height: stats.cardH
                name: "CPU"
                points: stats.cpu
                value: stats.cpu.length ? stats.last(stats.cpu).toFixed(0) + "%" : "-"
            }
        }
    }
}
