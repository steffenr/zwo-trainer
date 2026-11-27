<h1 align="center">
    <img width="250" alt="zwotrainer-logo-with-text" src="https://github.com/user-attachments/assets/1cc4ccb5-bf43-4cce-83c5-4fb7bd7a90dc" />
</h1>

# zwoTrainer

zwoTrainer rides Zwift `.zwo` workouts on a Bluetooth smart trainer in ERG mode and turns folders of workouts into training plans. Every ride is recorded as a FIT file and uploaded to Garmin Connect (and from there to Strava) and Intervals.icu. It runs on macOS, Windows and Linux.

No video courses, workout builder, music or subscription. You get a workout display and your own library.

**Website:** [steffenr.github.io/zwo-trainer](https://steffenr.github.io/zwo-trainer/) · **Download:** [latest release](https://github.com/steffenr/zwo-trainer/releases/latest) · **License:** [MIT](LICENSE)

- **Plans:** every folder with a weekly schedule is a plan. Ride the workouts in order; done and skipped ones are tracked and the next is always suggested.
- **Workouts:** ride anything freely, with search, length and intensity filters, TSS and favorites.
- **FTP tests:** Ramp, Ramp Lite, 20-minute, 8-minute and Power Profile, plus test workouts from your library. One click applies the new FTP.
- **Riders:** profiles with their own FTP, zones, plan progress, history and devices, optionally synced through iCloud Drive, Dropbox or Nextcloud.
- **Devices:** smart trainers (FTMS), power meters, heart-rate straps, Zwift Ride / Click / Play and OpenBikeControl controllers, with virtual shifting.
- **Languages:** English, German and French. zwoTrainer follows your system language until you pick one under Settings → App.

Built with **Tauri 2**: a Rust core and a plain HTML/CSS/JS interface, with no Node and no bundler. Zone colours follow the classic Zwift / WhatsOnZwift palette.

## Support

zwoTrainer is a spare-time project and stays free software. If it is useful to you:

<a href="https://buymeacoffee.com/steffenr"><img
  src="https://camo.githubusercontent.com/c28781810ec561314c0480f2a773391df0006ce9f6fc92c1e36dee408ab2869e/68747470733a2f2f63646e2e6275796d6561636f666665652e636f6d2f627574746f6e732f76322f64656661756c742d79656c6c6f772e706e67"
  alt="Buy Me a Coffee" width="150" height="42"></a>
---

## Contents

1. [Install](#install)
2. [Getting started](#getting-started)
3. [The top bar](#the-top-bar)
4. [Plans](#plans)
5. [Workouts](#workouts)
6. [FTP tests](#ftp-tests)
7. [Riding a workout](#riding-a-workout)
8. [Devices](#devices)
9. [Virtual shifting & controllers](#virtual-shifting--controllers)
10. [Ride history, FIT files, Garmin & Strava](#ride-history-fit-files-garmin--strava)
11. [Riders](#riders)
12. [Profile sync](#profile-sync)
13. [Settings](#settings)
14. [Zones & intensity](#zones--intensity)
15. [Where your data lives](#where-your-data-lives)
16. [Troubleshooting](#troubleshooting)
17. [For developers](#for-developers)
18. [License](#license)

---

## Install

### Download

Every release on the GitHub **Releases** page has installers for all platforms. They are unsigned, so the system asks once:

| Platform | File | First launch |
|---|---|---|
| macOS 13+ (Apple silicon) | `zwoTrainer_<version>_aarch64.dmg` | Right-click the app → **Open** (or System Settings → Privacy & Security → **Open Anyway**), then allow Bluetooth. |
| macOS 13+ (Intel) | `zwoTrainer_<version>_x64.dmg` | as above |
| Windows 10/11 (x64) | `zwoTrainer_<version>_x64-setup.exe` or `.msi` | SmartScreen: **More info → Run anyway**. Turn Bluetooth on in Settings; no pairing needed. |
| Linux (x64) | `.deb`, `.rpm` or `.AppImage` | Needs BlueZ (`bluetoothd`) running; the `.deb` and `.rpm` pull it in. |

The window is drawn by the system's web engine and the interface uses modern CSS (cascade layers and nesting), so keep it current: Safari 17+ on macOS, WebView2 on Windows (updates itself), WebKitGTK 2.42+ on Linux. With an older engine the screens appear unstyled.

zwoTrainer is developed and used on macOS. The Windows and Linux builds use the same code and are tested in CI on every push, but get less real-world riding.

### Updates

zwoTrainer updates itself. A few seconds after launch, and every 6 hours while it runs, it asks the newest GitHub release for a newer version. If there is one, a small card in the bottom-right corner offers **Install & restart**, **Later** and **What's new**.

- **Never during a ride:** an update found earlier appears when the ride ends.
- **Signed:** every update file is signed with the project's update key, and the app refuses anything that doesn't match.
- **Per install type:** the macOS app is replaced in place, Windows runs the installer you used, Linux updates the `.AppImage`, `.deb` or `.rpm` (the packages ask for your password).
- **Settings → App → Updates:** switch *Check for updates automatically* off, or press **Check now**. The setting belongs to this computer and isn't synced.

To build it yourself, see [docs/development.md](docs/development.md).

---

## Getting started

1. **Workouts folder.** zwoTrainer reads `~/Downloads/zwo` by default; change it under **Settings → App → Workouts folder**. Sub-folders with a weekly schedule are plans, other sub-folders are collections, and loose `.zwo` files in the root are single workouts.
2. **Your numbers.** Under **Settings → Rider** enter FTP, max heart rate and weight. Weight is needed for W/kg, VO2max and virtual shifting.
3. **Devices.** Click the **Bluetooth** button in the top bar and connect your trainer, heart-rate strap and, optionally, a Zwift controller. They reconnect automatically next time.
4. **Ride.** Pick a plan and press **Start plan**, or switch to **Workouts** and ride anything. The workout starts when you pedal, or press **Space**.

No hardware at hand? Each device dialog has **Use simulator**.

Settings has four tabs: **Rider** (FTP, heart rate, weight, bests, zones), **Riding** (sounds, ride behaviour, virtual shifting), **Connections** (profile sync, Garmin, other platforms) and **App** (appearance, language, workouts folder, devices, updates). Changes save as you make them; a number saves when you leave the field, and an out-of-range value shows an error instead. **Done**, ✕, Esc or a click outside just close the dialog.

---

## The top bar

Left: logo and the **Plans / Workouts / FTP Tests** switch. Right: **Devices**, **Ride history**, **Settings** and the **rider avatar**.

- **Devices** (Bluetooth icon): three dots show trainer, heart rate and shifter (green connected, amber connecting, grey off). The menu lists each device with *Connect / Change*. Devices that report a battery (most heart-rate straps and controllers, a few trainers) show it there: green from 40 %, amber from 16 %, red at 15 % or less.
- **Ride history** (calendar with a check mark): every ride, with uploads and FIT export.
- **Settings** (gear): rider data, app preferences (including light/dark) and connections.
- **Avatar:** switch, add or edit riders.

During a workout the bar stays the same, except that the mode switch shows the workout title, its plan and the ERG status, ride history is unavailable until the ride ends, and a compact-view icon appears.

---

## Plans

- **Plan or collection:** a sub-folder whose files span **at least two weeks** (`Week01_…`, `Week02_…`) is a **plan**. Everything else (one week only, e.g. WhatsOnZwift collections exported as `Week01_Day01…Day39`, or no week numbering) is a **collection**, shown only under **Workouts** without week/day labels. A folder you have started as a plan stays one.
- **Override:** in the folder's **⋯** menu, *Use as plan* or *Show as collection*. Stored per rider and synced.
- **Order:** natural sort by file name, so `Week01_Day01_…`, `Week01_Day02_…`, `Week02_Day01_…` group by week and day.
- **Description:** a Markdown file in the folder (`<folder>.md`, else `README.md`, else the only `.md`) is shown on the plan page and in the Workouts folder header. It supports headings, emphasis, links, lists, quotes and tables, and long texts start as a short preview with *Show more*. Links must be `https://`; they open in your browser.
- **Start plan** makes it the active plan. The home screen then shows **Up next** with profile, duration and TSS.
- **In order:** only the next workout can be started.
- **Skip** marks it skipped and moves on; **Undo skip** brings it back.
- **Done:** finishing a workout marks it done and offers **Start next now**.
- **Ending early** offers **Save as done**, **Count as skipped** or **Discard**.
- **Switching plans** keeps the old plan's progress.
- **⋯ menu** on the plan page: *Reset progress…*, *Show in Finder*, *Show as collection*, *Move plan folder to Trash…*.

---

## Workouts

Browse every workout across all folders and ride anything. Free rides are saved to your history but never change plan progress.

- **Sidebar:** *All workouts*, *★ Favorites*, *Recently ridden*, *Single workouts*, then **Plans** and **Collections**. A selected folder shows its description and a *Plan* / *Collection* badge.
- **Search** by title, name or file name.
- **Length filter:** ≤ 30, 30–60, 60–90 or > 90 minutes.
- **Intensity filter:** Z1 to Z5, several at once (see [Zones & intensity](#zones--intensity)).
- **Sort** by name, shortest, longest, hardest (TSS), intensity or recently ridden.
- **Each row** shows profile, duration, intensity tag and estimated TSS. Click for details or use **Ride**; for a workout in a plan, the details also offer **Open plan**.
- **Favorites:** star ☆ a workout; reorder with ↑ / ↓ inside *Favorites*.
- **⋯ menus:** on a row, favorite, *Show in Finder*, *Open its folder*, *Move workout to Trash…*; on a folder, *Show in Finder*, *Use as plan…* / *Show as collection*, *Move folder to Trash…*.

Deleting goes to the system Trash (Recycle Bin on Windows), so it can be restored. Favorites and plan progress that point to deleted files are cleaned up; ride history stays.

---

## FTP tests

| Test | Protocol | Result |
|---|---|---|
| **Ramp Test** | 5 min at 100 W, then +20 W per minute in ERG until you can't hold it, then an automatic 5-minute cool-down | 75 % of the best 1-minute power |
| **Ramp Test Lite** | the same with +10 W per minute, for beginners and lighter riders | 75 % of the best 1-minute power |
| **20-Minute Test** | Allen & Coggan: warm-up with spin-ups, 5 min all-out, recovery, 20 min all-out | 95 % of the 20-minute average |
| **8-Minute Test** | 2 × 8 min all-out with 10 min recovery (CTS) | 90 % of the better effort |
| **Power Profile Test** | 8 s sprint, then 1, 5 and 20 min maximal efforts | FTP, 5 s / 1 / 5 / 20 min bests, Critical Power and W′ |

**During a test**
- **All-out efforts** are ridden off ERG: the trainer simulates a flat road and you set the power with your gears. A pacing target is still shown, and in efforts of 5 minutes or longer the Current segment panel shows your running average and warns "too fast · ease off" when you're more than 10 % above it.
- **End of the ramp:** when you can't hold the target (cadence below 30 rpm or power below half the target for 10 s), the trainer switches to an easy 5-minute cool-down. Press ⏹ any time to see your result.
- **Measured parts:** auto-pause is off and skipping is blocked, so stopping counts as 0 W.

**Results**
- **Measured:** the ramp uses the best 60 seconds of the ramp itself, never the warm-up. The 20- and 8-minute tests use only the all-out effort, which counts when at least 95 % of it was ridden. Otherwise there is no FTP (it would come out too low), your FTP stays unchanged and the history marks the test *Not completed*.
- **Plausibility:** if the new FTP differs by more than 15 %, a note appears before you apply it.
- **Applying:** **Use X W as my FTP** recalculates the zones in watts and updates your personal bests. An older result can still be applied later.
- **History:** every result with its change against the previous FTP and a small trend chart.
- **W/kg and VO2max** need your weight. VO2max comes from 8-minute power (ACSM: `10.8 · W/kg + 7` ml/kg/min) or, after a ramp, from peak power (Hawley & Noakes: `0.01141 · W + 0.435` L/min).

**Tests in your library:** test-themed ZWO files (FTP Test, Ramp Test, Critical Power, Best effort, Benchmarking, …) are recognised automatically, including inside plans. Their free-ride blocks are the all-out efforts (Zwift's convention). Ramp-test files that lack the actual ramp (a known WhatsOnZwift export issue) start the built-in Ramp Test instead.

---

## Riding a workout

**Display:** three panels above the workout chart, a quarter, half and quarter of the width.
- **Live:** the watt gauge with target and actual power, then power, cadence, speed and heart rate with small bars.
- **Current segment:** the target in watts in the ring with % of FTP below it, plus target power, target cadence, segment time with progress bar and time remaining.
- **Next segment:** watts, % of FTP, duration and, if set, target cadence.

The intensity control sits next to play/pause. The chart has a watt axis, dims finished segments and draws your live power, cadence and heart-rate lines (each can be switched off; remembered per rider). The clock and readouts scale up in full screen.

**Start:** the workout starts after about 2 seconds of pedalling, or press **Space** / ▶.

### Compact view for videos

Click the **compact view icon** in the top bar (left of your avatar, during a ride) or press **C** to keep zwoTrainer beside or above a video player. It opens as a **960 × 195** bar, then at the size and position you last used, and can shrink to **240 × 150**.

- **Shows:** power gauge with target (a ramp shows its range), heart rate and cadence as large numbers, and the whole workout as a graph with **Now** and **Next** targets.
- **Layouts:** a wide bar (from 640 px wide) or a tall column (240–320 px wide). Switch with the layout button or **V**.
- **Small windows** drop the graph first, then move play/pause into the title row, then hide heart rate and cadence. Long values shrink to fit.
- **Unchanged:** shortcuts, controllers, trainer control, sounds and recording keep working. Virtual gear buttons appear in free-ride and all-out segments.
- **Back to full view:** the expand button or **C** restores the previous size and position. Stop and result dialogs expand automatically. Exit native full screen first.

There is no embedded video player and no always-on-top behaviour.

### During the ride

- **ERG** follows every target second by second, including ramps. Targets stay inside the power range the trainer reports, so it never rejects one.
- **Intensity:** − / + in the control bar, or ↑ / ↓ for ±1 % (Shift ±10 %), scales all targets.
- **Free-ride and all-out segments** release ERG: you ride with your gears or virtual gears.
- **Cadence check:** when a segment has a cadence target, the Live panel shows it next to your cadence (`86 / 90 rpm`). The bar turns **green** on target, **amber** 5–10 rpm off and **red** beyond 10 rpm. The next segment's target shows in its panel so you can prepare.
- **Auto-pause:** after 3 seconds without power or cadence the workout pauses and resumes when you pedal. Switch it off under Settings → Riding.
- **Coach line:** one short message at a time under the Current segment values: the workout's own text events first, then pacing warnings, cadence off target for 5 s, and cues in hard segments (Z4 and up). Switch the automatic hints off under Settings → Riding (*Coach hints*).
- **Sounds:** a countdown in the last 3 seconds before each target change: three rising notes mean power goes up, three falling notes down, a plain beep about the same (within 3 % FTP). A chime plays when a workout is ridden to the end (not after FTP tests). Switch each off under Settings → Riding.
- **Feedback:** every button press shows a short confirmation. The display stays awake and App Nap is disabled so ERG keeps updating in the background.

### Keyboard

| Key | Action |
|---|---|
| Space | start / pause |
| ← / → | previous / next segment |
| ↑ / ↓ | intensity ±1 % (Shift ±10 %) |
| + / − | shift gear (virtual gears); in free-ride segments ↑ / ↓ shift too |
| C | toggle Compact view (Ctrl/Cmd + C still copies) |
| V | in Compact view: switch between wide bar and tall column |
| Esc | end workout (closes an open menu instead) |
| Tab, then Space / Enter | press the ride button you tabbed to (Space no longer pauses until you click elsewhere); a button clicked with the mouse keeps Space = start / pause |

Menus work with arrow keys and Esc. Screen readers announce notices (uploads, sync, errors) and short ride hints (gear, intensity, auto-pause); every ride button has a spoken name. Recording stays at one sample per second even when the window is hidden or minimised.

If you switch to another app during a ride and zwoTrainer might still have keyboard focus, turn off **Keyboard shortcuts while riding** under Settings → Riding. On-screen buttons and controllers keep working.

### Controller buttons

| Zwift Ride / Play / Click | Action |
|---|---|
| Shift + / − | free-ride segments: virtual gear; ERG segments: intensity ±1 % |
| ▲ / ▼ | intensity ±1 % |
| ▶ / ◀ | next / previous segment |
| A, Y, Power-up | start / pause |
| Z | switch watts ↔ % FTP |

**OpenBikeControl:** Shift Up / Down work like Shift + / −, Increase / Decrease Difficulty like ▲ / ▼, Skip / Previous Interval and Right / Left like ▶ / ◀, Up / Down like ▲ / ▼, Select like A. When one press sends several (e.g. Shift Up + Increase Difficulty + Select), only one action runs: shift in free-ride segments, difficulty in ERG segments, otherwise interval skip or navigation.

### Finishing

The summary shows time, average power, NP, average HR, cadence and energy, then the Garmin upload status (or a manual import) and **Save .fit**. In a plan, the next workout is offered.

---

## Devices

| Device | Supported |
|---|---|
| Smart trainer | Bluetooth **FTMS** (Zwift Hub, Wahoo KICKR, Tacx, Elite, Saris, JetBlack, …), with ERG and flat-road simulation |
| Power meter | Bluetooth **Cycling Power**, power only (no ERG) |
| Heart rate | any Bluetooth strap or watch broadcasting HR |
| Controllers | **Zwift Ride**, **Zwift Click (v1/v2)**, **Zwift Play**, **OpenBikeControl** controllers and bridge apps (e.g. BikeControl) over Bluetooth |

- **Pairing:** **Devices** menu → *Connect*. Devices are remembered per rider and reconnect at launch and after dropouts (controllers for about a minute after one drops, e.g. when it falls asleep).
- **Retry auto-connect:** if the app started before your trainer or strap was awake, open the **Devices** menu and click it. It connects every saved device that is still off and leaves connected ones alone. It shows only while a saved device is off and no attempt is running.
- **One connection only:** close Zwift and other training apps first, because most trainers and controllers accept just one connection.

---

## Virtual shifting & controllers

**Virtual shifting** gives you gears in free-ride segments and all-out efforts, even on a trainer without real shifting.

- **How it works:** a virtual 24-speed drivetrain (ratio range and start gear configurable). Cadence × gear ratio gives a virtual speed, and road physics (rolling resistance and air drag, using your weight) turns that into the watts the trainer holds in ERG. Speed and distance in the FIT file follow it.
- **Per ride:** the Ready screen asks *Real gears* or *Virtual gears easy / medium / hard*. The default is under Settings → Riding → Virtual shifting (gear range and start gear under *Advanced*).
- **Shifting:** with a Zwift or OpenBikeControl controller, the keyboard (`+` / `−`) or the on-screen − / + buttons.

**Controllers**
- **Zwift Ride:** connect only the **left** controller; it relays the right one's buttons.
- **Zwift Click v2:** unlock it once in the Zwift phone app (connect, wait about 90 s, close Zwift), or it stops after about a minute.
- **OpenBikeControl:** controllers advertising the open [OpenBikeControl](https://github.com/OpenBikeControl/openbikecontrol-protocol) Bluetooth service, and apps like BikeControl that bridge other controllers to it, show up in the Shifter dialog. zwoTrainer tells the device which buttons it uses after connecting.
- **Button test:** the Shifter dialog shows every press and the action it triggers.

---

## Ride history, FIT files, Garmin & Strava

Every finished ride is saved as a **FIT file** with one lap per workout segment, including power, cadence, heart rate, speed/distance, NP, IF and TSS. **Ride history** lists all rides with *Garmin* upload and *FIT* export.

### Garmin Connect

Settings → Connections.

- **Sign in** with **Sign in to Garmin**. Garmin's own login page opens in a small window, MFA supported. zwoTrainer stores only the resulting session token for that rider, never your password.
- **Upload mode:** *Off*, *Manual* (a button after each ride and in the history) or *Automatic*.
- **Activity name:** every upload is named after the workout (e.g. *“5x6 Sweet Spot 1B”*), with plan and week/day in the description; Garmin would otherwise call it *“Indoor Cycling”*. Intervals.icu uploads are named the same way.
- **Edge identity:** the file identifies as a Garmin Edge, so Garmin computes Training Effect and VO2max and counts the ride for challenges.
- **Unofficial interface:** this is the approach of the Garmin Connect mobile app, not Garmin's partner API, so it may change. If it fails, **manual FIT import** saves the file, shows it in Finder and opens Garmin's import page.

### Strava

zwoTrainer has no direct Strava connection, because since 2026 Strava requires a paid subscription from the owner of an API app. Link Strava to your Garmin account once (Garmin Connect → Settings → Connected Apps → Strava) and every ride uploaded to Garmin goes on to Strava. As a fallback, use **FIT** in the history and drop the file on strava.com/upload.

Strava doesn't get the workout name: Garmin passes each ride on right after the upload and ignores the name in the FIT file, so Strava uses its own default (e.g. *“Morning Ride”*) and your default bike. The type is correctly *Indoor Cycling*. Rename it by hand or with a service such as Strautomator (its Garmin integration is a paid feature).

### Intervals.icu & COROS

Settings → Connections → **More platforms**.

| Platform | How | Set-up |
|---|---|---|
| **Intervals.icu** | **Automatic upload** (official API) | intervals.icu → Settings → *Developer Settings* → create an API key and paste it into zwoTrainer. Upload mode: Off / Manual / Automatic. |
| **COROS** | **Manual import** into the Training Hub | Turn on *Show import button*. After a ride, zwoTrainer saves a **ZIP** (Training Hub only accepts ZIPs), shows it in Finder and opens the Training Hub; there choose *Activity List → Import Data*. |

- **After a ride:** the summary lists Garmin, Intervals.icu and COROS with *Upload* or *Import…*; automatic uploads start by themselves.
- **Short rides:** a ride under 15 minutes (a test spin, a stopped workout) isn't uploaded automatically. The summary asks first: *Upload* sends it everywhere it would have gone, *Don't upload* keeps it on your computer (you can still upload later, also from the history).
- **In the history:** a ✓ marks where a ride went, and the row's **⋯** menu sends older rides to the others.

Wahoo, TrainingPeaks and Suunto only accept uploads from approved partner apps, so zwoTrainer doesn't offer them. TrainingPeaks and many others can be linked in Garmin Connect, which then forwards your rides.

---

## Riders

Each rider has their own:
- avatar (colour and initials or an emoji), FTP, max heart rate, weight, zone limits and power bests
- active plan, done/skipped marks, favorites, ride history and FTP tests
- theme, language, sounds, auto-pause, coach hints, virtual-shifting defaults, workouts folder and paired devices
- Garmin sign-in and upload mode

**Managing riders**
- **Switch** with the avatar in the top bar. With more than one rider, zwoTrainer asks **Who's riding?** at launch.
- **Edit** changes name, colour (8 presets or any custom colour) and emoji.
- **A new rider** takes the workouts folder, theme, language and devices from the current rider; everything else starts from defaults.
- **Deleting a rider** removes their settings, progress, history, stored rides and Garmin sign-in.

---

## Profile sync

Keep riders in sync across computers through a folder your cloud app already syncs, with no accounts or API keys. Set it up under **Settings → Connections → Profile sync**.

| Option | Folder used |
|---|---|
| iCloud Drive | `~/Library/Mobile Documents/com~apple~CloudDocs` (macOS) or `~\iCloudDrive` (iCloud for Windows) |
| Dropbox | `~/Library/CloudStorage/Dropbox…` or `~/Dropbox` |
| Nextcloud | `~/Library/CloudStorage/Nextcloud…` or `~/Nextcloud` (desktop client) |
| Other folder… | any folder another app keeps in sync |

- **Synced:** all riders, including avatar, FTP and zones, weight, plan progress, favorites, ride history, FTP tests and the ride FIT files.
- **Stays on each computer:** paired devices, the workouts folder, the Garmin FIT folder and the Garmin sign-in.
- **Conflicts:** the newest change to a rider wins. Ride history and FTP tests are merged from both sides, as are plan progress (per workout), personal bests (the higher one) and the FTP of a test applied elsewhere. Deleting a rider removes it everywhere.
- **When it runs:** at launch, a few seconds after every change, when the window gets focus and every 5 minutes, never during a ride. **Sync now** forces a run.
- **Layout in the cloud folder:** `zwoTrainer/profiles/<id>.json` and `zwoTrainer/activities/<id>/*.fit`. Only rider files and real FIT files are picked up from that folder; anything else left there is ignored.

---

## Settings

| Tab | Settings |
|---|---|
| **Rider** | FTP, max heart rate, weight, personal bests (5 s / 1 / 5 / 20 min), zone limits (upper limit of Z1–Z4 in % FTP) |
| **Riding** | Countdown beeps (with rising/falling notes), end-of-workout chime, auto-pause, coach hints, keyboard shortcuts while riding, virtual shifting (default, difficulty, gear-ratio range, start gear) |
| **Connections** | Profile sync, Garmin Connect (sign in, upload mode, manual FIT import folder), Strava note, more platforms (Intervals.icu API key and upload mode, COROS import button) |
| **App** | Appearance (Match system / Light / Dark), language (English / Deutsch / Français; applies immediately), workouts folder (*Change… / Rescan*), paired devices, *About* (version, *Check for updates automatically*, *Check now*, licence, links to website, source code, third-party licences and Buy Me a Coffee) |

---

## Zones & intensity

| Zone | Default upper limit | Colour |
|---|---|---|
| Z1 Recovery | ≤ 55 % FTP | grey `#7F7F7F` |
| Z2 Base endurance | ≤ 75 % | blue `#338CFF` |
| Z3 Tempo | ≤ 90 % | green `#59BF59` |
| Z4 Threshold | ≤ 105 % | yellow `#FFCC3F` |
| Z5 VO2max | > 105 % | orange `#FF6639` |

Limits can be changed per rider (Settings → Rider) and drive the colours, targets and zone strip.

**Workout intensity** (the Z-tag and filter in the workout list) is calculated once when a ZWO file is read, with the %FTP bands above. Free-ride time counts as Z2. A workout's intensity is the **highest zone it spends at least 60 s and 8 % of its time in**, so a VO2max session of 5 × 3 min at 115 % is Z5 even though most of it is warm-up and recovery.

**TSS** in the list is an estimate from the planned targets (free ride counted at 60 % FTP). The FIT file contains the TSS of what you actually rode.

---

## Where your data lives

| What | Where |
|---|---|
| Riders, settings, progress, history, update setting | `state.json` in the app data folder: `~/Library/Application Support/dev.steffenr.zwotrainer/` (macOS), `%APPDATA%\dev.steffenr.zwotrainer\` (Windows), `~/.local/share/dev.steffenr.zwotrainer/` (Linux). A damaged file is kept as `state.json.corrupt-<number>` and zwoTrainer starts fresh, so nothing is overwritten. |
| Garmin session tokens (with the OAuth consumer pair, downloaded once per Garmin sign-in) and the Intervals.icu API key | `secrets.json` in the same folder (owner-only: mode `0600` on macOS/Linux, an owner-only ACL on Windows; never synced) |
| Ride files | `activities/<rider>/*.fit` in the same folder (plus `*.garmin.fit`). Rides started in the same minute get separate files (`…-2.fit`); nothing ever replaces an existing ride file. |
| Workouts | your workouts folder; zwoTrainer only reads it, except *Move to Trash* |

Nothing is sent anywhere except what you enable: uploads to the platforms you connect and the cloud folder you choose for profile sync. The update check only downloads the release manifest from GitHub (switch it off under Settings → App → Updates).

---

## Troubleshooting

| Problem | Try |
|---|---|
| Trainer / HR not found | Close Zwift, TrainerRoad and other training apps; wake the device (pedal, wet the strap); check Bluetooth permission (macOS), that Bluetooth is on (Windows) or that `bluetoothd` is running (Linux). |
| ERG doesn't react | Connect the trainer as **trainer** (FTMS), not as a power meter; "Power only" in the ride header means no ERG. If zwoTrainer warns that another app controls the trainer, close Zwift, the Zwift Companion app and other training apps (also on phone or tablet), then reconnect. |
| Zwift Ride buttons do nothing | Connect only the **left** controller; check the *button test* in the Shifter dialog; update the Ride firmware in the Zwift Companion app. |
| Zwift Click stops after ~1 min | Unlock it once in the Zwift phone app (see [Virtual shifting & controllers](#virtual-shifting--controllers)). |
| A workout is missing | It must be a `.zwo` file inside the workouts folder; use **Settings → App → Rescan**. Unreadable files, files larger than 2 MB and workouts longer than 48 hours are skipped. |
| Garmin upload fails | Sign out and in again under Settings → Connections; use *Manual FIT import* meanwhile. |
| Intervals.icu says the key is wrong | Create a new key under intervals.icu → Settings → Developer Settings and paste it again (no spaces). |
| COROS import fails | Pick the **.zip** zwoTrainer highlighted, not the .fit; processing in Training Hub can take a few minutes. |
| Update fails or "Check now" can't reach GitHub | Check your connection and retry later, or install the newest version from the Releases page over the old one. |
| Sync says "waiting for iCloud downloads" | iCloud hasn't downloaded the files yet. zwoTrainer asks it to and picks them up on the next run, leaving those riders alone until then. On a new computer the default "Rider 1" is only uploaded once every rider file has arrived. |

---

## For developers

- **[docs/development.md](docs/development.md):** build from source, commands and tests, supported ZWO elements.
- **[docs/releasing.md](docs/releasing.md):** CI, the release workflow, in-app update signing and releasing by hand.
- **[AGENTS.md](AGENTS.md):** architecture, conventions and how to test. Read it before changing code.
- **[DESIGN.md](DESIGN.md):** the visual design system: tokens, typography, components, icons and layout rules.

---

## License

zwoTrainer is free and open source under the [MIT License](LICENSE) © 2026 SteffenR.

The installers bundle open-source Rust crates under their own licences (MIT, Apache-2.0, BSD, ISC, MPL-2.0 and others). Their notices are attached to every release as `THIRD-PARTY-NOTICES.html` and linked in the app under *Settings → App → About*. The countdown and end-of-workout sounds in `ui/sounds/` are under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain). Zwift, Garmin, Strava, Intervals.icu and COROS are trademarks of their owners; zwoTrainer isn't affiliated with them.
