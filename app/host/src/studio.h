// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: scene model on libobs. Canvases H (libobs main canvas) and V (obs_canvas_create), scenes per canvas,
// layers (one scene item each, on a source that may be shared), active scene per canvas, mixer state.
//
// Two input formats for project.load:
//   1. Project v1 (data/schemas/project.schema.json; Agent A's model). Mapped by model.h: one project scene becomes
//      one libobs scene on every project canvas, with the same scene id; one project layer becomes one source and
//      one item per placement; "duplicate" layers are extra items on the target's source.
//   2. Host test format, marked "format": "ujwalam-host-test" (generated test cards; no files, no devices):
//      { "format": "ujwalam-host-test", "version": 1, "name": "...",
//        "canvases": [ { "id": "H", "w": 1920, "h": 1080, "fps": 60 }, { "id": "V", "w": 1080, "h": 1920, "fps": 60 } ],
//        "scenes": [ { "id": "main", "canvas": "H", "name": "Main",
//                      "layers": [ { "id": "bars", "type": "test_pattern", "name": "Bars", "visible": true,
//                                    "settings": { ... }, "transform": { "fit": "inner", "x": 0, "y": 0, "w": 1920, "h": 1080 } } ] } ],
//        "active": { "H": "main", "V": "main-v" } }
//      Layer types: color, test_pattern, media, image; with --allow-devices also dshow_video, wasapi_input;
//      with --allow-browser also browser.
// Project v1 screen and window layers (D390 proposed) build only on a host started with --allow-screen-capture (which
// loads win-capture); otherwise they are listed unavailable ("forbidden"). Their targets come from the read-only RPC
// capture.listTargets -> { displays: [{id, name, width, height}], windows: [{id, title, exe}] } (screen_capture.h).
// Layers are listed bottom to top. Canvas ids are H and V (case-insensitive on input). A scene id may exist on both
// canvases; methods take an optional canvas and act on every canvas that has the scene when it is omitted (layers.list
// and layers.add need it when the scene is on both).
#pragma once

#include "json.h"
#include "model.h"
#include "preview_edit.h"
#include "transition_ease.h"

#include <obs.h>

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

class Studio {
public:
	struct Flags {
		bool allow_devices = false;
		bool allow_browser = false;
		bool allow_screen = false; // --allow-screen-capture: screen and window layers (D390 proposed)
	};
	struct LoadOptions {
		std::map<std::string, std::string> bases; // project v1 pathRef bases -> absolute directories
		bool skip_unavailable = false;            // build the rest when some layers cannot be built
		// Overlay browser layers: page URL per layer id (project v1 source.overlay; built by the Node caller with
		// feedQuery) and the relay page scope ("" none, "effects", "display"). The relay is one hidden browser
		// source (ujw:overlay-relay) that re-posts the overlay feed on BroadcastChannel 'rp-events' for pages such
		// as gg-burst. The ports are the host's own overlay server (set by the RPC layer, never by the caller).
		std::map<std::string, std::string> browser_urls;
		std::string relay_scope;
		uint16_t overlay_port = 0, overlay_feed_port = 0;
	};
	explicit Studio(Flags f) : flags_(f) {}
	~Studio();

	// Replaces the whole model. Refused (CONFLICT) while outputs_active. Throws rpc::Error.
	json::Value load(const json::Value &project, bool outputs_active, const LoadOptions &o = {});
	// Dry run for project v1: the build plan, device matches and what cannot be built. Creates nothing and opens no
	// device. Devices are listed (list-only; see devices.h) only with --allow-devices (D38).
	json::Value plan(const json::Value &project, const LoadOptions &o) const;
	json::Value get() const;
	void teardown();

