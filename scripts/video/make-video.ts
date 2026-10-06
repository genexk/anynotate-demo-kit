import { chromium, type BrowserContext, type Locator, type Page, type Worker } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
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
const AGENT_TIMEOUT_MS = 240_000;
const AGENT_MAX_TURNS = "16";
const KEEP = process.env.ANYNOTATE_VIDEO_KEEP === "1";
const VIEW = { width: 1280, height: 800 };
const TERM = { width: 640, height: 800 };
const BAR_HEIGHT = 56;
const FPS = 30;
const AGENT_ON_SCREEN_SECONDS = 5;
const AGENT_TOOLS = "Read,Edit,Glob,Grep";
const INBOX_VALUE = JSON.stringify({ agent: "claude" });

// Stand-in herdr panes. The first is the session the notes go to; the terminal pane in the video is its replay.
const SESSIONS = [
  { pane: "w1:p2", agent: "claude", cwd: "/home/me/anynotate-demo", title: "tomato soup" },
  { pane: "w1:p3", agent: "claude", cwd: "/home/me/recipes-api", title: "fix tests" },
  { pane: "w2:p1", agent: "codex", cwd: "/home/me/shop", title: "pricing" },
];
const SESSION = SESSIONS[0]!;
const SESSION_LABEL = `${SESSION.agent} · ${path.basename(SESSION.cwd)}`;
const TERM_CWD = "~/anynotate-demo";

const NOTE_1 = "Hard to read. Make it high-contrast, keep it orange.";
const NOTE_2 = "Badge says 45. Which is right? Make them agree.";
const NOTE_3 = "Make this tomato a deeper, riper red.";
const PHRASE = "about 25 minutes";
// The big tomato in the hero SVG (viewBox 680×200): circle at (320, 106), r 74, stem up to y 34.
const TOMATO_BOX = { x1: 238, y1: 26, x2: 402, y2: 186, viewWidth: 680, viewHeight: 200 };

const BEATS = ["1 · Point at it", "2 · Say what you want", "3 · Drag over anything", "4 · Pick your session and send", "5 · Claude Code edits the page"];

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

