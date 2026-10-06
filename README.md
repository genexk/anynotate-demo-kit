# Anynotate demo kit

Everything you need to show [Anynotate](https://github.com/genexk/anynotate) live or on video: a one-page presenter guide and scripts to set up, check and reset the [tomato soup demo site](https://github.com/genexk/anynotate-demo).

The story: a small recipe page has five things wrong with it. You leave a note on each one in Chrome, send the notes to an AI coding agent, and the page fixes itself in front of the audience.

**Presenter guide:** open [`index.html`](index.html), or the GitHub Pages copy of this repository. It has the exact note text for each step, the intent to pick, what the agent should change, and a line to say on camera.

## Quick start

```bash
git clone https://github.com/genexk/anynotate-demo-kit.git ~/anynotate-demo-kit
~/anynotate-demo-kit/scripts/setup.sh    # clone the demo into ~/anynotate-demo, run anynotate doctor, start the page
~/anynotate-demo-kit/scripts/check.sh    # pre-flight
# ...record...
~/anynotate-demo-kit/scripts/reset.sh    # back to the start state
```

On Windows, use the `.ps1` scripts: `pwsh -File scripts\setup.ps1`.

## Scripts

| Script | What it does |
| --- | --- |
| `setup.sh`, `setup.ps1` | Clones or updates the demo, runs `anynotate doctor`, starts the page at http://localhost:5173 and prints the agent folder |
| `check.sh`, `check.ps1` | Pre-flight; changes nothing. Exits 1 when a required check fails |
| `reset.sh`, `reset.ps1` | Resets the demo clone to `origin/main`, restarts the page, removes this page's notes from the Anynotate inbox |

All of them take an optional demo folder (default `~/anynotate-demo`); setup and reset also take `--dry-run` (`-DryRun`). Environment overrides:

| Variable | Default |
| --- | --- |
| `ANYNOTATE_DEMO_DIR` | `~/anynotate-demo` |
| `ANYNOTATE_DEMO_PORT` | `5173` |
| `ANYNOTATE_DEMO_REPO` | `https://github.com/genexk/anynotate-demo.git` |
| `ANYNOTATE_HOME` | `~/.anynotate`, as for Anynotate itself |

## What reset touches

- **The demo clone, and only the demo clone.** It must be the top of a git clone with the committed `.anynotate-demo` marker and an `origin` that is `genexk/anynotate-demo` (or a local path ending in an `anynotate-demo` folder); otherwise reset stops before changing anything. Then `git reset --hard origin/main` and `git clean -fd`.
- **The demo server it started**, by the pid in `.serve.pid`. Another process on the port is reported, never stopped.
- **Demo notes in the Anynotate inbox.** A bundle in `$ANYNOTATE_HOME/inbox/<id>/` or `archive/<id>/` is removed only when the `url` in its `annotations.json` is `http://localhost:5173` or starts with `http://localhost:5173/`, `?` or `#`. Bundles being delivered right now are skipped, and `inbox/latest` is repointed if it named a removed bundle. Reading the URL needs `jq` or `python3` (PowerShell reads JSON itself).

Unsent notes live in the browser, out of reach of any script: open Anynotate's Options and click **Clear all unsent notes**.

## Step screenshots

The guide's "You annotate → Result" pictures in `assets/steps/` come from `scripts/shots/make-shots.ts`. It serves two copies of the demo site, loads the unpacked extension in Playwright's Chromium and makes each note for real; the Result copies get each step's expected fix applied. Nothing is written to the demo clone, `~/.anynotate` or your browser profile.

```bash
cd scripts/shots
bun install
ANYNOTATE_EXTENSION_DIR=/path/to/anynotate-extension/.output/chrome-mv3-e2e bun make-shots.ts
```

| Variable | Default |
| --- | --- |
| `ANYNOTATE_EXTENSION_DIR` | `../anynotate-extension/.output/chrome-mv3-e2e` next to this kit. Needs an e2e build (`bun run build:e2e`), which exposes the hooks the script drives |
| `ANYNOTATE_DEMO_SITE` | `$ANYNOTATE_DEMO_DIR/site` |
| `ANYNOTATE_BRIDGE_DIR` | unset. A checkout of the Anynotate repo; when set, a throwaway bridge with a stand-in herdr pane runs so the dock shows a session |

## Record the demo video

`scripts/video/make-video.ts` records a ~40 second side-by-side clip and a GIF of the whole loop: three notes on the tomato soup page (an element, a text selection and a dragged region over the big tomato), sent to a Claude Code session picked from the dock, then a real Claude Code run that edits the page while the browser watches it reload. Nothing in the edit is scripted: the script runs `claude -p` on a temporary copy of the demo, and if that run fails or changes nothing, it stops without making a video.

```bash
cd scripts/video
bun install
ANYNOTATE_EXTENSION_DIR=/path/to/anynotate-extension/.output/chrome-mv3-e2e \
ANYNOTATE_BRIDGE_DIR=/path/to/anynotate \
bun make-video.ts
```

What it does:

1. Copies the demo clone to a temp folder and serves it with its own live-reload `serve.ts` on a free port.
2. Starts a throwaway bridge with a temp `ANYNOTATE_HOME` (never `~/.anynotate`) and a stand-in herdr that lists three neutral sessions (`claude · anynotate-demo`, `claude · recipes-api`, `codex · shop`), then Playwright's Chromium with the e2e extension build, recording the page at 1280×800. A dot follows the mouse so viewers can see the pointer.
3. Picks the Save recipe button, selects "about 25 minutes" and drags a region over the big tomato, writing a note on each. It then opens the dock's target list, picks the `claude · anynotate-demo` session and presses Send. The open list is the real `<select>` shown expanded in the dock, as in the guide's target-list shot, because the browser's own popup never appears on video.
4. Takes the exact line the bridge typed into the stand-in pane (`Browser notes waiting: read <temp home>/inbox/<id>/README.md and act on them.`) and runs it as `claude -p` in the temp copy with `--model sonnet --max-turns 16`, only the `Read,Edit,Glob,Grep` tools, `--add-dir <temp home>`, `--safe-mode --strict-mcp-config --no-session-persistence` (no hooks, plugins, MCP servers or your CLAUDE.md), the demo's `CLAUDE.md` appended as the system prompt, and `--output-format stream-json --verbose`, timestamping every event. It has four minutes.
5. Renders the terminal pane on the right, a replay of that real run styled like Claude Code: the delivered line appears as the user turn the moment Send is pressed, then each tool call, a one-line summary of each tool result and the agent's final message, in the order and at the times the stream reported them. Nothing in it is invented. For display only, the temp Anynotate home is shown as `~/.anynotate`, the bundle folder as `…` and the temp site copy as `~/anynotate-demo`.
6. Speeds up the agent's working time in both panes by the same factor (shown by a "sped up" badge), puts a caption per step in a bar above the video so it never covers the page, and writes:
   - `anynotate-demo.mp4` (H.264, 1920×856: browser left, terminal right, kept under 20 MB)
   - `anynotate-demo.gif` (1280 wide at 12 fps, stepping down until it is under 15 MB)
   - `anynotate-demo-agent-log.txt`: the notes the agent got, its timestamped events, its final message and the diff it made

Needs `bun`, `ffmpeg`, `ffprobe` and a logged-in `claude` on `PATH`.

| Variable | Default |
| --- | --- |
| `ANYNOTATE_EXTENSION_DIR` | `../anynotate-extension/.output/chrome-mv3-e2e` next to this kit. Needs an e2e build (`bun run build:e2e`) |
| `ANYNOTATE_BRIDGE_DIR` | `../anynotate` next to this kit. A checkout of the Anynotate repo with dependencies installed |
| `ANYNOTATE_DEMO_DIR` | `~/anynotate-demo`. Copied, never written to |
| `ANYNOTATE_VIDEO_OUT` | `~/Downloads` |
| `ANYNOTATE_VIDEO_MODEL` | `sonnet` |
| `ANYNOTATE_VIDEO_CLAUDE` | `claude` |
| `ANYNOTATE_VIDEO_KEEP` | unset. `1` keeps the temp folders (raw recording, site copy, Anynotate home); they are kept anyway when a run fails |

## License

MIT
