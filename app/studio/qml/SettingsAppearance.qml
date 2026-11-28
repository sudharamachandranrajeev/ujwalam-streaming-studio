// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Appearance (the widget's appearance::Page, D293): the themes as cards drawn in their own colours, the effects
// level (High performance, Reduce effects) and the animation choice. A card click and the effects switches are tried
// live; Save keeps them, Cancel puts the old look back.
// RareUI slice 2 (D384; design after RareUI, MIT, Swapnil Kalambe, Toast Tabs): with the pack's components.tabs = "avatar" the
// theme cards become round avatars (the chosen one larger, inside a ring) with a speech bubble that names the theme under the
// pointer or the chosen one. No autoplay ring (a theme must not change by itself). "full" springs the size, "calm" is
// still, "plain" (on air, High performance) keeps the cards.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: ap
    required property var box
    width: parent ? parent.width : 0
    spacing: Theme.sp.m
    readonly property var d: box.draft
    readonly property var themes: Theme.themes()
    readonly property string tabLook: Theme.rareui && Theme.fx !== "plain" && Theme.tabsStyle === "avatar" ? "avatar" : ""
    readonly property bool full: Theme.fx === "full" && Theme.motion
    property string hoverId: ""
    readonly property var shownTheme: themes.find(t => t.id === (hoverId !== "" ? hoverId : d.theme)) || null
    Item { // read by the probe (tab look, no loop)
        objectName: "tabLook:avatar"
        readonly property string look: ap.tabLook
        readonly property bool loop: false
        width: 0
        height: 0
    }

    UCard {
        title: "THEME"
        Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: "A theme changes the whole window: colours, type, corners, shadows, glow and motion. Click one to try it; Save keeps it. " +
                  "Your own theme files go in the themes folder next to the program."
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        Flow {
            width: parent.width
            spacing: ap.tabLook === "avatar" ? 16 : 10
            Repeater {
                model: ap.themes
                delegate: Button {
                    id: card
                    required property var modelData
                    readonly property bool chosen: ap.d.theme === modelData.id
                    objectName: "themeCard:" + modelData.id
                    readonly property bool av: ap.tabLook === "avatar"
                    width: av ? 52 : 136
                    height: av ? 52 : 112
                    // avatar: the chosen one is larger, the others a little smaller and lighter, a lift under the pointer
                    scale: !av ? 1 : chosen ? 1.2 : hovered ? 1.1 : 0.92
                    opacity: !av || chosen || hovered ? 1 : 0.75
                    Behavior on scale { enabled: card.av && ap.full; NumberAnimation { duration: 250; easing.type: Easing.OutBack } }
                    onHoveredChanged: if (hovered) ap.hoverId = modelData.id; else if (ap.hoverId === modelData.id) ap.hoverId = ""
                    checkable: false
                    hoverEnabled: true
                    focusPolicy: Qt.StrongFocus
                    text: modelData.name
                    Accessible.name: modelData.name
                    Accessible.description: modelData.topic || ""
                    ToolTip.visible: hovered && !!modelData.topic
                    ToolTip.text: modelData.topic || ""
                    ToolTip.delay: 500
                    onClicked: ap.box.pickTheme(modelData.id)
                    contentItem: Item {}
                    background: Loader { sourceComponent: card.av ? avatarBg : cardBg }
                    Component {
                        id: avatarBg
                        Item {
                            anchors.fill: parent
                            Rectangle { // the ring of the chosen theme
                                anchors.centerIn: parent
                                width: parent.width + 8
                                height: width
                                radius: width / 2
                                color: "transparent"
                                border.width: card.chosen ? 2 : card.visualFocus ? 1.5 : 0
                                border.color: Theme.c.accentHi
                            }
                            Rectangle { // the theme as a disc: its window colour, its panel and its accent
                                anchors.fill: parent
                                radius: width / 2
                                color: card.modelData.bg
                                border.width: 1
                                border.color: Theme.c.border
                                Rectangle { anchors.centerIn: parent; width: parent.width * 0.62; height: width; radius: width / 2; color: card.modelData.panel }
                                Rectangle { anchors.centerIn: parent; width: parent.width * 0.3; height: width; radius: width / 2; color: card.modelData.accent }
                            }
                        }
                    }
                    Component {
                        id: cardBg
                    Rectangle {
                        anchors.fill: parent
                        radius: Theme.radiusMedium
                        color: card.modelData.bg
                        border.width: card.chosen ? 2.2 : card.hovered || card.visualFocus ? 1.6 : 1
                        border.color: card.chosen ? Theme.c.accentHi : card.hovered || card.visualFocus ? card.modelData.accent : Theme.c.border
                        // a miniature window: a panel with a field and a primary button in the theme's own colours
                        Rectangle {
                            x: 8; y: 8
                            width: parent.width - 16
                            height: parent.height - 48
                            radius: Theme.radiusSmall
                            color: card.modelData.panel
                            Rectangle { x: 8; y: 9; width: parent.width * 0.45; height: 10; radius: 3; color: card.modelData.bg; opacity: 0.8 }
                            Rectangle { x: 8; y: parent.height - 20; width: 50; height: 13; radius: 5; color: card.modelData.accent }
                            Rectangle { x: parent.width * 0.58; y: 11; width: parent.width * 0.3; height: 3; radius: 1.5; color: card.modelData.text; opacity: 0.55 }
                            Rectangle { x: parent.width * 0.58; y: 18; width: parent.width * 0.2; height: 3; radius: 1.5; color: card.modelData.text; opacity: 0.55 }
                        }
                        Text {
                            x: 10
                            y: parent.height - 34
                            width: parent.width - 34
                            text: card.modelData.name
                            elide: Text.ElideRight
                            color: card.modelData.text
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.caption
                            font.weight: Font.Bold
                        }
                        Rectangle {
                            visible: card.chosen
                            x: parent.width - 24
                            y: parent.height - 32
                            width: 16
                            height: 16
                            radius: Theme.radiusSmall
                            color: card.modelData.accent
                            Text { anchors.centerIn: parent; text: "✓"; color: "white"; font.pixelSize: Theme.ty.caption; font.weight: Font.Bold }
                        }
                    }
                    }
                }
            }
        }
        Item { // the speech bubble of the avatar look: the name and the topic of the theme under the pointer, or the chosen one
            objectName: "avatarBubble"
            visible: ap.tabLook === "avatar" && ap.shownTheme !== null
            width: parent.width
            height: visible ? bubble.height + 12 : 0
            opacity: visible ? 1 : 0
            Behavior on opacity { enabled: ap.full; NumberAnimation { duration: 200 } }
            Rectangle { // the tail: a rotated square
                x: 24
                y: 6
                width: 12
                height: 12
                rotation: 45
                color: Theme.c.field
                border.width: 1
                border.color: Theme.c.border
            }
            Rectangle {
                id: bubble
                y: 12
                width: Math.min(parent.width, 360)
                height: bubbleText.implicitHeight + 24
                radius: Theme.radiusLarge
                color: Theme.c.field
                border.width: 1
                border.color: Theme.c.border
                Text {
                    id: bubbleText
                    anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: Theme.sp.m }
                    wrapMode: Text.Wrap
                    text: ap.shownTheme ? ap.shownTheme.name + (ap.shownTheme.topic ? ": " + ap.shownTheme.topic : "") : ""
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                    font.weight: Font.Medium
                }
            }
        }
    }

    UCard {
        title: "EFFECTS"
        USwitch {
            objectName: "settingsPerformance"
            width: parent.width
            text: "High performance (flat look: no shadows, glow, gradients or animation)"
            hint: "Less to draw. Colours, type and corners stay as the theme says."
            checked: ap.d.effects === "performance"
            onToggled: ap.box.setPerformance(checked)
        }
        USwitch {
            objectName: "settingsReduceEffects"
            width: parent.width
            text: "Reduce effects (no shadows, glow or 3D edges)"
            hint: "Turn this on if the window feels slow on this PC. Gradients and animations stay."
            enabled: ap.d.effects !== "performance"
            checked: ap.d.effects !== "full"
            onToggled: ap.box.setReduce(checked)
        }
    }

    UCard {
        title: "ANIMATIONS"
        Text {
            text: "Motion in the window:"
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.body
        }
        Row { // three choices, all in sight: radio buttons (Molten Stone, 2026-11-27; every theme)
            objectName: "settingsMotion"
            spacing: Theme.sp.l
            Repeater {
                model: ap.box.motionChoices
                URadio {
                    required property var modelData
                    objectName: "settingsMotion:" + modelData.value
                    text: modelData.text
                    checked: ap.d.motion === modelData.value
                    onClicked: ap.box.set("motion", modelData.value)
                }
            }
        }
    }
}