	json::Value scenes_list(const std::string &canvas) const; // canvas "" = all
	json::Value scene_create(const json::Value &scene);
	json::Value scene_remove(const std::string &scene, const std::string &canvas);
	json::Value scene_activate(const std::string &scene, const std::string &canvas);
	// transitions.set / transitions.get (D239): per canvas {type: cut|fade, durationMs}.
	// type cut | fade (ms = duration) | stinger (file = pathRef {base, rel} of a video, resolved with the last load's
	// bases; point_ms = when the scene changes under it; the stinger's own length is the duration; D242; audio = its own
	// sound in the canvas mix, D244).
	// easing (D327 TR1): a curve id of transition_ease.h for a fade ("linear" = the plain libobs fade).
	// D391 (proposed), each over ms (0 = the switch cuts), libobs obs-transitions:
	//   slide     (slide_transition):         direction left|right|up|down
	//   swipe     (swipe_transition):         direction, swipe_in (the new scene swipes in over the old one)
	//   wipe      (wipe_transition, luma):    pattern = a luma image id (data/transitions/luma-wipes.json; the file
	//                                         <id>.png in obs-transitions' luma_wipes), softness 0..1, invert
	//   fadeColor (fade_to_color_transition): color #RRGGBB, point_pct 1..99 (where the scene changes, % of ms)
	// stinger and these four take the canvas's second transition object (st), swapped onto channel 0 like the stinger
	// and released when the type goes back to cut or fade. A type whose libobs transition is missing is refused
	// (UNAVAILABLE) and the canvas keeps what it had.
	struct TransitionSpec {
		std::string type = "cut";
		int64_t ms = 0;
		const json::Value *file = nullptr; // stinger
		int64_t point_ms = 0;              // stinger
		bool audio = true;                 // stinger
		std::string easing = "linear";     // fade
		std::string direction;             // slide, swipe
		bool swipe_in = false;             // swipe
		std::string pattern;               // wipe
		double softness = 0.03;            // wipe (OBS default)
		bool invert = false;               // wipe
		std::string color;                 // fadeColor
		int64_t point_pct = 50;            // fadeColor (OBS default)
	};
	json::Value transition_set(const std::string &canvas, const TransitionSpec &t);
	json::Value transitions() const;
	// transitions.types (D391 proposed): every type transitions.set takes, its fields, and whether this host can run it
	// now (its libobs transition is registered). { types: [{type, fields: [...], available}], wipes: [ids] } with the
	// luma image ids whose file is present.
	static json::Value transition_types();
	// transitions.forceComplete (D327 TR1): a running fade or stinger on that canvas jumps to its end scene now.
	// { canvas, completed } (completed false when nothing was running).
	json::Value transition_force_complete(const std::string &canvas);

	json::Value layers_list(const std::string &scene, const std::string &canvas) const;
	json::Value layer_add(const std::string &scene, const std::string &canvas, const json::Value &layer, int64_t index);
	json::Value layer_remove(const std::string &scene, const std::string &canvas, const std::string &layer);
	// Project v1 (D240): builds layer `layer` of scene `scene` from `doc` (the project after the change, as the UI server
	// saves it) with the options of the last load, on every canvas it has a placement on, sharing an existing source
	// (duplicates, the other canvas). The doc becomes the host's model document.
	json::Value layer_add_model(const json::Value &doc, const std::string &scene, const std::string &layer);
	json::Value layer_order_model(const json::Value &doc, const std::string &scene);
	// Mixer "Add audio" (D393 proposed): builds project audio source `audio` of `doc` (the project after the change)
	// like project.load does: a device source on the next free output channel, or the binding of a built layer's
	// source (volume, mute, tracks, monitoring). Refused with a plain sentence when the plan cannot build it; refused
	// when it is in the mixer already. The doc becomes the host's model document.
	json::Value audio_add_model(const json::Value &doc, const std::string &audio);
	// Mixer remove (D393 proposed): `doc` no longer has audio source `audio`. A device source leaves its channel and is
	// released (parked instead when the watchdog has it as missing: its destroy may never return); a layer's source is
	// unbound (no tracks, no monitoring) and stays metered. removed false when the host had not built it.
	json::Value audio_remove_model(const json::Value &doc, const std::string &audio);
	json::Value layer_set_visible(const std::string &scene, const std::string &canvas, const std::string &layer, bool visible);
	// Effect editor (D260): replaces a layer's effects on every canvas (project v1 layers only).
	json::Value layer_set_effects(const std::string &scene, const std::string &layer, const json::Value &effects);
	json::Value layer_set_placement(const std::string &scene, const std::string &canvas, const std::string &layer,
					const json::Value &patch);
	json::Value layer_move(const std::string &scene, const std::string &canvas, const std::string &layer, int64_t index,
			       const std::string &dir);
	// Preview mouse editing (preview_edit.h): the visible layers of the canvas's active scene that have a project v1
	// placement, topmost first, as rectangles. false: no such canvas / scene, or not a project v1 model.
	bool preview_items(const std::string &canvas, std::string &scene, std::vector<pedit::Item> &top_first) const;

