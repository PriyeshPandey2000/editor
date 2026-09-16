# Windows support: implementation plan

Goal: the desktop app ships for Windows with the same features as macOS. Same
editor, same `dapi` CLI on PATH, same MCP registration with every agent, same
auto-update, same signed installer experience.

This document is the plan. Each stage is independently mergeable and leaves
`main` shippable for macOS. Stages are ordered so that every later stage can
be tested from a real Windows installer produced by the stage before it.

Paths below are relative to the repo root.

## Where we start

Most of the code is already portable. What is genuinely macOS-only:

| Area | File | macOS mechanism |
|---|---|---|
| Installer, updater | `apps/desktop/forge.config.ts` | DMG + ZIP makers, `update-electron-app` |
| Signing | `.github/workflows/release.yml` | Apple cert + notarization |
| Bundled CLI wrapper | `apps/desktop/scripts/stage-cli.mjs` | POSIX `sh` script that execs `Contents/MacOS/Diffusion Studio` |
| CLI on PATH | `apps/desktop/src/cli-install.ts` | `/usr/local/bin` symlink, admin prompt via `osascript` |
| CLI launching the app | `apps/cli/src/cli-client.ts` | `open -a` |
| MCP config paths | `apps/desktop/src/mcp-config.ts` | `Library/Application Support` for Claude Desktop and VS Code |
| Window chrome | `apps/desktop/src/main.ts`, `src/native/corner_radius.m` | `hiddenInset`, traffic lights, vibrancy, native corner radius addon |
| App menu | `apps/desktop/src/menu.ts` | Returns early off macOS |
| `fonts` tool | `apps/desktop/src/dapi/handlers/fonts.ts` | JXA via `osascript`; throws `unsupported` elsewhere |
| Dev scripts | `scripts/dev-desktop.mjs`, `apps/cli/package.json` | `lsof`, `ps`, process groups, Homebrew symlink |
| Download gate | `apps/web/src/lib/desktop-app.ts` | Points at the arm64 DMG, refuses other platforms |

Already handles Windows and needs only testing: the agent chat host
(`packages/agent-chat/src/host/env.ts`: PATHEXT lookup, `.cmd` shim
resolution, `taskkill`), deep links (`requestSingleInstanceLock` +
`second-instance`), path normalization in `projects.ts`, the recursive
`fs.watch`, the cloud-sync detector's OneDrive branch, renderer shortcuts
(Ctrl or Meta), and the Claude Agent SDK's win32 binaries.

## Design decisions

These are the choices the stages build on. Settle them first; changing one
later touches several stages.

