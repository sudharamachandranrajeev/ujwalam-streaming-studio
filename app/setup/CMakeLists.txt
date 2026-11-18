# SPDX-License-Identifier: GPL-3.0-or-later
# Ujwalam-Setup.exe (2026-11-18): install, update, repair, roll back and uninstall for the current user. Win32 only,
# no Qt, no runtime downloads; the package zip sits next to it (src/setup.cpp). Built by app/setup/tools/build.mjs.
cmake_minimum_required(VERSION 3.24)
project(ujwalam-setup LANGUAGES CXX)
enable_language(RC)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static C++ runtime: Setup runs before the Visual C++ runtime check of the installer, so it must not need it.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(ujwalam-setup WIN32 src/setup.cpp res/setup.rc res/setup.manifest)
target_compile_definitions(ujwalam-setup PRIVATE UNICODE _UNICODE)
target_link_libraries(ujwalam-setup PRIVATE bcrypt comctl32 shell32 user32)
if(MSVC)
	target_compile_options(ujwalam-setup PRIVATE /W4 /permissive- /utf-8)
endif()
