// SPDX-License-Identifier: GPL-3.0-or-later
// The Bots box (flag bot-manager; the widget's loadBots and botAction): Streamer.bot and Speaker.bot with their state,
// Start and Stop (on the click, D332) and the plain facts. Stop only ends a copy Ujwalam started; a copy the user started
// is never stopped here (the server refuses it too). Read on every 5th flag read, as the widget does, and after a click.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    objectName: "botsPanel"
    required property var store
    title: "Bots"
    visible: store.flags["bot-manager"] === true
    implicitHeight: visible ? rows.implicitHeight + 56 : 0

    property var bots: []
    property string error: ""
    property int reads: 0
    property int gen: 0 // a read answered after a newer one started is dropped

    onVisibleChanged: reads = 0 // the flag just came on: read at the next flag read
    Connections {
        target: panel.store
        function onFlagsRead() { if (panel.visible && panel.reads++ % 5 === 0) panel.load() }
    }

    function load() {
        const g = ++gen;
        Api.get("ui/api/bots", (ok, b, err) => {
            if (g !== gen) return;
            error = ok ? "" : "Bots: " + err;
            bots = ok && Array.isArray(b.bots) ? b.bots : [];
        });
    }
    function stateOf(o) {
        return o.ok === true ? "up" : o.running === true ? "running, port not answering" : o.installed === true ? "stopped" : "not installed";
    }
    function yn(v) { return v === true ? "yes" : "no" }
    function facts(o) {
        let t = "installed: " + yn(o.installed) + ", running: " + yn(o.running) + ", port " + o.port + " answering: " + yn(o.portAnswering)
            + ", started by Ujwalam: " + yn(o.startedByUs);
        if (o.error !== undefined) t += "\nCheck failed: " + o.error;
        if (o.wsError !== undefined) t += "\nPort setting refused: " + o.wsError;
        return t;
    }
    function act(bot, start) {
        Api.post(start ? "ui/api/bots/start" : "ui/api/bots/stop", { bot: bot }, (ok, r, err) => {
            if (!ok) store.say("Not done: " + err);
            else if (r.verdict === "confirm") store.confirmNeeded(r.pending);
            load();
        });
    }

    // ---- probe (tests): bots-start:<bot>, bots-stop:<bot> (a click on that button; refused when it is off) ----
    function probe() {
        const r = [];
        for (let i = 0; i < rep.count; i++) {
            const it = rep.itemAt(i);
            if (it) r.push({ bot: it.bot, state: stateOf(it.modelData), start: it.startBtn.enabled, stop: it.stopBtn.enabled, facts: facts(it.modelData) });
        }
        return { shown: visible, rows: r, buttons: r.length * 2, error: error, hint: hint.visible ? hint.text : "" };
    }
    function probeAction(a) {
        const p = a.split(":");
        if (!visible || p.length !== 2 || (p[0] !== "bots-start" && p[0] !== "bots-stop")) return false;
        for (let i = 0; i < rep.count; i++) {
            const it = rep.itemAt(i);
            if (!it || it.bot !== p[1]) continue;
            const b = p[0] === "bots-start" ? it.startBtn : it.stopBtn;
            if (!b.enabled) return false;
            b.clicked();
            return true;
        }
        return false;
    }

    Column {
        id: rows
        anchors { left: parent.left; right: parent.right; top: parent.top }
        spacing: 8
        Text {
            visible: panel.error !== ""
            width: rows.width
            text: panel.error
            wrapMode: Text.Wrap
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: 13
        }
        Repeater {
            id: rep
            model: panel.bots
            delegate: Column {
                id: row
                required property var modelData
                readonly property string bot: modelData.bot
                property alias startBtn: startBtn
                property alias stopBtn: stopBtn
                objectName: "botRow:" + bot
                width: rows.width
                spacing: 4
                Item {
                    width: row.width
                    height: Math.max(name.implicitHeight, startBtn.implicitHeight)
                    Text {
                        id: name
                        anchors { left: parent.left; right: buttons.left; rightMargin: 8; verticalCenter: parent.verticalCenter }
                        text: "<b>" + String(row.modelData.label || row.bot).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</b> " + panel.stateOf(row.modelData)
                        textFormat: Text.StyledText
                        wrapMode: Text.Wrap
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 14
                    }
                    Row {
                        id: buttons
                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                        spacing: 6
                        UButton {
                            id: startBtn
                            objectName: "botStart:" + row.bot
                            text: "Start"
                            enabled: row.modelData.installed === true && row.modelData.running !== true && row.modelData.error === undefined
                            onClicked: panel.act(row.bot, true)
                        }
                        UButton {
                            id: stopBtn
                            objectName: "botStop:" + row.bot
                            text: "Stop"
                            enabled: row.modelData.startedByUs === true // a copy the user started is never stopped here
                            onClicked: panel.act(row.bot, false)
                        }
                    }
                }
                Text {
                    width: row.width
                    text: panel.facts(row.modelData)
                    wrapMode: Text.Wrap
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 12
                }
            }
        }
        Text {
            id: hint
            visible: panel.error === "" && panel.bots.length > 0
            width: rows.width
            text: "Start and Stop act on the click. Stop only ends a bot that Ujwalam started."
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 12
        }
    }
}
