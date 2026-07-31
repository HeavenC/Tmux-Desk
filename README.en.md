# Tmux Desk

[简体中文](README.md) · **English**

Tmux Desk is a local-first desktop manager for tmux. It uses a workbench-style layout to bring your local tmux sessions, windows, panes, and real terminals into a single desktop window — with optional phone / tablet web access. macOS first, Windows (via WSL) supported.

Under the hood it's Electron + [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty): the control plane shells out to `tmux`, and the terminal plane attaches your local tmux panes — so **your `~/.tmux.conf` applies verbatim**.

## Screenshots

> The screenshots below use sandbox sessions and fictitious projects (acme-web / acme-api …). No real data.

| Desktop workbench | Tag groups & tabs |
|:---:|:---:|
| ![Main](docs/screenshots/01-main.png) | ![Tag tabs](docs/screenshots/02-tag-tabs.png) |
| **Command palette (⌘K)** | **File browser (⌘B)** |
| ![Command palette](docs/screenshots/03-command-palette.png) | ![File browser](docs/screenshots/04-file-browser.png) |

Dark theme (system-following also supported):

![Dark theme](docs/screenshots/05-dark-main.png)

### Phone / Tablet / Browser

Any phone browser can drive all of your local tmux sessions; add it to the home screen to use it like an app.

| iPhone (session list) | iPad (session list) |
|:---:|:---:|
| <img src="docs/screenshots/08-iphone.png" width="300" /> | <img src="docs/screenshots/09-ipad.png" width="360" /> |

| Phone full-screen terminal | Desktop browser |
|:---:|:---:|
| <img src="docs/screenshots/06-mobile-terminal.png" width="300" /> | ![Desktop browser](docs/screenshots/07-browser-list.png) |

## Features

- View, search, create, attach, favorite, rename and close local tmux sessions
- Assign multiple local **Tags** to a session and enter a dedicated workspace per Tag from the left rail
- The Tag rail fills available height and sorts by recent use; expand the column for full names, drag the right edge to resize, recently-used floats to the top with a smooth transition; **pin** frequently-used Tags to fix their order
- Tag and Favorites workspaces collapse the middle session column and group same-tag sessions into a row of browser-style tabs; no duplicates within a Tag
- The "All" view's session sidebar is drag-resizable (double-click the divider to reset); Tag / Favorites compact views still collapse it fully
- **Duplicate session** (like `git checkout -b`): derive a copy from an existing session's windows and directory, leaving the original untouched
- **Split panes** (`⌘D` vertical / `⌘⇧D` horizontal, `tmux split-window`) and **close/restore split**; each split has an × overlay button in its top-right corner
- **File browser on the right** (`⌘B` to toggle): browse the file tree of the current session's directory — open with default app, "Open With…" another app, reveal in Finder, copy path
- Hold `⌘` and click a filename or path in terminal output to open it with the system default app, like iTerm; relative, absolute and `file:line:column` forms are supported
- Pane picker in the workspace header for quick pane focus; `⌘1…9` switches the current session's tmux window
- Full interactive terminal via xterm.js + node-pty, with color, mouse and full-screen TUI programs
- **Terminal experience baseline out of the box**: mouse wheel/drag-select, 50000-line scrollback, Shift+Enter extended keys, windows numbered from 1, switch-session-on-last-pane-close — applied per session on attach, no `~/.tmux.conf` needed; each is toggleable under Settings → Terminal experience
- `⌘K` command palette and familiar desktop shortcuts
- Light, dark and system-following themes; defaults to light on first launch
- Bilingual UI (English / Chinese; system-following or manual)
- Auto-refresh after sessions are created or closed in an external Terminal
- Creates a separately signed Web share link for the current session; the server scopes listing, detail, terminal attach and window switching to that session
- No login, telemetry, cloud sync or plugins; the phone web service is off by default and only listens on the network after you start it

## Using Tags

