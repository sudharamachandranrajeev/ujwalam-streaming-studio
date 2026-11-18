// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: the process-wide objects the RPC methods act on.
#pragma once

#include "audio_health.h"
#include "device_watch.h"
#include "host_config.h"
#include "face.h"
#include "frames.h"
#include "gfx_watch.h"
#include "hotkeys.h"
#include "moments.h"
#include "outputs.h"
#include "overlay.h"
#include "panic.h"
#include "preview.h"
#include "rpc_server.h"
#include "studio.h"

#include <atomic>
#include <map>
#include <memory>
#include <string>
#include <vector>

struct App {
	std::string version = "0.1.0";
	std::string started_at;
	uint64_t start_tick = 0; // GetTickCount64 at start
	std::string data_dir, recordings_dir, discovery_path, log_path;
	std::wstring exe_path;
	bool allow_devices = false, allow_browser = false;
	bool allow_screen = false; // --allow-screen-capture: win-capture, screen and window layers (D390 proposed)
	bool allow_live = false; // --allow-live: real (non-loopback) stream targets (A0)
	bool twitch_bandwidth_test = false; // --twitch-bandwidth-test: twitch sinks in bandwidth-test mode (outputs.h)
	bool test_hooks = false; // --test-hooks: hotkeys.trigger (tests only; never passed by the launchers)
	uint32_t adapter = 0;
	std::string session;      // host start, local time YYYYMMDD-HHMMSS (markers file name)
	std::string config_path;  // --host-config (empty = defaults)
	HostConfig config;

	std::unique_ptr<Studio> studio;
	std::unique_ptr<Outputs> outputs;
	std::unique_ptr<Previews> previews;
	std::unique_ptr<Overlay> overlay; // overlay server child; only with --allow-browser and --overlay-root
	std::unique_ptr<Panic> panic;     // A0 day 2: in-process panic + event-core notification (panic.h)
	std::unique_ptr<Moments> moments; // markers and feedback captures (moments.h)
	std::unique_ptr<Hotkeys> hotkeys; // global hotkeys (hotkeys.h)
	std::unique_ptr<Frames> frames;   // frames.grab readback (frames.h)
	std::unique_ptr<face::Link> face; // face AI link (face.h, D295 proposed); also published through face::get()
	std::unique_ptr<ahealth::Ticker> audio_watch; // audio health watchdog (audio_health.h); null when not configured
	std::unique_ptr<devwatch::Watcher> device_watch; // device hot-plug (device_watch.h, D329); --allow-devices or --test-hooks
	std::unique_ptr<gfxwatch::Watch> gfx_watch; // graphics stall + GPU device-loss report (gfx_watch.h, D374)

	void *shutdown_event = nullptr; // HANDLE; set by host.shutdown or Ctrl+C
	std::atomic<bool> shutting_down{false};
	std::string shutdown_reason;
};

std::map<std::string, rpc::Method> make_methods(App &app);
json::Value host_status_json(App &app); // host.status (methods.cpp); also the feedback moment's stats
// Runs a hotkey's action (panic, feedback, marker); the hotkey thread and hotkeys.trigger call it.
void on_hotkey(App &app, const std::string &name, const char *via);
// One device hot-plug pass (D329): list (fake list with devices.testSet), list again after 1 s if a bound capture
// device looks gone, then reconcile the capture layers. null when devices cannot be listed. Watcher thread or RPC.
json::Value devices_pass(App &app, const char *why, const std::vector<std::string> &removed = {}, bool event = true);
// The audio monitoring output (host config monitoringDevice; --allow-devices only), the headphones CUE plays through.
// Chosen once, at the start, before the studio exists: no libobs source exists then (Codex review round 2, 2026-11-18).
// libobs 32.1.2 obs_set_audio_monitoring_device frees monitoring_device_id without a lock its readers take: a WASAPI
// monitor's reconnect (wasapi-output.c audio_monitor_init_wasapi) and an Audio Output Capture source's self-monitor
// check (obs-source.c obs_source_audio_output_capture_device_changed, also run from that source's "activate" signal
// on the video thread). A released source is destroyed later (obs_source_destroy_defer), so it can still hold a monitor
// after it left the studio's lists. Only "no source exists" excludes them all: the output never changes on a running
// graph.
void apply_monitoring(App &app);
// After a device pass (watcher, Try again): reports only, never switches. When the wanted output was not in use at the
// start and is listed now, monitoring_note() says the change applies on the next studio start. Any thread.
void check_monitoring(App &app);
// "" or the plain sentence above; mixer.list returns it as `headphones`.
std::string monitoring_note();
