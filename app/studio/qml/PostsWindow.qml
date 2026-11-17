// SPDX-License-Identifier: GPL-3.0-or-later
// Posts (flag posting; QML twin of the widget openPosts, plan Q4): the clip packages made after a stream. Edit the text,
// Approve or Reject (local files only), open the package folder, see the auto-post mode and a read-only dry run of its
// rules, the auto-upload queue state with "Retry now", and the private YouTube upload (Upload as private / Check
// status: one call at a time, the server re-checks that nothing is live). Its own window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "postsDlg"
    required property var store
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: Math.min(760, parent ? parent.width - 40 : 760)
    implicitHeight: Math.min(620, parent ? parent.height - 40 : 620)
    title: "Posts"
    closePolicy: Popup.CloseOnEscape

    property string info: "Loading..."
    property string autoInfo: ""
    property string previewInfo: ""
    property string queueInfo: ""
    property var posts: []
    property string selected: ""
    property bool signedIn: false
    property bool busy: false
    property int gen: 0

    readonly property var post: { for (const p of posts) if (p.id === selected) return p; return null }
    readonly property string queueState: post && post.queueState ? String(post.queueState) : ""
    readonly property bool isYoutube: post !== null && String(post.target || "").startsWith("youtube")
    readonly property bool uploaded: post !== null && post.status === "uploaded"
    readonly property bool canUpload: !busy && !uploaded && signedIn && post !== null && post.status === "approved"
    readonly property bool canCheck: !busy && uploaded
    readonly property bool retryShown: queueState === "failed" || (queueState === "queued" && !!(post && post.queueReasonText))

    function show() {
        gen++;
        info = "Loading...";
        autoInfo = "";
        previewInfo = "";
        queueInfo = "";
        posts = [];
        selected = "";
        // `busy` is not reset here: it belongs to the one request still on its way (Codex review), which may outlive a
        // close and reopen; only its own answer clears it, so no second action (or a second upload) starts meanwhile.
        open();
        const g = gen;
        reload();
        Api.get("ui/api/posts/auto", (ok, r) => {
            if (g !== gen || !ok) return;
            const m = r.mode || {};
            autoInfo = "Auto-post: " + (m.enabled === true ? "ON" : "off (review-first)") + ", " + (m.ruleCount || 0) + " rule(s), "
                     + (m.autoUpload === true ? "approve and upload (private)" : "approve only") + ". " + (r.plan || []).length + " planned action(s)."
                     + (r.rulesFile ? "\nRules file: " + r.rulesFile : "");
        });
        Api.get("ui/api/posts/youtube/status", (ok, r) => {
            if (g !== gen) return;
            signedIn = ok && r.signedIn === true;
        });
        return true;
    }
    onClosed: gen++

    // `said`: the outcome of the action that asked for the reload; it stays on the info line (render would replace it).
    // `release`: the upload or check keeps `busy` until the package's new status is read (else Upload is enabled again
    // on the old "approved" status for a moment).
    function reload(said, release) {
        const g = gen;
        Api.get("ui/api/posts", (ok, r, err) => {
            if (release) busy = false;
            if (g !== gen) return;
            if (!ok) { info = "Posts unavailable: " + err; return; }
            const q = r.queue;
            queueInfo = !q ? "" : "Upload queue: " + (q.queued || 0) + " waiting, " + (q.uploading || 0) + " uploading, " + (q.done || 0) + " done, "
                                 + (q.failed || 0) + " failed. " + (q.message || "");
            render(r.posts || []);
            if (said) info = said;
        });
    }
    function render(list) {
        const keep = selected;
        posts = list;
        if (post === null) selected = "";
        info = posts.length === 0 ? "No packages yet. Make them with services/posting/cli.mjs after a stream."
             : posts.length + " package(s). Private drafts only; approving marks a package. Upload to YouTube is separate (Upload as private).";
        if (selected === keep && post !== null) fillForm();
    }
    function flagged(p) { return (p.limits && p.limits.ok === false) || (p.unresolved || []).length > 0 }
    function rowText(p) {
        return (p.clipId || "") + "  " + (p.target || "") + "   " + (p.status || "") + (flagged(p) ? " / check" : "") + (p.queueState ? " / " + p.queueState : "");
    }
    function metaText(p) {
        if (!p) return "";
        return (p.target || "") + "  " + (p.layout || "") + "  " + p.startSec + "-" + p.endSec + " s  privacy " + (p.privacy || "") + "  status " + (p.status || "");
    }
    function limitsText(p) {
        if (!p) return "";
        const lim = p.limits || {};
        const bits = (lim.checks || []).map(c => c.field + " " + c.value + "/" + c.max + (c.unit ? " " + c.unit : "") + (c.ok ? "" : " OVER"));
        if ((p.unresolved || []).length) bits.push("unresolved: " + p.unresolved.join(", "));
        return (bits.length ? bits.join("  ") : "no limits checked") + (lim.status === "unverified" ? "  (limits UNVERIFIED)" : "");
    }
    function when(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString() }
    function queueText(p) {
        const qs = queueState;
        if (!qs) return "";
        const bits = [qs === "queued" ? "waiting" : qs === "done" ? "uploaded" : qs];
        if (p.queueReasonText) bits.push(p.queueReasonText);
        if (qs === "queued" && p.queueNextAt) bits.push("next try " + when(p.queueNextAt));
        if (p.queuePublishAt) bits.push((qs === "done" ? "goes public " : "will go public ") + when(p.queuePublishAt));
        if (p.videoUrl) bits.push("link (private): " + p.videoUrl);
        return bits.join(". ") + ".";
    }
    function ytText(p) {
        if (!p) return "";
        if (uploaded) return "Uploaded as private video " + (p.videoId || "?") + ". Use Check status to see if YouTube finished processing.";
        if (!signedIn) return "Not signed in. Run in a terminal: node services/posting/cli.mjs youtube signin";
        return p.status === "approved" ? "Approved. Ready to upload as private." : "Approve the package first.";
    }
    function pick(id) {
        selected = id;
        if (post === null) return false;
        fillForm();
        return true;
    }
    function fillForm() {
        titleField.text = post.title || "";
        descText.text = post.description || "";
        tagsField.text = (post.tags || []).join(", ");
        hashField.text = (post.hashtags || []).join(", ");
    }
    function csv(s) { return String(s).split(",").map(x => x.trim()).filter(x => x !== "") }
    // Edit / approve / reject: local files only; the reply carries the updated package.
    function act(route, body) {
        if (post === null || busy) return false;
        const g = gen;
        busy = true;
        Api.post(route, body, (ok, r, err) => {
            busy = false;
            if (g !== gen) return;
            if (!ok) { info = "Not done: " + err; return; }
            const np = r.post || {};
            posts = posts.map(p => p.id === np.id ? Object.assign({}, p, np) : p);
            fillForm();
            info = "Saved.";
        });
        return true;
    }
    function save() { return act("ui/api/posts/edit", { id: selected, title: titleField.text, description: descText.text, tags: csv(tagsField.text), hashtags: csv(hashField.text) }) }
    function setStatus(s) { return act("ui/api/posts/status", { id: selected, status: s }) }
    function openFolder() {
        if (post === null) return false;
        const g = gen;
        Api.post("ui/api/posts/open", { id: selected }, (ok, r, err) => { if (g === gen && !ok) info = "Could not open the folder: " + err });
        return true;
    }
    // Upload / check: one call at a time; the list is re-read afterwards (status and video id come from the server).
    function youtube(upload) {
        if (upload ? !canUpload : !canCheck) return false;
        const g = gen;
        busy = true;
        info = upload ? "Uploading... this can take a while. Keep this window open." : "Checking...";
        Api.post(upload ? "ui/api/posts/youtube/upload" : "ui/api/posts/youtube/check", { id: selected }, (ok, r, err) => {
            // Always re-read (it clears busy); the outcome only shows in the window that asked.
            reload(g !== gen ? "" : !ok ? "Not done: " + err
                 : upload ? "Uploaded as private video " + r.videoId + "."
                 : "Video " + r.videoId + ": " + (r.found === true ? "upload " + (r.uploadStatus || "?") + ", processing " + (r.processingStatus || "?") + ", privacy " + (r.privacyStatus || "?") : "not found"), true);
        });
        return true;
    }
    function retry() {
        if (!retryShown || busy) return false;
        const g = gen;
        Api.post("ui/api/posts/queue/retry", { id: selected }, (ok, r, err) => {
            if (g !== gen) return;
            reload(ok ? "Queued again. It uploads at the next check if no stream is live." : "Not done: " + err);
        });
        return true;
    }
    // Read-only dry run: what the rules would queue and skip. Nothing is written or sent.
    function preview() {
        const g = gen;
        previewInfo = "Checking...";
        Api.get("ui/api/posts/auto/preview", (ok, r, err) => {
            if (g !== gen) return;
            if (!ok || r.error) { previewInfo = "Preview unavailable." + (ok ? "" : " " + err); return; }
            const q = r.queued || [], sk = r.skipped || [];
            const kMax = 12;
            const L = [];
            if (r.rulesFile) L.push("Rules file: " + r.rulesFile);
            L.push("Dry run: " + q.length + " would be queued, " + sk.length + " skipped. Nothing is written or sent.");
            if (r.blocked) L.push("A stream looks live (" + r.blocked + "): a run would be refused.");
            q.slice(0, kMax).forEach(o => {
                let line = "  would " + (o.actions || []).join(" + ") + ": " + (o.kind || "?") + " to " + (o.target || "-") + " (rule " + (o.ruleId || "") + ") " + (o.id || "");
                if (typeof o.publishAt === "string") line += ", goes public about " + o.publishAt;
                else if (o.publishNote === "beyond-cap") line += ", waits: public time too far ahead";
                L.push(line);
            });
            if (q.length > kMax) L.push("  ... and " + (q.length - kMax) + " more");
            sk.slice(0, kMax).forEach(o => L.push("  skip " + (o.kind || "?") + " " + (o.target || "-") + " " + (o.id || "") + ": " + (o.reason || "") + (o.detail ? " (" + o.detail + ")" : "")));
            if (sk.length > kMax) L.push("  ... and " + (sk.length - kMax) + " more skipped");
            previewInfo = L.join("\n");
        });
        return true;
    }

    // ---- probe (tests): posts-open, posts-pick:<n>, posts-title:<enc>, posts-desc:<enc>, posts-tags:<enc>,
    // posts-hashtags:<enc>, posts-save, posts-approve, posts-reject, posts-folder, posts-preview, posts-retry, posts-check,
    // posts-close. (Upload is not a probe action: it would send a video; the tests read uploadEnabled.) ----
    function probe() {
        return { open: opened, info: info, autoInfo: autoInfo, previewInfo: previewInfo, queueInfo: queueInfo, rows: posts.map(rowText), selected: selected,
                 formShown: post !== null, meta: metaText(post), limits: limitsText(post), title: titleField.text, desc: descText.text, tags: tagsField.text,
                 hashtags: hashField.text, ytShown: isYoutube, ytInfo: ytText(post), uploadEnabled: canUpload, checkEnabled: canCheck,
                 queueShown: queueState !== "", queueText: post ? queueText(post) : "", retryShown: retryShown, busy: busy };
    }
    function probeAction(a) {
        if (a === "posts-open") return show();
        if (!opened) return false;
        if (a === "posts-close") { close(); return true }
        if (a === "posts-preview") return preview();
        if (a.startsWith("posts-pick:")) { const n = parseInt(a.slice(11), 10); return n >= 0 && n < posts.length && pick(posts[n].id) }
        if (post === null) return false;
        if (a.startsWith("posts-title:")) { titleField.text = decodeURIComponent(a.slice(12)); return true }
        if (a.startsWith("posts-desc:")) { descText.text = decodeURIComponent(a.slice(11)); return true }
        if (a.startsWith("posts-tags:")) { tagsField.text = decodeURIComponent(a.slice(11)); return true }
        if (a.startsWith("posts-hashtags:")) { hashField.text = decodeURIComponent(a.slice(15)); return true }
        if (a === "posts-save") return save();
        if (a === "posts-approve") return setStatus("approved");
        if (a === "posts-reject") return setStatus("rejected");
        if (a === "posts-folder") return openFolder();
        if (a === "posts-retry") return retry();
        if (a === "posts-check") return youtube(false);
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
    component Line: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        visible: text !== ""
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 13
    }
    // One scrolling column: the list has a fixed height (the widget's 170), the form below it grows.
    contentItem: ScrollView {
        id: scroll
        clip: true
        contentWidth: availableWidth
        Column {
            width: scroll.availableWidth
            spacing: 8
            Line { objectName: "postsInfo"; text: dlg.info; font.pixelSize: 14 }
            Line { objectName: "postsAuto"; text: dlg.autoInfo; color: Theme.c.muted }
            UButton {
                objectName: "postsPreview"
                text: "Preview auto-post rules"
                onClicked: dlg.preview()
            }
            Line { objectName: "postsPreviewInfo"; text: dlg.previewInfo }
            Line { objectName: "postsQueue"; text: dlg.queueInfo }
            ListView {
                objectName: "postsList"
                width: parent.width
                height: 170
                clip: true
                model: dlg.posts
                boundsBehavior: Flickable.StopAtBounds
                ScrollBar.vertical: ScrollBar {}
                delegate: Rectangle {
                    id: row
                    required property var modelData
                    required property int index
                    objectName: "postsItem:" + index
                    width: ListView.view.width
                    height: 30
                    radius: Theme.radiusSmall
                    color: row.modelData.id === dlg.selected ? Theme.c.accent : hover.hovered ? Theme.c.field : "transparent"
                    Text {
                        anchors { left: parent.left; right: parent.right; leftMargin: 8; rightMargin: 8; verticalCenter: parent.verticalCenter }
                        text: dlg.rowText(row.modelData)
                        elide: Text.ElideRight
                        color: row.modelData.id === dlg.selected ? Theme.c.onAccent : Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 13
                    }
                    HoverHandler { id: hover }
                    TapHandler { onTapped: dlg.pick(row.modelData.id) }
                }
            }
            Column {
                objectName: "postsForm"
                width: parent.width
                spacing: 8
                visible: dlg.post !== null
                Line { text: dlg.metaText(dlg.post); color: Theme.c.muted }
                Line { objectName: "postsLimits"; text: dlg.limitsText(dlg.post) }
                UField { id: titleField; objectName: "postsTitle"; width: parent.width; label: "Title"; placeholderText: "Title" }
                ScrollView {
                    width: parent.width
                    height: 90
                    TextArea {
                        id: descText
                        objectName: "postsDesc"
                        placeholderText: "Description"
                        wrapMode: TextArea.Wrap
                        color: Theme.c.text
                        placeholderTextColor: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: 14
                        Accessible.name: "Description"
                        background: Rectangle {
                            radius: Theme.radiusSmall
                            color: Theme.c.field
                            border.width: 1
                            border.color: descText.activeFocus ? Theme.c.accentHi : Theme.c.border
                        }
                    }
                }
                UField { id: tagsField; objectName: "postsTags"; width: parent.width; label: "Tags"; placeholderText: "Tags, comma separated" }
                UField { id: hashField; objectName: "postsHashtags"; width: parent.width; label: "Hashtags"; placeholderText: "Hashtags, comma separated" }
                Row {
                    spacing: 10
                    UButton { objectName: "postsSave"; text: "Save"; kind: "primary"; enabled: !dlg.busy; onClicked: dlg.save() }
                    UButton { objectName: "postsApprove"; text: "Approve"; enabled: !dlg.busy; onClicked: dlg.setStatus("approved") }
                    UButton { objectName: "postsReject"; text: "Reject"; enabled: !dlg.busy; onClicked: dlg.setStatus("rejected") }
                    UButton { objectName: "postsFolder"; text: "Open folder"; onClicked: dlg.openFolder() }
                }
                // D301 upload queue of the auto-post chain: state, plain reason, link when uploaded, Retry now.
                Column {
                    width: parent.width
                    spacing: 6
                    visible: dlg.queueState !== ""
                    Line { text: "Auto-upload queue"; font.weight: Font.DemiBold }
                    Line { objectName: "postsQueueSel"; text: dlg.post ? dlg.queueText(dlg.post) : "" }
                    UButton { objectName: "postsRetry"; text: "Retry now"; visible: dlg.retryShown; enabled: !dlg.busy; onClicked: dlg.retry() }
                }
                Column {
                    width: parent.width
                    spacing: 6
                    visible: dlg.isYoutube
                    Line { text: "YouTube (private upload)"; font.weight: Font.DemiBold }
                    Line { objectName: "postsYtInfo"; text: dlg.ytText(dlg.post) }
                    Row {
                        spacing: 10
                        UButton { objectName: "postsUpload"; text: "Upload as private"; enabled: dlg.canUpload; onClicked: dlg.youtube(true) }
                        UButton { objectName: "postsCheck"; text: "Check status"; enabled: dlg.canCheck; onClicked: dlg.youtube(false) }
                    }
                }
            }
        }
    }
    footer: Item {
        implicitHeight: 56
        UButton {
            objectName: "postsClose"
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            text: "Close"
            onClicked: dlg.close()
        }
    }
}