async function startBridge(home: string, extensionId: string): Promise<{ proc: ChildProcess; url: string; token: string; herdrLog: string }> {
  const port = await freePort();
  const list = path.join(home, "herdr-list.json");
  const agents = SESSIONS.map((s) => ({ agent: s.agent, agent_status: "idle", cwd: s.cwd, pane_id: s.pane, terminal_title_stripped: s.title }));
  writeFileSync(list, JSON.stringify({ result: { agents } }));
  const shim = path.join(home, "herdr");
  writeFileSync(shim, `#!/bin/sh\nexec bun '${path.join(BRIDGE_REPO, "test/fixtures/herdr-shim.ts")}' "$@"\n`, { mode: 0o755 });
  const empty = path.join(home, "empty");
  mkdirSync(empty);
  const herdrLog = path.join(home, "herdr.log");
  const proc = spawn(path.join(BRIDGE_REPO, "bin/anynotate"), ["bridge"], {
    env: {
      ...process.env,
      ANYNOTATE_HOME: home,
      ANYNOTATE_PORT: String(port),
      ANYNOTATE_ALLOWED_ORIGINS: `chrome-extension://${extensionId}`,
      ANYNOTATE_HERDR: shim,
      HERDR_SHIM_LIST: list,
      HERDR_SHIM_LOG: herdrLog,
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
        if (token && (await fetch(`${url}/sessions`, { headers: { "X-Anynotate-Token": token } })).status === 200) return { proc, url, token, herdrLog };
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
    const press = (d: boolean) => {
      down = d;
      dot.style.background = d ? "rgba(234,88,12,.85)" : "rgba(20,20,20,.55)";
      place();
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
    addEventListener("mousedown", () => press(true), true);
    addEventListener("mouseup", () => press(false), true);
    // A press the page never sees: clicking a closed <select> for real would open the OS popup, which video cannot show.
    (window as unknown as { demoPress(d: boolean): void }).demoPress = press;
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

  async fakeClick() {
    await this.page.evaluate(() => (window as unknown as { demoPress(d: boolean): void }).demoPress(true));
    await sleep(110);
    await this.page.evaluate(() => (window as unknown as { demoPress(d: boolean): void }).demoPress(false));
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
    await animate(ms, (t) => this.page.mouse.move(from.x + (to.x - from.x) * ease(t), from.y + (to.y - from.y) * ease(t)));
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

  async type(text: string, perChar = 25) {
    const start = Date.now();
    for (const [i, ch] of [...text].entries()) {
      await this.page.keyboard.type(ch);
      await sleep(Math.max(0, start + (i + 1) * perChar - Date.now()));
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
  await sleep(150);
  await d.clickOn(comment, 350);
  await sleep(120);
  await d.type(text, 22);
  await sleep(250);
  await d.clickOn(page.locator(`#popover [data-intent="${intent}"]`), 400);
  await sleep(300);
  await d.clickOn(page.locator("#save"), 350);
  await sleep(450);
}

// Shows the target <select> as an open list inside the dock, the way the guide's target-list shot does.
async function expandTargets(page: Page) {
  await page.locator("#target").evaluate((el: HTMLSelectElement) => {
    el.dataset.demoStyle = el.getAttribute("style") ?? "";
    el.size = el.options.length + el.querySelectorAll("optgroup").length;
    Object.assign(el.style, { backgroundImage: "none", padding: "4px", overflow: "hidden", fontSize: "12px" });
    el.style.height = `${el.scrollHeight + 10}px`;
    (el.nextElementSibling as HTMLElement).style.display = "none";
  });
}

async function collapseTargets(page: Page) {
  await page.locator("#target").evaluate((el: HTMLSelectElement) => {
    for (const o of el.options) o.removeAttribute("style");
    el.removeAttribute("size");
    el.setAttribute("style", el.dataset.demoStyle ?? "");
    (el.nextElementSibling as HTMLElement).style.display = "";
  });
}

async function optionPoint(page: Page, option: Locator) {
  const b = await option.boundingBox();
  if (b && b.width > 0 && b.height > 0) return { x: b.x + Math.min(b.width * 0.35, 110), y: b.y + b.height / 2 };
  return option.evaluate((o: HTMLOptionElement) => {
    const sel = o.closest("select")!;
    const rows = [...sel.querySelectorAll("optgroup, option")];
    const r = sel.getBoundingClientRect();
    const h = (sel.clientHeight - 8) / rows.length;
    return { x: r.left + 110, y: r.top + 4 + h * (rows.indexOf(o) + 0.5) };
  });
}

type AgentEvent = { t: number; kind: "text" | "tool" | "result" | "done"; text: string; error?: boolean };
type AgentResult = { ok: boolean; text: string; turns?: number; seconds: number; events: AgentEvent[]; raw: string; stderr: string };
type Block = { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

function editCounts(oldS: string, newS: string) {
  const a = oldS.split("\n"), b = newS.split("\n");
  const removed = a.filter((l) => !b.includes(l)).length;
  const added = b.filter((l) => !a.includes(l)).length;
  return `+${added} −${removed}`;
}

function toolLine(name: string, input: Record<string, unknown>, show: (s: string) => string): string {
  const s = (k: string) => show(String(input[k] ?? ""));
  if (name === "Read") return `Read(${s("file_path")})`;
  if (name === "Edit") return `Edit(${s("file_path")})`;
  if (name === "Grep") return `Grep("${s("pattern")}"${input.path ? `, ${s("path")}` : ""})`;
  if (name === "Glob") return `Glob("${s("pattern")}"${input.path ? `, ${s("path")}` : ""})`;
  return `${name}(${show(JSON.stringify(input)).slice(0, 60)})`;
}

function resultLine(use: { name: string; input: Record<string, unknown> } | undefined, block: Block, show: (s: string) => string): string {
  const parts = Array.isArray(block.content) ? (block.content as Block[]) : [{ type: "text", text: String(block.content ?? "") }];
  const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  const first = show(text.trim().split("\n")[0] ?? "").slice(0, 80);
  if (block.is_error) return `Error: ${first.replace(/<\/?tool_use_error>/g, "")}`;
  if (!use) return first;
  if (use.name === "Read") {
    if (parts.some((p) => p.type === "image")) return "Read image";
    return `Read ${text.replace(/\n+$/, "").split("\n").length} lines`;
  }
  if (use.name === "Edit") return `Updated ${show(String(use.input.file_path))} (${editCounts(String(use.input.old_string ?? ""), String(use.input.new_string ?? ""))})`;
  if (/^(No |Found )/.test(first)) return first;
  const n = text.trim() ? text.trim().split("\n").length : 0;
  return use.name === "Glob" ? `Found ${n} files` : `Found ${n} lines`;
}

async function runAgent(siteDir: string, prompt: string, home: string, t0: number, show: (s: string) => string): Promise<AgentResult> {
  const args = [
    "-p", prompt,
    "--model", AGENT_MODEL,
    "--max-turns", AGENT_MAX_TURNS,
    "--tools", AGENT_TOOLS,
    "--allowedTools", AGENT_TOOLS,
    "--add-dir", home,
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--append-system-prompt-file", path.join(siteDir, "CLAUDE.md"),
    "--output-format", "stream-json",
    "--verbose",
  ];
  const started = Date.now();
  const events: AgentEvent[] = [];
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  let result: { subtype?: string; is_error?: boolean; result?: string; num_turns?: number } | undefined;
  const now = () => (Date.now() - t0) / 1000;
  const onLine = (line: string) => {
    if (!line.trim()) return;
    let m: { type?: string; message?: { content?: Block[] } } & Record<string, unknown>;
    try { m = JSON.parse(line); } catch { return; }
    const t = now();
    if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) events.push({ t, kind: "text", text: show(b.text.trim()) });
        if (b.type === "tool_use" && b.id && b.name) {
          uses.set(b.id, { name: b.name, input: b.input ?? {} });
          events.push({ t, kind: "tool", text: toolLine(b.name, b.input ?? {}, show) });
        }
      }
    }
    if (m.type === "user") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_result") events.push({ t, kind: "result", text: resultLine(uses.get(b.tool_use_id ?? ""), b, show), error: !!b.is_error });
      }
    }
    if (m.type === "result") {
      result = m as typeof result;
      events.push({ t, kind: "done", text: show(String(result?.result ?? "")) });
    }
  };
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(CLAUDE, args, { cwd: siteDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, text: `could not start ${CLAUDE}: ${err}`, seconds: 0, events, raw: "", stderr: "" });
      return;
    }
    let out = "", err = "", pending = "";
    proc.stdout!.on("data", (c) => {
      out += c;
      pending += c;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    proc.stderr!.on("data", (c) => (err += c));
    const timer = setTimeout(() => proc.kill("SIGTERM"), AGENT_TIMEOUT_MS);
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `could not start ${CLAUDE}: ${e.message}`, seconds: 0, events, raw: out, stderr: err });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      onLine(pending);
      const seconds = (Date.now() - started) / 1000;
      if (signal) return resolve({ ok: false, text: `claude was stopped (${signal}) after ${seconds.toFixed(0)} s`, seconds, events, raw: out, stderr: err });
      if (!result) return resolve({ ok: false, text: `claude exited with ${code} and no result event`, seconds, events, raw: out, stderr: err });
      const ok = code === 0 && result.subtype === "success" && !result.is_error;
      resolve({ ok, text: show(String(result.result ?? result.subtype ?? "(no result)")), turns: result.num_turns, seconds, events, raw: out, stderr: err });
    });
  });
}

