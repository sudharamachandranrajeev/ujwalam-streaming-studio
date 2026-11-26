// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Posting & growth > Auto-post (the widget's autopost::Card, D375; plan Q3 slice 4): what uploads by itself, how
// many a day, how far apart and how far ahead, and the next posting times. Every automatic upload goes up scheduled
// (private until its publish time). It loads ui/api/posts/auto/settings and .../schedule when Settings opens (flag posting
// on); Save sends ui/api/posts/auto/settings only when the card changed (the server checks every value again). Moving or
// removing a queued clip acts on its own click (ui/api/posts/auto/queue/move|remove, D332). Not live-gated, like the widget.
// PT5 (D410): the POST TEXT AND GROWTH card (tone, emoji, own hashtags, footer with a preview on the newest clips, the
// share of each kind, growth suggestions) loads ui/api/posts/prefs and saves it with the same Save / Discard.
// D444 INSTAGRAM REELS card: ui/api/posts/instagram (state, never a secret or token), .../app (App ID + App Secret to the
// Credential Manager), .../connect (Facebook Login in the browser), .../disconnect, and the flag instagram-autopost
// (ui/api/flags/set). Each acts on its own click (D332), outside Save / Discard.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: ap
    required property var box
    width: parent ? parent.width : 0
    spacing: Theme.sp.m

    readonly property var kindList: [
        { id: "short", text: "Short clips" }, { id: "montage", text: "Montages" },
        { id: "won-reel", text: "Won-round reels" }, { id: "impact-play", text: "Impact plays" },
        { id: "long-highlights", text: "Long highlights videos" }
    ]

    // ---- state ----
    property bool loaded: false
    property bool started: false          // the load is on its way or done (Settings starts it as soon as the flags are known)
    property int gen: 0                   // a newer load or reset drops older answers
    property var card: ({ autoUpload: true, kinds: [], minScore: 0, maxPerDay: 1, intervalHours: 1, maxAheadDays: 365, placement: "grid-tiers", quotaUnitsPerDay: 10000, postsPerDayMin: 3, postsPerDayMax: 6, windowStart: "09:00", windowEnd: "23:00", minGapMinutes: 60, customTimes: ({}), skipDates: [], tierOffsets: [0, 15, 30, 45], gridGapMinutes: 15, readReuseMinutes: 120 })
    property string orig: ""              // the card as loaded, to see a change
    property var quota: ({})
    property int maxPerDayLimit: 100
    property string flagsText: ""
    property string timesInfo: "Loading..."
    property int schedCount: 0            // scheduled posts (the list itself is in the scheduling manager, SM1)
    property string schedNext: ""          // the next one, UTC
    property bool schedLoaded: false
    readonly property string schedLine: !schedLoaded ? "Loading..." : schedCount === 0 ? "No scheduled posts yet."
        : schedCount + (schedCount === 1 ? " scheduled post" : " scheduled posts") + (schedNext !== "" ? ", the next on " + localTime(schedNext) : "") + "."
    property string message: ""
    property string stuckLockId: ""       // D409 fifth review: a posting lock left by a closed copy (empty = none)
    // "What gets posted" (user 2026-11-20): the rules in use when they are the user's own shape (edited in place, unknown
    // rules and keys kept by the server); otherwise the card's own controls below write the rules.
    property bool rulesOwn: false
    property var rulesEdit: ({ autoUpload: false, maxUploadsPerDay: 1, rules: [] })
    property string rulesOrig: ""
    property var notices: []              // never silent: why nothing uploads, in plain words
    property string skipText: ""
    property string skipProblem: ""
    property string rulesProblem: ""      // Codex round 3: a rules file that cannot be read; only Reset replaces it
    // PT5 (D410): post text and growth (ui/api/posts/prefs)
    readonly property var prefsDefault: ({ text: { tone: "hype", emoji: false, hashtags: [], tags: [], footer: "" }, kindShare: ({ short: 20, montage: 20, "won-reel": 20, "impact-play": 20, "long-highlights": 20 }), growthSuggestions: true })
    property var prefs: JSON.parse(JSON.stringify(prefsDefault))
    property string prefsOrig: ""
    property bool prefsLoaded: false
    property string prefsError: ""
    property string tagsText: ""
    property string tagsProblem: ""
    property string ownTagsText: ""       // own search tags, comma-separated (2026-11-25)
    property string ownTagsProblem: ""
    property var previewItems: []         // [{kind, title, description, hashtags}]
    property string previewInfo: ""
    readonly property var weekDays: [{ id: "mon", text: "Mon" }, { id: "tue", text: "Tue" }, { id: "wed", text: "Wed" }, { id: "thu", text: "Thu" }, { id: "fri", text: "Fri" }, { id: "sat", text: "Sat" }, { id: "sun", text: "Sun" }]

    readonly property bool active: box.ready && box.flagOn("posting")
    // ---- D444 Instagram Reels ----
    property var ig: ({ hasApp: false, connected: false, username: null, expiresAt: null, redirectUri: "", flagOn: false, connecting: false, lastError: null, queue: null })
    property bool igLoaded: false
    property string igAppId: ""
    property string igSecret: ""
    property string igMsg: ""
    readonly property string igStatus: !igLoaded ? "Checking Instagram..."
        : ig.connecting ? "Waiting for you to finish signing in to Facebook in the browser..."
        : ig.connected ? "Connected" + (ig.username ? " to @" + ig.username : "") + (ig.expiresAt ? ". The sign-in renews itself (now valid until " + String(ig.expiresAt).slice(0, 10) + ")." : ".")
        : !ig.hasApp ? "Not connected. Save your Meta app's App ID and App Secret, then click Connect."
        : "Not connected. Click Connect and allow Ujwalam in the browser."
    readonly property string igQueueText: {
        const q = ig.queue;
        if (!ig.connected || !q) return "";
        const parts = [];
        if (q.done) parts.push(q.done + " posted");
        if (q.waiting) parts.push(q.waiting + " waiting" + (q.nextAt ? " (next " + localTime(q.nextAt) + ")" : ""));
        if (q.posting) parts.push(q.posting + " posting now");
        if (q.failed) parts.push(q.failed + " failed");
        return (parts.length ? "Reels: " + parts.join(", ") + "." : "No Reels yet.") + (q.reasonText ? " " + q.reasonText + "." : "");
    }
    function renderIg(b) { ig = b; igLoaded = true }
    function loadIg() {
        Api.get("ui/api/posts/instagram", (ok, b, err) => { if (ok) renderIg(b); else igMsg = "Instagram state is not available: " + err });
    }
    function saveIgApp() {
        if (igAppId.trim() === "" && igSecret.trim() === "") { igMsg = "Type the App ID and App Secret first."; return false }
        Api.post("ui/api/posts/instagram/app", { appId: igAppId.trim(), appSecret: igSecret.trim() }, (ok, b, err) => {
            if (ok) { renderIg(b); igSecret = ""; igMsg = "Saved in Windows Credential Manager." }
            else igMsg = "Not saved: " + ((b && b.text) ? b.text : err);
        });
        return true;
    }
    function connectIg() {
        igMsg = "";
        Api.post("ui/api/posts/instagram/connect", {}, (ok, b, err) => { if (ok) renderIg(b); else igMsg = "Could not start: " + ((b && b.text) ? b.text : err) });
        return true;
    }
    function disconnectIg() {
        Api.post("ui/api/posts/instagram/disconnect", {}, (ok, b, err) => { if (ok) { renderIg(b); igMsg = "Disconnected." } else igMsg = "Not disconnected: " + ((b && b.text) ? b.text : err) });
        return true;
    }
    function dropIg() {
        Api.post("ui/api/posts/instagram/drop", {}, (ok, b, err) => {
            if (ok) { renderIg(b); igMsg = b.dropped ? "Dropped " + b.dropped + " clip(s) from the Instagram queue. Their files are no longer kept for Instagram." : "Nothing was waiting for Instagram." }
            else igMsg = "Not dropped: " + ((b && b.text) ? b.text : err);
        });
        return true;
    }
    function setIgFlag(on) {
        Api.post("ui/api/flags/set", { id: "instagram-autopost", on: on }, (ok, b, err) => { if (!ok) igMsg = "Not changed: " + err; loadIg() });
        return true;
    }
    Timer { interval: 2000; repeat: true; running: ap.ig.connecting && ap.visible; onTriggered: ap.loadIg() }
    readonly property bool cardDirty: loaded && JSON.stringify(card) !== orig
    readonly property bool rulesDirty: loaded && rulesOwn && JSON.stringify(rulesEdit) !== rulesOrig
    readonly property bool prefsDirty: prefsLoaded && JSON.stringify(prefs) !== prefsOrig
    readonly property bool dirty: cardDirty || rulesDirty || prefsDirty
    readonly property int shareSum: kindList.reduce((n, k) => n + (prefs.kindShare[k.id] || 0), 0)
    // The card's own rule controls (kinds, upload, score, per day) changed: only then may Save write the rules file.
    function ruleKeys(o) { return JSON.stringify({ a: o.autoUpload, k: o.kinds, s: o.minScore, m: o.maxPerDay }) }
    readonly property bool ruleKeysDirty: loaded && orig !== "" && ruleKeys(card) !== ruleKeys(JSON.parse(orig))
    readonly property bool customOn: card.placement === "custom"
    readonly property var customNext: customOn ? customPreview(10) : []
    readonly property string problem: !rulesOwn && card.kinds.length === 0 ? "Choose at least one kind of clip to upload."
        : rulesOwn && rulesEdit.rules.some(r => r.kinds.length === 0) ? "Each rule needs at least one kind of clip."
        : customOn && weekDays.every(d => (card.customTimes[d.id] || []).length === 0) ? "Add at least one posting time to the week."
        : gridProblem !== "" ? gridProblem
        : skipProblem !== "" ? skipProblem
        : tagsProblem !== "" ? tagsProblem
        : ownTagsProblem !== "" ? ownTagsProblem
        : prefsLoaded && shareSum !== 100 ? "The shares of each kind add up to " + shareSum + " %; make them add up to 100 %."
        : card.postsPerDayMin > card.postsPerDayMax ? "The fewest posts a day must not be more than the most."
        : minutesOf(card.windowEnd, 0) <= minutesOf(card.windowStart, 0) ? "The posting window must end after it starts." : ""
    readonly property bool blocksSave: dirty && problem !== ""
    readonly property string fit: {
        // Same sum as the server (quota-budget.mjs uploadsFit): the most uploads n a day with
        // n x (upload + thumbnail units) + reads(n) x (one full channel read) <= quota - read reserve, where reads(n) is one
        // read per "reuse the channel read" period (ceil(1440 / minutes)), never more than n; 0 minutes = a read per upload.
        // 0 is possible and is said plainly (the daily budget then stops every upload).
        const per = typeof quota.perUploadUnits === "number" ? quota.perUploadUnits : 0;
        const read = typeof quota.readUnitsPerRead === "number" ? quota.readUnitsPerRead : 0;
        const reserve = typeof quota.readReserveUnits === "number" ? quota.readReserveUnits : 0;
        const q = card.quotaUnitsPerDay;
        const reuse = card.readReuseMinutes;
        const readsMax = reuse > 0 ? Math.ceil(1440 / reuse) : -1;
        // PT2: the upload bucket caps the count too (uploadsCap), and never more than the per-day limit (100, D434).
        const cap = Math.min(maxPerDayLimit, typeof quota.uploadsCap === "number" ? quota.uploadsCap : maxPerDayLimit);
        let n = 0;
        while (n < cap) {
            const m = n + 1, reads = readsMax < 0 ? m : Math.min(m, readsMax);
            if (m * per + reads * read > q - reserve) break;
            n = m;
        }
        const model = typeof quota.modelText === "string" && quota.modelText !== "" ? quota.modelText + " " : "";
        if (n === 0) return model + "No upload fits in a quota of " + q.toLocaleString(Qt.locale("en_US"), "f", 0) + " units a day (one upload needs "
            + (per + read + reserve).toLocaleString(Qt.locale("en_US"), "f", 0) + "): nothing uploads until the quota is raised.";
        return model + "About " + n + (n === 1 ? " upload a day fits" : " uploads a day fit") + " in the quota." + (card.maxPerDay > n ? " More than that a day stop at the quota and wait for the next day." : "");
    }
    // D434: the slot minutes and the gap, checked like the server (schedule.mjs gridProblem)
    readonly property string gridProblem: {
        const o = card.tierOffsets || [], g = card.gridGapMinutes;
        if (offsetsProblem !== "") return offsetsProblem;
        if (o.length === 0 || o.some(x => x < 0 || x > 59)) return "Slot minutes: list whole minutes from 0 to 59, like 0, 15, 30, 45.";
        if (o.some((x, i) => o.indexOf(x) !== i)) return "Slot minutes: a minute is listed twice.";
        const s = o.slice().sort((a, b) => a - b);
        let d = 60 - (s[s.length - 1] - s[0]);
        for (let k = 1; k < s.length; k++) d = Math.min(d, s[k] - s[k - 1]);
        return g > d ? "The gap between slots (" + g + " min) is wider than the smallest distance between your slot minutes (" + d + " min)." : "";
    }
    property string offsetsText: "0, 15, 30, 45"
    property string offsetsProblem: ""
    function setOffsets(text) {
        offsetsText = text;
        const parts = String(text).split(/[\s,]+/).filter(x => x !== "");
        if (parts.length === 0 || parts.some(x => !/^\d{1,2}$/.test(x))) { offsetsProblem = "Slot minutes: list whole minutes from 0 to 59, like 0, 15, 30, 45."; return false }
        offsetsProblem = "";
        return set("tierOffsets", parts.map(x => parseInt(x, 10)));
    }

    // PT5: the quota model in use and why, in plain words
    readonly property string quotaModel: {
        const m = quota.fallback === true ? "the old unit count, for today" : quota.model === "unit-sum" ? "the old unit count" : quota.model === "upload-bucket" ? "YouTube's upload allowance" : "";
        if (m === "") return "";
        const why = quota.fallback === true ? "YouTube said the upload quota was used up, so this lasts until the next Pacific midnight."
            : quota.model === "unit-sum" ? "Your quota settings ask for it." : "It is the default: Google gives uploads their own allowance of 100 a day.";
        return "Quota model in use: " + m + ". " + why;
    }

    onActiveChanged: { if (!active) reset(); else if (!started) load() }
    visible: active
    enabled: loaded

    readonly property var placements: ["grid-tiers", "random-daily", "custom", "fill-gaps", "after-last"]
    readonly property bool gridTiers: card.placement === "grid-tiers"
    readonly property bool randomDaily: card.placement === "random-daily"
    // "HH:MM" <-> minutes after midnight (the window boxes count in minutes, 30-minute steps)
    function minutesOf(s, def) { const m = /^(\d{2}):(\d{2})$/.exec(String(s || "")); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : def }
    function hhmm(n) { return two(Math.floor(n / 60)) + ":" + two(n % 60) }
    function clamp(n, lo, hi, def) { return Math.max(lo, Math.min(hi, typeof n === "number" && !isNaN(n) ? n : def)) }
    function round1(n) { return Math.round(n * 10) / 10 }
    function two(n) { return (n < 10 ? "0" : "") + n }
    function localTime(iso) {
        const d = new Date(iso);
        return isNaN(d.getTime()) ? String(iso) : Qt.formatDateTime(d, "ddd d MMM, HH:mm");
    }
    function problemsText(arr) { return (arr || []).map(p => p.text).join("; ") }

    function reset() {
        gen++;
        started = false;
        loaded = false;
        card = ({ autoUpload: true, kinds: [], minScore: 0, maxPerDay: 1, intervalHours: 1, maxAheadDays: 365, placement: "grid-tiers", quotaUnitsPerDay: 10000, postsPerDayMin: 3, postsPerDayMax: 6, windowStart: "09:00", windowEnd: "23:00", minGapMinutes: 60, customTimes: ({}), skipDates: [], tierOffsets: [0, 15, 30, 45], gridGapMinutes: 15, readReuseMinutes: 120 });
        orig = "";
        quota = ({});
        flagsText = "";
        timesInfo = "Loading...";
        schedCount = 0;
        schedNext = "";
        schedLoaded = false;
        message = "";
        rulesOwn = false;
        rulesEdit = ({ autoUpload: false, maxUploadsPerDay: 1, rules: [] });
        rulesOrig = "";
        rulesProblem = "";
        notices = [];
        skipText = "";
        offsetsText = "0, 15, 30, 45";
        offsetsProblem = "";
        prefs = JSON.parse(JSON.stringify(prefsDefault));
        prefsOrig = "";
        prefsLoaded = false;
        prefsError = "";
        tagsText = "";
        tagsProblem = "";
        ownTagsText = "";
        ownTagsProblem = "";
        previewItems = [];
        previewInfo = "";
    }

    function load() {
        const g = ++gen;
        started = true;
        Api.get("ui/api/posts/auto/settings", (ok, b, err) => {
            if (g !== gen) return; // closed, or opened again, before the answer came
            if (!ok) { timesInfo = "Auto-post settings are not available: " + err; return }
            render(b);
            loadTimes(false);
            loadRules(b.custom === true);
        });
        loadIg();
        Api.get("ui/api/posts/prefs", (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { prefsError = "Post text settings are not available: " + err; return }
            renderPrefs(b);
        });
    }

    // ---- PT5 (D410) post text and growth ----
    function renderPrefs(b) {
        const p = b.prefs || prefsDefault, t = p.text || ({});
        const ks = ({});
        for (const k of kindList) ks[k.id] = clamp(p.kindShare ? p.kindShare[k.id] : 0, 0, 100, 0);
        prefs = { text: { tone: t.tone === "clean" ? "clean" : "hype", emoji: t.emoji === true, hashtags: Array.isArray(t.hashtags) ? t.hashtags.map(String) : [],
                tags: Array.isArray(t.tags) ? t.tags.map(String) : [], footer: String(t.footer || "") },
            kindShare: ks, growthSuggestions: p.growthSuggestions !== false };
        prefsError = b.error ? "Your post text settings could not be read (" + String(b.error) + "); the defaults are shown, and Save writes them again." : "";
        tagsText = prefs.text.hashtags.join(" ");
        tagsProblem = "";
        ownTagsText = prefs.text.tags.join(", ");
        ownTagsProblem = "";
        prefsOrig = JSON.stringify(prefs);
        prefsLoaded = true;
    }
    function setPref(f) {
        if (!prefsLoaded) return false;
        const p = JSON.parse(JSON.stringify(prefs));
        if (f(p) === false) return false;
        prefs = p;
        return true;
    }
    function setTone(v) { return (v === "hype" || v === "clean") && setPref(p => { p.text.tone = v }) }
    function setTags(text) {
        tagsText = text;
        const parts = String(text).split(/[\s,]+/).filter(x => x !== "").map(x => x.startsWith("#") ? x : "#" + x);
        const bad = parts.find(x => !/^#[A-Za-z0-9_\u00C0-\uFFFF]{1,39}$/.test(x));
        tagsProblem = bad !== undefined ? "Own hashtags: " + bad + " is not a hashtag (letters, numbers or _ after the #)."
            : parts.length > 10 ? "Own hashtags: at most 10." : "";
        if (tagsProblem !== "") return false;
        return setPref(p => { p.text.hashtags = parts.filter((x, i) => parts.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i) });
    }
    // own search tags: comma-separated words (a tag may have spaces); same rule as post-prefs.mjs checkPrefs
    function setOwnTags(text) {
        ownTagsText = text;
        const parts = String(text).split(",").map(x => x.trim().replace(/\s+/g, " ")).filter(x => x !== "");
        const bad = parts.find(x => !/^[A-Za-z0-9À-￿][A-Za-z0-9À-￿ '-]{0,29}$/.test(x));
        ownTagsProblem = bad !== undefined ? "Own tags: \"" + bad + "\" is not a tag (letters, numbers, spaces, ' or -, at most 30 characters)."
            : parts.length > 15 ? "Own tags: at most 15." : "";
        if (ownTagsProblem !== "") return false;
        return setPref(p => { p.text.tags = parts.filter((x, i) => parts.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i) });
    }
    function setShare(kind, n) {
        if (!kindList.some(k => k.id === kind)) return false;
        return setPref(p => { p.kindShare[kind] = clamp(Math.round(n), 0, 100, 0) });
    }
    function loadPreview() {
        const g = gen;
        previewInfo = "Loading...";
        Api.post("ui/api/posts/prefs/preview", { text: JSON.parse(JSON.stringify(prefs.text)) }, (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { previewItems = []; previewInfo = "No preview: " + err; return }
            previewItems = Array.isArray(b.items) ? b.items : [];
            previewInfo = previewItems.length ? "Your newest clips with these choices (not saved yet):" : "No clips yet: the preview shows once the first clip has a post.";
        });
    }

    function loadRules(own) {
        const g = gen;
        Api.get("ui/api/posts/auto/rules", (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { notices = ["What gets posted could not be read: " + err]; return }
            renderRules(b, own);
        });
    }
    function renderRules(b, own) {
        notices = Array.isArray(b.notices) ? b.notices : [];
        rulesOwn = own && !b.error && Array.isArray(b.rules) && b.rules.length > 0;
        rulesEdit = { autoUpload: b.autoUpload === true, maxUploadsPerDay: clamp(b.maxUploadsPerDay, 1, maxPerDayLimit, 1),
            rules: (b.rules || []).map(r => ({ id: String(r.id), target: String(r.targetLabel || r.target), kinds: kindList.map(k => k.id).filter(id => (r.kinds || []).includes(id)), maxPerDay: clamp(r.maxPerDay, 1, maxPerDayLimit, 1) })) };
        rulesOrig = JSON.stringify(rulesEdit);
    }

    function render(b) {
        const c = b.card || ({}), fl = b.flags || ({});
        quota = b.quota || ({});
        const lim = (b.limits || ({})).maxPerDay;
        maxPerDayLimit = typeof lim === "number" ? lim : 24;
        const ks = Array.isArray(c.kinds) ? c.kinds : [];
        card = {
            autoUpload: c.autoUpload === true,
            kinds: kindList.map(k => k.id).filter(id => ks.includes(id)),
            minScore: round1(clamp(c.minScore, 0, 100, 0)),
            maxPerDay: clamp(c.maxPerDay, 1, maxPerDayLimit, 1),
            intervalHours: clamp(c.intervalHours, 1, 48, 1),
            maxAheadDays: clamp(c.maxAheadDays, 1, 730, 365),
            placement: placements.includes(c.placement) ? c.placement : "grid-tiers",
            quotaUnitsPerDay: clamp(c.quotaUnitsPerDay, 1000, 10000000, 10000),
            postsPerDayMin: clamp(c.postsPerDayMin, 1, 24, 3),
            postsPerDayMax: clamp(c.postsPerDayMax, 1, 24, 6),
            windowStart: hhmm(minutesOf(c.windowStart, 540)),
            windowEnd: hhmm(minutesOf(c.windowEnd, 1380)),
            minGapMinutes: clamp(c.minGapMinutes, 60, 1440, 60),
            customTimes: cleanWeek(c.customTimes),
            skipDates: Array.isArray(c.skipDates) ? c.skipDates.filter(s => /^\d{4}-\d{2}-\d{2}$/.test(String(s))).map(String) : [],
            tierOffsets: Array.isArray(c.tierOffsets) && c.tierOffsets.length ? c.tierOffsets.map(x => Number(x)) : [0, 15, 30, 45],
            gridGapMinutes: clamp(c.gridGapMinutes, 1, 60, 15),
            readReuseMinutes: clamp(c.readReuseMinutes, 0, 1440, 120)
        };
        skipText = card.skipDates.join(", ");
        offsetsText = card.tierOffsets.join(", ");
        offsetsProblem = "";
        const off = [];
        if (fl.autoPost !== true) off.push("Auto post");
        if (fl.schedule !== true) off.push("Scheduled posting");
        let t = off.length === 0 ? "Auto post and Scheduled posting are on."
            : "Nothing uploads by itself until " + off.join(" and ") + (off.length > 1 ? " are" : " is") + " switched on below.";
        t += fl.deleteUploaded === true
            ? " Delete posted clips forever is on: each clip file is deleted permanently once YouTube has processed its upload."
            : " Posted clip files stay in the clips folder.";
        rulesProblem = b.error ? "Your rules file has a problem: " + String(b.error) + "; fix it or reset it." : "";
        const bad = String(b.scheduleError || "");
        if (bad !== "") t += " Your saved schedule settings could not be read (" + bad + "); the defaults are shown, and Save writes them again.";
        flagsText = t;
        orig = JSON.stringify(card);
        loaded = true;
    }

    function loadTimes(fresh) {
        const g = gen;
        Api.get("ui/api/posts/auto/schedule?brief=1&count=0" + (fresh ? "&fresh=1" : ""), (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { timesInfo = "The posting times are not available: " + err; return }
            renderTimes(b);
        });
    }

    function renderTimes(b) {
        const err = b.error || "", live = b.liveError || "";
        stuckLockId = (b.stuckLock && typeof b.stuckLock.id === "string") ? b.stuckLock.id : "";
        let info;
        if (err === "schedule-read-incomplete")
            info = "The last channel read did not reach back far enough to see every scheduled post, so no time is given (nothing uploads until it does).";
        else if (err !== "")
            info = "The schedule settings are not valid, so no time is given.";
        else if (b.source === "none")
            info = "The channel has not been read yet; the times may move once it is.";
        else
            info = "Channel read " + (b.channelReadAt ? localTime(b.channelReadAt) : "earlier") + ". Times are in your time zone; each post is at least "
                + (b.placement === "random-daily" ? (b.minGapMinutes || 0) + " min" : b.placement === "grid-tiers" ? (b.gridGapMinutes || 0) + " min" : (b.intervalHours || 0) + " h") + " from the next.";
        if (live === "schedule-scope-missing") info += " Could not read the channel: sign in again so YouTube allows reading scheduled posts.";
        else if (live !== "") info += " Could not read the channel just now (" + live + ").";
        timesInfo = info;
        const g = gen; // the count and the next time are the manager's own (YouTube, Instagram, the channel), counts only
        Api.get("ui/api/posts/schedule/list?brief=1", (ok, c) => {
            if (g !== gen || !ok) return;
            schedCount = (c.counts && c.counts.total) || 0;
            schedNext = typeof c.nextAt === "string" ? c.nextAt : "";
            schedLoaded = true;
        });
    }

    // ---- custom times (user 2026-11-20) ----
    function cleanWeek(w) {
        const o = {};
        for (const d of weekDays) {
            const a = w && Array.isArray(w[d.id]) ? w[d.id].map(String).filter(s => minutesOf(s, -1) >= 0) : [];
            o[d.id] = a.filter((s, i) => a.indexOf(s) === i).sort((x, y) => minutesOf(x, 0) - minutesOf(y, 0)).slice(0, 24);
        }
        return o;
    }
    // "18:00", "9:30" or "1800" -> "HH:MM", or "" when it is not a time of day
    function timeOf(s) {
        const m = /^(\d{1,2}):?(\d{2})$/.exec(String(s || "").trim());
        if (!m) return "";
        const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
        return h < 24 && mi < 60 ? two(h) + ":" + two(mi) : "";
    }
    function addTime(day, s) {
        const t = timeOf(s);
        if (!loaded || t === "" || !weekDays.some(d => d.id === day)) return false;
        const w = cleanWeek(card.customTimes);
        if (w[day].includes(t) || w[day].length >= 24) return w[day].includes(t);
        w[day] = w[day].concat([t]);
        return set("customTimes", cleanWeek(w));
    }
    function removeTime(day, t) {
        if (!loaded || !weekDays.some(d => d.id === day)) return false;
        const w = cleanWeek(card.customTimes);
        w[day] = w[day].filter(x => x !== t);
        return set("customTimes", w);
    }
    function copyDay(day) {
        if (!loaded || !weekDays.some(d => d.id === day)) return false;
        const w = cleanWeek(card.customTimes), o = {};
        for (const d of weekDays) o[d.id] = w[day].slice();
        return set("customTimes", o);
    }
    // Days off: dates like 2026-12-25, separated by commas or spaces
    function setSkip(text) {
        skipText = text;
        const parts = String(text).split(/[\s,]+/).filter(s => s !== "");
        const bad = parts.filter(s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return true; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.toISOString().slice(0, 10) !== s });
        skipProblem = bad.length ? "Days off must be dates like 2026-12-25 (not " + bad[0] + ")." : "";
        if (bad.length) return false;
        return set("skipDates", parts.filter((s, i) => parts.indexOf(s) === i).sort());
    }
    // The next posts with these times (this PC's time zone; channel posts and the queue are checked by the server: a taken
    // or too close time is skipped, so the real list can have gaps). At least an hour ahead, like the server's lead time.
    function customPreview(n) {
        const out = [], w = card.customTimes || ({}), skip = card.skipDates || [];
        const from = Date.now() + 3600 * 1000;
        const day = new Date(); day.setHours(0, 0, 0, 0);
        for (let i = 0; i < 400 && out.length < n; i++) {
            const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i);
            const key = d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
            if (skip.includes(key)) continue;
            for (const t of (w[weekDays[(d.getDay() + 6) % 7].id] || [])) {
                const m = minutesOf(t, 0);
                const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(m / 60), m % 60);
                if (at.getTime() >= from && out.length < n) out.push(Qt.formatDateTime(at, "ddd d MMM, HH:mm"));
            }
        }
        return out;
    }

    // ---- what gets posted (rules in use, user 2026-11-20) ----
    function setRules(f) {
        if (!loaded || !rulesOwn) return false;
        const r = JSON.parse(JSON.stringify(rulesEdit));
        if (f(r) === false) return false;
        rulesEdit = r;
        return true;
    }
    function setRuleKind(id, kind, on) {
        if (!kindList.some(k => k.id === kind)) return false;
        return setRules(r => { const x = r.rules.find(q => q.id === id); if (!x) return false; x.kinds = kindList.map(k => k.id).filter(k => k === kind ? on : x.kinds.includes(k)) });
    }
    function setRuleMax(id, n) { return setRules(r => { const x = r.rules.find(q => q.id === id); if (!x) return false; x.maxPerDay = clamp(Math.round(n), 1, maxPerDayLimit, 1) }) }

    // ---- changes ----
    function set(k, v) {
        if (!loaded) return false;
        const c = Object.assign({}, card);
        c[k] = v;
        card = c;
        return true;
    }
    function setKind(id, on) {
        if (!loaded || !kindList.some(k => k.id === id)) return false;
        const has = card.kinds.includes(id);
        if (has === on) return true;
        return set("kinds", kindList.map(k => k.id).filter(x => x === id ? on : card.kinds.includes(x)));
    }
    function setNum(k, n, lo, hi) { return set(k, k === "minScore" ? round1(clamp(n, lo, hi, lo)) : clamp(Math.round(n), lo, hi, lo)) }

    // What Save sends: nothing when the card did not change. The page goes with the Settings window right after Save, so
    // the answer only needs the store.
    function save() {
        if (!dirty) return;
        const store = box.store, g = gen;
        if (rulesDirty) {
            const rb = { autoUpload: rulesEdit.autoUpload, maxUploadsPerDay: rulesEdit.maxUploadsPerDay, rules: rulesEdit.rules.map(r => ({ id: r.id, kinds: r.kinds.slice(), maxPerDay: r.maxPerDay })) };
            const sent = JSON.stringify(rulesEdit);
            Api.post("ui/api/posts/auto/rules", rb, (ok, b, err) => {
                if (ok) { if (g === gen) rulesOrig = sent; return store.say("What gets posted saved; the next upload pass uses it.") }
                const why = problemsText(b && b.problems);
                store.say("What gets posted not saved: " + (why !== "" ? why : err));
            });
        }
        if (prefsDirty) {
            const pb = JSON.parse(JSON.stringify(prefs));
            const psent = JSON.stringify(prefs);
            Api.post("ui/api/posts/prefs", { prefs: pb }, (ok, b, err) => {
                if (ok) { if (g === gen) prefsOrig = psent; return store.say("Post text and growth settings saved; new posts use them.") }
                const why = problemsText(b && b.problems);
                store.say("Post text and growth settings not saved: " + (why !== "" ? why : err));
            });
        }
        if (!cardDirty) return;
        const body = JSON.parse(JSON.stringify(card));
        Api.post("ui/api/posts/auto/settings", rulesOwn || !ruleKeysDirty ? { card: body, keepRules: true } : { card: body }, (ok, b, err) => {
            if (ok) {
                if (g === gen) orig = JSON.stringify(body);
                return store.say("Auto-post settings saved; the next upload pass uses them.");
            }
            const why = problemsText(b && b.problems);
            store.say("Auto-post settings not saved: " + (why !== "" ? why : err));
        });
    }

    // Reset: one click replaces a rules file that cannot be read with the card's own rules (D332, no confirm).
    function resetRules() {
        const g = gen;
        Api.post("ui/api/posts/auto/settings", { card: JSON.parse(JSON.stringify(card)), resetRules: true }, (ok, b, err) => {
            if (g !== gen) return;
            if (ok) { message = "Rules reset to the card's values."; rulesProblem = ""; load(); return }
            const why = problemsText(b && b.problems);
            message = "Not reset: " + (why !== "" ? why : err);
        });
    }

    // PT3 (D408): one click asks for an auto-post pass now (refused while a stream is live or starting).
    function runNow() {
        const g = gen;
        Api.post("ui/api/posts/auto/run", {}, (ok, b, err) => {
            if (g !== gen) return;
            message = ok ? "Auto-post runs now: new clips are checked and due uploads start within half a minute."
                : (b && b.error === "stream-live") || err === "stream-live" ? "Not run: a stream is live or starting. Auto-post waits until it ends."
                : "Not run: " + ((b && b.error) ? b.error : err);
        });
    }

    // D409 (fifth Codex review): one click clears a posting lock left behind by a closed copy (D332: no confirm).
    function clearLock() {
        const g = gen;
        Api.post("ui/api/posts/auto/clear-lock", { id: stuckLockId }, (ok, b, err) => {
            if (g !== gen) return;
            message = ok ? "Stuck posting lock cleared. Auto-post runs again within half a minute."
                : "Not cleared: the lock changed or its owner is still running (" + ((b && b.error) ? b.error : err) + ").";
            loadTimes(false);
        });
    }

    component Words: Text {
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: Theme.ty.body
    }
    component Quiet: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }
    // a label over its control; a Flow puts as many of them in a row as fit, so the page never needs sideways room
    component Field: Column {
        property string label: ""
        width: 250
        spacing: Theme.sp.xs
        Words { text: parent.label }
    }
    // a box that follows the page's value even after the user picked one (a picked value breaks a plain binding)
    component PickBox: UCombo {
        id: pb
        property int want: 0
        Binding { target: pb; property: "currentIndex"; value: pb.want }
    }
    component SpinBox2: USpin {
        id: sb
        property int want: 0
        Binding { target: sb; property: "value"; value: sb.want }
    }
    component KindToggle: UToggle {
        id: kt
        property bool want: false
        Binding { target: kt; property: "checked"; value: kt.want }
    }

    UCard {
        title: "AUTO-POST"
        Quiet {
            text: "Clips from your clips folder go up to YouTube by themselves, each as a scheduled post (with a few a day at random times the order is mixed, never two of the same kind in a row when another kind is waiting; otherwise oldest first): private until its publish time, then public. "
                + "Times are picked around the posts already scheduled on your channel, never two at the same time. Changes apply from the next upload pass when you click Save."
        }
        Quiet { objectName: "autopostFlags"; text: ap.flagsText }
        Row {
            visible: ap.rulesProblem !== ""
            width: parent.width
            spacing: Theme.sp.s
            Text {
                objectName: "autopostRulesProblem"
                width: parent.width - resetBtn.width - Theme.sp.s
                wrapMode: Text.Wrap
                text: ap.rulesProblem
                color: Theme.c.danger
                font.family: Theme.family
                font.pixelSize: Theme.ty.body
            }
            UButton {
                id: resetBtn
                objectName: "autopostRulesReset"
                text: "Reset"
                tip: "Replaces your rules file with the values on this card."
                onClicked: ap.resetRules()
            }
        }
        Repeater {
            model: ap.notices
            delegate: Text {
                required property var modelData
                required property int index
                objectName: "autopostNotice:" + index
                width: parent.width
                wrapMode: Text.Wrap
                text: modelData
                color: Theme.c.danger
                font.family: Theme.family
                font.pixelSize: Theme.ty.body
                font.weight: Font.Medium
            }
        }
        Words { visible: ap.rulesOwn; text: "What gets posted:" }
        Quiet { visible: ap.rulesOwn; text: "Your own posting rules. Switch the kinds of clip each rule uploads and how many a day; anything else in the rules file stays as it is." }
        USwitch {
            id: rulesUpSw
            objectName: "autopostRulesUpload"
            visible: ap.rulesOwn
            width: parent.width
            text: "Upload automatically"
            checked: ap.rulesEdit.autoUpload
            onToggled: ap.setRules(r => { r.autoUpload = checked })
            Binding { target: rulesUpSw; property: "checked"; value: ap.rulesEdit.autoUpload }
        }
        Field {
            visible: ap.rulesOwn
            label: "Uploads at most, all rules together:"
            width: 330
            SpinBox2 {
                objectName: "autopostRulesMax"
                label: "Uploads at most, all rules together"
                suffix: " a day"
                from: 1
                to: ap.maxPerDayLimit
                want: ap.rulesEdit.maxUploadsPerDay
                onValueModified: ap.setRules(r => { r.maxUploadsPerDay = ap.clamp(Math.round(value), 1, ap.maxPerDayLimit, 1) })
            }
        }
        Repeater {
            model: ap.rulesOwn ? ap.rulesEdit.rules : []
            delegate: Column {
                id: rr
                required property var modelData
                width: parent.width
                spacing: Theme.sp.xs
                Words { text: rr.modelData.target + " (" + rr.modelData.id + ")"; font.weight: Font.Medium }
                Flow {
                    width: parent.width
                    spacing: Theme.sp.s
                    Repeater {
                        model: ap.kindList
                        delegate: KindToggle {
                            required property var modelData
                            objectName: "autopostRuleKind_" + rr.modelData.id + "_" + modelData.id
                            text: modelData.text
                            want: rr.modelData.kinds.includes(modelData.id)
                            onToggled: ap.setRuleKind(rr.modelData.id, modelData.id, checked)
                        }
                    }
                    SpinBox2 {
                        objectName: "autopostRuleMax_" + rr.modelData.id
                        label: "At most a day for this rule"
                        suffix: " a day"
                        from: 1
                        to: ap.maxPerDayLimit
                        want: rr.modelData.maxPerDay
                        onValueModified: ap.setRuleMax(rr.modelData.id, value)
                    }
                }
            }
        }
        USwitch {
            id: upSw
            objectName: "autopostUpload"
            visible: !ap.rulesOwn
            width: parent.width
            text: "Upload clips automatically"
            checked: ap.card.autoUpload
            onToggled: ap.set("autoUpload", checked)
            Binding { target: upSw; property: "checked"; value: ap.card.autoUpload }
        }
        Words { visible: !ap.rulesOwn; text: "What uploads:" }
        Flow {
            visible: !ap.rulesOwn
            width: parent.width
            spacing: Theme.sp.s
            Repeater {
                model: ap.kindList
                delegate: KindToggle {
                    required property var modelData
                    objectName: "autopostKind_" + modelData.id
                    text: modelData.text
                    want: ap.card.kinds.includes(modelData.id)
                    onToggled: ap.setKind(modelData.id, checked)
                }
            }
        }
        Flow {
            width: parent.width
            spacing: Theme.sp.l
            Field {
                visible: !ap.rulesOwn
                label: "Minimum clip score:"
                SpinBox2 {
                    objectName: "autopostScore"
                    label: "Minimum clip score"
                    from: 0
                    to: 1000
                    stepSize: 10
                    // tenths of a point: 3.0 is 30
                    textFromValue: (v) => (v / 10).toFixed(1)
                    valueFromText: (t) => Math.round(parseFloat(String(t).replace(",", ".")) * 10) || 0
                    want: Math.round(ap.card.minScore * 10)
                    onValueModified: ap.setNum("minScore", value / 10, 0, 100)
                }
                Quiet { text: "Short clips need at least this score. Montages, reels and impact plays have no clip score: choosing the kind is enough." }
            }
            Field {
                visible: !ap.rulesOwn
                label: "Uploads at most:"
                SpinBox2 {
                    objectName: "autopostPerDay"
                    label: "Uploads at most"
                    suffix: " a day"
                    from: 1
                    to: ap.maxPerDayLimit
                    want: ap.card.maxPerDay
                    onValueModified: ap.setNum("maxPerDay", value, 1, ap.maxPerDayLimit)
                }
                Quiet { text: "What it does: the most clips uploaded in one day (YouTube allows up to " + ap.maxPerDayLimit + "). What it changes: more a day empties the backlog faster. What it could break: past what the quota fits (the line under the settings), uploads stop for the day and wait." }
            }
            Field {
                label: "Time between posts:"
                SpinBox2 {
                    objectName: "autopostGap"
                    label: "Time between posts"
                    suffix: " h"
                    from: 1
                    to: 48
                    enabled: !ap.randomDaily && !ap.gridTiers
                    want: ap.card.intervalHours
                    onValueModified: ap.setNum("intervalHours", value, 1, 48)
                }
                Quiet { text: ap.randomDaily ? "Not used with a few a day at random times: the gap below is used instead." : ap.gridTiers ? "Not used with hourly slots: the gap between slots below is used instead." : "Every post, yours from Ujwalam or already on the channel, is at least this far from the next." }
            }
            Field {
                label: "Schedule up to:"
                SpinBox2 {
                    objectName: "autopostDays"
                    label: "Schedule up to"
                    suffix: " days"
                    from: 1
                    to: 730
                    want: ap.card.maxAheadDays
                    onValueModified: ap.setNum("maxAheadDays", value, 1, 730)
                }
                Quiet { text: "How far into the future posts may be scheduled, always counted from today (365 = one year). A clip whose next free time is further ahead waits until a slot opens. A longer reach lets a big backlog be scheduled at once; a shorter one keeps more room for posts you add later." }
            }
            Field {
                label: "Where new posts go:"
                width: 330
                PickBox {
                    objectName: "autopostPlacement"
                    width: parent.width
                    label: "Where new posts go"
                    model: [{ value: "grid-tiers", text: "Hourly slots, a year ahead" }, { value: "random-daily", text: "Random each day" }, { value: "custom", text: "Custom times" }, { value: "fill-gaps", text: "Fill gaps between posts" }, { value: "after-last", text: "Always after the last scheduled post" }]
                    want: Math.max(0, ap.placements.indexOf(ap.card.placement))
                    onChose: (v) => ap.set("placement", v)
                }
                Quiet {
                    objectName: "autopostPlacementHelp"
                    text: ap.gridTiers ? "Hourly slots: each clip takes the earliest free hour slot (12:00, 13:00, 14:00 ...) from today up to the days-ahead limit. Only when every hour slot in that whole time is taken does it use the next slot minute (12:15, 13:15 ...), then the next (12:30 ...), and so on. Times follow this PC's clock. Changing to this moves no clip that already has a time."
                        : ap.randomDaily ? "Random each day: a few posts a day at random times inside the posting window below."
                        : ap.customOn ? "Custom times: the exact times you list for each weekday."
                        : ap.card.placement === "fill-gaps" ? "Fill gaps: the earliest whole hour that keeps the time between posts from every other post."
                        : "After the last: each new post goes after the latest one already scheduled."
                }
            }
            Field {
                label: "Slot minutes, in order:"
                width: 330
                UField {
                    objectName: "autopostTierOffsets"
                    width: 200
                    label: "Slot minutes, in order"
                    enabled: ap.gridTiers
                    placeholderText: "0, 15, 30, 45"
                    text: ap.offsetsText
                    onTextEdited: ap.setOffsets(text)
                }
                Quiet { text: "Hourly slots only. What it does: the minute past each hour that is filled first, then the next one, and so on (0, 15, 30, 45 = 12:00 first, then 12:15, then 12:30, then 12:45). What it changes: more minutes = more slots a day (4 minutes give 96 a day). What it could break: minutes closer together than the gap below are refused." }
            }
            Field {
                label: "Gap between slots:"
                SpinBox2 {
                    objectName: "autopostGridGap"
                    label: "Gap between slots"
                    enabled: ap.gridTiers
                    suffix: " min"
                    from: 1
                    to: 60
                    want: ap.card.gridGapMinutes
                    onValueModified: ap.setNum("gridGapMinutes", value, 1, 60)
                }
                Quiet { text: "Hourly slots only. What it does: no new post goes up closer than this to any other post, yours from Ujwalam or already on the channel. What it changes: a slot within this many minutes of another post is skipped. What it could break: a small gap lets posts land close together, so viewers see several at once; the old one-hour rule does not apply in this mode." }
            }
            Field {
                label: "Reuse the channel read for:"
                SpinBox2 {
                    objectName: "autopostReadReuse"
                    label: "Reuse the channel read for"
                    suffix: " min"
                    from: 0
                    to: 1440
                    stepSize: 15
                    want: ap.card.readReuseMinutes
                    onValueModified: ap.setNum("readReuseMinutes", value, 0, 1440)
                }
                Quiet { text: "What it does: before uploading, Ujwalam reads every post on your channel so no time is doubled. One read can cost up to 401 quota units, so it is used again for this long instead of reading before each upload. What it changes: longer = more uploads a day fit in the quota (120 min lets 100 a day fit; 0 = read before every upload, about 21 a day). What it could break: a post you schedule by hand in YouTube Studio during this time is not seen until the next read, so a new post could land within the gap of it." }
            }
            Field {
                label: "Posts a day, fewest:"
                SpinBox2 {
                    objectName: "autopostDayMin"
                    label: "Posts a day, fewest"
                    enabled: ap.randomDaily
                    from: 1
                    to: 24
                    want: ap.card.postsPerDayMin
                    onValueModified: ap.setNum("postsPerDayMin", value, 1, 24)
                }
                Quiet { text: "Each day gets a random number of posts between the fewest and the most." }
            }
            Field {
                label: "Posts a day, most:"
                SpinBox2 {
                    objectName: "autopostDayMax"
                    label: "Posts a day, most"
                    enabled: ap.randomDaily
                    from: 1
                    to: 24
                    want: ap.card.postsPerDayMax
                    onValueModified: ap.setNum("postsPerDayMax", value, 1, 24)
                }
                Quiet { text: "A day that has no room for that many takes what fits." }
            }
            Field {
                label: "Post from:"
                SpinBox2 {
                    objectName: "autopostWindowStart"
                    label: "Post from"
                    enabled: ap.randomDaily
                    from: 0
                    to: 1410
                    stepSize: 30
                    textFromValue: (v) => ap.hhmm(v)
                    valueFromText: (t) => ap.minutesOf(String(t).trim(), 540)
                    want: ap.minutesOf(ap.card.windowStart, 540)
                    onValueModified: ap.set("windowStart", ap.hhmm(value))
                }
                Quiet { text: "Your time zone. No post goes up before this time of day." }
            }
            Field {
                label: "Post until:"
                SpinBox2 {
                    objectName: "autopostWindowEnd"
                    label: "Post until"
                    enabled: ap.randomDaily
                    from: 30
                    to: 1440
                    stepSize: 30
                    textFromValue: (v) => ap.hhmm(v)
                    valueFromText: (t) => ap.minutesOf(String(t).trim(), 1380)
                    want: ap.minutesOf(ap.card.windowEnd, 1380)
                    onValueModified: ap.set("windowEnd", ap.hhmm(value))
                }
                Quiet { text: "No post goes up after this time of day. 00:00 to 24:00 is the whole day." }
            }
            Field {
                label: "At least apart:"
                SpinBox2 {
                    objectName: "autopostGapMinutes"
                    label: "At least apart"
                    enabled: ap.randomDaily
                    suffix: " min"
                    from: 60
                    to: 1440
                    stepSize: 15
                    want: ap.card.minGapMinutes
                    onValueModified: ap.setNum("minGapMinutes", value, 60, 1440)
                }
                Quiet { text: "Every post, yours from Ujwalam or already on the channel, is at least this far from the next. An hour is the least: that rule is always kept." }
            }
            Field {
                label: "YouTube quota:"
                width: 330
                SpinBox2 {
                    objectName: "autopostQuota"
                    label: "YouTube quota"
                    suffix: " units a day"
                    from: 1000
                    to: 10000000
                    stepSize: 1000
                    width: 200
                    want: ap.card.quotaUnitsPerDay
                    onValueModified: ap.setNum("quotaUnitsPerDay", value, 1000, 10000000)
                }
                Quiet { text: "Your YouTube Data API quota (Google Cloud Console > APIs & Services > Quotas). Raise it here after Google grants more." }
            }
        }
        Column {
            objectName: "autopostCustom"
            visible: ap.customOn
            width: parent.width
            spacing: Theme.sp.s
            Words { text: "Custom times (your time zone):" }
            Quiet { text: "Clips go up at these times, in order. A time that is too close to a post already on the channel, or already taken, is skipped, never moved. The daily limits still apply." }
            Repeater {
                model: ap.weekDays
                delegate: Flow {
                    id: wd
                    required property var modelData
                    property string draft: ""
                    width: parent.width
                    spacing: Theme.sp.s
                    Words { width: 44; text: wd.modelData.text }
                    Repeater {
                        model: ap.card.customTimes[wd.modelData.id] || []
                        delegate: Row {
                            id: chip
                            required property var modelData
                            spacing: 2
                            UChip { text: chip.modelData }
                            UButton {
                                objectName: "autopostTimeRemove_" + wd.modelData.id + "_" + chip.modelData
                                text: "x"
                                tip: "Remove " + chip.modelData
                                onClicked: ap.removeTime(wd.modelData.id, chip.modelData)
                            }
                        }
                    }
                    UField {
                        objectName: "autopostTimeField_" + wd.modelData.id
                        width: 90
                        label: "New time for " + wd.modelData.text
                        placeholderText: "18:00"
                        text: wd.draft
                        onTextEdited: wd.draft = text
                        onAccepted: { if (ap.addTime(wd.modelData.id, wd.draft)) wd.draft = "" }
                    }
                    UButton {
                        objectName: "autopostTimeAdd_" + wd.modelData.id
                        text: "Add"
                        enabled: ap.timeOf(wd.draft) !== ""
                        onClicked: { if (ap.addTime(wd.modelData.id, wd.draft)) wd.draft = "" }
                    }
                    UButton {
                        objectName: "autopostCopyDay_" + wd.modelData.id
                        text: "Copy to every day"
                        tip: "Every day gets the same times as " + wd.modelData.text + "."
                        onClicked: ap.copyDay(wd.modelData.id)
                    }
                }
            }
            Words { text: "Days off:" }
            UField {
                objectName: "autopostSkipDates"
                width: Math.min(parent.width, 420)
                label: "Days off"
                placeholderText: "2026-12-25, 2027-01-01"
                text: ap.skipText
                onTextEdited: ap.setSkip(text)
            }
            Quiet { text: "Nothing goes up on these dates." }
            Words { text: "Next 10 posts with these times:" }
            Quiet {
                objectName: "autopostCustomNext"
                text: ap.customNext.length ? ap.customNext.join("\n") : "No time yet: add one above."
            }
        }
        Quiet { objectName: "autopostFit"; text: ap.fit }
        Quiet { objectName: "autopostQuotaModel"; text: ap.quotaModel }
        Text {
            objectName: "autopostProblem"
            visible: ap.problem !== ""
            width: parent.width
            wrapMode: Text.Wrap
            text: ap.problem
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }

    // PT5 (D410): post text and growth, saved with the same Save / Discard as the card above
    UCard {
        title: "POST TEXT AND GROWTH"
        Quiet { text: "How new posts are worded, which kinds of clip go up most, and whether Ujwalam may suggest better posting times. New posts use these; posts already made keep their text." }
        Text {
            objectName: "autopostPrefsError"
            visible: ap.prefsError !== ""
            width: parent.width
            wrapMode: Text.Wrap
            text: ap.prefsError
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        Flow {
            width: parent.width
            spacing: Theme.sp.l
            Field {
                label: "Tone:"
                width: 330
                PickBox {
                    objectName: "autopostTone"
                    width: parent.width
                    label: "Tone"
                    model: [{ value: "hype", text: "Hype (as the lines are written)" }, { value: "clean", text: "Clean (no ! and no emoji)" }]
                    want: ap.prefs.text.tone === "clean" ? 1 : 0
                    onChose: (v) => ap.setTone(v)
                }
            }
            Field {
                label: "Emoji in titles:"
                KindToggle {
                    objectName: "autopostEmoji"
                    text: ap.prefs.text.emoji ? "Emoji on" : "Emoji off"
                    want: ap.prefs.text.emoji
                    enabled: ap.prefs.text.tone === "hype"
                    onToggled: ap.setPref(p => { p.text.emoji = checked })
                }
                Quiet { text: ap.prefs.text.tone === "hype" ? "One emoji at the end of the title, when it still fits." : "Clean tone never adds an emoji." }
            }
        }
        Words { text: "Your own hashtags:" }
        UField {
            objectName: "autopostTags"
            width: Math.min(parent.width, 420)
            label: "Your own hashtags"
            placeholderText: "#gaming #clutch"
            text: ap.tagsText
            onTextEdited: ap.setTags(text)
        }
        Quiet { text: "Added to every new post after the usual ones, up to 10." }
        Words { text: "Your own tags:" }
        UField {
            objectName: "autopostOwnTags"
            width: Math.min(parent.width, 420)
            label: "Your own tags"
            placeholderText: "my channel, mobile gamer"
            text: ap.ownTagsText
            onTextEdited: ap.setOwnTags(text)
        }
        Quiet { text: "Search tags added to every new post, after the game's tags. Separate them with commas; up to 15." }
        Words { text: "Description footer:" }
        UField {
            objectName: "autopostFooter"
            width: parent.width
            label: "Description footer"
            placeholderText: "Live most nights. New clips every day."
            text: ap.prefs.text.footer
            onTextEdited: ap.setPref(p => { p.text.footer = text.slice(0, 500) })
        }
        Quiet { text: "A last line under every new description (plain text, up to 500 characters)." }
        UButton {
            objectName: "autopostPreview"
            text: "Preview on my newest clips"
            tip: "Shows your newest clips' text with these choices. Nothing is saved or posted."
            onClicked: ap.loadPreview()
        }
        Quiet { objectName: "autopostPreviewInfo"; visible: ap.previewInfo !== ""; text: ap.previewInfo }
        Repeater {
            model: ap.previewItems
            delegate: Quiet {
                required property var modelData
                required property int index
                objectName: "autopostPreview:" + index
                color: Theme.c.text
                text: String(modelData.title) + "\n" + String(modelData.description) + "\n" + (modelData.hashtags || []).join(" ")
            }
        }
        Words { text: "Share of each kind:" }
        Quiet { text: "Of every 100 posts, about this many are of each kind. Only the order changes: the number a day and the gap stay as set above." }
        Flow {
            width: parent.width
            spacing: Theme.sp.l
            Repeater {
                model: ap.kindList
                delegate: Field {
                    id: sf
                    required property var modelData
                    label: modelData.text + ":"
                    width: 200
                    SpinBox2 {
                        objectName: "autopostShare_" + sf.modelData.id
                        label: sf.modelData.text
                        suffix: " %"
                        from: 0
                        to: 100
                        stepSize: 5
                        want: ap.prefs.kindShare[sf.modelData.id] || 0
                        onValueModified: ap.setShare(sf.modelData.id, value)
                    }
                }
            }
        }
        Quiet { objectName: "autopostShareSum"; text: "Together: " + ap.shareSum + " %" + (ap.shareSum === 100 ? "." : " (must be 100 %).") }
        USwitch {
            id: growSw
            objectName: "autopostGrowth"
            width: parent.width
            text: ap.prefs.growthSuggestions ? "Growth suggestions on" : "Growth suggestions off"
            checked: ap.prefs.growthSuggestions
            onToggled: ap.setPref(p => { p.growthSuggestions = checked })
            Binding { target: growSw; property: "checked"; value: ap.prefs.growthSuggestions }
        }
        Quiet { text: "With Growth data on and at least 8 posts with numbers, the Posts window may suggest moving some posts to better times, with the numbers behind it. Nothing changes until you click Apply, and Undo puts it back." }
    }

    UCard {
        title: "SCHEDULED POSTS"
        Quiet { objectName: "autopostSchedLine"; text: ap.schedLine }
        Quiet { objectName: "autopostTimesInfo"; text: ap.timesInfo }
        UButton {
            objectName: "autopostOpenManager"
            text: "Open scheduling manager"
            kind: "primary"
            tip: "Every scheduled post in one list: search, filter, move, remove, upload now or retry. Opens in its own window."
            onClicked: ap.box.store.scheduleWanted()
        }
        UButton {
            objectName: "autopostRefresh"
            text: "Check the channel again"
            tip: "Reads the posts already scheduled on your channel (read only, at most every 10 minutes)."
            onClicked: ap.loadTimes(true)
        }
        UButton {
            objectName: "autopostRunNow"
            text: "Run auto-post now"
            tip: "Checks for new clips and starts the uploads that are due, without waiting for the next check. Never while a stream is live or starting."
            onClicked: ap.runNow()
        }
        UButton {
            objectName: "autopostClearLock"
            visible: ap.stuckLockId !== ""
            text: "Clear stuck posting lock"
            tip: "A copy of Ujwalam that has closed left its posting lock behind, so nothing uploads. This removes that lock (only if its owner is really gone)."
            onClicked: ap.clearLock()
        }
        Quiet { objectName: "autopostMsg"; text: ap.message }
    }

    UCard {
        title: "INSTAGRAM REELS"
        objectName: "igCard"
        Quiet { text: "Posts each clip that goes to YouTube Shorts as an Instagram Reel too, as many a day as Instagram allows, at least the auto-post gap apart and never while you are live. Instagram has no scheduled posts, so a Reel goes up while the studio is open; a missed time posts at the next start. Needs an Instagram professional account linked to a Facebook Page, and your own Meta app." }
        Words { objectName: "igStatus"; width: parent.width; wrapMode: Text.Wrap; text: ap.igStatus }
        Quiet { objectName: "igQueue"; visible: text !== ""; text: ap.igQueueText }
        Quiet { objectName: "igError"; visible: !!ap.ig.lastError; color: Theme.c.danger; text: ap.ig.lastError || "" }
        USwitch {
            id: igSw
            objectName: "igFlag"
            width: parent.width
            text: ap.ig.flagOn ? "Instagram Reels autopost on" : "Instagram Reels autopost off"
            checked: ap.ig.flagOn
            onToggled: ap.setIgFlag(checked)
            Binding { target: igSw; property: "checked"; value: ap.ig.flagOn }
        }
        Flow {
            width: parent.width
            spacing: Theme.sp.m
            Field {
                label: "App ID"
                UField {
                    objectName: "igAppId"
                    width: parent.width
                    label: "App ID"
                    text: ap.igAppId
                    onTextEdited: ap.igAppId = text
                    inputMethodHints: Qt.ImhDigitsOnly | Qt.ImhNoPredictiveText
                    placeholderText: ap.ig.hasApp ? "Saved (leave empty to keep it)" : "From your Meta app's Basic settings"
                }
            }
            Field {
                label: "App Secret"
                Item {
                    objectName: "igSecretBox" // the field itself is not named: the probe tree never lists its text
                    width: parent.width
                    height: 34
                    UField {
                        anchors.fill: parent
                        label: "App Secret"
                        text: ap.igSecret
                        onTextEdited: ap.igSecret = text
                        echoMode: TextInput.Password // never shown, never echoed back by the server
                        inputMethodHints: Qt.ImhHiddenText | Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
                        placeholderText: ap.ig.hasApp ? "Saved (leave empty to keep it)" : "Kept in Windows Credential Manager only"
                    }
                }
            }
        }
        Row {
            spacing: Theme.sp.s
            UButton { objectName: "igSave"; text: "Save app"; tip: "Saves the App ID and App Secret in Windows Credential Manager. They are never shown again."; onClicked: ap.saveIgApp() }
            UButton {
                objectName: "igConnect"
                text: ap.ig.connected ? "Connect again" : "Connect"
                kind: "primary"
                enabled: ap.ig.hasApp && !ap.ig.connecting
                tip: "Opens Facebook in your browser. Sign in, allow Ujwalam, then come back here."
                onClicked: ap.connectIg()
            }
            UButton {
                objectName: "igDrop"
                visible: !!ap.ig.queue && (ap.ig.queue.waiting + ap.ig.queue.failed + ap.ig.queue.posting) > 0
                text: "Drop Instagram queue"
                tip: "Clips waiting for Instagram are never posted there. Their files are no longer kept for Instagram, so Delete posted clips forever can remove them once YouTube has them."
                onClicked: ap.dropIg()
            }
            UButton { objectName: "igDisconnect"; visible: ap.ig.connected; text: "Disconnect"; tip: "Removes the saved Instagram sign-in from this PC. Nothing more is posted to Instagram."; onClicked: ap.disconnectIg() }
        }
        Quiet { objectName: "igRedirect"; text: "In your Meta app (Facebook Login > Settings > Valid OAuth Redirect URIs) add exactly: " + (ap.ig.redirectUri || "(not known)") }
        Quiet { objectName: "igMsg"; visible: text !== ""; text: ap.igMsg }
    }

    // ---- probe (tests): the same names and values as the widget card's probe ----
    function probe() {
        return { loaded: loaded, card: JSON.parse(JSON.stringify(card)), dirty: dirty, fit: fit, flags: flagsText, problem: problem,
            rulesOwn: rulesOwn, rulesProblem: rulesProblem, rules: JSON.parse(JSON.stringify(rulesEdit)), notices: notices.slice(), customNext: customNext.slice(),
            timesInfo: timesInfo, schedCount: schedCount, schedNext: schedNext, schedLine: schedLine, message: message, stuckLockId: stuckLockId,
            prefsLoaded: prefsLoaded, prefs: JSON.parse(JSON.stringify(prefs)), prefsDirty: prefsDirty, prefsError: prefsError, shareSum: shareSum, quotaModel: quotaModel,
            previewInfo: previewInfo, preview: previewItems.map(i => String(i.title)), gridProblem: gridProblem, offsetsText: offsetsText,
            ig: { loaded: igLoaded, hasApp: ig.hasApp === true, connected: ig.connected === true, username: ig.username || "", flagOn: ig.flagOn === true, connecting: ig.connecting === true,
                status: igStatus, queue: igQueueText, redirectUri: ig.redirectUri || "", msg: igMsg, appIdTyped: igAppId, secretTyped: igSecret.length > 0 } };
    }

    // ap-upload:<on|off> | ap-kind:<id>:<on|off> | ap-score:<n> | ap-perday:<n> | ap-gap:<h> | ap-days:<n> | ap-placement:<id>
    // | ap-daymin:<n> | ap-daymax:<n> | ap-gapmin:<n> | ap-window:<from min>:<until min> | ap-quota:<n> | ap-refresh
    function probeAction(p) {
        if (!loaded) return false;
        const a = p[0], arg = p[1];
        const on = (v) => v === "on" || v === "1";
        // D444: ap-ig-appid:<digits> | ap-ig-secret:<text> | ap-ig-save | ap-ig-connect | ap-ig-disconnect | ap-ig-drop | ap-ig-flag:<on|off> | ap-ig-refresh
        if (a === "ap-ig-appid") { igAppId = String(arg || ""); return true }
        if (a === "ap-ig-secret") { igSecret = String(arg || ""); return true }
        if (a === "ap-ig-save") return saveIgApp();
        if (a === "ap-ig-connect") return connectIg();
        if (a === "ap-ig-disconnect") return disconnectIg();
        if (a === "ap-ig-drop") return dropIg();
        if (a === "ap-ig-flag") return setIgFlag(on(arg));
        if (a === "ap-ig-refresh") { loadIg(); return true }
        if (a === "ap-upload") return set("autoUpload", on(arg));
        if (a === "ap-clearlock") { if (stuckLockId === "") return false; clearLock(); return true }
        if (a === "ap-kind" && p.length === 3) return setKind(arg, on(p[2]));
        const n = parseInt(arg, 10);
        if (a === "ap-score" && !isNaN(n)) return setNum("minScore", n, 0, 100);
        if (a === "ap-perday" && !isNaN(n)) return setNum("maxPerDay", n, 1, maxPerDayLimit);
        if (a === "ap-gap" && !isNaN(n)) return setNum("intervalHours", n, 1, 48);
        if (a === "ap-days" && !isNaN(n)) return setNum("maxAheadDays", n, 1, 730);
        if (a === "ap-quota" && !isNaN(n)) return setNum("quotaUnitsPerDay", n, 1000, 10000000);
        if (a === "ap-daymin" && !isNaN(n)) return setNum("postsPerDayMin", n, 1, 24);
        if (a === "ap-daymax" && !isNaN(n)) return setNum("postsPerDayMax", n, 1, 24);
        if (a === "ap-gapmin" && !isNaN(n)) return setNum("minGapMinutes", n, 60, 1440);
        // D434: ap-gridgap:<min> | ap-reuse:<min> | ap-tiers:<minutes, comma>
        if (a === "ap-gridgap" && !isNaN(n)) return setNum("gridGapMinutes", n, 1, 60);
        if (a === "ap-reuse" && !isNaN(n)) return setNum("readReuseMinutes", n, 0, 1440);
        if (a === "ap-tiers") return setOffsets(p.slice(1).join(":"));
        if (a === "ap-window" && p.length >= 3) { // ap-window:<from minutes>:<until minutes>
            const s = parseInt(p[1], 10), e = parseInt(p[2], 10);
            if (isNaN(s) || isNaN(e)) return false;
            set("windowStart", hhmm(clamp(s, 0, 1439, 540)));
            return set("windowEnd", hhmm(clamp(e, 0, 1440, 1380)));
        }
        if (a === "ap-placement") {
            if (!placements.includes(arg)) return false;
            return set("placement", arg);
        }
        // ap-time-add:<day>:<HH>:<MM> | ap-time-remove:<day>:<HH>:<MM> | ap-copyday:<day> | ap-skip:<dates, comma> | ap-rule-kind:<rule>:<kind>:<on|off> | ap-rule-max:<rule>:<n> | ap-rules-upload:<on|off>
        if (a === "ap-time-add" && p.length >= 3) return addTime(arg, p.slice(2).join(":"));
        if (a === "ap-time-remove" && p.length >= 3) return removeTime(arg, p.slice(2).join(":"));
        if (a === "ap-copyday") return copyDay(arg);
        if (a === "ap-rules-reset") { resetRules(); return true }
        if (a === "ap-skip") return setSkip(p.slice(1).join(":"));
        if (a === "ap-rule-kind" && p.length === 4) return setRuleKind(arg, p[2], on(p[3]));
        if (a === "ap-rule-max" && p.length === 3) return setRuleMax(arg, parseInt(p[2], 10));
        if (a === "ap-rules-upload") return setRules(r => { r.autoUpload = on(arg) });
        if (a === "ap-refresh") { loadTimes(true); return true }
        if (a === "ap-open-manager") { box.store.scheduleWanted(); return true }
        if (a === "ap-run") { runNow(); return true }
        // PT5: ap-tone:<hype|clean> | ap-emoji:<on|off> | ap-tags:<tags, space-separated, URI-encoded> | ap-own-tags:<search tags, comma-separated, URI-encoded> | ap-footer:<URI-encoded text> | ap-share:<kind>:<n> | ap-growth:<on|off> | ap-preview
        if (a === "ap-tone") return setTone(arg);
        if (a === "ap-emoji") return setPref(q => { q.text.emoji = on(arg) });
        if (a === "ap-tags") return setTags(decodeURIComponent(p.slice(1).join(":")));
        if (a === "ap-own-tags") return setOwnTags(decodeURIComponent(p.slice(1).join(":")));
        if (a === "ap-footer") return setPref(q => { q.text.footer = decodeURIComponent(p.slice(1).join(":")).slice(0, 500) });
        if (a === "ap-share" && p.length === 3) return setShare(arg, parseInt(p[2], 10));
        if (a === "ap-growth") return setPref(q => { q.growthSuggestions = on(arg) });
        if (a === "ap-preview") { loadPreview(); return true }
        return false;
    }
}