1. Click `+` below the Tag area in the left rail to create a Tag.
2. In any session's `…` menu choose "Manage Tags…" to check multiple Tags at once.
3. Clicking a Tag in the left rail collapses the middle session list; that Tag's sessions appear as a row of tabs above the terminal.
4. Click the expand button to show full Tag names; drag the right edge to resize, double-click to reset. The most recently opened Tag smoothly floats to the top and persists across restarts; **pin** a Tag if you don't want it to move.
5. Click "All Sessions" to restore the full list. The settings page can create, rename and delete Tags; deleting a Tag never closes tmux sessions.

Tags, favorites, theme and window size are stored only on this machine. Duplicating a session inherits the source session's Tags; renaming a session migrates its Tag associations.

## ⚠️ tmux behavior vs App behavior (important)

Tmux Desk's terminal *is* your local tmux, and it **reads `~/.tmux.conf` as usual** when it attaches. So a lot of "App behavior" is actually decided by your **tmux config** — swap in a different tmux config elsewhere and the behavior changes.

The most experience-critical options are **managed by the App by default** (applied **per attached session** when connecting — your `~/.tmux.conf` is never modified and sessions in other terminals are unaffected): mouse wheel/drag-select, a 50000-line scrollback, Shift+Enter extended keys, windows numbered from 1, and switch-session-on-last-pane-close. Each can be turned off under **Settings → Terminal experience**; reconnect the session and it falls back to your own tmux config.

These are the common "I thought it was the App, but it's tmux" points (rows marked "App-managed" work out of the box):

