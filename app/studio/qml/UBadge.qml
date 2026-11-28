// SPDX-License-Identifier: GPL-3.0-or-later
// A small badge (Molten Stone, 2026-11-27, D449; every theme): a short caps word ("NEW") on an accent pill with a thin
// lighter rim. Fixed 18 px high, so a row never grows when it shows. A still item: nothing moves, no glow past its box.
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Rectangle {
    id: b
    property string text: "NEW"
    implicitHeight: 18
    implicitWidth: word.implicitWidth + 12
    radius: 9
    color: Theme.c.accent
    border.width: 1
    border.color: Theme.c.accentHi
    Accessible.role: Accessible.StaticText
    Accessible.name: text
    Text {
        id: word
        anchors.centerIn: parent
        text: b.text
        color: Theme.c.onAccent
        font.family: Theme.family
        font.pixelSize: 10
        font.weight: Font.Bold
        font.letterSpacing: 0.6
        font.capitalization: Font.AllUppercase
    }
}
