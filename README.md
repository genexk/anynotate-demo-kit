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

All of them take an optional demo folder (default `~/anynotate-demo`) and `--dry-run` (`-DryRun`). Environment overrides:

| Variable | Default |
| --- | --- |
| `ANYNOTATE_DEMO_DIR` | `~/anynotate-demo` |
| `ANYNOTATE_DEMO_PORT` | `5173` |
| `ANYNOTATE_DEMO_REPO` | `https://github.com/genexk/anynotate-demo.git` |
| `ANYNOTATE_HOME` | `~/.anynotate`, as for Anynotate itself |

## What reset touches

- **The demo clone, and only the demo clone.** It must be the top of a git clone with the committed `.anynotate-demo` marker and an `origin` remote ending in `anynotate-demo`; otherwise reset stops before changing anything. Then `git reset --hard origin/main` and `git clean -fd`.
- **The demo server it started**, by the pid in `.serve.pid`. Another process on the port is reported, never stopped.
- **Demo notes in the Anynotate inbox.** A bundle in `$ANYNOTATE_HOME/inbox/<id>/` or `archive/<id>/` is removed only when the `url` in its `annotations.json` is `http://localhost:5173` or starts with `http://localhost:5173/`, `?` or `#`. Bundles being delivered right now are skipped, and `inbox/latest` is repointed if it named a removed bundle. Reading the URL needs `jq` or `python3` (PowerShell reads JSON itself).

Unsent notes live in the browser, out of reach of any script: open Anynotate's Options and click **Clear all unsent notes**.

## License

MIT
