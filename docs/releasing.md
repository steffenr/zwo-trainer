# Releasing zwoTrainer

GitHub Actions builds and publishes everything (workflows in `.github/workflows/`). Platform and signing details are in [AGENTS.md](../AGENTS.md#releases--platforms).

## Workflows

| Workflow | Runs | What it does |
|---|---|---|
| **CI** (`ci.yml`) | every push to `develop` and every PR | Tests and clippy on Linux plus the UI checks (syntax, unit tests, translations, CSS, markup); tests on macOS and Windows. |
| **Release** (`release.yml`) | by hand: *Actions → Release → Run workflow* on `develop`, pick **patch / minor / major** | Runs the full CI first and stops if anything fails. Then bumps the version in `src-tauri/Cargo.toml` (the only place it lives) and `Cargo.lock`, commits `chore(release): X`, tags `vX` and pushes commit and tag together (atomically). One run at a time. Needs the repository secret `RELEASE_PAT` (a token with *Contents: read & write*), because pushes made with the default token don't start other workflows. |
| **Build** (`build-app.yml`) | every `v*` tag | Builds macOS Apple silicon + Intel, Windows x64 and Linux x64 in parallel, then publishes one GitHub release with all installers, notes generated from the commits since the previous tag and `THIRD-PARTY-NOTICES.html` (licences of all bundled Rust crates, generated with [cargo-about](https://github.com/EmbarkStudios/cargo-about) from `src-tauri/about.toml` and `about.hbs`). A manual run is a test build: the installers are attached to the run. |
| **Website** (`pages.yml`) | last step of each release build, or by hand | Publishes `site/` to GitHub Pages as of the latest release. The optional `ref` (e.g. `develop`) deploys another branch for an urgent site fix. Site changes on `develop` go live with the next release. One-time setup: *Settings → Pages → Build and deployment → Source: GitHub Actions*. |
| **Dependabot** (`.github/dependabot.yml`) | monthly | Pull requests against `develop`: all GitHub Actions in one, Rust minor and patch updates in one, each major crate update (e.g. `tauri`, `btleplug`) on its own. |

## In-app updates

With the secret `TAURI_SIGNING_PRIVATE_KEY` in the `release` environment (open to `v*` tags only), plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one, *Build* also signs update files. `src-tauri/tauri.updater.conf.json` turns on `createUpdaterArtifacts`, and the release gets the macOS `.app.tar.gz` bundles and a `latest.json` (`scripts/updater-manifest.mjs`) that the apps read from `releases/latest/download/latest.json`. Without the secret, builds still work, just without update files.

One-time setup: `scripts/setup-updater-key.sh` creates the key in `~/.tauri/`, writes the public key into `tauri.conf.json`, creates the environment and sets both secrets with `gh`. Run it again with the existing key to only move the secrets. Back up the key and password: without them, installed apps can't be updated any more.

## By hand

```bash
node scripts/sync-version.mjs 1.2.0
git commit -am "chore(release): 1.2.0"
git tag -a v1.2.0 -m v1.2.0 && git push --atomic origin develop v1.2.0
```

Use an annotated tag. A plain `git tag` creates a lightweight tag, which `git push --follow-tags` doesn't push, so no build would start.

## If the build fails

Re-run *Build* for the existing tag (*Re-run failed jobs* on that run). Don't run *Release* again: it would bump to the next version.