	// Panic (panic.h): hides every visible browser layer (overlays and effect pages) on every scene of every canvas
	// and returns what it hid; restore_layers shows those again (skipping layers that no longer exist or were shown
	// meanwhile). The overlay relay is not a scene item and is left alone.
	struct LayerRef {
		std::string canvas, scene, layer;
	};
	std::vector<LayerRef> hide_browser_layers();
	size_t restore_layers(const std::vector<LayerRef> &refs);

	// Latest meter peak (dBFS; -inf when silent or muted) of the source bound to project audio source `audio_id`
	// (a device global or a layer's audio). Never blocks: 1 found, 0 no such source, -1 the model is busy (another
	// thread holds it, e.g. project.load). For the cam-pop mic feed (overlay.h); any thread.
	int audio_peak_db(const std::string &audio_id, float &peak_db) const;
	// frames.grab (frames.h): a strong reference to the shared source behind layer `layer_id` (first match in any
	// scene on any canvas; a duplicate resolves to its target's source; a layer's effects wrapper is never returned).
	// The caller releases it. type = the layer type. Throws rpc::Error: no such layer, layer has no source / video.
	obs_source_t *layer_source_ref(const std::string &layer_id, std::string &type) const;
	// Audio health (D297 proposed; audio_health.h). no_data_ms: a source with no audio packet for this long is
	// "missing" (0 = not configured: receiving is reported as null). recreate: the watchdog replaces a missing device
	// audio source (a fresh libobs source, same type/settings/volume/mute/tracks/monitoring/sync offset/balance/flags/
	// filters, same output channel), at most max_recreates attempts per source per load, at most one attempt per
	// no_data_ms; the replaced one is parked, never destroyed while running. max_parked bounds the parked sources per
	// process (they survive project reloads); at the limit the watchdog stops restarting and says to restart Ujwalam.
	// A restarted source counts as recovered only once the new one delivers audio packets.
	struct AudioHealthCfg {
		uint32_t no_data_ms = 0;
		uint32_t max_recreates = 0;
		uint32_t max_parked = 0;
		bool recreate = false;
	};
	void set_audio_health(const AudioHealthCfg &c);
	// The pre-stream / pre-recording readiness view: every project device audio source with state ok | starting |
	// missing | inactive | unknown, receiving, lastDataMs, recreates; warnings ("Game audio missing"); recent events.
	json::Value audio_health() const;
	void audio_watch_tick(); // one watchdog pass (the audio_health.h ticker thread calls it)
	// --test-hooks only (methods.cpp): a project-style device audio global on the next output channel backed by the
	// host's fake source type ujw_test_audio (audio_health.h); stall stops / restarts its packets (simulated dead device).
	json::Value test_audio_add(const std::string &id, const std::string &name);
	json::Value test_audio_stall(const std::string &id, bool stall);
	// --test-hooks: that test global's destroy will never return (audio_health.h hangDestroy; shutdown guard test).
	json::Value test_audio_hang_destroy(const std::string &id);
	// --test-hooks: the source-level settings the watchdog must carry over (sync offset, balance, flags, filters):
	// set them on a test global (any field present) and read them back.
	json::Value test_audio_config(const std::string &id, const json::Value &set);
	// mixer.list: every metered sound, then (2026-11-18, A2) one row per project device sound the host could not build
	// (its device was not connected at load, or never opened): {id: "audio:<id>", audioSource, name, waiting: true,
	// message, active false, no meter}. The studio shows it as "Waiting for <device>".
	json::Value mixer_list() const;
	// mixer.levels (B9, 2026-11-18): the meters only, {busy, levels: [{id, peakDb, magnitudeDb}]} with the ids of
	// mixer.list. Never waits for the model lock (busy true and no levels while a load holds it). peakDb is the highest
	// peak of the last ~300 ms (B8: a short peak between two reads is not lost), so every reader sees it.
	json::Value mixer_levels() const;
	// Runs fn under the model lock only while no source has a monitor (CUE off everywhere, private sources included);
	// returns false without running it otherwise. libobs 32.1.2 frees the monitoring device id in
	// obs_set_audio_monitoring_device while an active WASAPI monitor's reconnect path can read it, and a CUE change
	// tears monitors down at the same time; with no monitor and the lock held (every CUE change takes it) neither can
	// happen. Codex review 2026-11-18, P1.
	bool when_no_monitors(const std::function<void()> &fn);
	json::Value mixer_set_volume(const std::string &id, const double *mul, const double *db);
	json::Value mixer_set_mute(const std::string &id, bool muted);
	json::Value mixer_set_cue(const std::string &id, bool cue);
	// Track routing (D273): the project audio.tracks this source goes to (bit n of its mixers = track n; every output
	// encodes track 1). Project v1 sources with an audio.sources entry only.
	json::Value mixer_set_tracks(const std::string &id, const std::vector<std::string> &tracks);

