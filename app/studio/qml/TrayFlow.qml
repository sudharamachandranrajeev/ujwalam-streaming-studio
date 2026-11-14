// SPDX-License-Identifier: GPL-3.0-or-later
// Keep running in the tray (D311 proposed; the widget's enterTray, leaveTray, stopAllFromTray and the allFinished
// handler, main_window.cpp). The tray itself is the widget studio's TrayKeeper through the Tray bridge (qml_tasks.h).
// The window hides (its previews with it), the status polls go on and the tray lists the tasks. The studio ends when the
// tasks finish or on Stop all, never while a stream or recording runs: every exit asks the UI server for the quit lock
// first (ui/api/quit/begin, then commit; fail closed) and releases a granted lock it does not use (ui/api/quit/cancel).
import QtQuick
import Ujwalam.Core

QtObject {
    id: flow
    required property var store
    required property var window
    property string stay: "" // why the studio stayed open (live, recording, unreadable, not-confirmed)

    function enter() {
        Tray.setQuitOnLastWindowClosed(false);
        window.hide();
        Tray.begin(store.tasks);
        Api.log("studio tray: on (" + store.activeTasks + " task(s))");
    }

    function leave() {
        Tray.end();
        Tray.setQuitOnLastWindowClosed(true);
        if (!studioHidden) { // the user asked for it: a normal show (D316); hidden mode never shows a window
            window.show();
            window.raise();
            window.requestActivate();
        }
        Api.log("studio tray: off (window open again)");
    }

    // then(can, why, token): the quit lock, fail closed (no answer, or no token: not granted).
    function requestQuit(then) {
        Api.post("ui/api/quit/begin", {}, (ok, r) => {
            if (ok && r && r.granted === true && typeof r.token === "string") return then(true, "", r.token);
            const why = ok && r && r.reason ? String(r.reason) : "";
            then(false, why === "" ? "unreadable" : why, "");
        });
    }
    function commitQuit(token, exitNow, stayOpen) {
        Api.post("ui/api/quit/commit", { token: token }, (ok, r) => {
            if (ok && r && r.ok === true) return exitNow();
            releaseQuit(token);
            Api.log("studio tray: quit not confirmed; staying open");
            stayOpen();
        });
    }
    function releaseQuit(token) {
        if (token) Api.post("ui/api/quit/cancel", { token: token }, () => {});
    }

    // Stop all from the tray: the click acts at once (D332). Unfinished clip jobs run again at the next start.
    function stopAll() {
        requestQuit((can, why, token) => {
            if (can) {
                commitQuit(token, () => {
                    Api.log("studio tray: stop all");
                    Qt.quit(); // exit 0: the launcher ends every task's whole process tree
                }, () => store.say("Ujwalam did not close: the quit was no longer confirmed. Try Stop all again."));
                return;
            }
            // Live, recording or unknown: quitting would stop them. Stop the tasks only; the studio and host stay, and
            // the tray ends when the stopped tasks show as ended (allFinished, checked again).
            stay = why;
            Api.log("studio tray: stop tasks only (" + why + ")");
            Api.post("ui/api/tasks/stop", {}, (ok, b, err) => { if (!ok) store.say("Could not stop the tasks: " + err); });
        });
    }

    // Every task done or failed: exit 0 makes the launcher stop the host, so never while a stream or recording runs (it
    // may have been started from the control page while the window was in the tray). Then the window comes back.
    function finished(countdown) {
        requestQuit((can, why, token) => {
            // The request took a while: a task may have started (the countdown was cancelled) or the window come back.
            // Then nothing exits, and a granted lock is released so going live is not blocked.
            if (!Tray.stillFinished(countdown)) {
                releaseQuit(token);
                Api.log("studio tray: not quitting (a task started or the window came back meanwhile)");
                return;
            }
            if (!can) {
                stay = why;
                Api.log("studio tray: all tasks finished; staying open (" + why + ")");
                store.say("All tasks finished. Ujwalam stays open: " + (why === "unreadable" ? "could not confirm that nothing is live" : why) + ".");
                return leave();
            }
            commitQuit(token, () => {
                Api.log("studio tray: all tasks finished; exiting");
                Api.log("studio tray probe: " + JSON.stringify(Tray.probe()));
                Qt.quit(); // exit 0: the launcher stops everything else (D280)
            }, () => { stay = "not-confirmed"; leave(); });
        });
    }

    // tray:<click|open|stop> (probe): the tray's own choices.
    function probeAction(a) {
        if (!Tray.active) return false;
        if (a === "tray:click") Tray.showList();
        else if (a === "tray:open") leave();
        else if (a === "tray:stop") stopAll();
        else return false;
        return true;
    }

    property Connections pTray: Connections {
        target: Tray
        function onOpenRequested() { flow.leave() }
        function onStopAllRequested() { flow.stopAll() }
        function onAllFinished(countdown) { flow.finished(countdown) }
    }
    // Every status poll while in the tray (the store reassigns tasks on each poll).
    property Connections pTasks: Connections {
        target: flow.store
        function onTasksChanged() { if (Tray.active) Tray.update(flow.store.tasks) }
    }
}
