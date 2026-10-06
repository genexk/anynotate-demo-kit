import { chromium, type BrowserContext, type Locator, type Page, type Worker } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const HERE = import.meta.dir;
const KIT = path.resolve(HERE, "../..");
const EXT = process.env.ANYNOTATE_EXTENSION_DIR ?? path.resolve(KIT, "../anynotate-extension/.output/chrome-mv3-e2e");
const DEMO = process.env.ANYNOTATE_DEMO_DIR ?? path.join(homedir(), "anynotate-demo");
const BRIDGE_REPO = process.env.ANYNOTATE_BRIDGE_DIR ?? path.resolve(KIT, "../anynotate");
const OUT = process.env.ANYNOTATE_VIDEO_OUT ?? path.join(homedir(), "Downloads");
const CLAUDE = process.env.ANYNOTATE_VIDEO_CLAUDE ?? "claude";
const AGENT_MODEL = process.env.ANYNOTATE_VIDEO_MODEL ?? "sonnet";
const AGENT_TIMEOUT_MS = 180_000;
const KEEP = process.env.ANYNOTATE_VIDEO_KEEP === "1";
const VIEW = { width: 1280, height: 800 };
const FPS = 30;
const CARD_SECONDS = 1.2;
const PANE = { pane: "w1:p2", agent: "claude", cwd: "/home/me/anynotate-demo", title: "tomato soup" };
const INBOX_VALUE = JSON.stringify({ agent: "claude" });
const AGENT_TOOLS = "Read,Edit,Glob,Grep";

const NOTE_1 = "Hard to read. Make it high-contrast, keep it orange.";
const NOTE_2 = "Badge says 45. Which is right? Make them agree.";
const PHRASE = "about 25 minutes";

const BEATS = ["1 · Point at it", "2 · Say what you want", "3 · Send to your Claude Code session", "4 · Claude Code edits the page"];

function fail(message: string): never {
  throw new Error(message);
}

const sleep = (ms: number) => Bun.sleep(ms);
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// Calls step(t) for t in (0, 1] against the wall clock, so slow round trips skip frames instead of stretching time.
async function animate(ms: number, step: (t: number) => Promise<unknown>) {
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / ms);
    await step(t);
    if (t >= 1) return;
    await sleep(12);
  }
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

const ffmpeg = (args: string[]) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const duration = (file: string) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
const mb = (file: string) => statSync(file).size / 1024 / 1024;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function copyDemo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "anynotate-video-site-"));
  cpSync(DEMO, dir, {
    recursive: true,
    filter: (src) => !/[/\\](\.git|node_modules|\.serve\.pid)$/.test(src),
  });
  return dir;
}