	// Canvas video for encoders: "H" -> obs_get_video(), "V" -> V canvas video. nullptr if absent.
	video_t *canvas_video(const std::string &canvas) const;
	bool canvas_size(const std::string &canvas, uint32_t &w, uint32_t &h, uint32_t &fps) const;
	json::Value canvases_json() const;

	static std::string norm_canvas(const std::string &c); // "h" -> "H"; "" if not H/V

	// ---- device hot-plug (D329; device_watch.h) ----
	// The device list every project build and the watcher use: the --test-hooks fake list when one is set
	// (devices.testSet), else devices::enumerate() with --allow-devices, else nothing (has = false; D38).
	devices::List list_devices(bool &has) const;
	// --test-hooks: replaces the device list with `l` (nullptr: back to the real one). Capture layers are then built on
	// ujw_test_capture and allowed without --allow-devices.
	void set_test_devices(const devices::List *l);
	bool test_devices() const;
	// After a device list change: true if some bound capture source's device is no longer listed (the watcher then
	// lists again after a short pause before it acts, so a glitch in one listing never unbinds a working source).
	bool device_loss_pending(const devices::List &l);
	// Reconciles every capture source with the list (devices::reconcile): binds waiting sources whose device arrived
	// (obs_source_update with the new video_device_id; only that source re-activates), marks sources whose device left
	// as waiting (their last frame is cleared; the device graph and every encoder and output are left alone). Bumps the
	// device seq. `removed`: interface paths the watcher saw leave since the last pass (a bound source whose device is
	// one of them is reactivated even when it is listed again, devices.h reconcile).
	// Codex review fix: a bind (or a build with a device) is only an attempt. The source is "connecting" until it
	// delivers a frame (its last frame is cleared before each attempt, so a picture means a new frame). Without a
	// frame after kConnectDelaysMs[attempt - 1] the same source is updated again (re-activation), with backoff, at
	// most kConnectAttempts times; then it stays "connecting" with a message until the device is plugged in again.
	// Encoders and outputs are never touched.
	// Returns {seq, changes:[{layer, device, action: bound | lost | retry, matchedBy?, attempt?, message?}]}.
	// `event` false (a connect check, no device event): the seq moves only when a source changed state.
	json::Value devices_changed(const devices::List &l, const char *why, const std::vector<std::string> &removed = {},
				    bool event = true);
	// host.status "devices": {seq, listed, waiting:[{layer, device, message}], connecting:[{layer, device, attempt,
	// message?}], connected:{deviceId: bool}} (no listing).
	json::Value devices_status() const;
	// Where connect checks are asked for (the device watcher's check_after; null: none).
	void set_check_scheduler(std::function<void(uint32_t)> f);
	static constexpr uint32_t kConnectAttempts = 5;
	// After the fast attempts a capture source without a picture is still tried, once a minute, for as long as it stays
	// without one (2026-11-18, A3: before, it gave up after about 75 s until the device was plugged in again).
	static constexpr uint32_t kSlowRetryMs = 60000;
	// devices.rescan ("Try again", 2026-11-18): every capture source without a picture is activated again now (its attempts
	// start over); device sounds that failed to open are tried again. Returns {retried}. The caller then runs a device
	// pass (binds what arrived) and rebuild_missing_files.
	json::Value devices_rescan();
	// Image and media layers whose file was missing at load (skipped as unavailable) are built now when their file is
	// there (layer_add_model with the host's model document; then the project order). Copies of them too. Returns the
	// number built. The model document and its saved state are not changed.
	uint32_t rebuild_missing_files();

private:
	struct Meter;
	struct Src { // one libobs source; shared by every item that shows it (H, V, duplicates)
		obs_source_t *src = nullptr;
		std::shared_ptr<Meter> meter;
		std::string owner;    // layer id that owns it
		std::string audio_id; // project audio source id bound to it
		std::string audio_name; // its project name ("Mic", "Game"): the mixer row name
		uint64_t created_ns = 0; // os_gettime_ns at wrap (start-up grace for the audio watchdog)
		// Capture layers (D329): the project device id, the win-dshow id the source was given, and whether it waits for
		// its device (built without one, or the device was unplugged). Guarded by the studio mutex.
		std::string device, bound_id, problem, matched_by;
		bool waiting = false;
		uint32_t binds = 0; // device binds after the build (arrivals)
		// Bound but no frame seen since the last activation attempt (Codex review fix): attempts made, and when the
		// last one was made (os_gettime_ns).
		bool connecting = false;
		uint32_t attempts = 0;
		uint64_t attempt_ns = 0;
		~Src();
	};
	struct Layer {
		std::string id, name, type;
		json::Value settings, transform; // host test format
		json::Value placement;           // project v1
		std::string dup_of;              // project v1 duplicate: target layer id
		bool visible = true;
		std::shared_ptr<Src> src;
		// project v1 layer.effects: the item shows `fx` (a private ujw_effects_wrap over src->src, owned by this
		// layer, effects.h) instead of the shared source; the placement crop is applied by the wrapper.
		std::vector<model::Effect> effects;
		obs_source_t *fx = nullptr;
		obs_sceneitem_t *item = nullptr;
	};
	struct Scene {
		std::string id, name, canvas;
		obs_scene_t *scene = nullptr;
		std::vector<Layer> layers; // bottom to top
	};
	struct Canvas {
		std::string id;
		uint32_t w = 0, h = 0, fps = 0;
		obs_canvas_t *vc = nullptr; // V only; H is the main canvas
		std::string active;
		// Scene transition (D239): channel 0 holds a fade transition whose child is the active scene. type "cut"
		// (default) switches at once; "fade" over ms. The UI server sets it (transitions.set) from the project file
		// while flag `transitions` is on.
		obs_source_t *tr = nullptr; // fade (also used for cuts)
		obs_source_t *st = nullptr; // stinger or a D391 type (slide, swipe, wipe, fadeColor), while the type is one of them
		obs_source_t *routed = nullptr; // the transition on channel 0
		std::string tr_type = "cut";
		uint32_t tr_ms = 0;
		std::string tr_ease = "linear"; // fade easing curve (D327 TR1)
		std::string st_ref; // "base:rel" of the stinger file
		uint32_t st_point = 0;
		bool st_audio = true; // the stinger's own sound in the canvas mix (Meld "audio" switch)
		std::string st_kind;  // libobs id of st
		json::Value st_info;  // D391: the type's own fields as transitions() reports them (object; null for a stinger)
	};
	struct Global { // project v1 audio device source on a main-canvas output channel
		std::shared_ptr<Src> src;
		uint32_t channel = 0;
		uint32_t recreates = 0; // audio watchdog restart attempts so far (failed creates count)
		uint64_t attempt_ns = 0; // os_gettime_ns of the last attempt (one attempt per no_data_ms)
		bool missing = false, gave_up = false;
	};

