// SPDX-License-Identifier: GPL-3.0-or-later
// A context menu in theme tokens. Its own window (Popup.Window), so a native preview never covers it; hidden test mode
// (never on screen) draws it inside the never-shown window. items() lists the rows for the tests' probe.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Menu {
    id: menu
    popupType: studioHidden ? Popup.Item : Popup.Window
    padding: 4
    background: Rectangle {
        implicitWidth: 240
        color: Theme.c.panel
        radius: Theme.radiusMedium
        border.width: 1
        border.color: Theme.c.border
        // A window popup is as big as its box, so a shadow past the edge would be cut off: only the in-window kind gets one.
        ShadowLayers { level: menu.popupType === Popup.Window ? 0 : 3; strength: 0; radius: Theme.radiusMedium }
    }
    // id, text, keys, enabled, tip of every row that is shown (separators have no id)
    function items() {
        const out = [];
        for (let i = 0; i < count; i++) {
            const m = itemAt(i);
            if (m && m.visible && m.objectName !== "")
                out.push({ id: m.objectName.split(":").pop(), text: m.text, keys: m.keys || "", enabled: m.enabled, tip: m.tip || "" });
        }
        return out;
    }
    function trigger(id) {
        for (let i = 0; i < count; i++) {
            const m = itemAt(i);
            if (m && m.visible && m.objectName.endsWith(":" + id)) {
                if (!m.enabled) return false;
                close();
                m.triggered();
                return true;
            }
        }
        return false;
    }
}
