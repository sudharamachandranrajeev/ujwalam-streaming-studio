// SPDX-License-Identifier: GPL-3.0-or-later
// Ujwalam-Setup.exe (2026-11-18): install, update, repair, roll back and uninstall Ujwalam for the current user (no
// admin rights). A small window; the work is done by the tested installer, Install-Ujwalam.ps1.
//
// The package is NOT inside this exe: it sits next to it (out/dist: ujwalam-<version>-win64.zip and its .zip.sha256),
// or in the update folder named in <install root>\data\ujwalam.json ("updateFolder"), or is given with --package. An
// exe that carries an archive and unpacks it is the classic shape Defender's machine-learning verdicts flag; this one
// only reads files that are already on disk.
//
// Install / update / repair:
//   1. a new folder <install root>\.setup-<pid>-<random>\ is made (it must not exist yet: never someone else's folder
//      or a link), the zip is copied into it, and the COPY's SHA-256 must match the .zip.sha256 file next to the zip
//      (else nothing happens); the copy is what gets unpacked, so the file checked is the file used (Codex review
//      2026-11-18);
//   2. the copy is unpacked with Windows' own tar.exe into that folder (same disk as the install);
//   3. the unpacked Install-Ujwalam.ps1 must match its line in the unpacked SHA256SUMS.txt; then it runs hidden
//      (CREATE_NO_WINDOW) with -AdoptPackage: it checks every file against SHA256SUMS.txt again, backs up the
//      settings, moves the folder into place and switches current.txt. A step that fails after the switch (shortcuts,
//      hand-over) is reported by the installer itself and leaves the new version installed and working;
//   4. the .setup folder is removed.
// Trust: the package is the user's own build from their own build folder; it is not signed (signing is P17, D3). Anyone
// who can write that folder can already change Ujwalam itself, so the checksums catch damage, not an attacker.
// Roll back: Install-Ujwalam.ps1 -Rollback of the installed version. Uninstall: a copy of Install-Ujwalam.ps1 in the
// temp folder runs -Uninstall; the data folder is kept unless the user ticks "Also delete my data".
//
// Usage: Ujwalam-Setup.exe [--install | --update | --repair | --rollback | --uninstall] [--package <zip>]
//                          [--install-root <dir>] [--quiet] [--delete-data] [--next-start] [--no-shortcuts]
//                          [--start-menu <dir>] [--desktop <dir>]
//   no action: the window offers what fits (Install, Update to, Repair, Roll back, Uninstall).
//   --quiet: no window; the installer's lines go to this process's stdout (when it has one); the exit code is the
//            installer's, or 20 no package, 21 checksum problem, 22 unpack failed, 23 bad arguments, 24 nothing
//            installed, 26 the package is not newer (--update).
//   --next-start: a running Ujwalam is not handed the new version (the studio's Update button).
// Nothing stays running: the exe ends when its window closes or (quiet) when the work is done.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>

#include <algorithm>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace {

// ---- small helpers ------------------------------------------------------------------------------------------------

std::wstring env(const wchar_t *name)
{
	wchar_t buf[32768];
	const DWORD n = GetEnvironmentVariableW(name, buf, 32768);
	return n > 0 && n < 32768 ? std::wstring(buf, n) : std::wstring();
}

std::wstring dirOf(const std::wstring &p)
{
	const size_t cut = p.find_last_of(L"\\/");
	return cut == std::wstring::npos ? std::wstring() : p.substr(0, cut);
}

bool isFile(const std::wstring &p)
{
	const DWORD a = GetFileAttributesW(p.c_str());
	return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

bool isDir(const std::wstring &p)
{
	const DWORD a = GetFileAttributesW(p.c_str());
	return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring fullPath(const std::wstring &p)
{
	wchar_t buf[MAX_PATH * 4];
	const DWORD n = GetFullPathNameW(p.c_str(), MAX_PATH * 4, buf, nullptr);
	std::wstring r = n > 0 && n < MAX_PATH * 4 ? std::wstring(buf, n) : p;
	while (r.size() > 3 && (r.back() == L'\\' || r.back() == L'/'))
		r.pop_back();
	return r;
}

bool startsWithI(const std::wstring &s, const std::wstring &prefix)
{
	return s.size() >= prefix.size() && CompareStringOrdinal(s.c_str(), int(prefix.size()), prefix.c_str(), int(prefix.size()), TRUE) == CSTR_EQUAL;
}

std::string readSmall(const std::wstring &file, size_t cap = 1 << 20)
{
	HANDLE h = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (h == INVALID_HANDLE_VALUE)
		return {};
	std::string s;
	char buf[8192];
	DWORD got = 0;
	while (s.size() < cap && ReadFile(h, buf, sizeof(buf), &got, nullptr) && got > 0)
		s.append(buf, got);
	CloseHandle(h);
	return s;
}

std::wstring widen(const std::string &s, UINT cp = CP_UTF8)
{
	if (s.empty())
		return {};
	const int n = MultiByteToWideChar(cp, 0, s.data(), int(s.size()), nullptr, 0);
	std::wstring w(size_t(n), L'\0');
	MultiByteToWideChar(cp, 0, s.data(), int(s.size()), w.data(), n);
	return w;
}

std::string utf8(const std::wstring &w)
{
	if (w.empty())
		return {};
	const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), nullptr, 0, nullptr, nullptr);
	std::string s(size_t(n), '\0');
	WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), s.data(), n, nullptr, nullptr);
	return s;
}

