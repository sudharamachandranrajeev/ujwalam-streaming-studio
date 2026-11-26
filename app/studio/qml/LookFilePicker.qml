// SPDX-License-Identifier: GPL-3.0-or-later
// RL5 (D445): the file picker for "New look from a reference" (a screenshot or a short video). Its own file, loaded by a
// Loader, so a missing QtQuick.Dialogs import can never break the dialog that uses it.
import QtQuick
import QtQuick.Dialogs
import "folderUrl.js" as FolderUrl

Item {
    id: picker
    signal chosen(string file)
    function open() { dlg.open() }
    FileDialog {
        id: dlg
        title: "Pick a screenshot or short video of the look you like"
        fileMode: FileDialog.OpenFile
        nameFilters: ["Pictures and videos (*.png *.jpg *.jpeg *.bmp *.webp *.mp4 *.mov *.m4v *.mkv *.webm)"]
        onAccepted: {
            const p = FolderUrl.folderPath(dlg.selectedFile); // file:///C:/x/y.png -> C:\x\y.png (same rule as folders)
            if (p !== "") picker.chosen(p);
        }
    }
}
