// SPDX-License-Identifier: GPL-3.0-or-later
// FX6 (D429): the folder picker for the AI music runtime (Settings > Clips). Its own file, loaded by a Loader, so a
// missing QtQuick.Dialogs import can never break the Clips page.
import QtQuick
import QtQuick.Dialogs

Item {
    id: picker
    signal chosen(string folder)
    function open() { dlg.open() }
    FolderDialog {
        id: dlg
        title: "Pick the folder where ACE-Step 1.5 is installed"
        onAccepted: {
            let p = decodeURIComponent(String(dlg.selectedFolder).replace(/^file:\/{2,3}/, ""));
            if (/^[A-Za-z]:\//.test(p)) p = p.replace(/\//g, "\\");
            picker.chosen(p);
        }
    }
}
