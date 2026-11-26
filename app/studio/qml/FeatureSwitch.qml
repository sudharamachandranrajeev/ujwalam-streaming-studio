// SPDX-License-Identifier: GPL-3.0-or-later
// A finished feature's own toggle in its Settings section (2026-11-26, user: "don't use the janky flag system"): the
// switch text says what it does in plain words; Save applies it with the other changes (ui/api/flags/set, which
// stores it in settings.json features and also works while live). Hidden when this server does not know the feature.
import QtQuick
import Ujwalam.Core

USwitch {
    id: fs
    required property var box
    required property string fid
    objectName: "feature:" + fid
    width: parent ? parent.width : implicitWidth
    visible: box.hasFeature(fid)
    height: visible ? implicitHeight : 0
    checked: box.flagDraft[fid] === true
    onToggled: box.setFlagDraft(fid, checked)
}