| What you see | Actually decided by | Relevant tmux config |
|---|---|---|
| Mouse wheel scrolls history, drag-to-select works in the terminal | **App-managed** | `mouse on` (per session). With the toggle off — and no config of your own — the wheel degrades into ↑/↓ arrow keys |
| How many lines you can scroll back | **App-managed** | `history-limit 50000` (per session; tmux defaults to just 2000, applies to panes created after attach) |
| **Shift+Enter inserts a newline** (isn't swallowed) in some TUI / REPL programs | **App-managed** | the App declares `extkeys` on attach and sets `set -s extended-keys on` — Claude Code and friends work out of the box |
| `⌘1…9` window numbers start at **1**; numbers renumber after you close a window | **App-managed** | `base-index 1` + `renumber-windows on` (per session; tmux defaults to 0-based, no renumber) |
| Closing the **last pane** of a session doesn't exit tmux but switches to another session | **App-managed** | `detach-on-destroy off` (per session) |
| Releasing a mouse drag copies to the system clipboard | tmux (this path) | e.g. `bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-no-clear "pbcopy"` |
| `prefix + T/L/X` pops up an fzf session picker etc. | tmux (your bindings, e.g. `sesh`) | `bind-key T display-popup …` |
| The color/content of that bottom status bar | tmux | the `status-*` options — tmux draws it, not the App |
| Whether true color (24-bit) works | tmux + terminal features | `terminal-features 'xterm*:RGB'` (the App already declares `RGB` on attach) |

The App only **forwards keys**, **attaches panes**, and layers its own desktop interactions on top (only the `⌘`-prefixed entries in the Shortcuts table below are App shortcuts). Therefore:

- **The prefix key is still tmux's prefix (default `⌃B`)**, which is a different thing from the App's `⌘B` (toggle file browser). To send tmux commands inside the App, press your prefix as usual.
- The App's "select-to-copy" goes through the xterm selection + OSC 52 path (see Privacy below), which is independent from your tmux `copy-pipe` binding — both may fire.
- If a behavior differs between the App and another terminal, **suspect a tmux config difference first** (prefix, `mouse`, `base-index`, …), not an App bug.

> For cross-environment consistency, the App does two things on attach: declares OSC 52 clipboard + true color support via `tmux -T clipboard,RGB attach-session`; and forces a UTF-8 locale (`LANG`/`LC_ALL`) for the tmux child, so launching from Finder/Dock doesn't fall back to the C locale and render CJK/emoji session names as `_`.

## Restoring sessions after a reboot

The tmux server is an in-memory process — a shutdown/reboot always wipes every session. That's not App behavior; tmux works the same in any terminal. **Tmux Desk snapshots your sessions itself, out of the box, with no plugins to install.**

Periodically (every 3 minutes by default, plus on every session change and before sleep or quit) the App stores every session, window, split layout and **each pane's working directory** to:

```
~/Library/Application Support/Tmux Desk/session-snapshot.json
```

After a reboot, opening the App waits a moment (in case you have another restore plugin, so it goes first), then checks whether the tmux server restarted: it only recreates sessions when the server is a **new process and the session really is gone** — sessions you closed yourself are never brought back.

To check on it, or when something goes wrong: an **exclamation mark** appears at the top right of the session view whenever something needs you; click it for the "Session snapshot" panel. When all is well you can reach the same panel via **Settings → Session snapshot & restore → View status**. It shows:

- last snapshot time, how many sessions are in it, how many were restored at launch;
- every problem with its cause, a suggested fix, and the matching one-click action (snapshot now / restore from snapshot / fix working directories);
- the **absolute paths of the snapshot and log files** (copyable). When reporting a problem, please attach `session-snapshot.log`.

Three switches live in Settings: periodic snapshots, restore on launch, and fix working directories (when a restored pane sits in `~`, type a `cd` back into the **idle shell**; panes running a program are never touched).

### Optionally: restore pane contents and processes too

The App's snapshot restores **structure and directories**, not the processes or screen contents inside panes. If you want those, add the community plugin pair [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) + [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum). They coexist with the App's snapshot (which stands down once it sees the plugin already restored your sessions):

```bash
git clone https://github.com/tmux-plugins/tmux-resurrect ~/.tmux/plugins/tmux-resurrect
git clone https://github.com/tmux-plugins/tmux-continuum ~/.tmux/plugins/tmux-continuum
```

Append to `~/.tmux.conf` (a manual clone is enough — no TPM required):

```tmux
set -g @resurrect-capture-pane-contents 'on'   # snapshot visible pane contents too
set -g @continuum-restore 'on'                 # auto-restore when the server starts
set -g @continuum-save-interval '15'           # auto-snapshot every 15 minutes
run-shell ~/.tmux/plugins/tmux-resurrect/resurrect.tmux
run-shell ~/.tmux/plugins/tmux-continuum/continuum.tmux
```

Once configured, continuum snapshots to `~/.local/share/tmux/resurrect/` every 15 minutes. The App wakes the tmux server on launch (`start-server`), which triggers continuum's auto-restore — no need to create a session first.

Caveats:

- What's restored is the **layout, not the processes**: programs running inside panes are only relaunched if whitelisted (`@resurrect-processes`); half-finished jobs and shell state don't survive — no scheme gets around that.
- The App injects the tmux binary's directory into the `PATH` of any server it starts, so plugins work even when launched from the Dock. If a plugin dies with `tmux: command not found` in **another GUI terminal**, add this before the plugin lines in tmux.conf: `set-environment -g PATH "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`.
- A running tmux server doesn't re-read its config; after editing, run `tmux source-file ~/.tmux.conf` once (or `tmux kill-server` and reopen).

## Keyboard shortcuts

All of the following are **App shortcuts** (tmux's own prefix bindings are unaffected — see the section above).

| Shortcut | Action |
|---|---|
| `⌘K` | Open command palette |
| `⌘N` | New session |
| `⌘F` | Search sessions |
| `⌘R` | Refresh sessions |
| `⌘B` | Toggle file browser |
| `⌘` + click a file path | Open a file from terminal output with its default app (relative to the active pane directory) |
| `⌘D` / `⌘⇧D` | Split vertically / horizontally (`tmux split-window`) |
| `⌘⇧T` | Cycle light / dark / system theme |
| `⌘1…9` | Switch the current session's tmux window |
| `⌘←/→` | Switch to the adjacent session tab within the current Tag/Favorites workspace (like iTerm) |
| `⌘⇧←/→` | Move the current session tab within the manual order |
| `⌘↑/↓` | **Switch between Tags** (jumps to the target Tag's first session; does not trigger the recency re-sort of unpinned Tags) |
| `Esc` | Close menu or dialog |

## Requirements

- macOS (Apple Silicon first; x64/universal packaging scripts retained) or Windows 10/11 + WSL2
- Node.js 22+ (only needed to run from source / package)
- macOS: Xcode Command Line Tools (to compile the `node-pty` native module)
- tmux:

```bash
brew install tmux          # macOS
sudo apt install tmux      # WSL / Linux
```

On macOS the app probes, in order: a **bundled tmux** (`Contents/Resources/bin/tmux` inside the `.app`), `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`, `/usr/bin/tmux`, then PATH.

> **Pre-bundle tmux for users who don't have it**: drop an executable tmux binary at `vendor/bin/tmux` before packaging and the app ships tmux, ready out of the box (see `vendor/README.md`). `vendor/bin` is empty by default, and the app falls back to system tmux.

## Download & install

Grab the artifact for your platform from [Releases](https://github.com/HeavenC/Tmux-Desk/releases):

| Platform | Artifact |
|---|---|
| macOS · Apple Silicon | `Tmux Desk-<version>-arm64.dmg` |
| macOS · Intel | `Tmux Desk-<version>-x64.dmg` |
| Windows | `Tmux Desk Setup <version>.exe` (NSIS installer) |

> macOS artifacts are **ad-hoc signed and not notarized**. If first launch warns "cannot verify developer", **right-click the App → Open**, or run `xattr -cr "/Applications/Tmux Desk.app"`. Always distribute the `.dmg` — do not send a bare `.app` over chat/email (it breaks symlinks inside the Electron framework and yields a "damaged" error). tmux must be installed on the machine to run.

## Windows (WSL)

Windows has no native tmux, so Tmux Desk runs tmux through **WSL**: the desktop side is still a Windows Electron app, but every tmux control command and terminal attach runs inside WSL as `wsl.exe -e tmux …`, and session/window/pane working directories are WSL-side paths.

> **In one sentence**: Tmux Desk is the "window + interaction"; tmux is the "session engine running in the background." Windows has no tmux, so the engine runs inside WSL (a lightweight Linux on Windows) and Tmux Desk just displays it. So the order is **WSL first, then tmux, then Tmux Desk**.

### From scratch (new users — 4 steps)

**Step 1 · Install WSL2**

If you've never used WSL, open **PowerShell as administrator** (Start menu → search "PowerShell" → right-click → Run as administrator) and run:

```powershell
wsl --install
```

This single command enables the WSL feature, installs WSL2, and installs the default distro **Ubuntu**. **Reboot** when it finishes.

> Works on Windows 11 and recent Windows 10 (2004+). If it says `wsl` is not recognized, your system is too old — see "Manual install on older Windows" below.

**Step 2 · Set up Ubuntu**

After rebooting, **Ubuntu** appears in the Start menu — open it. On first launch it asks you to create a **Linux username and password** (unrelated to your Windows account; just remember it — the password stays hidden while typing, which is normal). You're done once you see the shell prompt (like `you@pc:~$`).

**Step 3 · Install tmux inside Ubuntu**

In that Ubuntu window, run line by line (the first asks for the password from Step 2):

```bash
sudo apt update
sudo apt install -y tmux
tmux -V          # prints a tmux version number → installed
```

**Step 4 · Install and launch Tmux Desk**

Download `Tmux Desk Setup <version>.exe` from [Releases](https://github.com/HeavenC/Tmux-Desk/releases), double-click to install, then launch it. The app finds tmux through WSL automatically; if it doesn't right after install, click **"Re-detect"** in the UI.

You can now create sessions, open windows, and split panes. When creating a session, the working directory can be a Windows drive (`/mnt/c/...` in tmux) or a native WSL path (`/home/your-username/...`).

### Manual install on older Windows

If `wsl --install` isn't available (older Windows 10), run in an admin PowerShell:

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

Reboot, install the [WSL2 Linux kernel update package](https://aka.ms/wsl2kernel), then run:

```powershell
wsl --set-default-version 2
```

Finally install **Ubuntu** from the **Microsoft Store** (or `wsl --install -d Ubuntu`), then return to Step 2 above.

### Troubleshooting

- **App says tmux not found**: confirm `tmux -V` prints something inside WSL; if it still fails, click "Re-detect" or restart the app.
- **Multiple distros / wrong default**: pin it with the `TMUX_DESK_WSL_DISTRO` env var (see table); list distro names with `wsl -l -q`.
- **tmux not on the default PATH (e.g. self-compiled)**: set `TMUX_DESK_WSL_TMUX` to the absolute path of tmux inside WSL.

**Optional environment variables**

| Variable | Purpose |
|---|---|
| `TMUX_DESK_WSL_DISTRO` | Which WSL distro to use (maps to `wsl -d <distro>`). Unset → the default distro |
| `TMUX_DESK_WSL_TMUX` | The tmux command or absolute path inside WSL (default `tmux`) |

**Path handling**: both directories under Windows drives (shown in tmux as `/mnt/c/...`) and native WSL directories (`/home/...`, accessed via `\\wsl$\<distro>\...` UNC) can host sessions and be browsed. The file browser needs the distro name to reach native WSL paths — it auto-detects the first distro from `wsl -l -q`, or pin it with `TMUX_DESK_WSL_DISTRO`.

> No Windows icon is bundled yet; for branding, drop a 256×256 `build/icon.ico` before packaging.

## Run from source

```bash
git clone https://github.com/HeavenC/Tmux-Desk.git
cd Tmux-Desk
npm install
npm start
```

`npm install` uses Electron Builder to rebuild the `node-pty` native module for the current Electron version.

## Phone / Web access

Any phone/tablet browser can drive your local tmux sessions (pair it with [Tailscale](https://tailscale.com/) for remote access — its WireGuard tunnel provides transport security; the service itself does not do TLS). You can open every session or share only the current one:

- **Access every session**: use the phone icon in the desktop app's left rail (or "Phone access" in the command palette) → "Start web service" to show Tailscale and LAN QR codes.
- **Share the current session**: choose "Share this session" from its menu. The QR code and URL contain a separate signed capability bound to that session, not the full-access token; the server rejects attempts to read, attach to, or switch to another session with it.
- **Command-line daemon** (works without the app):

```bash
npm run serve:web     # builds the phone page and starts it, default port 8790
```

It prints access URLs per interface (with a random token, persisted at `~/.config/tmux-desk/web-token`). Open `http://<Tailscale IP>:8790/?token=<token>` on your phone and add it to the home screen.

- Session list → tap to enter a full-screen terminal (xterm.js), with Esc / Tab / Ctrl (sticky) / ⌃B / arrow assist keys at the bottom
- The top of the list switches between "All / Favorites / each Tag"; sessions are de-duplicated by name within a Tag, session cards show multiple Tags, and associations can be edited from the bottom sheet
- The phone page supports an independent light/dark theme (persisted per device), touch scrolling, notch safe areas, orientation and dynamic virtual-keyboard height
- The phone attaches a **session-group derivative** (`_web_*`) that mirrors the desktop content but keeps its own current window and size; it is cleaned up on disconnect
- Environment variables: `TMUX_DESK_WEB_PORT`, `TMUX_DESK_WEB_HOST`, `TMUX_DESK_WEB_TOKEN`, `TMUX_DESK_PREFERENCES_FILE`

The web service authenticates with either the random token or a session capability in the URL, but provides no TLS. Prefer Tailscale; LAN URLs are only for trusted Wi-Fi — **never expose port 8790 directly to the public internet**. A complete URL is an access credential; don't forward it.

> **Session-sharing boundary:** the signed URL can only see and attach to its designated session through the Web/API; tampering with it or requesting another session is rejected. It still exposes a real terminal, however. If that session provides a normal shell, the recipient runs commands as your local OS user and may deliberately invoke `tmux`, read files, or connect to other local resources. Share only with people you trust. For process-level isolation, use a separate OS user, container, or tmux socket.

## Advanced environment variables

| Variable | Purpose |
|---|---|
| `TMUX_DESK_SOCKET` | Run all tmux commands against a dedicated socket (`tmux -L <name>`) instead of the default one. Useful for **demos / screenshots / testing** — it never touches your real sessions. Empty → default socket. |
| `TMUX_DESK_PREFERENCES_FILE` | Override the preferences file path (theme, favorites, Tags, window size, …), so a demo/test instance stays isolated from your everyday config. |

## Tests

```bash
npm test
npm run test:integration
npm run build
```

Integration tests use an isolated `tmux -L tmux-desk-test-*` socket and never attach to, modify or close your existing tmux sessions.

## Packaging / building installers

### Easiest: one script (macOS)

```bash
cd Tmux-Desk
./build.sh            # DMG for the current Mac arch (Apple Silicon→arm64, Intel→x64)
./build.sh intel      # force Intel (x64)
./build.sh universal  # universal binary (arm64+x64, larger)
./build.sh all        # both arm64 and x64
```

The script checks the environment, installs deps (rebuilding `node-pty` for Electron), packages, and produces `Tmux Desk-<version>-<arch>.dmg` and `.zip` under `dist/`.

### Per-platform CI release (GitHub Actions)

Pushing a `v*` tag (e.g. `git tag v0.4.0 && git push --tags`) triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds **mac arm64 / mac x64 / Windows NSIS** on macOS and Windows runners and attaches the artifacts to the matching GitHub Release. This is the recommended way to get a **working Windows installer** — the native `node-pty` must be compiled on Windows and can't be cross-produced on a Mac.

### Manual equivalents (macOS)

```bash
npm install                                                     # deps + rebuild node-pty
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac           # arm64 DMG + zip
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac:x64       # Intel
```

Artifacts are **ad-hoc signed** (`codesign --sign -`, see `scripts/afterpack-adhoc.js`) but not notarized. For a real release, configure Developer ID signing and Apple notarization via Electron Builder environment variables — never commit certificates or credentials.

## Local data & privacy

Desktop mode never sends terminal input, output or tmux session data over the network. Once you start the phone web service, terminal data streams in real time between this machine and the token-holding device but is never written to disk; transport encryption is handled by an outer network layer such as Tailscale. Theme, favorites, Tags, Tag-rail expanded state and width, session associations, last session, sidebar width and window size are stored in:

```text
~/Library/Application Support/tmux-desk/preferences.json      # macOS
%APPDATA%\tmux-desk\preferences.json                          # Windows
```

The renderer process has no Node.js access and can only call tmux/terminal operations through allow-listed IPC; control commands use `execFile` argument arrays and never build shell strings.

## FAQ

### The app says tmux isn't found

Run `brew install tmux` (or `sudo apt install tmux` inside WSL), then restart the app or click "Re-detect". The default Apple Silicon Homebrew path is `/opt/homebrew/bin/tmux`.

### node-pty ABI error

The dependency may have been built by a different Node/Electron version. Rerun:

```bash
npm run postinstall
```

### Does switching sessions kill my tasks?

No. Switching only closes the `tmux attach` client for the current window; the tmux server and the processes inside the session keep running. `tmux kill-session` only runs after you explicitly choose "Close session" and confirm.

### Why does some terminal behavior differ from my other terminal?

See the **"tmux behavior vs App behavior"** section above — almost all differences come from `~/.tmux.conf` (prefix, `mouse`, `base-index`, extended keys, …), not the App.

### All my sessions are gone after a reboot?

tmux keeps nothing on disk by itself, but the App snapshots for you and recreates them on the next launch — see **"Restoring sessions after a reboot"** above. If they didn't come back, click the exclamation mark at the top right (or Settings → Session snapshot & restore → View status) for the reason, and send us the `session-snapshot.log` the panel points at.

### My restored sessions came back in my home directory (~)?

That's another restore plugin dropping the working directory when it recreates panes. The App detects it and types a `cd` back into the **idle shell** ("Fix working directories" in Settings, on by default); panes running a program are left alone — check the list in the "Session snapshot" panel and switch those yourself.

## License

[MIT](LICENSE)
