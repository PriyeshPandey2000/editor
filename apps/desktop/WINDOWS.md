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

Status: the dev build runs on a Windows machine (2026-09-21), which covers
`npm install` with the patches and the npm scripts in task 1 that the dev
path uses. The installer has not been built or run yet: tasks 2 to 5 are in
place but unexercised, so `.github/workflows/build-windows.yml`
(workflow_dispatch) is the next step, followed by the acceptance checks.
GitHub only lists a manually triggered workflow once its file is on the
default branch, so the workflow file has to reach `main` (a merge, or a
cherry-pick of that one file) before it can be run against this branch.
One fix came out of the dev run: `basename` in `packages/assets/src/types.ts`
split on `/` only and now handles backslashes and trailing separators. Squirrel's
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

Status: running on Windows in the dev build; the acceptance list below was
walked on 2026-09-22 (drag, double-click, scaling, theme switch, fullscreen,
accelerators). Not yet checked from an installer. Differences from the tasks
as written:
- The app has a light/dark switch, so the overlay cannot be one fixed colour.
  The renderer reports the color mode over `WINDOW_SET_COLOR_MODE`
  (`TitleBarColorMode` in `apps/web/src/app.tsx`) and main calls
  `setTitleBarOverlay`. The
  overlay is coloured like the sidebar (`--sidebar`) with symbols in
  `--muted-foreground`, like the other title bar icons; the dark symbol colour
  is that token flattened onto the sidebar, since the overlay takes opaque
  colours only (`WINDOWS_OVERLAY_COLORS` in `main.ts`).
- The editor draws its own title bar on Windows instead of only clearing the
  controls: `WindowsTitleBar` (`apps/web/src/components/ui/windows-title-bar.tsx`),
  filled by `EditorTitleBar` in `sidebar-left.tsx`. It is a fixed 40px row
  under the overlay with three cells: the project menu and layout toggles at
  the width of the left sidebar, the project name centered over the main
  column, and an empty cell at the width of the inspector where the native
  controls sit. The whole row drags the window; interactive children opt out
  with `-webkit-app-region: no-drag`. The editor root pads by
  `--titlebar-height`, which is 40px under `[data-platform=win32]` and 0
  elsewhere, and has to match `WINDOWS_OVERLAY_HEIGHT` in `main.ts`. The row
  stays up when the UI is hidden, so `FloatingProjectHeader` is not rendered
  on Windows, and the first row of the left sidebar drops its top border.
- The dashboard has no such row. Its sidebar header becomes
  `DashboardSidebarTitleBar`, one 40px row level with the controls, and the
  search bar and the billing header shrink to 40px and drag the window.
- The clearance is one CSS variable, `--titlebar-controls-width` in
  `index.css`, built from the `titlebar-area` env variables; it is 0 wherever
  there is no overlay. The dashboard search bar is the only content under the
  controls and pads by it; the title bar's controls cell uses it as a minimum
  width. The inspector header sits below the title bar now and needs nothing,
  as does the chat header, which moved into the left sidebar.

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

Status: the dev path runs on Windows (2026-09-22): the link script's shim
and PATH entry, `dapi --version` and `dapi open` from a fresh terminal. The
packaged path (Install CLI, the staged wrapper, the Squirrel hooks) waits
for the installer. Differences from the tasks as written:
- The shim holds the absolute path of the current executable, rewritten on
  every packaged launch and from the install/update hooks. Whether Squirrel's
  stub exe forwards stdio is still to be checked on hardware; if it does, the
  shim can point at the stub instead.
- PATH is edited through the registry from PowerShell, not
  `[Environment]::SetEnvironmentVariable`, which would expand every
  `%VARIABLE%` already in the user's PATH and store it as a plain string.
  Deleting a variable that does not exist afterwards makes .NET send the
  settings-change broadcast.
- `uninstallCli` only takes the folder off PATH. The shim stays, because MCP
  registrations run it; the Squirrel uninstall hook removes it.
- The settings card no longer mentions `/usr/local/bin`; only the "installed"
  toast differs on Windows (it says to open a new terminal).

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

