// SPDX-License-Identifier: GPL-3.0-or-later
// The scheduling manager's content (ScheduleCenter.qml holds the data and the actions): the header with its buttons, the
// search and filters, the bulk buttons, the Move box and the list. The list is a ListView over day headers and posts: only
// the rows on screen exist, and each reads its data by key, so a refresh changes only texts that changed. The same view
// sits in the panel and in the own window (ScheduleWindow.qml).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Item {
    id: view
    required property var center
    property bool inWindow: false

    Column {
        id: top
        anchors { left: parent.left; right: parent.right; top: parent.top }
        spacing: Theme.sp.s
        Item {
            width: parent.width
            height: 30
            Text {
                id: heading
                anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                text: "SCHEDULED POSTS"
                color: Theme.c.muted
                font.family: Theme.ty.displayFamily
                font.pixelSize: Theme.ty.caption
                font.weight: Font.Bold
                font.letterSpacing: 1
            }
            Text {
                objectName: "schedSummary"
                anchors { left: heading.right; leftMargin: Theme.sp.m; right: btnRow.left; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                elide: Text.ElideRight
                text: view.center.summaryText
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.caption
            }
            Row {
                id: btnRow
                anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                spacing: Theme.sp.s
                UButton {
                    objectName: "schedRefresh"
                    text: "Refresh"
                    implicitHeight: 26
                    tip: "Read the list again"
                    focusPolicy: Qt.NoFocus
                    onClicked: view.center.load()
                }
                UButton {
                    objectName: "schedOwnWindow"
                    visible: !view.inWindow
                    text: "Open in own window"
                    implicitHeight: 26
                    tip: "Open the list in its own window, with more room"
                    focusPolicy: Qt.NoFocus
                    onClicked: view.center.openWindow()
                }
                UButton {
                    objectName: "schedDock"
                    visible: view.inWindow
                    text: "Dock"
                    implicitHeight: 26
                    tip: "Close this window and go back to the small panel"
                    focusPolicy: Qt.NoFocus
                    onClicked: view.center.dockWindow()
                }
                UButton {
                    objectName: "schedHide"
                    visible: !view.inWindow
                    text: "Hide"
                    implicitHeight: 26
                    focusPolicy: Qt.NoFocus
                    onClicked: view.center.open = false
                }
            }
        }
        Flow {
            width: parent.width
            spacing: Theme.sp.s
            UField {
                id: searchBox
                objectName: "schedSearch"
                width: Math.max(180, Math.min(260, parent.width - 3 * 170))
                label: "Search"
                placeholderText: "Search clip, day or place"
                text: view.center.search
                onTextEdited: view.center.search = text
            }
            UCombo {
                id: targetBox
                objectName: "schedTarget"
                label: "Show posts for"
                width: 170
                model: view.center.targetModel
                onChose: (v) => view.center.fTarget = v
                Component.onCompleted: pick(view.center.fTarget)
            }
            UCombo {
                id: stateBox
                objectName: "schedState"
                label: "Show posts that are"
                width: 190
                model: view.center.stateModel
                onChose: (v) => view.center.fState = v
                Component.onCompleted: pick(view.center.fState)
            }
            UCombo {
                id: channelBox
                objectName: "schedChannel"
                visible: view.center.multiChannel
                label: "Show posts for channel"
                width: 170
                model: view.center.channelModel
                onChose: (v) => view.center.fChannel = v
                onModelChanged: pick(view.center.fChannel)
                Component.onCompleted: pick(view.center.fChannel)
                Connections { target: view.center; function onFChannelChanged() { channelBox.pick(view.center.fChannel) } }
            }
            UCombo {
                id: sortBox
                objectName: "schedSort"
                label: "Sort by time"
                width: 150
                model: view.center.sortModel
                onChose: (v) => view.center.sortDir = v
                Component.onCompleted: pick(view.center.sortDir)
            }
        }
        Row {
            spacing: Theme.sp.s
            visible: view.center.failedRemovable > 0 || view.center.undoList.length > 0
            UButton {
                objectName: "schedRemoveFailed"
                visible: view.center.failedRemovable > 0
                enabled: !view.center.bulkBusy
                text: "Remove all failed (" + view.center.failedRemovable + ")"
                implicitHeight: 28
                tip: "Takes every failed post out of the upload queue. They stay in the Posts window."
                focusPolicy: Qt.NoFocus
                onClicked: view.center.removeFailed()
            }
            UButton {
                objectName: "schedUndo"
                visible: view.center.undoList.length > 0
                enabled: !view.center.bulkBusy
                text: "Undo the day move (" + view.center.undoList.length + ")"
                implicitHeight: 28
                tip: "Puts the posts you just moved back at their old times."
                focusPolicy: Qt.NoFocus
                onClicked: view.center.undoMove()
            }
        }
        Column {
            objectName: "schedMoveBox"
            visible: view.center.moving.mode !== ""
            width: parent.width
            spacing: Theme.sp.xs
            Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: view.center.moving.mode === "day" ? "Move every post of this day to another day (same clock times, your time zone), like 2026-11-14:"
                    : "New publish time (your time zone), like 2026-11-14 18:00:"
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: Theme.ty.small
            }
            Row {
                spacing: Theme.sp.s
                UField {
                    objectName: "schedMoveText"
                    width: 210
                    label: "New time"
                    text: view.center.moveText
                    onTextEdited: view.center.moveText = text
                    onAccepted: view.center.goMove()
                }
                UButton { objectName: "schedMoveGo"; text: "Move"; kind: "primary"; focusPolicy: Qt.NoFocus; onClicked: view.center.goMove() }
                UButton { objectName: "schedMoveCancel"; text: "Cancel"; focusPolicy: Qt.NoFocus; onClicked: view.center.cancelMove() }
            }
        }
        Text {
            objectName: "schedMessage"
            visible: text !== ""
            width: parent.width
            wrapMode: Text.Wrap
            text: view.center.message
            color: /^Not /.test(view.center.message) ? Theme.c.danger : Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        Text {
            objectName: "schedInfo"
            visible: text !== ""
            width: parent.width
            wrapMode: Text.Wrap
            text: view.center.info
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.caption
        }
    }

    Text {
        objectName: "schedEmpty"
        visible: view.center.loaded && view.center.shownRows === 0
        anchors { left: parent.left; top: top.bottom; topMargin: Theme.sp.m }
        text: view.center.filtered ? "No post matches this search." : "Nothing is scheduled."
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.body
    }

    ListView {
        id: list
        objectName: "schedRows"
        anchors { left: parent.left; right: parent.right; top: top.bottom; topMargin: Theme.sp.s; bottom: parent.bottom }
        clip: true
        spacing: 2
        model: view.center.rowIds
        boundsBehavior: Flickable.StopAtBounds
        reuseItems: true
        cacheBuffer: 200
        ScrollBar.vertical: ScrollBar {}
        delegate: Item {
            id: cell
            required property string rid
            required property int index
            readonly property var r: view.center.rowOf(rid)
            width: ListView.view.width - Theme.sp.m
            height: r.head ? 34 : 56
            Component.onCompleted: view.center.rowsMade++
            Loader {
                anchors.fill: parent
                sourceComponent: cell.r.head ? headComp : rowComp
            }
            Component {
                id: headComp
                Item {
                    Text {
                        objectName: "schedDay"
                        anchors { left: parent.left; leftMargin: Theme.sp.xs; verticalCenter: parent.verticalCenter }
                        text: cell.r.text + "  (" + cell.r.count + ")"
                        color: Theme.c.text
                        font.family: Theme.ty.displayFamily
                        font.pixelSize: Theme.ty.body
                        font.weight: Font.Bold
                    }
                    UButton {
                        objectName: "schedMoveDay:" + cell.r.day
                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                        visible: cell.r.movable > 0
                        enabled: !view.center.bulkBusy
                        text: "Move this day"
                        implicitHeight: 26
                        tip: "Move every post of this day to another day, at the same clock times."
                        focusPolicy: Qt.NoFocus
                        onClicked: view.center.startDayMove(cell.r.day)
                    }
                }
            }
            Component {
                id: rowComp
                Rectangle {
                    id: row
                    objectName: "schedRow:" + cell.r.key
                    readonly property bool busy: view.center.busy[cell.r.key] === true || view.center.bulkBusy
                    radius: Theme.radiusMedium
                    color: Theme.c.field
                    border.width: 1
                    border.color: cell.r.state === "failed" ? Theme.c.danger : Theme.c.border
                    Row {
                        id: topLine
                        anchors { left: parent.left; leftMargin: Theme.sp.m; top: parent.top; topMargin: 6 }
                        spacing: Theme.sp.m
                        Text { text: cell.r.hhmm; color: Theme.c.text; font.family: Theme.family; font.pixelSize: Theme.ty.body; font.weight: Font.DemiBold }
                        Text { text: cell.r.targetText; color: Theme.c.accentHi; font.family: Theme.family; font.pixelSize: Theme.ty.small; }
                        Text { visible: view.center.multiChannel && (cell.r.channelText || "") !== ""; text: cell.r.channelText || ""; color: Theme.c.muted; font.family: Theme.family; font.pixelSize: Theme.ty.small }
                        Text {
                            text: cell.r.stateText
                            color: cell.r.state === "failed" ? Theme.c.danger : cell.r.state === "scheduled" ? Theme.c.ok : Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.small

                        }
                    }
                    Text {
                        anchors { left: parent.left; leftMargin: Theme.sp.m; right: btns.left; rightMargin: Theme.sp.s; bottom: parent.bottom; bottomMargin: 6 }
                        elide: Text.ElideRight
                        text: cell.r.title + (cell.r.reasonText !== "" ? "  -  " + cell.r.reasonText : "")
                        color: cell.r.reasonText !== "" && cell.r.state === "failed" ? Theme.c.danger : Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.caption
                    }
                    Row {
                        id: btns
                        anchors { right: parent.right; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                        spacing: Theme.sp.xs
                        UButton {
                            objectName: "schedNow:" + cell.r.key
                            visible: cell.r.btn.now
                            enabled: !row.busy
                            text: cell.r.postText
                            implicitHeight: 26
                            tip: cell.r.platform === "instagram" ? "Post this Reel now. Never while a stream is live." : "Upload this clip to YouTube now. It still goes public at its time. Never while a stream is live."
                            focusPolicy: Qt.NoFocus
                            onClicked: view.center.nowRow(cell.r.key, false)
                        }
                        UButton {
                            objectName: "schedRetry:" + cell.r.key
                            visible: cell.r.btn.retry
                            enabled: !row.busy
                            text: "Retry"
                            implicitHeight: 26
                            tip: "Try this post again. Never while a stream is live."
                            focusPolicy: Qt.NoFocus
                            onClicked: view.center.nowRow(cell.r.key, true)
                        }
                        UButton {
                            objectName: "schedMove:" + cell.r.key
                            visible: cell.r.btn.move
                            enabled: !row.busy
                            text: "Move"
                            implicitHeight: 26
                            focusPolicy: Qt.NoFocus
                            onClicked: view.center.startMove(cell.r.key)
                        }
                        UButton {
                            objectName: "schedRemove:" + cell.r.key
                            visible: cell.r.btn.remove
                            enabled: !row.busy
                            text: "Remove"
                            implicitHeight: 26
                            tip: "Takes this clip out of the upload queue. Its post stays in the Posts window."
                            focusPolicy: Qt.NoFocus
                            onClicked: view.center.removeRow(cell.r.key)
                        }
                    }
                }
            }
        }
    }
}
