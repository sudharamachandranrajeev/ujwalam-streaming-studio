// SPDX-License-Identifier: GPL-3.0-or-later
// Import Meld session (QML twin of the widget openImport, plan Q4): reads the Meld session file into a new project file
// (never changing existing scenes, layers, devices or settings) and checks it against the host. "Load into the studio"
// then loads it through the same route as the widget (a live change still asks through the confirm window). Its own
// window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "importDlg"
    required property var store
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    width: Math.min(560, parent ? parent.width - 40 : 560)
    height: Math.min(460, parent ? parent.height - 40 : 460)
    title: "Import Meld session"
    closePolicy: Popup.CloseOnEscape

    property string info: ""
    property var counts: []
    property bool canLoad: false
    property bool unavailable: false        // the host cannot show some items: offer to skip them
    property int gen: 0

    function show() {
        gen++;
        info = "Importing and checking against the host...";
        counts = [];
        canLoad = false;
        unavailable = false;
        skipBox.checked = false;
        open();
        const g = gen;
        Api.post("ui/api/project/import-meld", {}, (ok, r, err) => {
            if (g !== gen) return;
            if (!ok) {
                info = String(err).startsWith("HTTP 503")
                     ? "No Meld session file is configured (set UJWALAM_MELD_SESSION or paths.meld_session in the local profile)."
                     : "Import failed: " + err;
                return;
            }
            const imp = r.imported || {}, plan = r.plan || {};
            const bits = ["Created a new project file (" + (imp.file || "") + ")."];
            if ((imp.skipped || 0) > 0) bits.push(imp.skipped + " item(s) skipped by the importer.");
            if (r.planError) bits.push("Host check failed (" + r.planError + ").");
            info = bits.join(" ");
            const list = [];
            const add = (prefix, o) => { for (const k in (o || {})) if (typeof o[k] === "number" || typeof o[k] === "boolean") list.push(prefix + k + ": " + o[k]); };
            add("imported ", imp.counts);
            add("skipped ", imp.skippedByKind);
            add("plan ", plan);
            counts = list;
            unavailable = (plan.unavailable || 0) > 0;
            canLoad = r.plan !== null && r.plan !== undefined && Object.keys(plan).length > 0;
        });
        return true;
    }
    onClosed: gen++

    function load() {
        if (!canLoad) return false;
        const body = unavailable && skipBox.checked ? { skipUnavailable: true } : {};
        close();
        Api.post("ui/api/project/load", body, (ok, r, err) => {
            if (!ok) return store.say("Not loaded: " + err);
            if (r.verdict === "confirm") store.confirmNeeded(r.pending);
        });
        return true;
    }

    // ---- probe (tests): import-open, import-skip:<on|off>, import-load, import-close ----
    function probe() { return { open: opened, info: info, counts: counts, canLoad: canLoad, skipShown: unavailable, skip: skipBox.checked } }
    function probeAction(a) {
        if (a === "import-open") return show();
        if (!opened) return false;
        if (a === "import-skip:on" || a === "import-skip:off") { if (!unavailable) return false; skipBox.checked = a.endsWith(":on"); return true }
        if (a === "import-load") return load();
        if (a === "import-close") { close(); return true }
        return false;
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: 18
        bottomPadding: 6
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    contentItem: Item {
        Text {
            id: infoText
            objectName: "importInfo"
            anchors { left: parent.left; right: parent.right; top: parent.top }
            text: dlg.info
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        ListView {
            objectName: "importCounts"
            anchors { left: parent.left; right: parent.right; top: infoText.bottom; topMargin: 8; bottom: skipBox.visible ? skipBox.top : parent.bottom; bottomMargin: 8 }
            clip: true
            model: dlg.counts
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            delegate: Text {
                required property string modelData
                width: ListView.view.width
                height: 24
                verticalAlignment: Text.AlignVCenter
                text: modelData
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: 13
            }
        }
        CheckBox {
            id: skipBox
            objectName: "importSkip"
            anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
            visible: dlg.unavailable
            text: "Skip the items the host cannot show (missing files or devices)"
            font.family: Theme.family
            font.pixelSize: 13
            contentItem: Text {
                leftPadding: skipBox.indicator.width + 8
                text: skipBox.text
                wrapMode: Text.Wrap
                color: Theme.c.text
                font: skipBox.font
                verticalAlignment: Text.AlignVCenter
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                objectName: "importClose"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                objectName: "importLoad"
                text: "Load into the studio"
                kind: "primary"
                enabled: dlg.canLoad
                onClicked: dlg.load()
            }
        }
    }
}