function siteDiff(siteDir: string): string {
  const r = spawnSync("diff", ["-ru", path.join(DEMO, "site"), path.join(siteDir, "site")], { encoding: "utf8" });
  return r.stdout.replaceAll(path.join(DEMO, "site"), "a/site").replaceAll(path.join(siteDir, "site"), "b/site");
}

const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
const BRAND_BG = "#0d0b17";
const TOTAL_WIDTH = VIEW.width + TERM.width;

async function renderBars(dir: string, speed: number) {
  const browser = await chromium.launch({ channel: "chromium" });
  const shoot = async (html: string, file: string, transparent = false) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await browser.newPage({ viewport: { width: TOTAL_WIDTH, height: BAR_HEIGHT }, deviceScaleFactor: 1 });
      try {
        await page.setContent(html);
        await page.screenshot({ path: file, omitBackground: transparent, timeout: 10_000 });
        return file;
      } catch (err) {
        if (attempt === 2) throw err;
      } finally {
        await page.close();
      }
    }
    return file;
  };
  const right = `<div style="position:absolute;left:${VIEW.width}px;width:${TERM.width}px;top:0;height:${BAR_HEIGHT}px;display:flex;align-items:center;justify-content:center;color:#8f88b3;font:500 15px/1 ${FONT}">Claude Code session · replay of the real run</div>`;
  const bar = (inner: string) => `<html><body style="margin:0;width:${TOTAL_WIDTH}px;height:${BAR_HEIGHT}px;background:${BRAND_BG};position:relative;overflow:hidden">${inner}${right}</body></html>`;
  const base = await shoot(bar(""), path.join(dir, "bar-0.png"));
  const captions: string[] = [];
  for (const [i, beat] of BEATS.entries()) {
    const [num, label] = beat.split(" · ");
    captions.push(await shoot(bar(`<div style="position:absolute;left:20px;top:9px;display:flex;align-items:center;gap:12px;padding:0 20px 0 8px;height:38px;border-radius:19px;background:#221d38;color:#fff;font:600 20px/1 ${FONT}">
      <span style="display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#ea580c;font-size:16px">${num}</span>${label}</div>`), path.join(dir, `bar-${i + 1}.png`)));
  }
  const badge = await shoot(`<html><body style="margin:0;background:transparent;width:${TOTAL_WIDTH}px;height:${BAR_HEIGHT}px;position:relative">
    <div style="position:absolute;right:${TERM.width + 20}px;top:11px;height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;border-radius:17px;background:#ea580c;color:#fff;font:700 17px/1 ${FONT}">⏩ sped up ${speed.toFixed(1).replace(/\.0$/, "")}×</div></body></html>`, path.join(dir, "badge.png"), true);
  await browser.close();
  return { base, captions, badge };
}

