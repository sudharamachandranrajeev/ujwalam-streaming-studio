// SPDX-License-Identifier: GPL-3.0-or-later
// The drop pointer under a tooltip or tip bubble (Molten Stone, 2026-11-27; every theme): a small molten drop in the
// accent, drawn once into a 10 x 7 box. Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Canvas {
    id: d
    width: 10
    height: 7
    onPaint: {
        const g = getContext("2d");
        g.reset();
        g.fillStyle = String(Theme.c.accent);
        g.beginPath();
        g.moveTo(1, 0); g.lineTo(9, 0);
        g.quadraticCurveTo(6, 2, 5.6, 4.6);
        g.arc(5, 4.8, 1.8, 0, Math.PI, false);
        g.quadraticCurveTo(4, 2, 1, 0);
        g.fill();
    }
    Connections { target: Theme; function onChanged() { d.requestPaint() } }
}