async function serveDemo(dir: string): Promise<{ proc: ChildProcess; url: string }> {
  const port = await freePort();
  const proc = spawn("bun", ["serve.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) fail(`the demo server exited with ${proc.exitCode}`);
    try {
      if ((await fetch(url)).ok) return { proc, url };
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  fail("the demo server never answered");
}

async function startBridge(home: string, extensionId: string): Promise<{ proc: ChildProcess; url: string; token: string }> {
  const port = await freePort();
  const list = path.join(home, "herdr-list.json");
  writeFileSync(list, JSON.stringify({ result: { agents: [{ agent: PANE.agent, agent_status: "idle", cwd: PANE.cwd, pane_id: PANE.pane, terminal_title_stripped: PANE.title }] } }));
  const shim = path.join(home, "herdr");
  writeFileSync(shim, `#!/bin/sh\nexec bun '${path.join(BRIDGE_REPO, "test/fixtures/herdr-shim.ts")}' "$@"\n`, { mode: 0o755 });
  const empty = path.join(home, "empty");
  mkdirSync(empty);
  const proc = spawn(path.join(BRIDGE_REPO, "bin/anynotate"), ["bridge"], {
    env: {
      ...process.env,
      ANYNOTATE_HOME: home,
      ANYNOTATE_PORT: String(port),
      ANYNOTATE_ALLOWED_ORIGINS: `chrome-extension://${extensionId}`,
      ANYNOTATE_HERDR: shim,
      HERDR_SHIM_LIST: list,
      HERDR_SHIM_LOG: path.join(home, "herdr.log"),
      CLAUDE_CONFIG_DIR: empty,
      CODEX_HOME: empty,
    },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(home, "token");
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) fail(`bridge exited with ${proc.exitCode}`);
    if (existsSync(tokenFile)) {
      const token = readFileSync(tokenFile, "utf8").trim();
      try {
        if (token && (await fetch(`${url}/sessions`, { headers: { "X-Anynotate-Token": token } })).status === 200) return { proc, url, token };
      } catch { /* not listening yet */ }
    }
    await sleep(100);
  }
  fail("the throwaway bridge never answered");
}

// Runs in every page load, so the dot survives the live-reload refreshes. It sits in the top layer, above the dock.
function cursorScript() {
  if (window.top !== window) return;
  const KEY = "demo-cursor-pos";
  const install = () => {
    const dot = document.createElement("div");
    dot.setAttribute("popover", "manual");
    dot.setAttribute("aria-hidden", "true");
    dot.id = "demo-cursor";
    dot.style.cssText = [
      "position:fixed", "inset:auto", "left:0", "top:0", "margin:0", "padding:0", "border:0", "overflow:visible",
      "width:20px", "height:20px", "border-radius:50%", "background:rgba(20,20,20,.55)",
      "box-shadow:0 0 0 2px #fff,0 2px 8px rgba(0,0,0,.35)", "pointer-events:none",
      "transition:transform 90ms ease-out, background 90ms", "display:none",
    ].join(";");
    let x = 0, y = 0, down = false;
    const place = () => {
      dot.style.transform = `translate(${x - 10}px, ${y - 10}px) scale(${down ? 0.7 : 1})`;
    };
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
      if (saved) { x = saved.x; y = saved.y; dot.style.display = "block"; place(); }
    } catch { /* no storage */ }
    document.documentElement.appendChild(dot);
    dot.showPopover();
    addEventListener("mousemove", (e) => {
      x = e.clientX; y = e.clientY;
      dot.style.display = "block";
      place();
      try { sessionStorage.setItem(KEY, JSON.stringify({ x, y })); } catch { /* no storage */ }
    }, true);
    addEventListener("mousedown", () => { down = true; dot.style.background = "rgba(234,88,12,.85)"; place(); }, true);
    addEventListener("mouseup", () => { down = false; dot.style.background = "rgba(20,20,20,.55)"; place(); }, true);
  };
  if (document.documentElement) install();
  else addEventListener("DOMContentLoaded", install);
}

class Director {
  private x = VIEW.width / 2;
  private y = VIEW.height / 2;
  constructor(private page: Page) {}

  async glide(x: number, y: number, ms = 650) {
    const sx = this.x, sy = this.y;
    await animate(ms, (t) => this.page.mouse.move(sx + (x - sx) * ease(t), sy + (y - sy) * ease(t)));
    this.x = x;
    this.y = y;
  }

  async glideTo(target: Locator, ms = 650, dx = 0.5, dy = 0.5) {
    const b = await target.boundingBox();
    if (!b) fail(`nothing to point at: ${target}`);
    await this.glide(b.x + b.width * dx, b.y + b.height * dy, ms);
  }

  async click() {
    await this.page.mouse.down();
    await sleep(90);
    await this.page.mouse.up();
  }

  async clickOn(target: Locator, ms = 650) {
    await this.glideTo(target, ms);
    await sleep(150);
    await this.click();
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }, ms = 700) {
    await this.glide(from.x, from.y, 500);
    await sleep(120);
    await this.page.mouse.down();
    await animate(ms, (t) => this.page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t));
    await this.page.mouse.up();
    this.x = to.x;
    this.y = to.y;
  }

  async scrollTo(top: number, ms = 900) {
    const from = await this.page.evaluate(() => scrollY);
    await animate(ms, (t) => this.page.evaluate((y) => scrollTo(0, y), from + (top - from) * ease(t)));
  }

  async scrollToShow(selector: string, offset: number, ms = 900) {
    const top = await this.page.evaluate(([sel, off]) => {
      const el = document.querySelector(sel as string)!;
      const max = document.documentElement.scrollHeight - innerHeight;
      return Math.max(0, Math.min(max, el.getBoundingClientRect().top + scrollY - (off as number)));
    }, [selector, offset] as const);
    await this.scrollTo(top, ms);
  }

  async keycap(label: string, ms = 1300) {
    await this.page.evaluate(([text, hold]) => {
      const k = document.createElement("div");
      k.setAttribute("popover", "manual");
      k.setAttribute("aria-hidden", "true");
      k.textContent = text as string;
      k.style.cssText = "position:fixed;inset:auto;left:50%;bottom:120px;transform:translateX(-50%);margin:0;padding:10px 18px;border:0;border-radius:12px;background:rgba(20,20,20,.86);color:#fff;font:600 22px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:none";
      document.documentElement.appendChild(k);
      k.showPopover();
      setTimeout(() => k.remove(), hold as number);
    }, [label, ms] as const);
  }

  async type(text: string) {
    const start = Date.now();
    for (const [i, ch] of [...text].entries()) {
      await this.page.keyboard.type(ch);
      await sleep(Math.max(0, start + (i + 1) * 25 - Date.now()));
    }
  }
}