type Segment = { a: number; b: number; speed: number };

function mapTime(t: number, segs: Segment[]): number {
  let out = 0;
  for (const { a, b, speed } of segs) {
    if (t <= b) return out + Math.max(0, t - a) / speed;
    out += (b - a) / speed;
  }
  return out;
}

type TermItem = { at: number; dur: number; kind: "user" | "text" | "tool" | "result" | "done"; text: string; error?: boolean };
type TermScript = {
  prompt: string; typeAt: number; typeDur: number; submitAt: number; doneAt: number; agentStart: number;
  items: TermItem[]; segs: Segment[]; model: string; tools: string; title: string; cwd: string;
};

// Lays the real agent events onto the output timeline: each appears when it happened (after the cut), and text streams
// in at a reading pace without ever starting before the previous item finished.
function termTimeline(events: AgentEvent[], m: Record<string, number>, segs: Segment[], prompt: string, turns: number | undefined, seconds: number): TermScript {
  const typeAt = mapTime(m.sendClick!, segs);
  const typeDur = 0.4;
  const submitAt = typeAt + typeDur + 0.15;
  const items: TermItem[] = [{ at: submitAt, dur: 0, kind: "user", text: prompt }];
  let cursor = submitAt + 0.1;
  const lastText = events.findLast((e) => e.kind === "text");
  const done = events.find((e) => e.kind === "done");
  for (const e of events) {
    let at = Math.max(mapTime(e.t, segs), cursor);
    if (e.kind === "done") {
      if (done && lastText && done.text.trim() !== lastText.text.trim()) {
        const dur = Math.min(1.8, Math.max(0.4, done.text.length / 260));
        items.push({ at, dur, kind: "text", text: done.text });
        at += dur + 0.1;
      }
      items.push({ at, dur: 0, kind: "done", text: `Worked for ${seconds.toFixed(1)}s${turns ? ` · ${turns} turns` : ""}` });
      cursor = at;
      continue;
    }
    const final = e === lastText;
    const dur = e.kind === "text" ? Math.min(final ? 1.8 : 0.9, Math.max(final ? 0.4 : 0.15, e.text.length / (final ? 260 : 220))) : 0;
    items.push({ at, dur, kind: e.kind, text: e.text, error: e.error });
    cursor = at + dur + 0.08;
  }
  const doneAt = items.findLast((i) => i.kind === "done")?.at ?? cursor;
  return {
    prompt, typeAt, typeDur, submitAt, doneAt, agentStart: m.agentStart!, items, segs,
    model: AGENT_MODEL, tools: AGENT_TOOLS.split(",").join(", "), title: SESSION_LABEL, cwd: TERM_CWD,
  };
}