**Squirrel.Windows, not MSI or MSIX.** `update-electron-app` only knows
Squirrel, and keeping one updater on both platforms is worth more than a
Program Files install. Consequence: the app lives under
`%LOCALAPPDATA%\DiffusionStudio\app-<version>\` and moves to a new folder on
every update. Nothing durable may point into an `app-<version>` folder.

**A stable shim directory for the CLI.** Because the install folder moves,
the `dapi` that goes on PATH is not the staged wrapper. It is a `dapi.cmd`
the app writes to `%LOCALAPPDATA%\DiffusionStudio\bin\` on every packaged
launch, pointing at the current executable. PATH holds that folder; MCP stdio
registrations point at that file. This is the Windows shape of what
`healMcpRegistrations` already does on macOS.

**Window Controls Overlay for the title bar.** `titleBarStyle: "hidden"` plus
`titleBarOverlay` gives native minimize/maximize/close inside our drag strip.
The renderer already has the drag regions; it only needs clearance on the
right where the controls sit. No custom-drawn window buttons.

**Fonts through the renderer on every platform.** Chromium's
`queryLocalFonts` is already what the editor uses to list families. Routing
the `fonts` dapi tool through it makes the tool identical on macOS and
Windows and lets the JXA script go.

**x64 first, arm64 after.** Windows on ARM is a later add: same pipeline,
second matrix entry.

## Stage 0: an installer that installs

Goal: a `Diffusion Studio Setup.exe` built by CI (unsigned) that installs,
launches, opens a project, and exports a video. Nothing about CLI, MCP, or
chrome yet.

Status: implemented on macOS, not yet run on Windows. Every task below is
in place; `.github/workflows/build-windows.yml` (workflow_dispatch) is the
next step, followed by the acceptance checks on a Windows machine. Squirrel's
`iconUrl` points at `assets/icon.ico` on `main`, so Add/Remove Programs
shows the icon only once this lands there.

Tasks:

1. **npm scripts that survive `cmd.exe`.**
   - `apps/desktop/package.json` `build:agent-host`: the single-quoted
     `'--external:@anthropic-ai/claude-agent-sdk-*'` reaches esbuild with
     literal quotes on Windows. Use escaped double quotes.
   - `apps/cli/package.json` `build`: `chmod +x` fails on Windows. Move the
     chmod into a small Node script that no-ops on win32, or drop it (the
     bundled CLI is never run directly).
   - `apps/desktop/scripts/stage-runtime.mjs`, `scripts/release.mjs`,
     `scripts/dev-desktop.mjs`: `execFileSync("npm", …)` cannot spawn
     `npm.cmd` without a shell on Windows. Add one helper that resolves
     `npm.cmd` on win32 and passes `shell: true`, or runs
     `npm-cli.js` through `process.execPath`.
   - `apps/desktop/scripts/build-native.mjs` already exits on non-darwin.
   - Check `patches/` applies cleanly on Windows (`patch-package` at
     postinstall).
2. **Forge config** (`apps/desktop/forge.config.ts`):
   - Add `@electron-forge/maker-squirrel` for `win32` with an explicit
     `name: "DiffusionStudio"` (Squirrel rejects spaces in the package id),
     `setupExe`, `setupIcon: "./assets/icon.ico"`, and `exe:
     "Diffusion Studio.exe"` matching the packager output.
   - Add `./assets/icon.ico` (multi-size, 16 to 256). The `icon: "./assets/icon"`
     base path already lets packager pick `.ico` per platform.
   - Keep the DMG and ZIP makers as they are.
3. **Squirrel startup events** (`apps/desktop/src/squirrel.ts`, new):
   handle `--squirrel-install`, `--squirrel-updated`, `--squirrel-uninstall`,
   `--squirrel-obsolete` at the very top of `main.ts`, before `app.setName`.
   Install and update create the Start Menu shortcut through `Update.exe
   --createShortcut`; uninstall removes it. Quit after handling. Stage 2 adds
   the shim and PATH cleanup to the same hooks, which is why this is our own
   module rather than `electron-squirrel-startup`.
4. **Protocol registration.** `app.setAsDefaultProtocolClient` runs on every
   launch already, so the registry entry follows the moving install folder.
   Verify only.
5. **CI build job** (`.github/workflows/build-windows.yml`, new,
   `workflow_dispatch`): `windows-latest`, Node 20, `npm ci`, copy
   `apps/web/.env.example`, `SKIP_SIGN=1 npm run make --workspace=@diffusionstudio/desktop`,
   upload `apps/desktop/out/make/**` as an artifact. This is the test
   installer for every later stage.

Acceptance:
- Setup exe installs to `%LOCALAPPDATA%\DiffusionStudio`, creates a Start
  Menu entry, and launches.
- A project folder opens, the canvas renders, a 1080p export completes and
  plays in Media Player.
- Uninstall from Settings removes the app and the shortcut.

## Stage 1: window chrome and menu

Goal: the window looks and behaves like a first-class Windows app.

Tasks:

1. **BrowserWindow options** (`apps/desktop/src/main.ts`, `createWindow`):
   on win32 use `titleBarStyle: "hidden"` and `titleBarOverlay: { color:
   "#1c1c1c", symbolColor: "#f8f8f8", height: 40 }` (40px matches the `h-10`
   drag strip in the renderer). Keep `trafficLightPosition` and `vibrancy`
   darwin-only. The corner-radius addon is already gated; Windows 11 rounds
   frameless windows itself.
2. **Renderer clearance** (`apps/web/src`): the sidebar padding is keyed on
   `[data-platform=darwin]` for the traffic lights at top-left. Add the
   win32 counterpart for the top-right: the header actions in
   `agent-chat/header-actions.tsx` and `sidebar-right/inspector/inspector-header.tsx`
   must not sit under the overlay. Prefer the CSS environment variables
   Chromium exposes with the overlay (`env(titlebar-area-x)`,
   `env(titlebar-area-width)`) over a hard-coded width, so the clearance is
   right at every DPI.
3. **Fullscreen.** `enter-full-screen` / `leave-full-screen` fire on Windows
   too; confirm the `WINDOW_FULLSCREEN_CHANGE` event and the
   `data-fullscreen` padding rule behave.
4. **Menu** (`apps/desktop/src/menu.ts`): off macOS, build the same
   role-based menu without the app submenu and set `autoHideMenuBar: true`
   on the window. Without a menu Electron has no accelerators for reload,
   devtools, zoom, or quit. Alt still reveals it, which is normal on Windows.
5. **Dev icon.** The dev-build dock icon is darwin-only; on win32 set the
   window icon from `assets/icon-dev.png` in dev so the taskbar shows it.

Acceptance:
- Minimize/maximize/close render natively, the strip drags the window,
  double-click on the strip maximizes.
- Nothing in the top bar is hidden under the controls at 100 %, 150 %, and
  200 % scaling.
- Ctrl+R, Ctrl+Shift+I, Ctrl+Plus/Minus, Alt+F4 work.

## Stage 2: the `dapi` CLI

Goal: after clicking "Install CLI" in settings, `dapi` works in a fresh
terminal and keeps working after the app updates.

Tasks:

1. **Staged wrapper** (`apps/desktop/scripts/stage-cli.mjs`): on win32 emit
   `cli\bin\dapi.cmd` instead of the shell script:
   ```bat
   @echo off
   setlocal
   set "ELECTRON_RUN_AS_NODE=1"
   "%~dp0..\..\..\Diffusion Studio.exe" "%~dp0..\dapi.js" %*
   ```
   The staged layout on Windows is `<install>\resources\cli\{dapi.js,bin\dapi.cmd}`,
   with the executable at `<install>\Diffusion Studio.exe`. Keep emitting
   the `sh` wrapper on darwin; emit both when a flag asks, so a macOS host
   can stage a Windows tree for inspection.
2. **Stable shim** (`apps/desktop/src/cli-install.ts`): on win32,
   `installCli` and every packaged launch write
   `%LOCALAPPDATA%\DiffusionStudio\bin\dapi.cmd` containing the absolute
   path of `process.execPath` and the staged `dapi.js`. Write atomically
   (`atomic.ts` has the helper). Do the same from the `--squirrel-updated`
   hook so the shim is fresh before the first post-update launch.

   To verify early: whether Squirrel's stub `Diffusion Studio.exe` at the
   install root forwards environment and stdio to the current version. If it
   does, the shim can point at the stub and never go stale. If not, the
   absolute path rewritten at launch is the fallback, and a stale window
   exists only between an update and the next launch.
3. **PATH** (`cli-install.ts`): `installCli` adds the shim folder to the
   user PATH by editing `HKCU\Environment\Path` through PowerShell's
   `[Environment]::SetEnvironmentVariable(…, "User")`, which also broadcasts
   the settings change so new terminals see it. Do not use `setx`: it
   truncates at 1024 characters. `uninstallCli` removes the entry and the
   shim folder. `cliStatus` reads the same key. No admin prompt, so
   `cancelled` never occurs on Windows.
4. **Launching the app from the CLI** (`apps/cli/src/cli-client.ts`
   `launchApp`): on win32 the CLI is Electron running as Node, so
   `process.execPath` is the app. Spawn it `detached` with `stdio:
   "ignore"`, `ELECTRON_RUN_AS_NODE` removed from the env, `--hidden` when
   `background` is set, then `unref()`. This is simpler than the `open -a`
   dance and needs no app name lookup.
5. **Uninstall hygiene** (`squirrel.ts`): `--squirrel-uninstall` removes the
   PATH entry and the shim folder, then stage 3's MCP entries.
6. **Settings copy** (`apps/web/src/components/dashboard/settings-view.tsx`):
   the CLI card mentions `/usr/local/bin` and an admin prompt; branch the
   copy on `window.desktop.platform`.

Acceptance:
- Click Install CLI, open a new PowerShell and a new cmd.exe: `dapi --version`
  and `dapi open <folder>` work; the latter launches the app when it is not
  running.
- Install version N, then N+1 through the updater (stage 5) or a manual
  setup: `dapi` still works from the same terminal.
- Uninstall the app: PATH entry and shim folder are gone.

## Stage 3: MCP registration

Goal: every agent in the settings list connects on Windows.

Tasks:

1. **Per-platform targets** (`apps/desktop/src/mcp-config.ts`): make
   `marker` and `config` platform-aware. Claude Desktop is
   `%APPDATA%\Claude\claude_desktop_config.json`, VS Code is
   `%APPDATA%\Code\User\mcp.json`. The dotfile agents (`.claude.json`,
   `.cursor`, `.codex`, `.gemini`, `.codeium`) are the same relative to the
   home folder. `mcp-install.ts` resolves against `homedir()`; for `APPDATA`
   targets resolve against `process.env.APPDATA` instead. Extend the
   `AgentTarget` type with a resolver rather than a string so the tests in
   `mcp-config.test.ts` stay pure.
2. **stdio entry shape** (`mcp-config.ts` `stdio`): a `.cmd` cannot be
   spawned without a shell by recent Node, and Claude Desktop is not ours to
   configure. Register `command: "cmd", args: ["/c", "<shim>\\dapi.cmd", "mcp"]`
   on win32. `readServer` and `needsBinary` must recognise that shape.
3. **Healing** (`mcp-install.ts` `healMcpRegistrations`): the "is this
   entry ours" check looks for `Diffusion Studio` in the command. On Windows
   the command is `cmd` and the path is in `args`; match on the shim path
   instead. The `AppTranslocation` checks stay darwin-only.
4. **Dev binary**: `DEV_BINARY` is a Homebrew path. On win32 use the shim
   folder; stage 6's dev shim writes there.

Acceptance:
- Connect and disconnect each of Claude Code, Claude Desktop, Cursor,
  VS Code, Codex, Gemini CLI on a Windows machine; each agent lists the
  `diffusion` server and can call `whoami`.
- After an app update, Claude Desktop still starts `dapi mcp` without
  editing its config.

## Stage 4: tool parity

Goal: no dapi tool answers "macOS only".

Tasks:

1. **`fonts`**: move the handler from `apps/desktop/src/dapi/handlers/fonts.ts`
   to the renderer side (`apps/web/src/dapi/handlers/`), built on the
   `queryLocalFonts` wrapper in `apps/web/src/engine/fonts.ts`. Map style
   names to CSS weights and italic the way the JXA did; keep the
   `family`, `weights`, `style`, `limit` filters and the output schema in
   `packages/dapi` unchanged. Delete the JXA. Verify the call works while the
   window is hidden (headless launches).
2. **Cloud sync** (`apps/desktop/src/projects.ts` `cloudSyncKind`): add
   Dropbox (`%USERPROFILE%\Dropbox`, or the paths in
   `%LOCALAPPDATA%\Dropbox\info.json`) and Google Drive (the drive letter or
   folder from `%LOCALAPPDATA%\Google\DriveFS`) to the win32 branch.
3. **`report`**: uses `gh`, which is cross-platform. Verify the `ENOENT`
   path produces the same "install gh" message.
4. **Docs sweep** (`docs/`): `reference/tools/fonts.md` says macOS only;
   `reference/tools/open.md`, `screenshot.md`, `README.md`, and
   `guides/walkthroughs/podcast-clip.md` mention `/Applications` paths or
   macOS. Add the Windows paths beside them. These ship inside the app.
5. **Analytics**: `analytics.ts` already sends the right UA per platform.

Acceptance:
- `dapi fonts`, `dapi media *`, `dapi screenshot`, `dapi export`, `dapi report`
  all succeed on Windows with output shaped like macOS.
- The docs an agent reads on Windows do not tell it to look in
  `/Applications`.

## Stage 5: signing, auto-update, release

Goal: a signed installer that SmartScreen accepts, published by the tag
workflow next to the DMG, updating itself.

Tasks:

1. **Certificate.** Options, in order of preference:
   - Azure Trusted Signing: cheapest, cloud HSM, no token, works in CI.
     Needs an Azure tenant and organization validation.
   - OV or EV Authenticode cert on a cloud HSM (DigiCert KeyLocker, SSL.com
     eSigner). Also CI-friendly, more expensive.
   - A cert on a USB token cannot sign in GitHub Actions.
   Ops task; everything below assumes Trusted Signing.
2. **Signing hook** (`forge.config.ts` `packagerConfig.windowsSign`):
   configure `@electron/windows-sign` with a custom `signWithParams` (or
   the `hookFunction`) that calls the Trusted Signing CLI. Squirrel also
   signs `Setup.exe` and the nupkg contents through the maker's
   `signWithParams`, so both places take the same command.
3. **Release workflow** (`.github/workflows/release.yml`): add a
   `publish-windows` job on `windows-latest` that runs the same version
   check, `npm ci`, env copy, and `npm run publish --workspace=@diffusionstudio/desktop`
   with the signing secrets. Both jobs publish to the same draft release;
   the GitHub publisher appends assets. Squirrel's `RELEASES` file must land
   in the release for the updater to work.
4. **Updater** (`main.ts`): `updateElectronApp({ repo })` already covers
   Squirrel. Verify it finds `RELEASES` and the nupkg and that the
   `--squirrel-updated` hook from stage 2 runs.
5. **Website and README**: `apps/web/src/lib/desktop-app.ts` picks the
   setup exe on Windows (name it version-independent, like the DMG, so
   `releases/latest/download/` resolves); the README badge and download
   copy list Windows. `bump-cask.yml` is macOS-only and stays as is.
6. **Long paths**: add `longPathAware` to the app manifest via the packager's
   `win32metadata` options so deep `node_modules` trees in projects do not
   hit `MAX_PATH`.

Acceptance:
- Fresh Windows 11 VM, no dev tools: download from the site, no SmartScreen
  warning, app runs.
- Install version N, publish N+1, relaunch: the app updates in the
  background and the next launch is N+1. `dapi` and the Claude Desktop
  registration still work after the update.

## Stage 6: dev workflow and polish

Goal: developing on a Windows machine is as easy as on macOS, and the app
gets the Windows 11 look.

Tasks:

1. **`scripts/dev-desktop.mjs`**: port reclaim uses `lsof` and `ps`; tree
   kill uses negative PIDs. On win32 use `Get-NetTCPConnection` or `netstat
   -ano` for the port, `wmic`/`Get-Process` for the command line, and
   `taskkill /T /F` for teardown. Spawn `.cmd` tool shims with `shell: true`.
2. **Dev shim**: `apps/cli/package.json` `symlink:create` links into
   Homebrew. Add a `shim:create` script that writes a `dapi.cmd` into the
   stable shim folder pointing at the workspace build, and teach
   `mcp-install.ts`'s dev binary to use it.
3. **Mica** (`main.ts`): on Windows 11 22H2+, `backgroundMaterial: "mica"`
   with a transparent `backgroundColor` gives the vibrancy look. Electron has
   had bugs combining this with `titleBarOverlay`; treat as optional and
   feature-detect by build number.
4. **arm64**: add `--arch=arm64` to the Windows CI matrix and a second
   Squirrel output. Test on a Windows-on-ARM VM.
5. **winget**: a manifest in `microsoft/winget-pkgs`, bumped by a workflow
   like `bump-cask.yml`. Optional; only once the installer name is stable.

## Verification that needs Windows hardware

These cannot be settled from macOS and should run on a real machine or VM
at the end of stage 0 and again at stage 5:

- **HEVC sources.** Chromium decodes through Media Foundation, which needs
  the optional HEVC Video Extension on many machines. Decide whether to
  detect the missing decoder and explain it, or to transcode through the
  runtime's existing path.
- **WebGPU.** D3D12 instead of Metal. Run the compositor and an export on
  NVIDIA, AMD, and Intel integrated GPUs.
- **Claude Code and Codex.** Both have native Windows builds now; Claude
  Code still wants Git for Windows for its shell tool. Test the chat host's
  probe, login status, and a full session with each.
- **DPI scaling.** 125 % and 150 % are the common Windows defaults; check
  the overlay clearance, the timeline hit targets, and screenshots from the
  `screenshot` tool.
- **Antivirus.** Defender scanning the `app-<version>` folder on first
  launch can make the first start slow; measure and note it in the download
  page if it is bad.

## Out of scope

- A per-machine install under Program Files (would need MSI and a different
  updater).
- Windows 10. Electron 43 still runs there, but Mica and the overlay CSS
  variables do not; nothing in the plan breaks on it, and nothing targets it.
- Linux. Almost everything above carries over, but it is a separate plan.