	Flags flags_;
	mutable std::mutex dev_m_;      // the device list state below (never held while calling into libobs)
	bool test_list_on_ = false;
	devices::List test_list_;
	mutable devices::List last_list_; // newest list seen (a build or a watcher pass); host.status reads it
	mutable bool have_list_ = false;
	std::atomic<uint64_t> dev_seq_{0};
	std::function<void(uint32_t)> check_; // guarded by dev_m_
	// Connect attempts (studio mutex held): counts one more attempt on `s`; with `update`, clears its last frame and
	// re-activates it (obs_source_update with video_device_id = obs_id); without, notes the build-time activation.
	void connect_attempt(Src &s, const std::string &obs_id, bool update);
	// Connect checks (studio mutex held): retries sources that are still without a frame; returns the retries as
	// changes and asks the scheduler for the next check.
	bool connect_checks(json::Value &changes, const char *why); // true: a source got a frame or was retried
	void schedule_connect_check();
	static bool has_frame(const Src &s);
	void note_list(const devices::List &l) const;
	std::vector<std::shared_ptr<Src>> capture_srcs() const;
	const json::Value *model_device(const std::string &id) const;
	// A2 (2026-11-18): project device sounds (microphone, audio-output) that are not built while their device is listed
	// are built now (the audio_add_model build). At most kAudioTries tries per sound while its device stays listed (a
	// device Windows will not open is not hammered); devices_rescan starts over. Studio mutex held.
	static constexpr uint32_t kAudioTries = 3;
	std::map<std::string, uint32_t> audio_tries_;
	// Layers the last load_model skipped as unavailable (rebuild_missing_files looks at their files again).
	std::set<std::string> unbuilt_layers_;
	void bind_waiting_audio(const devices::List &l, json::Value &changes, const char *why);
	// The project device sounds that are not built: {audio id, device id} (studio mutex held).
	std::vector<std::pair<std::string, std::string>> unbuilt_device_audio() const;
	// One mixer row per metered source, in mixer order (project device sounds, then layer sounds with a project entry,
	// then the rest); f(src, id, scene or null, layer or null).
	void each_mixer_src(const std::function<void(const Src &, const std::string &, const Scene *, const Layer *)> &f) const;
	AudioHealthCfg health_;
	std::vector<std::shared_ptr<Src>> parked_; // replaced device audio sources (released in ~Studio only)
	std::vector<json::Value> audio_events_;    // newest last, at most kAudioEvents
	uint64_t audio_seq_ = 0;
	void audio_event(const char *kind, const Global &g, const std::string &text);
	bool recreate_global(Global &g);
	std::string audio_state(const Global &g, uint64_t now, int64_t &last_ms) const;
	bool parked_full() const { return health_.max_parked && parked_.size() >= health_.max_parked; }
	mutable std::recursive_mutex m_;
	std::unique_ptr<ease::Easer> easer_; // created at the first eased fade; reset in teardown (before the transitions go)
	std::vector<Canvas> canvases_;
	std::vector<Scene> scenes_;
	std::vector<Global> globals_;
	std::string format_; // "project-v1" or "ujwalam-host-test"
	json::Value model_doc_;
	LoadOptions last_opts_; // of the last project v1 load (layer_add_model builds with them)
	bool dirty_ = false;
	obs_source_t *relay_ = nullptr; // overlay relay browser source (showing and active while it exists)
	std::string relay_scope_;
	void make_relay(const LoadOptions &o);
	void drop_relay();