async function phraseBox(page: Page, selector: string, phrase: string) {
  return page.evaluate(([sel, text]) => {
    const n = document.querySelector(sel)!.firstChild as Text;
    const from = n.data.indexOf(text);
    const r = document.createRange();
    r.setStart(n, from);
    r.setEnd(n, from + text.length);
    const rects = [...r.getClientRects()];
    const first = rects[0]!, last = rects[rects.length - 1]!;
    return {
      from: { x: first.left + 1, y: (first.top + first.bottom) / 2 },
      to: { x: last.right - 1, y: (last.top + last.bottom) / 2 },
    };
  }, [selector, phrase] as const);
}

async function writeNote(d: Director, page: Page, text: string, intent: "change" | "explain") {
  const comment = page.locator("#comment");
  await comment.waitFor({ state: "visible" });
  await sleep(200);
  await d.clickOn(comment, 400);
  await sleep(150);
  await d.type(text);
  await sleep(300);
  await d.clickOn(page.locator(`#popover [data-intent="${intent}"]`), 450);
  await sleep(350);
  await d.clickOn(page.locator("#save"), 400);
  await sleep(600);
}

type AgentResult = { ok: boolean; text: string; turns?: number; seconds: number; raw: string; stderr: string };

async function runAgent(siteDir: string, home: string): Promise<AgentResult> {
  const prompt = `Browser notes waiting: read ${path.join(home, "inbox/latest/README.md")} and act on them. Keep changes minimal.`;
  const args = [
    "-p", prompt,
    "--model", AGENT_MODEL,
    "--max-turns", "12",
    "--tools", AGENT_TOOLS,
    "--allowedTools", AGENT_TOOLS,
    "--add-dir", home,
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--append-system-prompt-file", path.join(siteDir, "CLAUDE.md"),
    "--output-format", "json",
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(CLAUDE, args, { cwd: siteDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, text: `could not start ${CLAUDE}: ${err}`, seconds: 0, raw: "", stderr: "" });
      return;
    }
    let out = "", err = "";
    proc.stdout!.on("data", (c) => (out += c));
    proc.stderr!.on("data", (c) => (err += c));
    const timer = setTimeout(() => proc.kill("SIGTERM"), AGENT_TIMEOUT_MS);
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `could not start ${CLAUDE}: ${e.message}`, seconds: 0, raw: out, stderr: err });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      const seconds = (Date.now() - started) / 1000;
      if (signal) return resolve({ ok: false, text: `claude was stopped (${signal}) after ${seconds.toFixed(0)} s`, seconds, raw: out, stderr: err });
      try {
        const parsed = JSON.parse(out);
        const result = (Array.isArray(parsed) ? parsed : [parsed]).findLast((m: { type?: string }) => m.type === "result");
        const ok = code === 0 && result?.subtype === "success" && !result.is_error;
        resolve({ ok, text: String(result?.result ?? result?.subtype ?? "(no result)"), turns: result?.num_turns, seconds, raw: out, stderr: err });
      } catch {
        resolve({ ok: false, text: `claude exited with ${code} and no JSON result`, seconds, raw: out, stderr: err });
      }
    });
  });
}

function siteDiff(siteDir: string): string {
  const r = spawnSync("diff", ["-ru", path.join(DEMO, "site"), path.join(siteDir, "site")], { encoding: "utf8" });
  return r.stdout.replaceAll(path.join(DEMO, "site"), "a/site").replaceAll(path.join(siteDir, "site"), "b/site");
}

