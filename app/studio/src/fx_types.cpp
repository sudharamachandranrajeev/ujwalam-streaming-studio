// SPDX-License-Identifier: GPL-3.0-or-later
#include "fx_types.h"

namespace {

FxParam fxNum(const char *k, const char *l, double lo, double hi, double def, double step, int dec)
{
	return {k, l, false, lo, hi, def, step, dec, ""};
}
FxParam fxCol(const char *k, const char *l, const char *def)
{
	return {k, l, true, 0, 0, 0, 0, 0, def};
}

} // namespace

const std::vector<FxType> &fxTypes()
{
	static const std::vector<FxType> t = {
		{"blur", "Blur", {fxNum("strength", "Strength (source px)", 1, 100, 10, 1, 1)}, "filter"},
		{"rounded", "Rounded corners", {fxNum("radius", "Radius (source px)", 0, 500, 20, 1, 1)}, "shape"},
		{"chromaKey", "Chroma key", {fxCol("color", "Key colour", "#00ff00"), fxNum("similarity", "Similarity", 1, 1000, 400, 10, 0),
					     fxNum("smoothness", "Smoothness", 1, 1000, 80, 10, 0)}, "camera"},
		{"shadow", "Shadow", {fxCol("color", "Colour", "#000000"), fxNum("opacity", "Opacity", 0, 1, 0.5, 0.05, 2),
				      fxNum("size", "Softness (px)", 0, 200, 10, 1, 1), fxNum("distance", "Distance (px)", 0, 200, 10, 1, 1),
				      fxNum("angle", "Light from (degrees)", -360, 360, 135, 5, 1)}, "light"},
		{"glow", "Glow", {fxCol("color", "Colour", "#ffffff"), fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2),
				  fxNum("size", "Size (px)", 0, 200, 15, 1, 1), fxNum("spread", "Spread", 0, 1, 0, 0.05, 2)}, "light"},
		{"color", "Colour correction", {fxNum("brightness", "Brightness", -1, 1, 0, 0.05, 2), fxNum("contrast", "Contrast", -1, 1, 0, 0.05, 2),
						fxNum("saturation", "Saturation", -1, 1, 0, 0.05, 2), fxNum("hue", "Hue (degrees)", -180, 180, 0, 5, 1)}, "filter"},
		{"toner", "Toner", {fxCol("shadows", "Shadows", "#000000"), fxCol("darktones", "Dark tones", "#404040"),
				    fxCol("midtones", "Mid tones", "#808080"), fxCol("brights", "Brights", "#c0c0c0"),
				    fxCol("highlights", "Highlights", "#ffffff"), fxNum("amount", "Amount", 0, 1, 1, 0.05, 2)}, "filter"},
		{"blinds", "Blinds", {fxNum("completion", "Hidden share", 0, 1, 0.5, 0.05, 2), fxNum("angle", "Angle (degrees)", -360, 360, 90, 5, 1),
					  fxNum("width", "Slat width (% of layer)", 1, 100, 10, 1, 1), fxNum("feather", "Feather (px)", 0, 100, 2, 1, 1)}, "shape"},
		{"cornerPin", "Corner pin", {fxNum("topLeftX", "Top left x", 0, 1, 0, 0.01, 3), fxNum("topLeftY", "Top left y", 0, 1, 0, 0.01, 3),
					     fxNum("topRightX", "Top right x", 0, 1, 1, 0.01, 3), fxNum("topRightY", "Top right y", 0, 1, 0, 0.01, 3),
					     fxNum("bottomRightX", "Bottom right x", 0, 1, 1, 0.01, 3),
					     fxNum("bottomRightY", "Bottom right y", 0, 1, 1, 0.01, 3),
					     fxNum("bottomLeftX", "Bottom left x", 0, 1, 0, 0.01, 3),
					     fxNum("bottomLeftY", "Bottom left y", 0, 1, 1, 0.01, 3)}, "shape"},
		// D291. lut and imageMask need a file field (not in this table yet): they are kept as they are, not editable here.
		{"sharpen", "Sharpen", {fxNum("amount", "Amount", 0, 1, 0.2, 0.05, 2)}, "filter"},
		{"vignette", "Vignette", {fxNum("amount", "Amount", 0, 1, 0.5, 0.05, 2), fxNum("size", "Clear centre", 0, 1, 0.4, 0.05, 2),
					  fxNum("softness", "Softness", 0, 1, 0.5, 0.05, 2), fxCol("color", "Colour", "#000000")}, "filter"},
		{"grain", "Film grain", {fxNum("amount", "Amount", 0, 1, 0.15, 0.05, 2), fxNum("size", "Grain size (px)", 1, 10, 1, 1, 0)}, "filter"},
		// D445 realism looks
		{"bloom", "Bloom (glow on lights)", {fxNum("amount", "Amount", 0, 1, 0.2, 0.05, 2),
						    fxNum("threshold", "Starts at brightness", 0, 1, 0.8, 0.05, 2),
						    fxNum("size", "Reach (% of layer)", 1, 20, 3, 0.5, 1)}, "light"},
		{"clarity", "Clarity (local contrast)", {fxNum("amount", "Amount", 0, 1, 0.3, 0.05, 2),
							 fxNum("size", "Reach (% of layer)", 1, 20, 2, 0.5, 1)}, "filter"},
		{"chromatic", "Lens colour fringe", {fxNum("amount", "Amount", 0, 1, 0.3, 0.05, 2)}, "filter"},
		{"pixelate", "Pixelate", {fxNum("size", "Block size (px)", 2, 200, 16, 1, 0)}, "filter"},
		{"posterize", "Posterize", {fxNum("levels", "Levels", 2, 32, 6, 1, 0)}, "filter"},
		{"mirror", "Mirror", {}, "camera"},
		{"flip", "Flip upside down", {}, "camera"},
		{"circleMask", "Circle mask", {fxNum("feather", "Soft edge (%)", 0, 25, 0, 0.5, 1), fxNum("borderWidth", "Border (%)", 0, 25, 0, 0.5, 1),
					       fxCol("borderColor", "Border colour", "#ffffff")}, "camera"},
		{"roundMask", "Rounded mask", {fxNum("radius", "Corner (%)", 0, 50, 12, 1, 1), fxNum("feather", "Soft edge (%)", 0, 25, 0, 0.5, 1),
					       fxNum("borderWidth", "Border (%)", 0, 25, 0, 0.5, 1), fxCol("borderColor", "Border colour", "#ffffff")}, "camera"},
		{"opacity", "Opacity", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendAdd", "Blend: add", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendSubtract", "Blend: subtract", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendMultiply", "Blend: multiply", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendScreen", "Blend: screen", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendLighten", "Blend: lighten", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendDarken", "Blend: darken", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"gradientMask", "Gradient fade", {fxNum("angle", "Direction (degrees)", -360, 360, 90, 5, 1), fxNum("start", "Fade starts", 0, 1, 0.6, 0.05, 2),
						   fxNum("end", "Fade ends", 0, 1, 1, 0.05, 2)}, "compositing"},
		// Face AI (flag face-ai, D295 proposed). personMask mode (remove | blur | replace) and its file, and faceSticker
		// (file), need a choice / file field (not in this table yet): mode is kept as it is (added: remove), faceSticker
		// is not editable here.
		{"personMask", "Background (AI)", {fxNum("threshold", "Edge threshold", 0, 1, 0.5, 0.05, 2),
						   fxNum("feather", "Edge softness", 0, 1, 0.2, 0.05, 2),
						   fxNum("smoothing", "Steadiness", 0, 0.95, 0.4, 0.05, 2),
						   fxNum("strength", "Blur strength (blur mode)", 1, 100, 20, 1, 1),
						   fxCol("color", "Colour (replace mode)", "#00b140")}, "camera"},
		{"autoFrame", "Follow face", {fxNum("zoom", "Zoom", 1, 4, 1.6, 0.1, 2), fxNum("smoothing", "Smoothing (s)", 0, 5, 0.5, 0.1, 2),
					      fxNum("deadzone", "Dead zone", 0, 0.5, 0.1, 0.01, 2)}, "camera"},
	};
	return t;
}

const FxType *fxType(const QString &type)
{
	for (const auto &t : fxTypes())
		if (type == QLatin1String(t.type))
			return &t;
	return nullptr;
}
