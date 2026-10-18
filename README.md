# zwoTrainer

A lightweight, fast indoor-training app for macOS that rides Zwift `.zwo` workouts and turns folders of workouts into training plans. It controls your smart trainer in ERG mode, records every ride as a FIT file and uploads it to Garmin Connect (and from there to Strava) and Intervals.icu.

No video courses, no workout builder, no music, no subscription. You get a clean workout display and your own library.

- **Plans:** every folder is a plan. Start it and ride the workouts in order; skipped and done workouts are tracked and the next one is always suggested.
- **Workouts:** browse and ride any workout freely, with search, length and intensity filters, TSS and favorites.
- **FTP Tests:** Ramp, Ramp Lite, 20-minute, 8-minute and Power Profile tests, plus test workouts from your library. One click applies the new FTP. W/kg and VO2max estimates are included.
- **Riders:** several profiles with their own FTP, zones, plan progress, history, avatar and devices, optionally synced through iCloud Drive, Dropbox or Nextcloud.
- **Devices:** Bluetooth smart trainers (FTMS), power meters, heart-rate straps and Zwift Ride / Click / Play controllers, with virtual shifting for free-ride segments.

Built with **Tauri 2**: a Rust core and a plain HTML/CSS/JS interface, with no Node and no bundler. Light mode uses pure white and dark mode pure black; zone colours follow the classic Zwift / WhatsOnZwift palette.

---

## Contents