async function renderOverlays(dir: string, card: { title: string; sub: string }) {
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
  const font = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  const files: string[] = [];
  for (const [i, beat] of BEATS.entries()) {
    const [num, label] = beat.split(" · ");
    await page.setContent(`<html><body style="margin:0;background:transparent">
      <div style="position:absolute;left:32px;bottom:30px;display:flex;align-items:center;gap:12px;padding:12px 22px 12px 14px;border-radius:14px;background:rgba(17,17,17,.84);color:#fff;font:600 24px/1.1 ${font};box-shadow:0 8px 28px rgba(0,0,0,.28)">
        <span style="display:inline-grid;place-items:center;width:34px;height:34px;border-radius:50%;background:#ea580c;font-size:19px">${num}</span>${label}
      </div></body></html>`);
    const file = path.join(dir, `caption-${i + 1}.png`);
    await page.screenshot({ path: file, omitBackground: true });
    files.push(file);
  }
  await page.setContent(`<html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#16181d;color:#fff;font-family:${font}">
    <div style="text-align:center">
      <div style="font:700 44px/1.2 ${font};letter-spacing:-.01em">${card.title}</div>
      <div style="margin-top:18px;font:500 22px/1.4 ${font};color:#c9ced8">${card.sub}</div>
    </div></body></html>`);
  const cardFile = path.join(dir, "card.png");
  await page.screenshot({ path: cardFile });
  await browser.close();
  return { captions: files, card: cardFile };
}

type Segment = [number, number];

function keepSegments(m: Record<string, number>, changes: number[], end: number): Segment[] {
  const clusters: Segment[] = [];
  for (const c of changes) {
    const last = clusters.at(-1);
    if (last && c - last[1] < 1.5) last[1] = c;
    else clusters.push([c, c]);
  }
  const segs: Segment[] = [[m.pageReady!, m.sendShown!], ...clusters.map(([a, b]) => [a - 0.6, b + 1.3] as Segment), [m.revealStart!, end]];
  const merged: Segment[] = [];
  for (const [a, b] of segs) {
    const last = merged.at(-1);
    const start = Math.max(a, last ? last[1] : a);
    if (b <= start) continue;
    if (last && start - last[1] < 0.3) last[1] = b;
    else merged.push([start, b]);
  }
  return merged;
}

function mapTime(t: number, segs: Segment[], cardAfterFirst: number): number {
  let out = 0;
  for (const [i, [a, b]] of segs.entries()) {
    if (t <= b) return out + Math.max(0, t - a);
    out += b - a;
    if (i === 0) out += cardAfterFirst;
  }
  return out;
}