// One argument quoted for CommandLineToArgvW (and PowerShell's -File): backslashes before a quote are doubled.
std::wstring quote(const std::wstring &a)
{
	std::wstring r = L"\"";
	size_t bs = 0;
	for (wchar_t c : a) {
		if (c == L'\\') {
			bs++;
			continue;
		}
		if (c == L'"') {
			r.append(bs * 2 + 1, L'\\');
			r += L'"';
		} else {
			r.append(bs, L'\\');
			r += c;
		}
		bs = 0;
	}
	r.append(bs * 2, L'\\');
	return r + L"\"";
}

// ---- versions -------------------------------------------------------------------------------------------------------

struct Ver {
	int a = 0, b = 0, c = 0, n = 0;
	bool ok = false;
	std::wstring text;
};

// "X.Y.Z-alpha.N" (the shape Install-Ujwalam.ps1 accepts).
Ver parseVer(const std::wstring &s)
{
	Ver v;
	int parts[4] = {};
	int i = 0;
	size_t p = 0;
	for (; i < 3; i++) {
		size_t q = p;
		while (q < s.size() && iswdigit(s[q]))
			q++;
		if (q == p || q - p > 6)
			return v;
		parts[i] = _wtoi(s.substr(p, q - p).c_str());
		if (i < 2) {
			if (q >= s.size() || s[q] != L'.')
				return v;
			p = q + 1;
		} else
			p = q;
	}
	if (s.compare(p, 7, L"-alpha.") != 0)
		return v;
	p += 7;
	size_t q = p;
	while (q < s.size() && iswdigit(s[q]))
		q++;
	if (q == p || q != s.size() || q - p > 6)
		return v;
	parts[3] = _wtoi(s.substr(p).c_str());
	v.a = parts[0];
	v.b = parts[1];
	v.c = parts[2];
	v.n = parts[3];
	v.ok = true;
	v.text = s;
	return v;
}

int cmpVer(const Ver &x, const Ver &y)
{
	const int xa[4] = {x.a, x.b, x.c, x.n}, ya[4] = {y.a, y.b, y.c, y.n};
	for (int i = 0; i < 4; i++)
		if (xa[i] != ya[i])
			return xa[i] < ya[i] ? -1 : 1;
	return 0;
}

// current.txt / previous.txt: the first line, when it is a version.
Ver readPointer(const std::wstring &file)
{
	std::string s = readSmall(file, 256);
	const size_t cut = s.find_first_of("\r\n");
	if (cut != std::string::npos)
		s.resize(cut);
	while (!s.empty() && s.back() == ' ')
		s.pop_back();
	return parseVer(widen(s));
}

struct Pkg {
	std::wstring zip;
	Ver ver;
};

// The newest ujwalam-<version>-win64.zip in dir (by version, never by file date).
Pkg newestPackage(const std::wstring &dir)
{
	Pkg best;
	if (dir.empty())
		return best;
	WIN32_FIND_DATAW fd;
	HANDLE h = FindFirstFileW((dir + L"\\ujwalam-*-win64.zip").c_str(), &fd);
	if (h == INVALID_HANDLE_VALUE)
		return best;
	do {
		if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
			continue;
		std::wstring name = fd.cFileName;
		const std::wstring pre = L"ujwalam-", suf = L"-win64.zip";
		if (name.size() <= pre.size() + suf.size())
			continue;
		const Ver v = parseVer(name.substr(pre.size(), name.size() - pre.size() - suf.size()));
		if (!v.ok)
			continue;
		if (!best.ver.ok || cmpVer(v, best.ver) > 0) {
			best.zip = dir + L"\\" + name;
			best.ver = v;
		}
	} while (FindNextFileW(h, &fd));
	FindClose(h);
	return best;
}

// The string value of a top-level key in a small JSON file (data\ujwalam.json "updateFolder"); empty when absent.
std::wstring jsonString(const std::string &text, const std::string &key)
{
	const std::string k = "\"" + key + "\"";
	size_t p = text.find(k);
	if (p == std::string::npos)
		return {};
	p += k.size();
	while (p < text.size() && (text[p] == ' ' || text[p] == '\t' || text[p] == '\r' || text[p] == '\n'))
		p++;
	if (p >= text.size() || text[p] != ':')
		return {};
	p++;
	while (p < text.size() && (text[p] == ' ' || text[p] == '\t' || text[p] == '\r' || text[p] == '\n'))
		p++;
	if (p >= text.size() || text[p] != '"')
		return {};
	p++;
	std::wstring out;
	std::string run;
	auto flush = [&] {
		out += widen(run);
		run.clear();
	};
	while (p < text.size() && text[p] != '"') {
		if (text[p] != '\\') {
			run += text[p++];
			continue;
		}
		flush();
		if (++p >= text.size())
			return {};
		const char e = text[p++];
		if (e == 'u' && p + 4 <= text.size()) {
			out += wchar_t(std::stoi(text.substr(p, 4), nullptr, 16));
			p += 4;
		} else if (e == 'n')
			out += L'\n';
		else if (e == 't')
			out += L'\t';
		else if (e == 'r')
			out += L'\r';
		else if (e == 'b' || e == 'f')
			continue;
		else
			out += wchar_t(e);
	}
	flush();
	return out;
}

// ---- hashing ------------------------------------------------------------------------------------------------------