const TERM_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --bg: ${BRAND_BG}; --fg: #e6e3f2; --dim: #8f88b3; --line: #2b2547; --accent: #d97757; --green: #4ade80; --red: #f87171; --code: #c4b5fd; }
* { box-sizing: border-box; }
html, body { margin: 0; width: ${TERM.width}px; height: ${TERM.height}px; background: var(--bg); color: var(--fg); overflow: hidden; }
body { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; display: flex; flex-direction: column; border-left: 1px solid #000; }
.titlebar { flex: none; height: 34px; display: flex; align-items: center; padding: 0 12px; background: #17142a; border-bottom: 1px solid var(--line); font: 600 13px/1 ${FONT}; color: #cfcae6; position: relative; }
.lights { display: flex; gap: 7px; }
.lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
.titlebar .name { position: absolute; left: 0; right: 0; text-align: center; pointer-events: none; }
.titlebar .cwd { margin-left: auto; color: var(--dim); font: 12px/1 ui-monospace, Menlo, monospace; }
.screen { flex: 1; display: flex; flex-direction: column; padding: 12px 16px 10px; min-height: 0; }
.log { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; }
.welcome { border: 1px solid var(--accent); border-radius: 8px; padding: 8px 12px; margin-bottom: 14px; }
.welcome b { color: var(--accent); }
.welcome .d { color: var(--dim); }
.row { display: flex; gap: 8px; margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
.row .m { flex: none; width: 12px; }
.row .x { flex: 1; min-width: 0; }
.user { color: #b9b4cf; background: #1a1630; border-radius: 4px; padding: 4px 8px 4px 0; }
.user .m { padding-left: 6px; width: 20px; color: var(--dim); }
.tool .m { color: var(--green); }
.tool .x b { font-weight: 700; }
.res { margin-top: -6px; color: var(--dim); }
.res .m { width: 24px; text-align: right; }
.res.err { color: var(--red); }
.done { margin-top: 4px; color: var(--accent); }
.text .m { color: var(--fg); }
code { color: var(--code); }
.status { flex: none; height: 22px; color: var(--accent); margin: 4px 0 2px; white-space: pre; }
.status .d { color: var(--dim); }
.input { flex: none; border: 1px solid #4b4570; border-radius: 6px; padding: 7px 10px; min-height: 36px; white-space: pre-wrap; word-break: break-word; }
.input .p { color: var(--dim); }
.caret { display: inline-block; width: 8px; height: 15px; vertical-align: -3px; background: var(--fg); }
.foot { flex: none; color: var(--dim); font-size: 11.5px; padding: 6px 2px 0; display: flex; justify-content: space-between; }
</style></head><body>
<div class="titlebar"><span class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span><span class="name" id="title"></span><span class="cwd" id="cwd"></span></div>
<div class="screen">
  <div class="log" id="log"></div>
  <div class="status" id="status"></div>
  <div class="input" id="input"></div>
  <div class="foot"><span id="foot-l"></span></div>
</div>
<script>
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md = (s) => esc(s).replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>").replace(/\`([^\`]+)\`/g, "<code>$1</code>");
const SPIN = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
let S;
window.setup = (script) => {
  S = script;
  document.getElementById("title").textContent = S.title;
  document.getElementById("cwd").textContent = S.cwd;
  document.getElementById("foot-l").textContent = S.model + " · tools: " + S.tools;
};
const unmap = (tau) => {
  let out = 0;
  for (const g of S.segs) { const len = (g.b - g.a) / g.speed; if (tau <= out + len) return g.a + (tau - out) * g.speed; out += len; }
  return S.segs[S.segs.length - 1].b;
};
window.renderAt = (t) => {
  const parts = ['<div class="welcome"><b>✻</b> Welcome to <b>Claude Code</b><br><span class="d">  cwd: ' + esc(S.cwd) + '</span></div>'];
  for (const it of S.items) {
    if (it.at > t) break;
    const n = it.dur > 0 ? Math.min(it.text.length, Math.ceil(it.text.length * (t - it.at) / it.dur)) : it.text.length;
    const txt = it.text.slice(0, n);
    if (it.kind === "user") parts.push('<div class="row user"><span class="m">&gt;</span><span class="x">' + esc(txt) + '</span></div>');
    if (it.kind === "text") parts.push('<div class="row text"><span class="m">⏺</span><span class="x">' + md(txt) + '</span></div>');
    if (it.kind === "tool") { const i = txt.indexOf("("); parts.push('<div class="row tool"><span class="m">⏺</span><span class="x"><b>' + esc(txt.slice(0, i)) + '</b>' + esc(txt.slice(i)) + '</span></div>'); }
    if (it.kind === "result") parts.push('<div class="row res' + (it.error ? " err" : "") + '"><span class="m">⎿</span><span class="x">' + esc(txt) + '</span></div>');
    if (it.kind === "done") parts.push('<div class="row done"><span class="m">✻</span><span class="x">' + esc(txt) + '</span></div>');
  }
  const log = parts.join("");
  let status = "";
  if (t >= S.submitAt && t < S.doneAt) {
    const secs = Math.max(0, Math.floor(unmap(t) - S.agentStart));
    status = SPIN[Math.floor(t * 8) % SPIN.length] + ' Working… <span class="d">(' + secs + 's · esc to interrupt)</span>';
  }
  let input = "";
  const typing = t >= S.typeAt && t < S.submitAt;
  if (typing) input = esc(S.prompt.slice(0, Math.ceil(S.prompt.length * Math.min(1, (t - S.typeAt) / S.typeDur))));
  const caret = typing || Math.floor(t * 1.6) % 2 === 0 ? '<span class="caret"></span>' : '<span class="caret" style="opacity:0"></span>';
  const inputHtml = '<span class="p">&gt; </span>' + input + caret;
  const key = log + "|" + status + "|" + inputHtml;
  if (key !== window.lastKey) {
    document.getElementById("log").innerHTML = log;
    document.getElementById("status").innerHTML = status;
    document.getElementById("input").innerHTML = inputHtml;
    window.lastKey = key;
  }
  return key;
};
</script></body></html>`;

async function renderTerminal(dir: string, script: TermScript, total: number): Promise<string> {
  const framesDir = path.join(dir, "term");
  mkdirSync(framesDir);
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage({ viewport: TERM, deviceScaleFactor: 1 });
  await page.setContent(TERM_HTML);
  await page.evaluate((s) => (window as unknown as { setup(s: unknown): void }).setup(s), script);
  const frames: { file: string; from: number }[] = [];
  let last = "";
  const count = Math.ceil(total * FPS);
  for (let k = 0; k < count; k++) {
    const tau = k / FPS;
    const key = await page.evaluate((t) => (window as unknown as { renderAt(t: number): string }).renderAt(t), tau);
    if (key === last) continue;
    last = key;
    const file = path.join(framesDir, `f${String(frames.length).padStart(5, "0")}.png`);
    await page.screenshot({ path: file });
    frames.push({ file, from: tau });
  }
  await browser.close();
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.from ?? total) - f.from).toFixed(4)}`).join("\n");
  const listFile = path.join(dir, "term.txt");
  writeFileSync(listFile, `ffconcat version 1.0\n${list}\nfile '${frames.at(-1)!.file}'\n`);
  const out = path.join(dir, "term.mp4");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=${FPS},format=yuv420p`, "-t", total.toFixed(3), "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", out]);
  return out;
}

function pathScrubber(siteDir: string, home: string, bundleDir: string) {
  const variants = (p: string) => {
    const all = new Set([p]);
    try { all.add(realpathSync(p)); } catch { /* gone */ }
    for (const v of [...all]) if (v.startsWith("/private/")) all.add(v.slice("/private".length));
    return [...all].sort((a, b) => b.length - a.length);
  };
  const pairs: [string, string][] = [
    ...variants(bundleDir).map((v) => [v, "~/.anynotate/inbox/…"] as [string, string]),
    ...variants(home).map((v) => [v, "~/.anynotate"] as [string, string]),
    ...variants(siteDir).flatMap((v) => [[`${v}/`, ""], [v, TERM_CWD]] as [string, string][]),
  ];
  const userHome = homedir();
  return (s: string) => {
    let out = s;
    for (const [from, to] of pairs) out = out.replaceAll(from, to);
    return out.replace(/\/(private\/)?var\/folders\/[^\s)"'`]*/g, "…").replaceAll(userHome, "~");
  };
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
    const toggle = () => (worker as Worker).evaluate(() => (globalThis as unknown as { anynotateCommand(c: string): Promise<unknown> }).anynotateCommand("toggle-annotate"));
    const target = page.locator("#target");
    const targetReady = async () => {
      await page.locator("#dock").waitFor({ state: "visible" });
      await target.locator(`option[value='${INBOX_VALUE}']`).waitFor({ state: "attached", timeout: 10_000 });
      for (let i = 0; i < 50 && (await target.inputValue()) !== INBOX_VALUE; i++) await sleep(100);
      return (await target.inputValue()) === INBOX_VALUE;
    };
    const sessionOption = target.locator('optgroup[label="Sessions"] option', { hasText: `${SESSION_LABEL} · ` });

    // Off camera (trimmed): let the dock load its targets and start on the Inbox, so the session pick is a real change.
    await toggle();
    if (!(await targetReady())) await target.selectOption(INBOX_VALUE);
    await sessionOption.waitFor({ state: "attached", timeout: 10_000 });
    await sleep(300);
    await toggle();
    await page.locator("#dock").waitFor({ state: "hidden" });
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
    mark("pageReady");
    await sleep(300);

    mark("beat1");
    await d.glide(900, 330, 450);
    await d.keycap("Alt + Shift + A", 900);
    await sleep(150);
    await toggle();
    if (!(await targetReady())) fail("the dock did not come back with the Inbox selected");
    await sleep(400);

    await d.scrollToShow(".actions", 430, 800);
    await sleep(150);
    await d.clickOn(page.locator("#pick"), 500);
    await sleep(150);
    await d.glideTo(page.locator("#save-recipe"), 700);
    await sleep(450);
    await d.click();
    mark("beat2");
    await writeNote(d, page, NOTE_1, "change");

    await d.scrollToShow(".intro", 260, 800);
    await sleep(200);
    const p = await phraseBox(page, ".intro", PHRASE);
    await d.drag(p.from, p.to, 650);
    await writeNote(d, page, NOTE_2, "explain");

    mark("beat3");
    await d.scrollToShow("#hero", 110, 600);
    await sleep(150);
    await d.clickOn(page.locator("#pick"), 500);
    await sleep(200);
    const hero = (await page.locator("#hero").boundingBox())!;
    const sx = hero.width / TOMATO_BOX.viewWidth, sy = hero.height / TOMATO_BOX.viewHeight;
    await d.drag(
      { x: hero.x + TOMATO_BOX.x1 * sx, y: hero.y + TOMATO_BOX.y1 * sy },
      { x: hero.x + TOMATO_BOX.x2 * sx, y: hero.y + TOMATO_BOX.y2 * sy },
      900,
    );
    await writeNote(d, page, NOTE_3, "change");
    const regionRow = await page.locator("#notes li .q").last().textContent();
    if (!regionRow?.startsWith("Region ")) fail(`the third note is not a region note (dock says: ${regionRow})`);

    mark("beat4");
    await d.glideTo(target, 550);
    await sleep(150);
    await d.fakeClick();
    await expandTargets(page);
    await sleep(700);
    const to = await optionPoint(page, sessionOption);
    await d.glide(to.x, to.y, 550);
    await sessionOption.evaluate((o: HTMLOptionElement) => Object.assign(o.style, { background: "#2c58c9", color: "#fff" }));
    await sleep(350);
    await d.click();
    await sleep(250);
    await collapseTargets(page);
    await page.locator("#target-hint").filter({ hasText: "Typed into the pane now." }).waitFor({ timeout: 5000 });
    await sleep(700);
    await d.clickOn(page.locator("#send"), 450);
    mark("sendClick");

    let delivered = "";
    for (let i = 0; i < 150 && !delivered; i++) {
      const log = existsSync(b.herdrLog) ? readFileSync(b.herdrLog, "utf8") : "";
      delivered = log.match(new RegExp(`agent prompt ${SESSION.pane} (Browser notes waiting: .+? and act on them\\.)`))?.[1] ?? "";
      if (!delivered) await sleep(100);
    }
    if (!delivered) fail("the bridge never typed the notes into the stand-in pane");
    const readme = delivered.match(/read (.+README\.md) and act/)?.[1] ?? fail(`no README path in: ${delivered}`);
    if (!existsSync(readme)) fail(`the delivered README does not exist: ${readme}`);
    const show = pathScrubber(siteDir, home, path.dirname(readme));
    await d.glide(1000, 300, 400);
    await page.locator("#status").filter({ hasText: /\S/ }).waitFor({ timeout: 15_000 });
    await sleep(500);
    mark("sendShown");

    const changes: number[] = [];
    const watcher = watch(path.join(siteDir, "site"), { recursive: true }, () => changes.push((Date.now() - t0) / 1000));
    mark("agentStart");
    console.log("running claude -p on the temp copy…");
    const agent = await runAgent(siteDir, delivered, home, t0, show);
    mark("agentEnd");
    await sleep(1000);
    watcher.close();
    const diff = siteDiff(siteDir);

    const eventLog = agent.events.map((e) => `${(e.t - marks.agentStart!).toFixed(1).padStart(6)} s  ${e.kind.padEnd(6)}  ${e.text.replace(/\n/g, "\n" + " ".repeat(18))}`);
    const log = [
      "Anynotate demo video: the agent run behind the edit",
      "",
      `Command: claude -p --model ${AGENT_MODEL} --max-turns ${AGENT_MAX_TURNS} --tools ${AGENT_TOOLS} --allowedTools ${AGENT_TOOLS} --add-dir <temp ANYNOTATE_HOME> --safe-mode --strict-mcp-config --no-session-persistence --append-system-prompt-file <demo>/CLAUDE.md --output-format stream-json --verbose`,
      `Prompt (as the bridge typed it into the pane; temp paths shortened): ${show(delivered)}`,
      `Result: ${agent.ok ? "success" : "FAILED"} · ${agent.seconds.toFixed(1)} s${agent.turns ? ` · ${agent.turns} turns` : ""}`,
      "",
      "## The notes the agent received (README.md)",
      "",
      show(readFileSync(readme, "utf8")),
      "## Agent events (stream-json, seconds after start; what the terminal pane replays)",
      "",
      ...eventLog,
      "",
      "## Agent's final message",
      "",
      agent.text,
      "",
      "## Diff it made to the demo site",
      "",
      diff || "(no changes)",
      ...(agent.ok ? [] : ["", "## stderr", "", show(agent.stderr)]),
    ].join("\n");
    const logFile = path.join(OUT, "anynotate-demo-agent-log.txt");
    writeFileSync(logFile, log);
    if (!agent.ok) fail(`the agent run failed: ${agent.text}\nlog: ${logFile}`);
    if (!diff) fail(`the agent changed nothing, so there is no honest video to make\nlog: ${logFile}`);

    mark("revealStart");
    await d.scrollToShow("#hero", 110, 500);
    await d.glideTo(page.locator("#hero"), 500, 0.47, 0.5);
    await sleep(700);
    await d.glideTo(page.locator(".meta span").nth(1), 450);
    await sleep(350);
    await d.glideTo(page.locator(".intro"), 450, 0.75, 0.75);
    await sleep(700);
    await d.scrollToShow(".actions", 430, 600);
    await d.glideTo(page.locator("#save-recipe"), 450, 0.5, 1.6);
    await sleep(1500);
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

    const agentSpan = at("agentEnd") - at("agentStart");
    const speed = Math.max(1, agentSpan / AGENT_ON_SCREEN_SECONDS);
    const segs: Segment[] = [
      { a: at("pageReady"), b: at("agentStart"), speed: 1 },
      { a: at("agentStart"), b: at("agentEnd"), speed },
      { a: at("agentEnd"), b: at("end"), speed: 1 },
    ];

    const edited = path.join(work, "edited.mp4");
    const parts = segs.map(({ a, b: e, speed: s }, i) => `[r${i}]trim=start=${a.toFixed(3)}:end=${e.toFixed(3)},setpts=(PTS-STARTPTS)/${s.toFixed(4)}[s${i}]`);
    const graph = [
      `[0:v]split=${segs.length}${segs.map((_, i) => `[r${i}]`).join("")}`,
      ...parts,
      `${segs.map((_, i) => `[s${i}]`).join("")}concat=n=${segs.length}:v=1:a=0,fps=${FPS}[v]`,
    ].join(";");
    ffmpeg(["-i", cfr, "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-crf", "12", "-preset", "veryfast", edited]);
    const total = duration(edited);

    const events = agent.events.map((e) => ({ ...e, t: e.t + shift }));
    const script = termTimeline(events, shifted, segs, show(delivered), agent.turns, agent.seconds);
    const term = await renderTerminal(work, script, total);

    const bars = await renderBars(work, speed);
    const o = (name: string) => mapTime(at(name), segs);
    const windows: [number, number][] = [
      [o("beat1"), o("beat2")],
      [o("beat2"), o("beat3")],
      [o("beat3"), o("beat4")],
      [o("beat4"), o("agentStart")],
      [o("agentStart"), total + 1],
    ];
    const badge: [number, number] | undefined = speed > 1.05 ? [o("agentStart"), o("agentEnd")] : undefined;

    const mp4 = path.join(OUT, "anynotate-demo.mp4");
    const still = (f: string) => ["-loop", "1", "-framerate", String(FPS), "-t", total.toFixed(3), "-i", f];
    const inputs = ["-i", edited, "-i", term, ...still(bars.base), ...bars.captions.flatMap(still), ...still(bars.badge)];
    const capBase = 3;
    const badgeIn = capBase + bars.captions.length;
    const steps = [`[2:v]format=yuv420p[b0]`];
    let barLabel = "[b0]";
    windows.forEach(([a, e], i) => {
      const next = `[b${i + 1}]`;
      steps.push(`${barLabel}[${capBase + i}:v]overlay=0:0:shortest=1:enable='between(t,${a.toFixed(3)},${e.toFixed(3)})'${next}`);
      barLabel = next;
    });
    if (badge) {
      steps.push(`${barLabel}[${badgeIn}:v]overlay=0:0:shortest=1:enable='between(t,${badge[0].toFixed(3)},${badge[1].toFixed(3)})'[bb]`);
      barLabel = "[bb]";
    }
    steps.push(`[0:v][1:v]hstack=inputs=2[main]`, `${barLabel}[main]vstack=inputs=2,format=yuv420p[v]`);
    const capGraph = steps.join(";");
    for (const crf of [22, 26, 30]) {
      ffmpeg([...inputs, "-filter_complex", capGraph, "-map", "[v]", "-t", total.toFixed(3), "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
      if (mb(mp4) <= 20) break;
    }

    const gif = path.join(OUT, "anynotate-demo.gif");
    let gifShape = "";
    for (const [fps, width] of [[12, 1280], [10, 1280], [12, 1120], [10, 1120], [10, 1024], [8, 960]] as const) {
      ffmpeg(["-i", mp4, "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", gif]);
      gifShape = `${fps} fps, ${width} wide`;
      if (mb(gif) <= 15) break;
    }

    console.log(JSON.stringify({
      mp4: { path: mp4, mb: +mb(mp4).toFixed(2), seconds: +duration(mp4).toFixed(2) },
      gif: { path: gif, mb: +mb(gif).toFixed(2), shape: gifShape },
      log: logFile,
      agent: { seconds: +agent.seconds.toFixed(1), turns: agent.turns, speed: +speed.toFixed(2), events: agent.events.length, text: agent.text },
      segments: segs.map(({ a, b: e, speed: s }) => [+a.toFixed(2), +e.toFixed(2), +s.toFixed(2)]),
      captions: windows.map(([a, e]) => [+a.toFixed(2), +e.toFixed(2)]),
      sendAt: +o("sendClick").toFixed(2),
      fileChanges: changes.map((c) => +mapTime(c + shift, segs).toFixed(2)),
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
