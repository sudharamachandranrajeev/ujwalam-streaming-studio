// SPDX-License-Identifier: GPL-3.0-or-later
// One taskbar identity for Ujwalam (2026-11-19, docs/evidence/2026-11-19-taskbar-grouping.md).
//
// Windows groups taskbar buttons by AppUserModelID. With none set it derives one from the exe path, so the studio
// (ujwalam-studio.exe in a version folder) got its own button and the pinned shortcut (ujwalam-start.exe) never lit
// up. Every process that owns a visible top-level window sets the same explicit id early in main(), and every app
// shortcut the installer writes carries it (System.AppUserModel.ID).
//
// The id must match:
//   - $AppUserModelId in tools/package/Install-Ujwalam.ps1 (the shortcuts),
//   - kAppUserModelId in app/host/src/main.cpp (the preview windows).
// tests/taskbar-id.test.mjs checks that the three are the same. Ujwalam-Setup.exe is a different tool: no id.
//
// Relaunch (the studio window): pinning the running window pins the launcher, not ujwalam-studio.exe. ujwalam-start.exe
// passes its own path and arguments in UJWALAM_RELAUNCH_EXE and UJWALAM_RELAUNCH_ARGS; without them (dev runs, tests)
// no relaunch properties are set.
#pragma once

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <objbase.h>
#include <propkey.h>
#include <propsys.h>
#include <shellapi.h>
#include <shobjidl.h>

#include <string>

namespace taskbarid {

inline constexpr wchar_t kId[] = L"Ujwalam.Studio";

// SetCurrentProcessExplicitAppUserModelID; call before the first window is created.
inline bool applyProcess() { return SUCCEEDED(SetCurrentProcessExplicitAppUserModelID(kId)); }

// The process's explicit id as Windows reports it, or empty.
inline std::wstring current()
{
	PWSTR p = nullptr;
	std::wstring r;
	if (SUCCEEDED(GetCurrentProcessExplicitAppUserModelID(&p)) && p)
		r = p;
	CoTaskMemFree(p);
	return r;
}

namespace detail {
inline HRESULT setString(IPropertyStore *s, const PROPERTYKEY &k, const std::wstring *v)
{
	PROPVARIANT pv;
	PropVariantInit(&pv);
	if (v) {
		const size_t bytes = (v->size() + 1) * sizeof(wchar_t);
		pv.pwszVal = static_cast<PWSTR>(CoTaskMemAlloc(bytes));
		if (!pv.pwszVal)
			return E_OUTOFMEMORY;
		memcpy(pv.pwszVal, v->c_str(), bytes);
		pv.vt = VT_LPWSTR;
	} // else VT_EMPTY: removes the value
	const HRESULT hr = s->SetValue(k, pv);
	PropVariantClear(&pv);
	return hr;
}
} // namespace detail

// Sets (set = true) or clears (set = false; before the window is destroyed, as Windows asks) the window's id and its
// relaunch command, name and icon. Returns true when every value was written. The id alone is set when the relaunch
// command is empty.
inline bool windowProps(HWND hwnd, bool set, const std::wstring &relaunchCmd, const std::wstring &name, const std::wstring &icon)
{
	if (!hwnd)
		return false;
	IPropertyStore *s = nullptr;
	if (FAILED(SHGetPropertyStoreForWindow(hwnd, IID_PPV_ARGS(&s))) || !s)
		return false;
	const std::wstring id = kId;
	const bool relaunch = set && !relaunchCmd.empty();
	bool ok = true;
	// The relaunch values first, the id last (Windows reads them when the id is set) and cleared in reverse.
	if (relaunch || !set) {
		ok &= SUCCEEDED(detail::setString(s, PKEY_AppUserModel_RelaunchCommand, set ? &relaunchCmd : nullptr));
		ok &= SUCCEEDED(detail::setString(s, PKEY_AppUserModel_RelaunchDisplayNameResource, set ? &name : nullptr));
		ok &= SUCCEEDED(detail::setString(s, PKEY_AppUserModel_RelaunchIconResource, set ? &icon : nullptr));
	}
	ok &= SUCCEEDED(detail::setString(s, PKEY_AppUserModel_ID, set ? &id : nullptr));
	s->Release();
	return ok;
}

// The relaunch command from ujwalam-start.exe ("<exe>" <args>), or empty.
inline std::wstring relaunchCommand(std::wstring *exeOut = nullptr)
{
	wchar_t exe[MAX_PATH * 2];
	const DWORD n = GetEnvironmentVariableW(L"UJWALAM_RELAUNCH_EXE", exe, MAX_PATH * 2);
	if (!n || n >= MAX_PATH * 2)
		return {};
	std::wstring cmd = L"\"" + std::wstring(exe, n) + L"\"";
	wchar_t args[2048];
	const DWORD a = GetEnvironmentVariableW(L"UJWALAM_RELAUNCH_ARGS", args, 2048);
	if (a && a < 2048)
		cmd += L" " + std::wstring(args, a);
	if (exeOut)
		*exeOut = std::wstring(exe, n);
	return cmd;
}

} // namespace taskbarid
#endif