bool sha256File(const std::wstring &file, std::string &hex)
{
	BCRYPT_ALG_HANDLE alg = nullptr;
	BCRYPT_HASH_HANDLE hash = nullptr;
	if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0)
		return false;
	bool ok = BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0;
	HANDLE h = ok ? CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr) : INVALID_HANDLE_VALUE;
	ok = ok && h != INVALID_HANDLE_VALUE;
	std::vector<unsigned char> buf(1 << 20);
	DWORD got = 0;
	while (ok && ReadFile(h, buf.data(), DWORD(buf.size()), &got, nullptr) && got > 0)
		ok = BCryptHashData(hash, buf.data(), got, 0) == 0;
	unsigned char digest[32] = {};
	ok = ok && BCryptFinishHash(hash, digest, 32, 0) == 0;
	if (h != INVALID_HANDLE_VALUE)
		CloseHandle(h);
	if (hash)
		BCryptDestroyHash(hash);
	BCryptCloseAlgorithmProvider(alg, 0);
	if (!ok)
		return false;
	static const char *hx = "0123456789abcdef";
	hex.clear();
	for (unsigned char b : digest) {
		hex += hx[b >> 4];
		hex += hx[b & 15];
	}
	return true;
}

// ---- files --------------------------------------------------------------------------------------------------------

bool isReparse(const std::wstring &p)
{
	const DWORD a = GetFileAttributesW(p.c_str());
	return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_REPARSE_POINT);
}

// Deletes a folder this program made (the .setup unpack folder, the temp copy of the installer). Never follows a link:
// a link (junction, symlink) at the top or anywhere inside is removed as a link, never walked into.
void removeTree(const std::wstring &dir)
{
	if (isReparse(dir)) {
		RemoveDirectoryW(dir.c_str());
		return;
	}
	WIN32_FIND_DATAW fd;
	HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &fd);
	if (h != INVALID_HANDLE_VALUE) {
		do {
			const std::wstring n = fd.cFileName;
			if (n == L"." || n == L"..")
				continue;
			const std::wstring p = dir + L"\\" + n;
			if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
				removeTree(p);
			else {
				SetFileAttributesW(p.c_str(), FILE_ATTRIBUTE_NORMAL);
				if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
					RemoveDirectoryW(p.c_str());
				else
					DeleteFileW(p.c_str());
			}
		} while (FindNextFileW(h, &fd));
		FindClose(h);
	}
	RemoveDirectoryW(dir.c_str());
}

