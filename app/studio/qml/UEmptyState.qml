// SPDX-License-Identifier: GPL-3.0-or-later
// An empty list (Molten Stone, 2026-11-27; every theme): a picture, a title ("No results found"), a line of help and an
// optional button (actionText; action() on click, acting at once, D332). In Molten Stone the picture is the painted moon
// landscape with an astronaut and a planet (no face: a closed visor); elsewhere a small drawn planet in the accent.
// Fixed 230 px high with a button, 190 without, the same in every theme. Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Item {
    id: es
    property string title: "No results found"
    property string text: ""
    property string actionText: ""
    signal action()
    objectName: "emptyState"
    implicitWidth: 300
    implicitHeight: actionText !== "" ? 230 : 190

    Column {
        anchors.horizontalCenter: parent.horizontalCenter
        width: Math.min(parent.width, 300)
        spacing: Theme.sp.s
        Item {
            width: parent.width
            height: 110
            Image {
                anchors.centerIn: parent
                visible: source !== ""
                source: Theme.art.empty !== undefined ? Theme.art.empty : ""
                width: 189; height: 110
                fillMode: Image.PreserveAspectFit
                smooth: true
            }
            Canvas { // the theme-neutral picture: a planet with a ring
                id: planet
                anchors.centerIn: parent
                visible: Theme.art.empty === undefined
                width: 90; height: 70
                onPaint: {
                    const g = getContext("2d");
                    g.reset();
                    g.fillStyle = String(Theme.c.field);
                    g.strokeStyle = String(Theme.c.border);
                    g.beginPath(); g.arc(45, 35, 22, 0, Math.PI * 2); g.fill(); g.stroke();
                    g.strokeStyle = String(Theme.c.accent);
                    g.lineWidth = 2;
                    g.beginPath(); g.ellipse(9, 28, 72, 16); g.stroke();
                }
                Connections { target: Theme; function onChanged() { planet.requestPaint() } }
            }
        }
        Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: es.title
            color: Theme.c.text
            font.family: Theme.ty.displayFamily
            font.pixelSize: Theme.ty.subtitle
            font.weight: Font.DemiBold
        }
        Text {
            visible: es.text !== ""
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            maximumLineCount: 2
            elide: Text.ElideRight
            text: es.text
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        UButton {
            objectName: "emptyAction"
            visible: es.actionText !== ""
            anchors.horizontalCenter: parent.horizontalCenter
            text: es.actionText
            kind: "primary"
            onClicked: es.action()
        }
    }
}