	Canvas *canvas(const std::string &id);
	const Canvas *canvas(const std::string &id) const;
	Scene *scene(const std::string &id, const std::string &canvas);
	const Scene *scene(const std::string &id, const std::string &canvas) const;
	std::vector<Scene *> scenes_named(const std::string &id, const std::string &canvas);
	Scene *one_scene(const std::string &id, const std::string &canvas);
	void make_canvases(const std::vector<model::Canvas> &defs, const std::map<std::string, bool> &mix);
	Scene &new_scene(const std::string &id, const std::string &name, const std::string &canvas);
	Scene &make_scene(const json::Value &def);
	Layer make_layer(Scene &s, const json::Value &def);
	obs_source_t *create_source(const Scene &s, const std::string &layer_id, const std::string &type,
				    const json::Value &settings);
	std::shared_ptr<Src> wrap(obs_source_t *src, const std::string &owner);
	std::shared_ptr<Src> make_src(const model::Source &spec, const std::string &layer);
	std::shared_ptr<Src> find_src(const std::string &owner);
	void add_item(Scene &s, Layer &l);
	void apply_transform(const Scene &s, Layer &l);
	void apply_placement(Layer &l);
	void apply_order(Scene &s);
	void destroy_layer(Layer &l);
	void destroy_scene(Scene &s);
	void set_channel(Canvas &c, Scene *s, bool animate = false);
	json::Value load_model(const json::Value &doc, const LoadOptions &o);
	json::Value load_test_format(const json::Value &project, const LoadOptions &o);
	json::Value scene_json(const Scene &s) const;
	json::Value layer_json(const Scene &s, const Layer &l) const;
	std::shared_ptr<Src> find_audio(const std::string &id);
	model::Options model_options(const json::Value &doc, const LoadOptions &o, devices::List &list, bool list_devices) const;
};