Status: running on Windows in the dev build (2026-09-22). Checked: the app
listens on 127.0.0.1:3274; the stdio proxy answers `initialize` when spawned
as `cmd /c <shim>\dapi.cmd mcp`, the shape Claude Desktop gets; Connect for
Codex writes the `[mcp_servers.diffusion]` table and `codex mcp list` shows
the server enabled; a live session calls `context`, and Disconnect removes
the entry (2026-09-22). Not every agent in the list has been connected from
Windows. Agent paths are `{ root: "home" | "appData", path }`, and
`appData` resolves through Electron's `app.getPath("appData")`, so the target
table has no platform branches. The Squirrel uninstall hook removes our entry
from every agent.

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
  `diffusion` server and can call `context`.
- After an app update, Claude Desktop still starts `dapi mcp` without
  editing its config.

## Stage 4: tool parity

Goal: no dapi tool answers "macOS only".

Status: `dapi fonts` and `dapi screenshot` run on Windows in the dev build
(2026-09-22), also from a minimized window, and an export completes. `fonts`
has the same output shape as macOS (style names mapped to weights, "Arial
Black" under Arial at 900). `screenshot` turned up one fix: `%TEMP%` is set
with 8.3 short names (`KONSTA~1`) and `os.tmpdir()` passes them through, so
`present.ts` resolves the temp dir with `realpathSync.native` before writing
anything into it. `queryLocalFonts` was
probed in Electron on macOS: it needs no user gesture, but Chromium rejects it
("Page needs to be visible") once a window has been shown and then hidden or
minimized. A never-shown window counts as visible, so `--hidden` launches were
never affected. The main window therefore sets `backgroundThrottling: false`,
which keeps the page visible in every state; the minimized-window check
confirms it holds on Windows. `media *` and `report` have not been run
there. Google Drive's streaming drive is recognised by
shape (a drive root holding `My Drive` on a machine with DriveFS), because its
letter is only in the client's database; check that on hardware.

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

Status: everything but the Azure account is in place (2026-09-22) and none
of it has run yet, since signing needs the account. The certificate is
Azure Artifact Signing, the service Microsoft launched as Trusted Signing
and renamed in 2026; the setup is in the next section. Differences from the
tasks as written:
- Signing is `windowsSign` in `forge.config.ts`, on the packager and on the
  Squirrel maker, so the app's executables, the nupkg contents, and
  `Setup.exe` are all signed with the same options: the Windows SDK
  `signtool.exe`, Microsoft's dlib plugin, a metadata file naming the
  account, Microsoft's timestamp authority, SHA-256 only. The three paths
  come from `WINDOWS_SIGNTOOL_PATH`, `WINDOWS_SIGN_DLIB`, and
  `WINDOWS_SIGN_METADATA`; a Windows build without them fails unless
  `SKIP_SIGN=1`, the same rule as `osxSign`. For the Squirrel side,
  `electron-winstaller` swaps its bundled `signtool.exe` for a Node
  single-executable stub that calls `@electron/windows-sign`, which is why
  the maker takes the options object and not a `signWithParams` string.
- `release.yml` has the `publish-windows` job. It signs in to Azure with
  OIDC (`azure/login`, no client secret), installs the dlib from NuGet,
  picks the newest SDK signtool on the runner, writes the metadata file,
  and publishes. It runs after the macOS job so the two do not race to
  create the draft release.
- The site (`desktop-app.ts`) serves `Diffusion-Studio-x64-Setup.exe` on
  Windows and the DMG on macOS; the promos' copy names the platform; the
  README lists both.
- `assets/app.manifest` is Electron 43's own manifest, read out of
  `electron.exe`, plus `longPathAware`. The packager replaces the manifest
  wholesale, so the file has to be refreshed when Electron's changes.
- Windows on ARM gets the x64 installer under emulation; see stage 6.

Tasks:

1. **Certificate.** Azure Artifact Signing: cheapest, cloud HSM, no token,
   works in CI. Ops task; the next section is the runbook. Alternatives
   would have been an OV or EV cert on a cloud HSM (DigiCert KeyLocker,
   SSL.com eSigner); a cert on a USB token cannot sign in GitHub Actions.
2. **Signing hook** (`forge.config.ts` `windowsSign`): done, see status.
3. **Release workflow** (`.github/workflows/release.yml` `publish-windows`):
   done, see status. Squirrel's `RELEASES` file and the nupkg land in the
   release next to the setup exe; the updater needs all three.
4. **Updater** (`main.ts`): `updateElectronApp({ repo })` already covers
   Squirrel; update.electronjs.org serves `RELEASES` from the release it
   finds for the `.exe` asset. Verify on hardware that the app finds the
   nupkg and that the `--squirrel-updated` hook from stage 2 runs.
5. **Website and README**: done, see status. `bump-cask.yml` is macOS-only
   and stays as is.
6. **Long paths**: done, see status. Windows honours the flag only with the
   `LongPathsEnabled` policy, on by default on Windows 11.

Acceptance:
- Fresh Windows 11 VM, no dev tools: download from the site, no SmartScreen
  warning, app runs.
- Install version N, publish N+1, relaunch: the app updates in the
  background and the next launch is N+1. `dapi` and the Claude Desktop
  registration still work after the update.

### Signing setup on Azure

One-time ops work; nothing in the repo changes. The result is four GitHub
secrets and three repository variables that `publish-windows` reads.

1. **Azure.** A Microsoft Entra tenant and a subscription. Register the
   `Microsoft.CodeSigning` resource provider on the subscription
   (Subscriptions, Resource providers, Register; or
   `az provider register --namespace Microsoft.CodeSigning`).
2. **Account.** Create an *Artifact Signing account* (portal search, or
   `az extension add --name artifact-signing` then
   `az artifact-signing create -n <account> -g <group> -l <region> --sku Basic`).
   Basic is enough: 5,000 signatures a month, and a release signs a few
   dozen files. The region fixes the endpoint, one of
   `https://<code>.codesigning.azure.net` (`weu` for West Europe, `neu` for
   North Europe, `eus` for East US, ...); pick one and keep account and
   profile in it, a mismatch is a 403 at signing time.
3. **Roles.** On the account, assign yourself *Artifact Signing Identity
   Verifier* (needed to create the validation below). Assign the CI
   identity from step 5 *Artifact Signing Certificate Profile Signer*.
4. **Identity validation.** Account, Identity validations, New identity,
   Organization, Public. Legal entity name, website, a monitored mailbox on
   the company domain (a verification link arrives there and expires in
   seven days), business identifier (the register number), address, and the
   name of the person who completes the individual check. Microsoft
   validates against public records; one to twenty business days, with
   document requests by email. This is the step to start first; everything
   else can be done while it is pending, and the Public Trust profile below
   cannot be created until it is Completed.
5. **CI identity.** An Entra app registration (Microsoft Entra ID, App
   registrations, New registration, no redirect URI) with a federated
   credential for GitHub Actions: Certificates & secrets, Federated
   credentials, Add credential, scenario "GitHub Actions deploying Azure
   resources", organization `diffusionstudio`, repository `editor`, entity
   type Environment, environment name `release`. The job declares
   `environment: release`, which is what puts that subject in its OIDC
   token; a tag name would change with every release, an environment does
   not. Create the `release` environment under the repository's Settings,
   Environments (no protection rules needed). No client secret is created;
   the workflow's `id-token: write` permission is the credential.
6. **Certificate profile.** Account, Certificate profiles, Create, Public
   Trust, pick the validated identity. The profile name is the value
   `CertificateProfileName` in the metadata. Certificates are issued per
   signature and live three days, which is why every signature is
   timestamped.
7. **GitHub.** Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` (the app
   registration's application ID), `AZURE_SUBSCRIPTION_ID`. Variables:
   `ARTIFACT_SIGNING_ENDPOINT` (the regional URL), `ARTIFACT_SIGNING_ACCOUNT`,
   `ARTIFACT_SIGNING_PROFILE`. `GITHUB_TOKEN` is the fourth secret and is
   automatic.
8. **Check before the first tag.** Run the workflow's signing steps by
   hand on any Windows machine with the Azure CLI signed in as a user who
   has the Signer role: `nuget install Microsoft.ArtifactSigning.Client -x`,
   write the metadata file, then
   `signtool sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib <dlib> /dmdf <metadata> <any exe>`
   and `signtool verify /pa /v <exe>`. The subject should read the legal
   entity from step 4.

SmartScreen reputation is separate from the signature. Public Trust
certificates from Artifact Signing start with reputation carried over from
Microsoft's validation, so the warning normally does not appear, but a brand
new publisher can still see it for the first downloads.

## Stage 6: dev workflow and polish

Goal: developing on a Windows machine is as easy as on macOS, and the app
gets the Windows 11 look.

Status: task 1 runs on Windows: the dev build starts through
`scripts/dev-desktop.mjs` (2026-09-21). Task 2 is implemented but not yet
confirmed on Windows; the script is `npm run link` in `apps/cli`
(`scripts/dev-link.mjs`), one command on both platforms, which writes the
Homebrew symlink on macOS and, on Windows, the `dapi.cmd` shim plus the user
PATH entry, edited through the registry like `cli-windows.ts` does. Both ran
on Windows on 2026-09-22. A terminal only sees the new PATH when its parent
process started after the change: one opened from VS Code inherits VS Code's
environment until VS Code is restarted, which is why the script says to open
a new terminal. Task 3 (Mica) was
tried and dropped, see below. Tasks 4 and 5 are open. arm64 has one
constraint beyond a matrix entry: update.electronjs.org reads a single
`RELEASES` file from each release for every Windows architecture, so a
second Squirrel output needs either its own release tag or a different
update feed; the x64 installer runs under emulation on Windows on ARM in
the meantime. winget waits for the first signed release, since the manifest
carries the installer's hash.

Mica, tried on Windows on 2026-09-21 and reverted: the window stays solid.
The material worked with `titleBarStyle: "hidden"` and a transparent
`titleBarOverlay` colour, but it does not give the macOS look. Mica is a fixed
tint of the desktop wallpaper (around #202020 in dark mode), not a blur of
what is behind the window, so it read lighter than the macOS backdrop; laying
the app's 7% grey over it to match the depth left too little of the material
to be worth the moving parts. Those were: feature detection by build number
(22621), a flag from main to the page to make `--sidebar` transparent,
`nativeTheme.themeSource` following the app's theme preference (Windows tints
Mica from the app theme, not the page), and no stacked `bg-sidebar` once the
colour is translucent. The attempt is in commits 7145e69 and a34c00d if it is
picked up again; `backgroundMaterial: "acrylic"` is the option that actually
blurs the content behind the window.

Tasks:

1. **`scripts/dev-desktop.mjs`**: port reclaim uses `lsof` and `ps`; tree
   kill uses negative PIDs. On win32 use `Get-NetTCPConnection` or `netstat
   -ano` for the port, `wmic`/`Get-Process` for the command line, and
   `taskkill /T /F` for teardown. Spawn `.cmd` tool shims with `shell: true`.
2. **Dev shim**: `apps/cli/package.json` `symlink:create` links into
   Homebrew. Add a script that writes a `dapi.cmd` into the stable shim
   folder pointing at the workspace build, and teach `mcp-install.ts`'s dev
   binary to use it.
3. **Mica** (`main.ts`): on Windows 11 22H2+, `backgroundMaterial: "mica"`
   with a transparent `backgroundColor` gives the vibrancy look. Electron has
   had bugs combining this with `titleBarOverlay`; treat as optional and
   feature-detect by build number. Dropped, see the status above.
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
  Code still wants Git for Windows for its shell tool. Probe, login status,
  and a session ran on 2026-09-22 in the dev build. The native Codex
  installer's folder (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`) was
  missing from the chat host's fallback dirs and is there now; an app whose
  launching process predates an install still needs a restart from a fresh
  terminal, since it only sees that process's PATH.
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
