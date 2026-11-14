// SPDX-License-Identifier: GPL-3.0-or-later
// The × that closes a tip, the tour or the help panel (the widget's guideClose tool button). tip is its tooltip and name.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

AbstractButton {
    id: b
    property string tip: ""
    implicitWidth: 28
    implicitHeight: 28
    hoverEnabled: true
    focusPolicy: Qt.NoFocus
    Accessible.name: tip
    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 500
    contentItem: Text {
        text: "×"
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        color: b.hovered ? Theme.c.text : Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 19
    }
    background: Rectangle {
        radius: 6
        color: b.down ? Theme.c.border : b.hovered ? Theme.c.field : "transparent"
    }
}
