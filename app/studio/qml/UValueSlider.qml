// SPDX-License-Identifier: GPL-3.0-or-later
// The shared slider with its number box (the widget's ValueSlider, D330): drag or click the track (one change on
// release), the wheel only while it has focus (one notch, one step), or type a value and press Enter. The value is held
// to from..to and rounded to decimals. committed(value) is the change; the owner sets value back (a refused change shows
// the old value again).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Item {
    id: vs
    property real from: 0
    property real to: 1
    property real stepSize: 0.1
    property int decimals: 1
    property real value: 0
    property string label: ""
    property string unit: ""          // shown after the box (" dB")
    property alias meter: sl.meter     // a level drawn in the groove (the mixer)
    property alias hold: sl.hold       // the peak-hold marker (the mixer)
    property alias mark: sl.mark       // a fixed tick, 0..1 (the mixer's 0 dB)
    property string fromText: ""       // shown in the box at `from` (the mixer: "Off")
    signal committed(real value)
    implicitHeight: 32

    function fit(v) {
        v = Number(v);
        if (!isFinite(v)) return value;
        v = Math.min(to, Math.max(from, v));
        const f = Math.pow(10, decimals);
        return Math.round(v * f) / f;
    }
    function shown(v) { return fromText !== "" && v <= from ? fromText : v.toFixed(decimals) }
    function sync() { sl.value = value; box.text = shown(value) }
    // The new value shows at once (held to the range); an owner that refuses it sets value back, which shows again.
    // The same value again sends nothing (2026-11-18, B5: a press on the handle without a move saved nothing new but
    // still sent a change).
    function commit(v) {
        const f = fit(v);
        sl.value = f;
        box.text = shown(f);
        if (f === fit(value)) return;
        committed(f);
    }
    // The probe's typed value: the real box, then Enter.
    function typeValue(v) { box.text = String(v); box.accepted(); return true }
    onValueChanged: sync()
    Component.onCompleted: sync()

    USlider {
        id: sl
        objectName: vs.objectName !== "" ? vs.objectName + ":slider" : ""
        anchors { left: parent.left; right: box.left; rightMargin: 8; verticalCenter: parent.verticalCenter }
        from: vs.from
        to: vs.to
        stepSize: vs.stepSize
        Accessible.name: vs.label
        onCommitted: (v) => vs.commit(v)
    }
    UField {
        id: box
        objectName: vs.objectName !== "" ? vs.objectName + ":box" : ""
        anchors { right: unitText.left; rightMargin: vs.unit !== "" ? 4 : 0; verticalCenter: parent.verticalCenter }
        width: 64
        label: vs.label
        horizontalAlignment: TextInput.AlignRight
        validator: RegularExpressionValidator { regularExpression: /-?[0-9]*([.,][0-9]*)?/ }
        onAccepted: vs.commit(parseFloat(String(text).replace(",", ".")))
        onActiveFocusChanged: if (!activeFocus) vs.sync() // left without Enter: the value as it is
    }
    Text {
        id: unitText
        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
        width: vs.unit !== "" ? implicitWidth : 0
        text: vs.unit
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }
}
