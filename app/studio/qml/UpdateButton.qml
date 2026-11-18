// SPDX-License-Identifier: GPL-3.0-or-later
// "Update available" in the on-air bar (setup installer, 2026-11-18): shown only when the build folder holds a newer
// package whose checksum matches. One click installs it through Ujwalam-Setup.exe for the next start (no typed
// confirmation, D332); while live or recording the server refuses with a plain note. It asks the server once at start
// and when "Check for updates" is clicked (More menu); while an install runs it re-reads every 3 s until it ends. No
// other polling.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UButton {
    id: btn
    objectName: "updateBtn"
    required property var store
    property var st: ({})
    property bool installing: false
    readonly property bool onAir: store.live || store.recording
    visible: installing || st.available === true
    kind: "primary"
    readonly property string version: st.installing || (st.latest ? st.latest.version : "")
    text: installing ? "Updating to " + version + "…" : "Update available: " + version
    enabled: !installing
    tip: onAir ? "A newer Ujwalam is ready. Stop the stream and the recording first, then click to install it for the next start."
               : "Install Ujwalam " + version + " from the build folder. Your settings are backed up first; it runs from the next start."

    // check(true): "Check for updates" (fresh checksum, says what it found); check(false): the start-up look.
    function check(fresh) {
        Api.get("ui/api/setup/update" + (fresh ? "?fresh=1" : ""), (ok, b, err) => {
            if (!ok) { if (fresh) btn.store.say("Could not check for updates: " + err); return; }
            btn.st = b;
            btn.installing = !!b.installing;
            if (b.last && !b.installing && btn.watching) { btn.watching = false; btn.store.say(b.last.message); }
            if (!fresh) return;
            if (b.available) btn.store.say("Update available: Ujwalam " + b.latest.version + ". Click the button in the top bar to install it.");
            else btn.store.say(btn.why(b));
        });
    }
    function why(b) {
        if (b.reason === "not-installed") return "Updates work in an installed Ujwalam (this one runs from a checkout).";
        if (b.reason === "no-update-folder") return "No build folder is set: install once with Ujwalam-Setup.exe from the build folder.";
        if (b.reason === "no-package") return "No package in the build folder " + b.folder + ".";
        if (b.reason === "not-verified") return "The package " + b.latest.version + " does not match its checksum file; build it again.";
        if (b.reason === "no-setup") return "Ujwalam-Setup.exe is missing from the build folder; build the package again.";
        return "Ujwalam " + (b.current || "") + " is up to date.";
    }
    property bool watching: false
    Timer { interval: 3000; repeat: true; running: btn.installing; onTriggered: btn.check(false) }
    Component.onCompleted: check(false)

    onClicked: {
        if (installing) return;
        Api.post("ui/api/setup/update", {}, (ok, b, err) => {
            if (!ok) { btn.store.say(b && b.message ? b.message : "The update did not start: " + err); btn.check(false); return; }
            btn.installing = true;
            btn.watching = true;
            btn.store.say("Installing Ujwalam " + b.version + " for the next start. Your settings are backed up first.");
        });
    }
}
