// SPDX-License-Identifier: GPL-3.0-or-later
// The effect types the studio edits (D260, D290), shared by the widget studio (main_window.cpp, LookPanel) and the QML
// studio (QmlApi::fxTypes). One table, so a type added here shows up in both.
#pragma once

#include <QString>
#include <vector>

// Effect editor (D260): every effect type the host knows (app/host/src/model.cpp, same ranges), its settings and the
// values a new one starts with. Numbers are canvas px, 0..1 shares or degrees, as in data/schemas/project.schema.json.
struct FxParam {
	const char *key, *label;
	bool colour;
	double lo, hi, def, step;
	int dec;
	const char *cdef;
};
// group (D290): where the effect is listed in the inspector: "shape" (corners, pin, blinds), "filter" (colour, blur,
// looks), "camera" (key, mask, mirror), "compositing" (blend, opacity, masks), "light" (shadow, glow).
struct FxType {
	const char *type, *label;
	std::vector<FxParam> params;
	const char *group = "filter";
};

const std::vector<FxType> &fxTypes();
const FxType *fxType(const QString &type); // nullptr for a type not in the table