// Makes a new folder <parent>\<prefix><pid>-<random> that did not exist before (CreateDirectory fails on an existing
// name, a link included), so the folder is this program's own. Empty on failure.
std::wstring makePrivateDir(const std::wstring &parent, const std::wstring &prefix)
{
	for (int i = 0; i < 8; i++) {
		unsigned char r[8] = {};
		if (BCryptGenRandom(nullptr, r, sizeof(r), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
			return std::wstring();
		std::wstring hex;
		static const wchar_t *hx = L"0123456789abcdef";
		for (unsigned char b : r) {
			hex += hx[b >> 4];
			hex += hx[b & 15];
		}
		const std::wstring d = parent + L"\\" + prefix + std::to_wstring(GetCurrentProcessId()) + L"-" + hex;
		if (CreateDirectoryW(d.c_str(), nullptr))
			return isReparse(d) ? std::wstring() : d;
		if (GetLastError() != ERROR_ALREADY_EXISTS)
			return std::wstring();
	}
	return std::wstring();
}

// The SHA-256 a SHA256SUMS.txt lists for one file (lines "<64 hex>  <path>"); empty when it is not listed.
std::string listedSum(const std::string &sums, const std::string &rel)
{
	size_t at = 0;
	while (at < sums.size()) {
		size_t nl = sums.find('\n', at);
		if (nl == std::string::npos)
			nl = sums.size();
		std::string l = sums.substr(at, nl - at);
		at = nl + 1;
		while (!l.empty() && (l.back() == '\r' || l.back() == ' '))
			l.pop_back();
		if (l.size() == 66 + rel.size() && l.compare(64, 2, "  ") == 0 && l.compare(66, std::string::npos, rel) == 0 &&
		    l.find_first_not_of("0123456789abcdef") >= 64)
			return l.substr(0, 64);
	}
	return std::string();
}

// ---- running a hidden program ---------------------------------------------------------------------------------------

// Runs cmd with no window (CREATE_NO_WINDOW), stdin NUL, stdout and stderr to a pipe read line by line.
DWORD runCapture(const std::wstring &cmd, const std::wstring &cwd, const std::function<void(const std::wstring &)> &line)
{
	SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
	HANDLE rd = nullptr, wr = nullptr;
	if (!CreatePipe(&rd, &wr, &sa, 0))
		return 1000;
	SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
	HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
	STARTUPINFOW si{};
	si.cb = sizeof(si);
	si.dwFlags = STARTF_USESTDHANDLES;
	si.hStdInput = nul;
	si.hStdOutput = wr;
	si.hStdError = wr;
	PROCESS_INFORMATION pi{};
	std::wstring c = cmd;
	const BOOL ok = CreateProcessW(nullptr, c.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
	CloseHandle(wr);
	if (nul != INVALID_HANDLE_VALUE)
		CloseHandle(nul);
	if (!ok) {
		CloseHandle(rd);
		line(L"could not start: " + cmd + L" (error " + std::to_wstring(GetLastError()) + L")");
		return 1001;
	}
	CloseHandle(pi.hThread);
	// Windows PowerShell writes to a pipe in the console's OEM code page.
	const UINT cp = GetOEMCP();
	std::string pending;
	char buf[4096];
	DWORD got = 0;
	while (ReadFile(rd, buf, sizeof(buf), &got, nullptr) && got > 0) {
		pending.append(buf, got);
		size_t nl;
		while ((nl = pending.find('\n')) != std::string::npos) {
			std::string l = pending.substr(0, nl);
			pending.erase(0, nl + 1);
			while (!l.empty() && (l.back() == '\r' || l.back() == ' '))
				l.pop_back();
			if (!l.empty())
				line(widen(l, cp));
		}
	}
	if (!pending.empty())
		line(widen(pending, cp));
	CloseHandle(rd);
	WaitForSingleObject(pi.hProcess, INFINITE);
	DWORD code = 1;
	GetExitCodeProcess(pi.hProcess, &code);
	CloseHandle(pi.hProcess);
	return code;
}

std::wstring system32()
{
	wchar_t buf[MAX_PATH];
	const UINT n = GetSystemDirectoryW(buf, MAX_PATH);
	return std::wstring(buf, n);
}

std::wstring powershellExe() { return system32() + L"\\WindowsPowerShell\\v1.0\\powershell.exe"; }

// ---- state ----------------------------------------------------------------------------------------------------------

struct Opts {
	std::wstring action; // install, update, repair, rollback, uninstall, or empty (the window offers)
	std::wstring package, root, startMenu, desktop;
	bool quiet = false, deleteData = false, nextStart = false, noShortcuts = false, confirmed = false;
	DWORD waitPid = 0;
};

struct State {
	std::wstring self, selfDir, root;
	Ver cur, prev;
	Pkg pkg;
	std::wstring updateFolder;
};

Opts g_opts;
State g_state;
HWND g_wnd = nullptr;
bool g_busy = false;
int g_exit = 0; // window mode: the exit code of the last action (the process returns it)

void refreshState()
{
	State &s = g_state;
	s.cur = readPointer(s.root + L"\\current.txt");
	s.prev = readPointer(s.root + L"\\previous.txt");
	if (s.prev.ok && !isDir(s.root + L"\\" + s.prev.text))
		s.prev = Ver{};
	// The data root as the launcher and the installer resolve it: UJWALAM_DATA_ROOT, else <install root>\data.
	const std::wstring dataRoot = env(L"UJWALAM_DATA_ROOT").empty() ? s.root + L"\\data" : fullPath(env(L"UJWALAM_DATA_ROOT"));
	s.updateFolder = jsonString(readSmall(dataRoot + L"\\ujwalam.json"), "updateFolder");
	if (!s.updateFolder.empty() && s.updateFolder.find(L':') == std::wstring::npos && s.updateFolder.rfind(L"\\\\", 0) != 0)
		s.updateFolder = dataRoot + L"\\" + s.updateFolder; // relative to the data root, like the launcher
	s.pkg = Pkg{};
	if (!g_opts.package.empty()) {
		const std::wstring zip = fullPath(g_opts.package);
		const std::wstring name = zip.substr(dirOf(zip).size() + 1);
		const std::wstring pre = L"ujwalam-", suf = L"-win64.zip";
		if (name.size() > pre.size() + suf.size() && startsWithI(name, pre))
			s.pkg.ver = parseVer(name.substr(pre.size(), name.size() - pre.size() - suf.size()));
		if (s.pkg.ver.ok)
			s.pkg.zip = zip;
		return;
	}
	s.pkg = newestPackage(s.selfDir);
	if (!s.pkg.ver.ok && !s.updateFolder.empty())
		s.pkg = newestPackage(fullPath(s.updateFolder));
}

// ---- output ---------------------------------------------------------------------------------------------------------

constexpr UINT WM_APP_LINE = WM_APP + 1;
constexpr UINT WM_APP_STEP = WM_APP + 2;
constexpr UINT WM_APP_DONE = WM_APP + 3;

void post(UINT msg, const std::wstring &text)
{
	if (g_opts.quiet || !g_wnd) {
		HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
		if (out && out != INVALID_HANDLE_VALUE) {
			const std::string s = utf8((msg == WM_APP_STEP ? L"[setup] " : L"") + text + L"\r\n");
			DWORD w = 0;
			WriteFile(out, s.data(), DWORD(s.size()), &w, nullptr);
		}
		return;
	}
	PostMessageW(g_wnd, msg, 0, reinterpret_cast<LPARAM>(new std::wstring(text)));
}

void say(const std::wstring &t)
{
	// The installer's lines start with "[install] "; the window shows them without it.
	post(WM_APP_LINE, startsWithI(t, L"[install] ") ? t.substr(10) : t);
}

void step(const std::wstring &t) { post(WM_APP_STEP, t); }

// ---- the work -----------------------------------------------------------------------------------------------------

DWORD runInstaller(const std::wstring &script, const std::wstring &args)
{
	const std::wstring cmd = quote(powershellExe()) + L" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + quote(script) + L" -InstallRoot " +
				 quote(g_state.root) + args;
	return runCapture(cmd, env(L"TEMP"), say);
}

std::wstring shortcutArgs()
{
	std::wstring a;
	if (g_opts.noShortcuts)
		a += L" -NoShortcuts";
	if (!g_opts.startMenu.empty())
		a += L" -StartMenuDir " + quote(fullPath(g_opts.startMenu));
	if (!g_opts.desktop.empty())
		a += L" -DesktopDir " + quote(fullPath(g_opts.desktop));
	return a;
}

int doInstall()
{
	const State &s = g_state;
	if (!s.pkg.ver.ok) {
		say(L"No Ujwalam package (ujwalam-<version>-win64.zip) was found next to this program" +
		    std::wstring(s.updateFolder.empty() ? L"." : L" or in the update folder " + s.updateFolder + L"."));
		return 20;
	}
	const bool repair = s.cur.ok && cmpVer(s.cur, s.pkg.ver) == 0;
	step(L"Checking the package " + s.pkg.ver.text);
	std::string want = readSmall(s.pkg.zip + L".sha256", 4096);
	want = want.substr(0, std::min<size_t>(64, want.size()));
	std::transform(want.begin(), want.end(), want.begin(), [](char c) { return char(c >= 'A' && c <= 'F' ? c + 32 : c); });
	if (want.size() != 64 || want.find_first_not_of("0123456789abcdef") != std::string::npos) {
		say(L"The package has no checksum file (" + s.pkg.zip + L".sha256); build it again with npm run package:alpha. Nothing was changed.");
		return 21;
	}
	SHCreateDirectoryExW(nullptr, s.root.c_str(), nullptr);
	const std::wstring staging = makePrivateDir(s.root, L".setup-");
	if (staging.empty()) {
		say(L"Could not make a work folder in " + s.root + L" (error " + std::to_wstring(GetLastError()) + L"). Nothing was changed.");
		return 22;
	}
	// The copy is checked and the copy is unpacked: the file checked is the file used.
	const std::wstring zip = staging + L"\\package.zip";
	std::string have;
	if (!CopyFileW(s.pkg.zip.c_str(), zip.c_str(), TRUE) || !sha256File(zip, have) || have != want) {
		say(L"The package does not match its checksum file (it is damaged or was changed); build it again. Nothing was changed.");
		removeTree(staging);
		return 21;
	}
	say(L"package checksum ok (SHA-256 " + widen(have.substr(0, 16)) + L"...)");

	step(L"Unpacking " + s.pkg.ver.text);
	DWORD code = runCapture(quote(system32() + L"\\tar.exe") + L" -xf " + quote(zip) + L" -C " + quote(staging), staging, say);
	const std::wstring pkgDir = staging + L"\\ujwalam-" + s.pkg.ver.text + L"-win64";
	const std::wstring script = pkgDir + L"\\Install-Ujwalam.ps1";
	if (code != 0 || !isFile(script)) {
		say(L"The package could not be unpacked (tar exit " + std::to_wstring(code) + L"). Nothing was changed.");
		removeTree(staging);
		return 22;
	}
	// The installer script runs only when it matches its line in the package's SHA256SUMS.txt (the script then checks
	// every other file itself).
	const std::string listed = listedSum(readSmall(pkgDir + L"\\SHA256SUMS.txt", 16u << 20), "Install-Ujwalam.ps1");
	std::string scriptSum;
	if (listed.empty() || !sha256File(script, scriptSum) || scriptSum != listed) {
		say(L"The unpacked installer does not match the package's SHA256SUMS.txt; build the package again. Nothing was changed.");
		removeTree(staging);
		return 21;
	}

	step(std::wstring(repair ? L"Repairing " : s.cur.ok ? L"Updating to " : L"Installing ") + s.pkg.ver.text);
	std::wstring args = L" -AdoptPackage -UpdateFolder " + quote(dirOf(s.pkg.zip)) + shortcutArgs();
	if (repair)
		args += L" -Repair";
	if (g_opts.nextStart)
		args += L" -NoHandOver";
	// The installer finishes the job itself, rolling nothing back from out here: before current.txt changes every
	// failure leaves the old version in place; after it, the new version is installed and a failed extra (a shortcut)
	// is reported, not undone (an outside -Rollback would be refused while the studio that asked for the update runs).
	code = runInstaller(script, args);
	removeTree(staging);
	return int(code);
}

int doRollback()
{
	const State &s = g_state;
	if (!s.cur.ok || !s.prev.ok) {
		say(L"There is no earlier version to go back to.");
		return 24;
	}
	step(L"Going back to " + s.prev.text);
	std::wstring script = s.root + L"\\" + s.cur.text + L"\\Install-Ujwalam.ps1";
	if (!isFile(script))
		script = s.root + L"\\" + s.prev.text + L"\\Install-Ujwalam.ps1";
	return int(runInstaller(script, L" -Rollback"));
}

int doUninstall()
{
	const State &s = g_state;
	std::wstring script;
	for (const Ver &v : {s.cur, s.prev})
		if (v.ok && isFile(s.root + L"\\" + v.text + L"\\Install-Ujwalam.ps1")) {
			script = s.root + L"\\" + v.text + L"\\Install-Ujwalam.ps1";
			break;
		}
	if (script.empty()) {
		say(L"No Ujwalam install was found in " + s.root + L".");
		return 24;
	}
	step(L"Removing Ujwalam");
	// The installer is copied out first: the folder it sits in is removed.
	const std::wstring tmp = makePrivateDir(env(L"TEMP"), L"ujwalam-setup-");
	const std::wstring copy = tmp + L"\\Install-Ujwalam.ps1";
	if (tmp.empty() || !CopyFileW(script.c_str(), copy.c_str(), TRUE)) {
		say(L"Could not copy the installer to " + tmp + L"; nothing was removed.");
		return 1;
	}
	std::wstring args = L" -Uninstall" + shortcutArgs();
	if (g_opts.deleteData)
		args += L" -DeleteData";
	const DWORD code = runInstaller(copy, args);
	removeTree(tmp);
	return int(code);
}

int run(const std::wstring &action)
{
	if (action == L"rollback")
		return doRollback();
	if (action == L"uninstall")
		return doUninstall();
	if (action == L"update" && g_state.cur.ok && g_state.pkg.ver.ok && cmpVer(g_state.pkg.ver, g_state.cur) <= 0) {
		say(L"The package " + g_state.pkg.ver.text + L" is not newer than the installed " + g_state.cur.text + L".");
		return 26;
	}
	if (action == L"repair" && !(g_state.cur.ok && g_state.pkg.ver.ok && cmpVer(g_state.pkg.ver, g_state.cur) == 0)) {
		say(L"Repair needs the package of the installed version" + std::wstring(g_state.cur.ok ? L" (" + g_state.cur.text + L")" : L"") + L".");
		return 23;
	}
	return doInstall();
}

bool selfUnderRoot() { return startsWithI(fullPath(g_state.selfDir) + L"\\", g_state.root + L"\\"); }

// ---- the window -------------------------------------------------------------------------------------------------------

enum { IDC_TITLE = 100, IDC_INFO, IDC_MAIN, IDC_ROLLBACK, IDC_UNINSTALL, IDC_CLOSE, IDC_STEP, IDC_PROGRESS, IDC_LOG };
HFONT g_font = nullptr, g_bold = nullptr;
int g_dpi = 96;
int S(int v) { return MulDiv(v, g_dpi, 96); }
std::wstring g_mainAction;

void setText(int id, const std::wstring &t) { SetWindowTextW(GetDlgItem(g_wnd, id), t.c_str()); }
void enable(int id, bool on) { EnableWindow(GetDlgItem(g_wnd, id), on && !g_busy); }

void updateUi()
{
	const State &s = g_state;
	std::wstring info = L"Installed: " + (s.cur.ok ? s.cur.text : std::wstring(L"none")) + L"   (in " + s.root + L")\r\n";
	info += L"Package: " + (s.pkg.ver.ok ? s.pkg.ver.text + L"   (" + dirOf(s.pkg.zip) + L")" : std::wstring(L"none found"));
	setText(IDC_INFO, info);
	std::wstring main;
	g_mainAction.clear();
	if (!s.pkg.ver.ok)
		main = L"No package found";
	else if (!s.cur.ok) {
		main = L"Install " + s.pkg.ver.text;
		g_mainAction = L"install";
	} else if (cmpVer(s.pkg.ver, s.cur) > 0) {
		main = L"Update to " + s.pkg.ver.text;
		g_mainAction = L"update";
	} else if (cmpVer(s.pkg.ver, s.cur) == 0) {
		main = L"Repair " + s.pkg.ver.text;
		g_mainAction = L"repair";
	} else
		main = L"Installed version is newer";
	setText(IDC_MAIN, main);
	enable(IDC_MAIN, !g_mainAction.empty());
	setText(IDC_ROLLBACK, s.prev.ok && s.cur.ok ? L"Roll back to " + s.prev.text : std::wstring(L"Roll back"));
	enable(IDC_ROLLBACK, s.prev.ok && s.cur.ok);
	enable(IDC_UNINSTALL, s.cur.ok);
	enable(IDC_CLOSE, true);
}

void startWork(const std::wstring &action)
{
	g_busy = true;
	updateUi();
	HWND bar = GetDlgItem(g_wnd, IDC_PROGRESS);
	ShowWindow(bar, SW_SHOW);
	SendMessageW(bar, PBM_SETMARQUEE, TRUE, 40);
	std::thread([action] {
		const int code = run(action);
		PostMessageW(g_wnd, WM_APP_DONE, WPARAM(code), 0);
	}).detach();
}

// Uninstall: one question, keep-data as the default (the box is not ticked).
bool askUninstall(bool &deleteData)
{
	TASKDIALOGCONFIG c{};
	c.cbSize = sizeof(c);
	c.hwndParent = g_wnd;
	c.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION;
	c.pszWindowTitle = L"Ujwalam setup";
	c.pszMainIcon = TD_INFORMATION_ICON;
	c.pszMainInstruction = L"Remove Ujwalam from this PC?";
	const std::wstring content = L"The program files and shortcuts are removed. Your settings, projects, recordings and clips in " + g_state.root +
				     L"\\data are kept, so installing Ujwalam again picks them up. Stream keys stay in Windows Credential Manager.";
	c.pszContent = content.c_str();
	const TASKDIALOG_BUTTON buttons[] = {{IDOK, L"Remove Ujwalam"}, {IDCANCEL, L"Keep Ujwalam"}};
	c.pButtons = buttons;
	c.cButtons = 2;
	c.nDefaultButton = IDCANCEL;
	c.pszVerificationText = L"Also delete my data (settings, projects, recordings, clips and logs)";
	int button = 0;
	BOOL checked = FALSE;
	if (FAILED(TaskDialogIndirect(&c, &button, nullptr, &checked)) || button != IDOK)
		return false;
	deleteData = checked == TRUE;
	return true;
}

// The program cannot remove itself while it runs from the install folder: a copy in the temp folder does the uninstall.
bool relaunchFromTemp()
{
	const std::wstring tmp = makePrivateDir(env(L"TEMP"), L"ujwalam-uninstall-");
	const std::wstring copy = tmp + L"\\Ujwalam-Setup.exe";
	if (tmp.empty() || !CopyFileW(g_state.self.c_str(), copy.c_str(), TRUE))
		return false;
	std::wstring cmd = quote(copy) + L" --uninstall --confirmed --wait-pid " + std::to_wstring(GetCurrentProcessId()) + L" --install-root " + quote(g_state.root);
	if (g_opts.deleteData)
		cmd += L" --delete-data";
	if (g_opts.noShortcuts)
		cmd += L" --no-shortcuts";
	if (!g_opts.startMenu.empty())
		cmd += L" --start-menu " + quote(fullPath(g_opts.startMenu));
	if (!g_opts.desktop.empty())
		cmd += L" --desktop " + quote(fullPath(g_opts.desktop));
	STARTUPINFOW si{};
	si.cb = sizeof(si);
	PROCESS_INFORMATION pi{};
	if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, tmp.c_str(), &si, &pi))
		return false;
	CloseHandle(pi.hThread);
	CloseHandle(pi.hProcess);
	return true;
}

void appendLog(const std::wstring &t)
{
	HWND log = GetDlgItem(g_wnd, IDC_LOG);
	const int len = GetWindowTextLengthW(log);
	SendMessageW(log, EM_SETSEL, len, len);
	const std::wstring line = (len ? L"\r\n" : L"") + t;
	SendMessageW(log, EM_REPLACESEL, FALSE, reinterpret_cast<LPARAM>(line.c_str()));
}

HWND child(const wchar_t *cls, const wchar_t *text, DWORD style, int x, int y, int w, int h, int id, HFONT font)
{
	HWND c = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, S(x), S(y), S(w), S(h), g_wnd, reinterpret_cast<HMENU>(INT_PTR(id)), nullptr, nullptr);
	SendMessageW(c, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
	return c;
}

LRESULT CALLBACK wndProc(HWND w, UINT msg, WPARAM wp, LPARAM lp)
{
	switch (msg) {
	case WM_CREATE: {
		g_wnd = w;
		child(L"STATIC", L"Ujwalam setup", SS_LEFT, 16, 12, 568, 26, IDC_TITLE, g_bold);
		child(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, 16, 42, 568, 36, IDC_INFO, g_font);
		child(L"BUTTON", L"", BS_DEFPUSHBUTTON | WS_TABSTOP, 16, 86, 196, 30, IDC_MAIN, g_font);
		child(L"BUTTON", L"Roll back", BS_PUSHBUTTON | WS_TABSTOP, 220, 86, 170, 30, IDC_ROLLBACK, g_font);
		child(L"BUTTON", L"Uninstall", BS_PUSHBUTTON | WS_TABSTOP, 398, 86, 92, 30, IDC_UNINSTALL, g_font);
		child(L"BUTTON", L"Close", BS_PUSHBUTTON | WS_TABSTOP, 498, 86, 86, 30, IDC_CLOSE, g_font);
		child(L"STATIC", L"Choose what to do. Your settings and projects are backed up before every change.", SS_LEFT | SS_NOPREFIX, 16, 128, 568, 20, IDC_STEP,
		      g_font);
		HWND bar = child(PROGRESS_CLASSW, L"", PBS_MARQUEE, 16, 152, 568, 10, IDC_PROGRESS, g_font);
		ShowWindow(bar, SW_HIDE);
		HWND log = child(L"EDIT", L"", WS_BORDER | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL, 16, 170, 568, 218, IDC_LOG, g_font);
		SendMessageW(log, EM_SETLIMITTEXT, 1 << 20, 0);
		updateUi();
		if (g_opts.action == L"uninstall" && g_opts.confirmed)
			startWork(L"uninstall");
		else if (!g_opts.action.empty() && g_opts.action != L"uninstall")
			startWork(g_opts.action);
		return 0;
	}
	case WM_COMMAND:
		if (g_busy)
			return 0;
		switch (LOWORD(wp)) {
		case IDC_MAIN:
			if (!g_mainAction.empty())
				startWork(g_mainAction);
			return 0;
		case IDC_ROLLBACK:
			startWork(L"rollback");
			return 0;
		case IDC_UNINSTALL: {
			bool del = false;
			if (!askUninstall(del))
				return 0;
			g_opts.deleteData = del;
			if (selfUnderRoot()) {
				if (relaunchFromTemp()) {
					DestroyWindow(w);
					return 0;
				}
				appendLog(L"Could not start the uninstaller from the temp folder; the setup program itself stays in " + g_state.root + L".");
			}
			startWork(L"uninstall");
			return 0;
		}
		case IDC_CLOSE:
			DestroyWindow(w);
			return 0;
		}
		break;
	case WM_APP_LINE:
	case WM_APP_STEP: {
		std::wstring *t = reinterpret_cast<std::wstring *>(lp);
		if (msg == WM_APP_STEP)
			setText(IDC_STEP, *t + L" ...");
		appendLog(msg == WM_APP_STEP ? L"--- " + *t + L" ---" : *t);
		delete t;
		return 0;
	}
	case WM_APP_DONE: {
		g_busy = false;
		HWND bar = GetDlgItem(w, IDC_PROGRESS);
		SendMessageW(bar, PBM_SETMARQUEE, FALSE, 0);
		ShowWindow(bar, SW_HIDE);
		const int code = int(wp);
		g_exit = code;
		setText(IDC_STEP, code == 0 ? L"Done." : L"Stopped: see the lines below (code " + std::to_wstring(code) + L"). Nothing half-done was left in use.");
		refreshState();
		updateUi();
		return 0;
	}
	case WM_CLOSE:
		if (g_busy) {
			appendLog(L"Please wait: setup is still working.");
			return 0;
		}
		DestroyWindow(w);
		return 0;
	case WM_DESTROY:
		PostQuitMessage(0);
		return 0;
	}
	return DefWindowProcW(w, msg, wp, lp);
}

bool parseArgs(Opts &o)
{
	int argc = 0;
	LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
	if (!argv)
		return false;
	bool ok = true;
	for (int i = 1; i < argc && ok; i++) {
		const std::wstring a = argv[i];
		auto value = [&](std::wstring &dst) {
			if (i + 1 >= argc)
				ok = false;
			else
				dst = argv[++i];
		};
		if (a == L"--install" || a == L"--update" || a == L"--repair" || a == L"--rollback" || a == L"--uninstall") {
			if (!o.action.empty())
				ok = false;
			o.action = a.substr(2);
		} else if (a == L"--package")
			value(o.package);
		else if (a == L"--install-root")
			value(o.root);
		else if (a == L"--start-menu")
			value(o.startMenu);
		else if (a == L"--desktop")
			value(o.desktop);
		else if (a == L"--quiet")
			o.quiet = true;
		else if (a == L"--delete-data")
			o.deleteData = true;
		else if (a == L"--next-start")
			o.nextStart = true;
		else if (a == L"--no-shortcuts")
			o.noShortcuts = true;
		else if (a == L"--confirmed")
			o.confirmed = true;
		else if (a == L"--wait-pid") {
			std::wstring v;
			value(v);
			o.waitPid = DWORD(_wtoi(v.c_str()));
		} else
			ok = false;
	}
	LocalFree(argv);
	if (o.deleteData && o.action != L"uninstall")
		ok = false;
	if (o.quiet && o.action.empty())
		ok = false;
	return ok;
}

} // namespace

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int show)
{
	if (!parseArgs(g_opts)) {
		g_opts.quiet = true;
		post(WM_APP_LINE, L"usage: Ujwalam-Setup.exe [--install|--update|--repair|--rollback|--uninstall] [--package <zip>] [--install-root <dir>] [--quiet] "
				   L"[--delete-data] [--next-start] [--no-shortcuts] [--start-menu <dir>] [--desktop <dir>]");
		return 23;
	}
	if (g_opts.waitPid) {
		HANDLE p = OpenProcess(SYNCHRONIZE, FALSE, g_opts.waitPid);
		if (p) {
			WaitForSingleObject(p, 15000);
			CloseHandle(p);
		}
	}
	wchar_t self[MAX_PATH * 2];
	const DWORD sn = GetModuleFileNameW(nullptr, self, MAX_PATH * 2);
	g_state.self = std::wstring(self, sn);
	g_state.selfDir = dirOf(g_state.self);
	std::wstring root = g_opts.root;
	if (root.empty()) {
		const std::wstring la = env(L"LOCALAPPDATA");
		if (la.empty()) {
			g_opts.quiet = true;
			post(WM_APP_LINE, L"LOCALAPPDATA is not set; pass --install-root");
			return 23;
		}
		root = la + L"\\Ujwalam";
	}
	g_state.root = fullPath(root);
	refreshState();

	if (g_opts.quiet) {
		// Light: below-normal priority (the children inherit it), no window, ends when the work is done.
		SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
		return run(g_opts.action);
	}

	INITCOMMONCONTROLSEX icc{sizeof(icc), ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES};
	InitCommonControlsEx(&icc);
	g_dpi = int(GetDpiForSystem());
	NONCLIENTMETRICSW ncm{};
	ncm.cbSize = sizeof(ncm);
	SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(ncm), &ncm, 0);
	g_font = CreateFontIndirectW(&ncm.lfMessageFont);
	LOGFONTW bold = ncm.lfMessageFont;
	bold.lfWeight = FW_SEMIBOLD;
	bold.lfHeight = bold.lfHeight * 4 / 3;
	g_bold = CreateFontIndirectW(&bold);

	WNDCLASSEXW wc{sizeof(wc)};
	wc.lpfnWndProc = wndProc;
	wc.hInstance = inst;
	wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
	wc.hIconSm = wc.hIcon;
	wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
	wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
	wc.lpszClassName = L"UjwalamSetup";
	RegisterClassExW(&wc);
	const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
	RECT r{0, 0, S(600), S(404)};
	AdjustWindowRect(&r, style, FALSE);
	HWND w = CreateWindowExW(0, wc.lpszClassName, L"Ujwalam setup", style, CW_USEDEFAULT, CW_USEDEFAULT, r.right - r.left, r.bottom - r.top, nullptr, nullptr,
				 inst, nullptr);
	if (!w)
		return 1;
	ShowWindow(w, show);
	UpdateWindow(w);
	MSG m;
	while (GetMessageW(&m, nullptr, 0, 0) > 0) {
		if (IsDialogMessageW(w, &m))
			continue;
		TranslateMessage(&m);
		DispatchMessageW(&m);
	}
	return g_exit;
}
