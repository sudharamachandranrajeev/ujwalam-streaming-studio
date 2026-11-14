// SPDX-License-Identifier: GPL-3.0-or-later
// The help panel (the widget's HelpPanel, help_panel.cpp; D294): How clips are made and Posting your clips, each with its
// picture and a Show me button that runs the related tour, and Replay the welcome tour. Right-aligned under the top bar,
// as wide as the room right of the previews allows (340..440 px): a native preview window covers anything drawn there.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Rectangle {
    id: help
    objectName: "guideHelp"
    property bool open: false
    property bool postingOn: false
    property bool autoOn: false
    signal showMe(string tour)
    signal replayTour()
    readonly property string facts: "In this build: posting is " + (postingOn ? "ON" : "OFF") + ", automatic posting is " + (autoOn ? "ON" : "OFF") + "."

    radius: 16
    color: Theme.c.panel
    border.color: Theme.c.border
    border.width: 1
    visible: opacity > 0
    opacity: open ? 1 : 0
    property real slide: open ? 0 : 36
    Behavior on opacity { enabled: Theme.motion; NumberAnimation { duration: help.open ? 240 : 180; easing.type: help.open ? Easing.OutCubic : Easing.InCubic } }
    Behavior on slide { enabled: Theme.motion; NumberAnimation { duration: help.open ? 240 : 180; easing.type: help.open ? Easing.OutCubic : Easing.InCubic } }
    transform: Translate { x: help.slide }

    // host: the window's size; top: below the ? button; avoid: the preview rects.
    function place(hostW, hostH, top, avoid) {
        const y0 = top, h = Math.max(260, Math.min(660, hostH - y0 - 48));
        let left = 6;
        for (const r of avoid) if (r.y + r.height >= y0 && r.y <= y0 + h) left = Math.max(left, r.x + r.width + 8);
        // 280 at the least (the widget's 340 does not fit beside the QML layers column at 1600 px, and a native preview
        // window would paint over the panel); text wraps.
        const w = Math.max(280, Math.min(440, hostW - 10 - left));
        width = w;
        height = h;
        x = hostW - w - 10;
        y = y0;
    }
    function click(what) {
        const b = { "show-clips": showClips, "show-posting": showPosting, "replay": replay, "close": closeBtn }[what];
        if (b) b.clicked();
    }
    function probe() { return { open: open, sections: [s1.text, s2.text], facts: facts, showMeButtons: 2 } }

    component Para: Text {
        width: body.width
        wrapMode: Text.Wrap
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 13
        lineHeight: 1.1
    }
    component Bullet: Para { property string say: ""; text: "•  " + say }
    component Caption: Text {
        width: body.width
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 11
        font.weight: Font.DemiBold
    }
    component Section: Text {
        width: body.width
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 15
        font.weight: Font.DemiBold
    }

    // The pictures, drawn on a 392-wide sheet and scaled to the panel (the widget's HelpArt).
    component Art: Canvas {
        id: art
        property string kind: "clips"
        readonly property real sheetH: kind === "clips" ? 104 : 164
        width: body.width
        height: Math.round(sheetH * width / 392)
        Connections { target: Theme; function onChanged() { art.requestPaint() } }
        onWidthChanged: requestPaint()
        onPaint: {
            const p = getContext("2d");
            p.reset();
            const s = width / 392;
            p.scale(s, s);
            const ink = String(Theme.c.text), acc = String(Theme.c.accentHi), accent = String(Theme.c.accent), muted = String(Theme.c.muted);
            const NW = 76, NH = 46;
            const rr = (x, y, w, h, r) => { p.beginPath(); p.roundedRect(x, y, w, h, r, r) };
            p.fillStyle = Qt.darker(Theme.c.panel, 1.25);
            rr(0.5, 0.5, 391, sheetH - 1, 12); p.fill();
            const line = (pts, col, wd, dash) => {
                p.strokeStyle = col; p.lineWidth = wd; p.lineCap = "round"; p.lineJoin = "round";
                p.setLineDash ? p.setLineDash(dash ? [4, 3] : []) : null;
                p.beginPath(); p.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]); p.stroke();
            };
            const icon = (kind, cx, cy) => {
                p.save();
                if (kind === "screen") {
                    p.strokeStyle = ink; p.lineWidth = 1.6; rr(cx - 15, cy - 11, 30, 19, 3); p.stroke();
                    line([[cx - 6, cy + 12], [cx + 6, cy + 12]], ink, 1.6);
                    p.strokeStyle = acc; p.beginPath(); p.ellipse(cx + 3 - 4, cy - 2 - 4, 8, 8); p.stroke();
                    line([[cx + 3, cy - 9], [cx + 3, cy + 5]], acc, 1.6); line([[cx - 4, cy - 2], [cx + 10, cy - 2]], acc, 1.6);
                } else if (kind === "magnifier") {
                    p.strokeStyle = acc; p.lineWidth = 2.2; p.beginPath(); p.ellipse(cx - 3 - 9, cy - 3 - 9, 18, 18); p.stroke();
                    line([[cx + 4, cy + 4], [cx + 12, cy + 12]], acc, 2.2);
                } else if (kind === "funnel") {
                    line([[cx - 13, cy - 10], [cx + 13, cy - 10], [cx + 3, cy + 1], [cx + 3, cy + 11], [cx - 3, cy + 8], [cx - 3, cy + 1], [cx - 13, cy - 10]], acc, 1.8);
                } else if (kind === "cuts") {
                    p.fillStyle = acc; rr(cx - 17, cy - 7, 22, 14, 2.5); p.fill();
                    p.fillStyle = accent; rr(cx + 9, cy - 12, 9, 22, 2.5); p.fill();
                } else if (kind === "review") {
                    p.strokeStyle = ink; p.lineWidth = 1.6; rr(cx - 13, cy - 11, 26, 22, 3); p.stroke();
                    line([[cx - 6, cy], [cx - 2, cy + 4], [cx + 6, cy - 5]], String(Theme.c.ok), 2.4);
                } else if (kind === "upload") {
                    line([[cx, cy + 10], [cx, cy - 9]], acc, 2.2); line([[cx - 7, cy - 2], [cx, cy - 10], [cx + 7, cy - 2]], acc, 2.2);
                    line([[cx - 10, cy + 12], [cx + 10, cy + 12]], acc, 2.2);
                } else if (kind === "box") {
                    p.strokeStyle = muted; p.lineWidth = 1.8; rr(cx - 12, cy - 4, 24, 15, 2); p.stroke();
                    line([[cx - 12, cy - 4], [cx - 8, cy - 10], [cx + 8, cy - 10], [cx + 12, cy - 4]], muted, 1.8);
                }
                p.restore();
            };
            const node = (x, y, kind, caption, dashed) => {
                p.save();
                p.fillStyle = String(Theme.c.field); rr(x, y, NW, NH, 10); p.fill();
                p.strokeStyle = dashed ? muted : accent; p.lineWidth = 1.3;
                if (p.setLineDash) p.setLineDash(dashed ? [4, 3] : []);
                rr(x, y, NW, NH, 10); p.stroke();
                if (p.setLineDash) p.setLineDash([]);
                p.restore();
                icon(kind, x + NW / 2, y + NH / 2);
                p.fillStyle = muted;
                p.font = "10px \"" + Theme.family + "\"";
                p.textAlign = "center";
                const words = caption.split(" "), lines = [""];
                for (const w of words) { const t = (lines[lines.length - 1] + " " + w).trim(); if (p.measureText(t).width > NW + 16 && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = t }
                lines.forEach((l, i) => p.fillText(l, x + NW / 2, y + NH + 13 + i * 12));
            };
            const arrowTo = (ax, ay, bx, by, dashed) => {
                const col = dashed ? muted : acc;
                if (p.setLineDash) p.setLineDash(dashed ? [4, 3] : []);
                line([[ax, ay], [bx, by]], col, 1.5);
                if (p.setLineDash) p.setLineDash([]);
                const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
                if (len > 1) {
                    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
                    line([[bx, by], [bx - ux * 6 + nx * 3.5, by - uy * 6 + ny * 3.5]], col, 1.5);
                    line([[bx, by], [bx - ux * 6 - nx * 3.5, by - uy * 6 - ny * 3.5]], col, 1.5);
                }
            };
            if (kind === "clips") {
                const gap = (392 - 4 * NW) / 5, y = 12;
                const icons = ["screen", "magnifier", "funnel", "cuts"];
                const caps = ["Your game screen", "Find the best moments", "Match filter", "H and V clips"];
                for (let i = 0; i < 4; i++) {
                    const x = gap + i * (NW + gap);
                    node(x, y, icons[i], caps[i]);
                    if (i < 3) arrowTo(x + NW + 3, y + NH / 2, x + NW + gap - 3, y + NH / 2);
                }
            } else {
                const x0 = 14, x1 = 128, x2 = 288;
                node(x0, 54, "cuts", "A finished clip");
                node(x1, 54, "review", "You read and approve");
                node(x2, 10, "upload", "YouTube Shorts, private");
                node(x2, 98, "box", "TikTok, Reels: package", true);
                arrowTo(x0 + NW + 3, 77, x1 - 3, 77);
                arrowTo(x1 + NW + 3, 70, x2 - 3, 33);
                arrowTo(x1 + NW + 3, 84, x2 - 3, 121, true);
            }
        }
    }

    Item {
        id: head
        anchors { left: parent.left; right: parent.right; top: parent.top; leftMargin: 16; rightMargin: 10; topMargin: 12 }
        height: 30
        Text {
            anchors { left: parent.left; verticalCenter: parent.verticalCenter }
            text: "Help"
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 16
            font.weight: Font.DemiBold
        }
        GuideClose {
            id: closeBtn
            objectName: "guideHelpClose"
            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
            tip: "Close help"
            onClicked: help.open = false
        }
    }
    Flickable {
        id: scroll
        anchors { left: parent.left; right: parent.right; top: head.bottom; bottom: replay.top; leftMargin: 16; rightMargin: 10; topMargin: 8; bottomMargin: 10 }
        contentHeight: body.implicitHeight + 6
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Column {
            id: body
            width: scroll.width - 8
            spacing: 8
            Section { id: s1; objectName: "guideSection:clips"; text: "How clips are made" }
            Art { kind: "clips" }
            Bullet { say: "Ujwalam reads the game screen in your recording, or while you stream, and finds your best moments." }
            Bullet { say: "The match filter keeps clips only from matches that went well: by default the ones where you finish in the top 3. You can also set a number of kills." }
            Bullet { say: "Each moment is cut into a wide (H) clip and a tall (V) clip." }
            Bullet { say: "Clips are saved in the My clips folder. While you are live, only light work runs; the clip videos are made after the stream." }
            Bullet { say: "You choose when it happens (ask me, after I stop, while I record, or never) in Settings, Clips. Save clip and Mark moment work any time." }
            UButton { id: showClips; objectName: "guideShowClips"; text: "Show me"; kind: "primary"; onClicked: help.showMe("clips") }
            Item { width: 1; height: 8 }
            Section { id: s2; objectName: "guideSection:posting"; text: "Posting your clips" }
            Art { kind: "posting" }
            Caption { text: "WORKS TODAY" }
            Bullet { say: "Posts (in the More menu, when posting is switched on) shows a package for each clip: the video, a cover picture and text for YouTube Shorts, TikTok and Instagram Reels. You read, edit and approve each one. This step sends nothing." }
            Bullet { say: "An approved clip can go to YouTube Shorts as a private video. It goes up only when you click Upload, and nothing becomes public by itself. Signing in to YouTube is set up from the command line for now." }
            Bullet { say: "TikTok and Instagram Reels: Ujwalam prepares the package only. You upload those yourself." }
            Caption { text: "NEEDS YOUR CLICK" }
            Bullet { say: "Switching posting on, and every upload. Uploads are refused while you are live." }
            Caption { text: "AUTOMATIC POSTING" }
            Bullet { say: "It exists only as an opt-in rule file used from the command line after a stream, and it is off. The rule list is empty, so nothing posts by itself. A rule can approve matching clips, and only if you also allow it, upload them privately to YouTube Shorts. There is no switch for it in this window yet." }
            Caption { objectName: "helpFacts"; text: help.facts }
            UButton { id: showPosting; objectName: "guideShowPosting"; text: "Show me"; kind: "primary"; onClicked: help.showMe("posting") }
        }
    }
    UButton {
        id: replay
        objectName: "guideHelpReplay"
        anchors { left: parent.left; bottom: parent.bottom; leftMargin: 16; bottomMargin: 14 }
        text: "Replay the welcome tour"
        onClicked: help.replayTour()
    }
}