1. [Install & build](#install--build)
2. [Getting started](#getting-started)
3. [The top bar](#the-top-bar)
4. [Plans](#plans)
5. [Workouts](#workouts)
6. [FTP Tests](#ftp-tests)
7. [Riding a workout](#riding-a-workout)
8. [Devices](#devices)
9. [Virtual shifting & controllers](#virtual-shifting--controllers)
10. [Ride history, FIT files, Garmin & Strava](#ride-history-fit-files-garmin--strava)
    - [Intervals.icu & COROS](#intervalsicu--coros)
11. [Riders (profiles)](#riders-profiles)
12. [Profile sync](#profile-sync)
13. [Settings reference](#settings-reference)
14. [Zones & intensity](#zones--intensity)
15. [Where your data lives](#where-your-data-lives)
16. [Troubleshooting](#troubleshooting)
17. [For developers](#for-developers)

---

## Install & build

**Requirements:** macOS 11 or later, Rust 1.82+ (`rustup`) and the Xcode command-line tools (`xcode-select --install`).

```bash
cargo install tauri-cli --version "^2" --locked   # once
cd ~/Projects/zwoTrainer
cargo tauri dev          # run in development
cargo tauri build        # release build
```

The release build ends up in `src-tauri/target/release/bundle/macos/zwoTrainer.app`, with a `.dmg` next to it in `bundle/dmg/`. Drag the app into *Applications*.

On the first Bluetooth search macOS asks for Bluetooth access. If you declined, allow it later under **System Settings → Privacy & Security → Bluetooth**.

---

## Getting started

1. **Workouts folder.** zwoTrainer reads `~/Downloads/zwo` by default. Change it under **Settings → App → Workouts folder**. Every sub-folder is a plan; loose `.zwo` files in the root are single workouts.
2. **Your numbers.** Open **Settings → Rider** and enter FTP, max heart rate and weight. Weight is needed for W/kg, VO2max and virtual shifting.
3. **Devices.** Click the **Bluetooth** button in the top bar and connect your trainer, heart-rate strap and (optionally) a Zwift controller. They reconnect automatically next time.
4. **Ride.** Pick a plan and press **Start plan**, or switch to **Workouts** and ride anything. The workout starts as soon as you pedal, or press **Space**.

> No hardware at hand? Each device dialog has **Use simulator**, so you can try every screen.

---

## The top bar

| Left | | Right |
|---|---|---|
| Logo · **Plans / Workouts / FTP Tests** | | **Devices** · **Ride history** · **Settings** · **Rider avatar** |

- **Devices** (Bluetooth icon): three small dots show trainer, heart rate and shifter. Green means connected, amber means connecting, grey means off. Click it for a menu with each device and *Connect / Change*.
- **Ride history** (calendar with a check mark): every ride, with uploads and FIT export.
- **Settings** (gear): rider data, app preferences (including light/dark appearance) and connections.
- **Avatar**: switch, add or edit riders.

During a workout the bar stays the same. The mode switch is replaced by the workout title, its plan and the ERG status, and ride history is unavailable until the ride ends.

---

## Plans

- Every sub-folder of the workouts folder is a plan. Workouts are sorted by file name with natural sort, so `Week01_Day01_…`, `Week01_Day02_…`, `Week02_Day01_…` are grouped by week and day.
- **Start plan** makes it the active plan. The home screen then always shows **Up next** with its profile, duration and TSS.
- **In order.** Only the next workout can be started; later ones are locked.
- **Skip** marks the next workout as skipped and moves on. **Undo skip** brings it back.
- **Done.** Finishing a workout marks it done and offers **Start next now**.
- **Ending early** gives you the choice of **Save as done**, **Count as skipped** or **Discard**.
- **Switching plans** keeps the progress of the old plan, so you can return to it.
- **⋯ menu** on the plan page: *Reset progress…*, *Show in Finder*, *Move plan folder to Trash…*.

---

## Workouts

Browse every workout across all folders and ride anything. Free rides are saved to your history but never change plan progress.

- **Collections** (left): *All workouts*, *★ Favorites*, *Recently ridden*, *Single workouts* and every folder.
- **Search** by title, name or file name.
- **Length filter:** ≤ 30, 30–60, 60–90 or > 90 minutes.
- **Intensity filter:** Z1 Recovery, Z2 Base endurance, Z3 Tempo, Z4 Threshold, Z5 VO2max. Several can be active at once (see [Zones & intensity](#zones--intensity)).
- **Sort** by name, shortest, longest, hardest (TSS), intensity or recently ridden.
- **Each row** shows the workout profile, duration, intensity tag and estimated TSS. Click it for details, or use **Ride**.
- **Favorites:** star ☆ a workout. Favorites can be reordered with ↑ / ↓ inside the *Favorites* collection.
- **Row ⋯ menu:** favorite, *Show in Finder*, *Open its folder*, *Move workout to Trash…*.
- **Folder ⋯ menu** (next to the folder title): *Show in Finder*, *Move folder to Trash…*.

Deleting always goes to the macOS Trash, so it can be restored. Favorites and plan progress that point to deleted files are cleaned up; ride history stays.

---

## FTP Tests

| Test | Protocol | Result |
|---|---|---|
| **Ramp Test** | 5 min at 100 W, then +20 W per minute in ERG until you can't hold it; ends automatically | 75 % of the best 1-minute power |
| **Ramp Test Lite** | the same with +10 W per minute, for beginners and lighter riders | 75 % of the best 1-minute power |
| **20-Minute Test** | Allen & Coggan: warm-up with spin-ups, 5 min all-out, recovery, 20 min all-out | 95 % of the 20-minute average |
| **8-Minute Test** | 2 × 8 min all-out with 10 min recovery (CTS) | 90 % of the better effort |
| **Power Profile Test** | 8 s sprint, then 1, 5 and 20 min maximal efforts | FTP, 5 s / 1 / 5 / 20 min bests, Critical Power and W′ |

- **ALL OUT efforts** are ridden off ERG: the trainer simulates a flat road and you set the power with your gears, or with virtual shifting. A pacing target is still shown.
- **The result** appears as "Your FTP is ~X W". **Use X W as my FTP** applies it and recalculates the zones in watts. Personal bests (5 s, 1, 5, 20 min) are updated automatically.
- **Test history** lists every result with its change against the previous FTP and a small FTP trend chart. An older result can still be applied later.
- **Tests in your library:** test-themed ZWO files (FTP Test, Ramp Test, Critical Power, Best effort, Benchmarking, …) are recognised automatically, including inside plans. Following Zwift's convention, their free-ride blocks are the all-out efforts. Ramp-test files that lack the actual ramp (a known WhatsOnZwift export issue) start the built-in Ramp Test instead.
- **W/kg and VO2max** need your weight. VO2max is estimated from your 8-minute power with the ACSM equation (`10.8 · W/kg + 7` ml/kg/min), or after a ramp test from peak power (Hawley & Noakes, `0.01141 · W + 0.435` L/min).

---

## Riding a workout

**Display:** current power on a gauge (target vs. actual), the segment ring with target and segment times, the upcoming segment, coach messages and the zone-coloured workout chart with your live power, cadence and heart-rate lines. Each line can be switched on or off; the choice is remembered per rider. The workout clock (elapsed and remaining) and all readouts scale up in full screen.

**Starting:** the workout starts after about 2 seconds of pedalling, or press **Space** / ▶.

**Trainer control:**
- **ERG** follows every target second by second, including ramps.
- **Intensity** (‹ › ±1 %, « » ±10 %) scales all targets.
- **Free-ride and all-out segments** release ERG: you ride with your gears, or with virtual gears.

**Auto-pause:** after 3 seconds without power or cadence the workout pauses, and it resumes as soon as you pedal again. You can switch this off under Settings → App.

**Beeps:** a countdown in the last 3 seconds before each change of target (Settings → App).

**Keyboard:**

| Key | Action |
|---|---|
| Space | start / pause |
| ← / → | previous / next segment |
| ↑ / ↓ | intensity ±1 % (with Shift ±10 %) |
| + / − | shift gear (virtual gears); during free-ride segments ↑ / ↓ shift too |
| Esc | end workout |

**Controller buttons** (Zwift Ride / Play / Click):

| Button | Action |
|---|---|
| Shift + / − | free-ride segments: virtual gear; ERG segments: intensity ±1 % |
| ▲ / ▼ | intensity ±1 % |
| ▶ / ◀ | next / previous segment |
| A, Y, Power-up | start / pause |
| Z | switch watts ↔ % FTP |

Every button press shows a short confirmation on screen. The display stays awake during a ride, and App Nap is disabled so ERG keeps updating in the background.

**Finishing:** the summary shows time, average power, NP, average HR, cadence and energy. Below that, the Garmin upload status (or a manual import) and **Save .fit**. In a plan, the next workout is offered.

---

## Devices

| Device | Supported |
|---|---|
| Smart trainer | Bluetooth **FTMS** (Zwift Hub, Wahoo KICKR, Tacx, Elite, Saris, JetBlack, …), with ERG and flat-road simulation |
| Power meter | Bluetooth **Cycling Power**, power only (no ERG) |
| Heart rate | any Bluetooth heart-rate strap or watch broadcasting HR |
| Controllers | **Zwift Ride**, **Zwift Click (v1/v2)**, **Zwift Play** |

- **Pairing:** pair from the **Devices** menu → *Connect*. Devices are remembered per rider and reconnect at launch and after dropouts.
- **One connection only:** close Zwift and other training apps first, because most trainers and controllers accept just one connection.

---

## Virtual shifting & controllers

**Virtual shifting** gives you gears in free-ride segments and all-out efforts, even on a trainer without real shifting.

- **How it works:** a virtual 24-speed drivetrain (ratio range and start gear configurable). Cadence × gear ratio gives a virtual speed, and road physics (rolling resistance and air drag, using your weight) turns that into the watts the trainer holds in ERG. Speed and distance in the FIT file follow the virtual speed.
- **Choice per ride:** the Ready screen asks *Real gears* or *Virtual gears easy / medium / hard*. The default is set under Settings → App → Virtual shifting.
- **Shifting:** with a Zwift controller, the keyboard (`+` / `−`) or the on-screen − / + buttons.

**Controllers:**
- **Zwift Ride:** connect only the **left** controller; it relays the right one's buttons.
- **Zwift Click v2:** unlock it once in the Zwift phone app (connect, wait about 90 s, close Zwift), or it stops after about a minute.
- **Button test:** the Shifter dialog has a live *button test* showing every press and the action it triggers.

---

## Ride history, FIT files, Garmin & Strava

Every finished ride is saved as a **FIT file** with one lap per workout segment, including power, cadence, heart rate, speed/distance, NP, IF and TSS. **Ride history** lists all rides with *Garmin* upload and *FIT* export.

**Garmin Connect** (Settings → Connections):
- **Sign in:** click **Sign in to Garmin**. Garmin's own login page opens in a small window, MFA supported. zwoTrainer stores only the resulting session token for that rider, never your password.
- **Upload mode:** *Off*, *Manual* (a button after each ride and in the history) or *Automatic*.
- **Edge identity:** the uploaded file identifies as a Garmin Edge, so Garmin computes Training Effect and VO2max and counts the ride for challenges.
- **Unofficial interface:** this is the same approach as the Garmin Connect mobile app, not Garmin's official partner API, so it may change. If it fails, the **manual FIT import** fallback saves the file, shows it in Finder and opens Garmin's import page.

**Strava:** zwoTrainer has no direct Strava connection, because since 2026 Strava requires a paid subscription from the owner of an API app. Link Strava to your Garmin account once (Garmin Connect → Settings → Connected Apps → Strava) and every ride uploaded to Garmin Connect goes on to Strava. As a fallback, use **FIT** in the history and drop the file on strava.com/upload.

### Intervals.icu & COROS

Settings → Connections → **More platforms**.

| Platform | How | Set-up |
|---|---|---|
| **Intervals.icu** | **Automatic upload** (official API) | intervals.icu → Settings → *Developer Settings* → create an API key and paste it into zwoTrainer. Upload mode: Off / Manual / Automatic. |
| **COROS** | **Manual import** into the Training Hub | Turn on *Show import button*. After a ride, zwoTrainer saves it as a **ZIP** (Training Hub only accepts ZIPs), shows it in Finder and opens the Training Hub; there choose *Activity List → Import Data*. |

- **After a ride:** the summary lists Garmin, Intervals.icu and COROS with *Upload* or *Import…*; automatic uploads start by themselves.
- **In the ride history:** a ✓ marks where a ride went, and the row's **⋯** menu sends older rides to the others.

Other platforms (Wahoo, TrainingPeaks, Suunto) only accept uploads from approved partner apps, so zwoTrainer doesn't offer them. TrainingPeaks and many others can be linked in Garmin Connect, which then forwards your rides.

---

## Riders (profiles)

**Per rider:**
- avatar (colour and initials or an emoji), FTP, max heart rate, weight, zone limits and power bests
- active plan, done/skipped marks, favorites, ride history and FTP tests
- theme, beeps, auto-pause, virtual-shifting defaults, workouts folder and paired devices
- Garmin sign-in and upload mode

**Managing riders:**
- **Switch** with the avatar in the top bar. With more than one rider, zwoTrainer asks **Who's riding?** at launch.
- **Edit** changes the name, colour (8 presets or any custom colour) and emoji.
- **A new rider** takes over the workouts folder, theme and devices from the current rider; everything else starts from defaults.
- **Deleting a rider** removes their settings, progress, history, stored rides and Garmin sign-in.

---

## Profile sync

Keep riders in sync across Macs through a folder your cloud app already syncs. No accounts or API keys are involved. Set it up under **Settings → Connections → Profile sync**.

| Option | Folder used |
|---|---|
| iCloud Drive | `~/Library/Mobile Documents/com~apple~CloudDocs` |
| Dropbox | `~/Library/CloudStorage/Dropbox…` or `~/Dropbox` |
| Nextcloud | `~/Library/CloudStorage/Nextcloud…` or `~/Nextcloud` (desktop client) |
| Other folder… | any folder another app keeps in sync |

- **Synced:** all riders, including avatar, FTP and zones, weight, plan progress, favorites, ride history, FTP tests and the ride FIT files.
- **Stays on each Mac:** paired devices, the workouts folder, the Garmin FIT folder and the Garmin sign-in.
- **Conflicts:** the newest change to a rider wins. Ride history and FTP tests are merged from both sides. Deleting a rider removes it on all Macs.
- **When it runs:** at launch, a few seconds after every change, when the window gets focus and every 5 minutes, never during a ride. **Sync now** forces a run.
- **First sync on a new Mac:** an untouched default rider is replaced by the riders already in the folder, so you don't get a second "Rider 1".
- **Layout in the cloud folder:** `zwoTrainer/profiles/<id>.json` and `zwoTrainer/activities/<id>/*.fit`.

---

## Settings reference

| Tab | Setting |
|---|---|
| **Rider** | FTP, max heart rate, weight, personal bests (5 s / 1 / 5 / 20 min), zone limits (upper limit of Z1–Z4 in % FTP) |
| **App** | Appearance (Match system / Light / Dark), countdown beeps, auto-pause, workouts folder (*Change… / Rescan*), virtual shifting (default, difficulty, gear-ratio range, start gear), paired devices overview |
| **Connections** | Profile sync, Garmin Connect (sign in, upload mode, manual FIT import folder), Strava note, more platforms (Intervals.icu API key and upload mode, COROS import button) |

---

## Zones & intensity

| Zone | Default upper limit | Colour |
|---|---|---|
| Z1 Recovery | ≤ 55 % FTP | grey `#7F7F7F` |
| Z2 Base endurance | ≤ 75 % | blue `#338CFF` |
| Z3 Tempo | ≤ 90 % | green `#59BF59` |
| Z4 Threshold | ≤ 105 % | yellow `#FFCC3F` |
| Z5 VO2max | > 105 % | orange `#FF6639` |

The limits can be changed per rider (Settings → Rider) and drive the colours, targets and zone strip.

**Workout intensity** (the Z-tag and filter in the workout list) is calculated once when a ZWO file is read:
- It uses the standard %FTP bands above.
- Free-ride time counts as Z2.
- A workout's intensity is the **highest zone it spends at least 60 s and 8 % of its time in**. A VO2max session with 5 × 3 min at 115 % is Z5 even though most of it is warm-up and recovery.

**TSS** in the list is an estimate from the planned targets (free ride counted at 60 % FTP). The FIT file contains the TSS of what you actually rode.

---

## Where your data lives

| What | Where |
|---|---|
| Riders, settings, progress, history | `~/Library/Application Support/dev.steffenr.zwotrainer/state.json` |
| Garmin session tokens and the Intervals.icu API key (owner-only file) | `…/dev.steffenr.zwotrainer/secrets.json` (never synced) |
| Ride files | `…/dev.steffenr.zwotrainer/activities/<rider>/*.fit` (plus `*.garmin.fit`) |
| Workouts | your workouts folder; zwoTrainer only reads it, except *Move to Trash* |

Nothing is sent anywhere except what you enable: uploads to the platforms you connect, and the cloud folder you choose for profile sync.

---

## Troubleshooting

| Problem | Try |
|---|---|
| Trainer / HR not found | Close Zwift, TrainerRoad and other training apps; wake the device (pedal / wet the strap); check Bluetooth permission for zwoTrainer. |
| ERG doesn't react | Make sure the trainer is connected as **trainer** (FTMS), not as a power meter; "Power only" in the ride header means no ERG. |
| Zwift Ride buttons do nothing | Connect only the **left** controller; check the *button test* in the Shifter dialog; update the Ride firmware in the Zwift Companion app. |
| Zwift Click stops after ~1 min | Unlock it once in the Zwift phone app (see above). |
| A workout is missing | It must be a `.zwo` file inside the workouts folder; use **Settings → App → Rescan**. |
| Garmin upload fails | Sign out and in again under Settings → Connections; use *Manual FIT import* meanwhile. |
| Intervals.icu says the key is wrong | Create a new key under intervals.icu → Settings → Developer Settings and paste it again (no spaces). |
| COROS import fails | Pick the **.zip** file zwoTrainer highlighted, not the .fit; processing in Training Hub can take a few minutes. |
| Sync says "waiting for iCloud downloads" | iCloud hasn't downloaded the files yet; zwoTrainer asks it to and picks them up on the next run. |

---

## For developers

- **[AGENTS.md](AGENTS.md):** architecture, commands, conventions and how to test. Read it before changing code.
- **[DESIGN.md](DESIGN.md):** the visual design system, covering tokens, typography, components, icons and layout rules.

```bash
cd src-tauri && cargo test                                                    # unit tests
ZWO_TEST_DIR=~/Downloads/zwo cargo test scan_real_library -- --nocapture       # parse a whole library
```

Supported ZWO elements: `SteadyState`, `SolidState`, `Warmup`, `Cooldown`, `Ramp`, `IntervalsT`, `FreeRide`, `MaxEffort`, `textevent` (inside elements and at workout level) and the cadence attributes. Ramps follow Zwift's rule: `PowerLow` is the start value and `PowerHigh` the end value.
