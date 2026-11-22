// SPDX-License-Identifier: GPL-3.0-or-later
// FX6 (D429): a FolderDialog file URL as a Windows folder path. file:///C:/x -> C:\x; file://server/share/x ->
// \\server\share\x; anything else -> "" (the settings check then refuses it). Tested by tests/folder-url.test.mjs.

function folderPath(url) {
    var s = String(url || "");
    var p;
    if (/^file:\/\/\//i.test(s)) p = s.slice(8);                 // local: file:///C:/x
    else if (/^file:\/\/[^\/]/i.test(s)) p = "//" + s.slice(7);  // UNC: file://server/share/x
    else return "";
    try { p = decodeURIComponent(p); } catch (e) { return ""; }
    if (/^[A-Za-z]:(\/|$)/.test(p)) return p.replace(/\//g, "\\").replace(/^([A-Za-z]:)$/, "$1\\");
    if (/^\/\/[^\/]+\/[^\/]+/.test(p)) return p.replace(/\//g, "\\");
    return "";
}
