# Development

Architecture, conventions and testing rules are in [AGENTS.md](../AGENTS.md); the visual system is in [DESIGN.md](../DESIGN.md); releasing is in [releasing.md](releasing.md).

## Build from source

Needs Rust 1.90+ (`rustup`) and the platform's Tauri prerequisites:

- **macOS 13+:** Xcode command-line tools (`xcode-select --install`).
- **Windows 10/11:** Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11).
- **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libdbus-1-dev pkg-config`

```bash
cargo install tauri-cli --version "^2" --locked   # once
cargo tauri dev          # run in development
cargo tauri build        # release build for this platform
```

Installers end up in `src-tauri/target/release/bundle/`. On the first Bluetooth search macOS asks for access; if you declined, allow it under **System Settings → Privacy & Security → Bluetooth**.

## Commands

```bash
cd src-tauri && cargo test                                                    # unit tests
cd src-tauri && cargo clippy --all-targets                                    # lints (keep warning-free)
ZWO_TEST_DIR=~/Downloads/zwo cargo test scan_real_library -- --nocapture       # parse a whole library
node --test scripts/*.test.mjs                                                # UI unit tests
node scripts/check-i18n.mjs                                                   # translations complete (en / de / fr)
node scripts/check-css.mjs                                                    # CSS layers, imports, nesting
node scripts/check-html.mjs                                                   # markup reaches the DOM only through mount()
npx -y -p playwright node scripts/shots/run.mjs                               # retake all website screenshots (site/img)
```

Website screenshots are generated from the real interface with a sample rider and library, never taken by hand; see *Website* in [AGENTS.md](../AGENTS.md).

## Supported ZWO elements

`SteadyState`, `SolidState`, `Warmup`, `Cooldown`, `Ramp`, `IntervalsT`, `FreeRide`, `MaxEffort`, `textevent` (inside elements and at workout level) and the cadence attributes. Ramps follow Zwift's rule: `PowerLow` is the start value and `PowerHigh` the end value.