async function main() {
  if (!existsSync(path.join(EXT, "manifest.json"))) fail(`no extension build at ${EXT}; set ANYNOTATE_EXTENSION_DIR to an e2e build (wxt build --mode e2e)`);
  if (!existsSync(path.join(DEMO, "serve.ts")) || !existsSync(path.join(DEMO, "site/index.html"))) fail(`no demo clone at ${DEMO}; set ANYNOTATE_DEMO_DIR`);
  if (!existsSync(path.join(BRIDGE_REPO, "bin/anynotate"))) fail(`no Anynotate checkout at ${BRIDGE_REPO}; set ANYNOTATE_BRIDGE_DIR`);
  if (spawnSync(CLAUDE, ["--version"]).status !== 0) fail(`${CLAUDE} is not runnable; the video needs a real Claude Code run`);
  for (const tool of ["ffmpeg", "ffprobe"]) if (spawnSync(tool, ["-version"]).status !== 0) fail(`${tool} not found`);
  mkdirSync(OUT, { recursive: true });

  const work = mkdtempSync(path.join(tmpdir(), "anynotate-video-work-"));
  const siteDir = copyDemo();
  const home = mkdtempSync(path.join(tmpdir(), "anynotate-video-home-"));
  const server = await serveDemo(siteDir);
  let bridge: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  let succeeded = false;
  try {
    context = await chromium.launchPersistentContext(path.join(home, "profile"), {
      channel: "chromium",
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
      viewport: VIEW,
      deviceScaleFactor: 1,
      colorScheme: "light",
      recordVideo: { dir: path.join(work, "raw"), size: VIEW },
    });
    const t0 = Date.now();
    const marks: Record<string, number> = {};
    const mark = (name: string) => (marks[name] = (Date.now() - t0) / 1000);

    await context.addInitScript(cursorScript);
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const extensionId = worker.url().split("/")[2]!;
    if ((await worker.evaluate(() => typeof (globalThis as Record<string, unknown>).anynotateCommand)) !== "function") {
      fail("this extension build has no test hooks; build it with wxt build --mode e2e");
    }
    const b = await startBridge(home, extensionId);
    bridge = b.proc;
    await worker.evaluate(({ url, token }) => chrome.storage.local.set({ bridge: { url }, e2eToken: token }), b);

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(server.url);
    const d = new Director(page);
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
    mark("pageReady");
    await sleep(700);

    mark("beat1");
    await d.glide(900, 330, 500);
    await d.keycap("Alt + Shift + A", 1100);
    await sleep(250);
    await (worker as Worker).evaluate(() => (globalThis as unknown as { anynotateCommand(c: string): Promise<unknown> }).anynotateCommand("toggle-annotate"));
    await page.locator("#dock").waitFor({ state: "visible" });
    await sleep(700);

    await d.scrollToShow(".actions", 430, 900);
    await sleep(200);
    await d.clickOn(page.locator("#pick"), 550);
    await sleep(200);
    await d.glideTo(page.locator("#save-recipe"), 750);
    await sleep(550);
    await d.click();
    mark("beat2");
    await writeNote(d, page, NOTE_1, "change");

    await d.scrollToShow(".intro", 260, 900);
    await sleep(250);
    const p = await phraseBox(page, ".intro", PHRASE);
    await d.drag(p.from, p.to, 700);
    await writeNote(d, page, NOTE_2, "explain");

    mark("beat3");
    await d.scrollToShow(".actions", 430, 800);
    const target = page.locator("#target");
    await target.locator(`option[value='${INBOX_VALUE}']`).waitFor({ state: "attached", timeout: 10_000 });
    await d.clickOn(target, 500);
    await target.selectOption(INBOX_VALUE);
    await sleep(600);
    await d.clickOn(page.locator("#send"), 450);
    mark("sendClick");
    await d.glide(1000, 330, 450);
    await page.locator("#status").filter({ hasText: /queued|delivered|sent/ }).waitFor({ timeout: 15_000 });
    await sleep(1300);
    mark("sendShown");

    const readme = path.join(home, "inbox/latest/README.md");
    for (let i = 0; i < 100 && !existsSync(readme); i++) await sleep(100);
    if (!existsSync(readme)) fail("the bridge never wrote inbox/latest/README.md");

    await d.glide(1180, 120, 400);

    const changes: number[] = [];
    const watcher = watch(path.join(siteDir, "site"), { recursive: true }, () => changes.push((Date.now() - t0) / 1000));
    mark("agentStart");
    console.log("running claude -p on the temp copy…");
    const agent = await runAgent(siteDir, home);
    mark("agentEnd");
    await sleep(1500);
    watcher.close();
    const diff = siteDiff(siteDir);

    const log = [
      "Anynotate demo video: the agent run behind the edit",
      "",
      `Command: claude -p --model ${AGENT_MODEL} --max-turns 12 --tools ${AGENT_TOOLS} --allowedTools ${AGENT_TOOLS} --add-dir <temp ANYNOTATE_HOME> --safe-mode --strict-mcp-config --no-session-persistence --append-system-prompt-file <demo>/CLAUDE.md`,
      `Prompt: Browser notes waiting: read <temp ANYNOTATE_HOME>/inbox/latest/README.md and act on them. Keep changes minimal.`,
      `Result: ${agent.ok ? "success" : "FAILED"} · ${agent.seconds.toFixed(1)} s${agent.turns ? ` · ${agent.turns} turns` : ""}`,
      "",
      "## The notes the agent received (inbox/latest/README.md)",
      "",
      readFileSync(readme, "utf8").replaceAll(home, "<temp ANYNOTATE_HOME>"),
      "## Agent's final message",
      "",
      agent.text,
      "",
      "## Diff it made to the demo site",
      "",
      diff || "(no changes)",
      ...(agent.ok ? [] : ["", "## stderr", "", agent.stderr]),
    ].join("\n");
    const logFile = path.join(OUT, "anynotate-demo-agent-log.txt");
    writeFileSync(logFile, log);
    if (!agent.ok) fail(`the agent run failed: ${agent.text}\nlog: ${logFile}`);
    if (!diff) fail(`the agent changed nothing, so there is no honest video to make\nlog: ${logFile}`);

    mark("revealStart");
    await d.glideTo(page.locator("#save-recipe"), 600, 0.5, 1.6);
    await sleep(1000);
    await d.scrollTo(0, 900);
    await sleep(200);
    await d.glideTo(page.locator(".meta span").nth(1), 600);
    await sleep(700);
    await d.glideTo(page.locator(".intro"), 600, 0.75, 0.75);
    await sleep(2000);
    mark("end");

    const closeAt = (Date.now() - t0) / 1000;
    const video = page.video();
    await context.close();
    context = undefined;
    const rawPath = await video!.path();

    const cfr = path.join(work, "raw.mp4");
    ffmpeg(["-i", rawPath, "-vf", `fps=${FPS},scale=${VIEW.width}:${VIEW.height},setsar=1,format=yuv420p`, "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", cfr]);
    const shift = duration(cfr) - closeAt;
    const at = (name: string) => marks[name]! + shift;
    const shifted = Object.fromEntries(Object.keys(marks).map((k) => [k, at(k)]));
    const segs = keepSegments(shifted, changes.map((c) => c + shift), at("end"));

    const overlays = await renderOverlays(work, {
      title: "Claude Code is working…",
      sub: `headless claude -p read the notes and edited the page · agent ran ~${Math.round(agent.seconds)} s, shortened here`,
    });

    const edited = path.join(work, "edited.mp4");
    const n = segs.length;
    const parts = segs.map(([a, b2], i) => `[r${i}]trim=start=${a.toFixed(3)}:end=${b2.toFixed(3)},setpts=PTS-STARTPTS[s${i}]`);
    const order = segs.map((_, i) => (i === 0 ? `[s0][card]` : `[s${i}]`)).join("");
    const graph = [
      `[0:v]split=${n}${segs.map((_, i) => `[r${i}]`).join("")}`,
      ...parts,
      `[1:v]scale=${VIEW.width}:${VIEW.height},fps=${FPS},setsar=1,format=yuv420p,trim=duration=${CARD_SECONDS},setpts=PTS-STARTPTS,fade=in:st=0:d=0.15,fade=out:st=${CARD_SECONDS - 0.15}:d=0.15[card]`,
      `${order}concat=n=${n + 1}:v=1:a=0[v]`,
    ].join(";");
    ffmpeg(["-i", cfr, "-loop", "1", "-framerate", String(FPS), "-t", String(CARD_SECONDS), "-i", overlays.card, "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", edited]);

    const total = duration(edited);
    const cardStart = mapTime(segs[0]![1], segs, 0);
    const windows: Segment[] = [
      [mapTime(at("beat1"), segs, CARD_SECONDS), mapTime(at("beat2"), segs, CARD_SECONDS)],
      [mapTime(at("beat2"), segs, CARD_SECONDS), mapTime(at("beat3"), segs, CARD_SECONDS)],
      [mapTime(at("beat3"), segs, CARD_SECONDS), cardStart],
      [cardStart + CARD_SECONDS, total],
    ];
    const mp4 = path.join(OUT, "anynotate-demo.mp4");
    const capInputs = overlays.captions.flatMap((f) => ["-loop", "1", "-t", total.toFixed(3), "-i", f]);
    let chain = "[0:v]";
    const capGraph = windows.map(([a, b2], i) => {
      const outLabel = i === windows.length - 1 ? "[v]" : `[o${i}]`;
      const step = `${chain}[${i + 1}:v]overlay=0:0:shortest=1:enable='between(t,${a.toFixed(3)},${b2.toFixed(3)})'${outLabel}`;
      chain = outLabel;
      return step;
    }).join(";");
    for (const crf of [22, 26, 30]) {
      ffmpeg(["-i", edited, ...capInputs, "-filter_complex", capGraph, "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
      if (mb(mp4) <= 20) break;
    }

    const gif = path.join(OUT, "anynotate-demo.gif");
    for (const [fps, width] of [[14, 960], [12, 960], [10, 880], [10, 800]] as const) {
      ffmpeg(["-i", mp4, "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", gif]);
      if (mb(gif) <= 15) {
        console.log(`gif: ${fps} fps, ${width} wide`);
        break;
      }
    }

    console.log(JSON.stringify({
      mp4: { path: mp4, mb: +mb(mp4).toFixed(2), seconds: +duration(mp4).toFixed(2) },
      gif: { path: gif, mb: +mb(gif).toFixed(2) },
      log: logFile,
      agent: { seconds: +agent.seconds.toFixed(1), turns: agent.turns, text: agent.text },
      segments: segs.map(([a, b2]) => [+a.toFixed(2), +b2.toFixed(2)]),
      captions: windows.map(([a, b2]) => [+a.toFixed(2), +b2.toFixed(2)]),
    }, null, 2));
    succeeded = true;
  } finally {
    await context?.close();
    bridge?.kill();
    server.proc.kill();
    if (KEEP || !succeeded) console.error(`kept temp dirs: ${work} ${siteDir} ${home}`);
    else for (const dir of [work, siteDir, home]) rmSync(dir, { recursive: true, force: true });
  }
}

await main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
