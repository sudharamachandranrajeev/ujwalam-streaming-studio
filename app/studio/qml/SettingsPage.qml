// SPDX-License-Identifier: GPL-3.0-or-later
// One Settings page (Q3): its title, its cards in a column and its FEATURES card last. It scrolls up and down only: the
// column is as wide as the view, so nothing ever scrolls sideways. Shown while it is the page picked in the list.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

ScrollView {
    id: pg
    required property var box        // the SettingsDialog: draft, flags, page
    property string title: ""
    property string pageId: ""        // the flags' page id for the FEATURES card ("" = no card)
    property string lead: ""          // a muted line above the cards
    property string note: ""          // a muted line under the FEATURES card
    default property alias content: col.data
    // D432: a page body given as a Component is made the first time the page is shown, then kept (the stateful pages
    // that the window calls by id stay as plain children). Every page made at once froze Settings for seconds.
    property Component body: null
    property bool made: false
    onVisibleChanged: if (visible) made = true
    Component.onCompleted: if (visible) made = true
    objectName: "settingsPage:" + title
    visible: box.page === title
    clip: true
    contentWidth: availableWidth
    contentHeight: outer.height
    ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

    Column {
        id: outer
        width: pg.availableWidth - 12
        spacing: Theme.sp.m
        Text {
            objectName: "settingsTitle:" + pg.title
            text: pg.title
            color: Theme.c.text
            font.family: Theme.ty.displayFamily
            font.pixelSize: Theme.ty.title
            font.weight: Font.DemiBold
        }
        Text {
            objectName: "settingsLead:" + pg.title
            visible: pg.lead !== ""
            width: parent.width
            text: pg.lead
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        Column {
            id: col
            width: parent.width
            spacing: Theme.sp.m
            Loader {
                active: pg.body !== null && pg.made
                visible: active
                width: parent.width
                sourceComponent: pg.body
                asynchronous: true // built over several frames: the window keeps answering while a big page is made
            }
        }
        FeaturesCard {
            box: pg.box
            pageId: pg.pageId
        }
        Text {
            objectName: "settingsNote:" + pg.title
            visible: pg.note !== ""
            width: parent.width
            text: pg.note
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }
}
