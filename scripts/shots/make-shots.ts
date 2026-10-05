import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import sharp from "sharp";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const HERE = import.meta.dir;
const KIT = path.resolve(HERE, "../..");
const OUT = path.join(KIT, "assets/steps");
const EXT = process.env.ANYNOTATE_EXTENSION_DIR ?? path.resolve(KIT, "../anynotate-extension/.output/chrome-mv3-e2e");
const SITE = process.env.ANYNOTATE_DEMO_SITE ?? path.join(process.env.ANYNOTATE_DEMO_DIR ?? path.join(homedir(), "anynotate-demo"), "site");
const BRIDGE_REPO = process.env.ANYNOTATE_BRIDGE_DIR;
const FULL = process.env.SHOTS_FULL === "1";
const VIEW = { width: 1280, height: 800 };
const MAX_WIDTH = 1400;
const PANE = { pane: "w1:p2", agent: "claude", cwd: "/home/me/anynotate-demo", title: "tomato soup" };

type Clip = { x: number; y: number; width: number; height: number };

const NOTES = {
  1: "This button is hard to read. Give it enough contrast to pass WCAG AA, and keep it orange.",
  2: "The badge at the top says 45 minutes. Which one is right? Add up the steps and make the two agree.",
  3: "These lines are cramped. Give the list more breathing room, like the method steps below.",
  4: "Picking 2 or 6 changes the badge, but the ingredient amounts stay the same. Make them scale.",
  5: "Make this tomato a deeper, riper red.",
} as const;

type Fix = [file: string, from: string, to: string];

const FIXES: Record<keyof typeof NOTES, Fix[]> = {
  1: [["style.css", "--accent-soft: #f4a77f;", "--accent-soft: #c2410c;"]],
  2: [["index.html", "in about 25 minutes.", "in about 45 minutes."]],
  3: [["style.css", "#ingredients li { line-height: 1.2; margin: 0; }", "#ingredients li { line-height: 1.6; margin: 0 0 6px; }"]],
  4: [
    ["app.js", '"#ingredients [data-qty]"', '"#ingredients [data-base]"'],
    ["app.js", "el.dataset.qty", "el.dataset.base"],
  ],
  5: [["index.html", '<circle cx="320" cy="106" r="74" fill="#e8795a"/>', '<circle cx="320" cy="106" r="74" fill="#c81e1e"/>']],
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function copySite(fixes: Fix[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "anynotate-shots-site-"));
  cpSync(SITE, dir, { recursive: true });
  for (const [file, from, to] of fixes) {
    const p = path.join(dir, file);
    const text = readFileSync(p, "utf8");
    if (!text.includes(from)) fail(`fix not applicable: ${file} has no ${from}`);
    writeFileSync(p, text.replace(from, to));
  }
  return dir;
}

function serve(dir: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "") || "index.html";
      const file = Bun.file(path.join(dir, path.normalize(rel)));
      return file.size ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
}

async function startBridge(home: string, extensionId: string): Promise<{ proc: ChildProcess; url: string; token: string }> {
  const port = 48000 + Math.floor(Math.random() * 1000);
  const list = path.join(home, "herdr-list.json");
  writeFileSync(list, JSON.stringify({ result: { agents: [{ agent: PANE.agent, agent_status: "idle", cwd: PANE.cwd, pane_id: PANE.pane, terminal_title_stripped: PANE.title }] } }));
  const shim = path.join(home, "herdr");
  writeFileSync(shim, `#!/bin/sh\nexec bun '${path.join(BRIDGE_REPO!, "test/fixtures/herdr-shim.ts")}' "$@"\n`, { mode: 0o755 });
  const empty = path.join(home, "empty");
  mkdirSync(empty);
  const proc = spawn(path.join(BRIDGE_REPO!, "bin/anynotate"), ["bridge"], {
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
    await Bun.sleep(100);
  }
  fail("the throwaway bridge never answered");
}

async function toggleAnnotate(worker: Worker) {
  await worker.evaluate(() => (globalThis as unknown as { anynotateCommand(c: string): Promise<unknown> }).anynotateCommand("toggle-annotate"));
  await Bun.sleep(400);
}

async function selectPhrase(page: Page, selector: string, phrase: string) {
  await page.evaluate(([sel, text]) => {
    const n = document.querySelector(sel)!.firstChild as Text;
    const from = n.data.indexOf(text);
    const r = document.createRange();
    r.setStart(n, from);
    r.setEnd(n, from + text.length);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, [selector, phrase] as const);
}

async function pickElement(page: Page, hoverSelector: string, levelsUp: number) {
  await page.keyboard.down("Alt");
  await page.locator(hoverSelector).hover();
  for (let i = 0; i < levelsUp; i++) await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Alt");
}

async function drawRegion(page: Page, box: { x: number; y: number; w: number; h: number }) {
  const b = (await page.locator("#hero").boundingBox())!;
  const s = b.width / 680;
  const x = b.x + box.x * s, y = b.y + box.y * s, w = box.w * s, h = box.h * s;
  await page.locator("#pick").click();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + w / 2, y + h / 2, { steps: 5 });
  await page.mouse.move(x + w, y + h, { steps: 5 });
  await page.mouse.up();
}

async function writeNote(page: Page, text: string, intent: "change" | "explain") {
  await page.locator("#comment").waitFor({ state: "visible" });
  await page.locator("#comment").fill(text);
  await page.locator(`#popover [data-intent="${intent}"]`).click();
  await page.mouse.move(2, 2);
  await Bun.sleep(500);
}

async function union(page: Page, selectors: string[], pad: number): Promise<Clip> {
  const boxes = [];
  for (const s of selectors) {
    const b = await page.locator(s).first().boundingBox();
    if (b) boxes.push(b);
  }
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.min(VIEW.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const y1 = Math.min(VIEW.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

async function save(page: Page, name: string, clip: Clip | undefined) {
  const raw = await page.screenshot({ clip: FULL ? undefined : clip, animations: "disabled" });
  let img = sharp(raw);
  const { width } = await img.metadata();
  if (width && width > MAX_WIDTH) img = img.resize({ width: MAX_WIDTH });
  await img.png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toFile(path.join(OUT, name));
  console.log(name, JSON.stringify(clip));
}

type Step = {
  n: keyof typeof NOTES;
  scroll: string;
  prepare?: (page: Page) => Promise<void>;
  place: (page: Page) => Promise<void>;
  intent: "change" | "explain";
  area: string[];
  resultArea?: string[];
};

const STEPS: Step[] = [
  {
    n: 1,
    scroll: ".actions",
    prepare: async (p) => {
      await p.addStyleTag({ content: "body { padding-bottom: 240px; }" });
      await scrollTo(p, ".actions");
    },
    place: (p) => pickElement(p, "#save-recipe", 0),
    intent: "change",
    area: ["main > h2:last-of-type", ".actions"],
  },
  { n: 2, scroll: ".meta", place: (p) => selectPhrase(p, ".intro", "about 25 minutes"), intent: "explain", area: ["#title", ".intro"] },
  { n: 3, scroll: "#ingredients", place: (p) => pickElement(p, "#ingredients li:nth-child(3)", 1), intent: "change", area: [".servings", "#ingredients"] },
  {
    n: 4,
    scroll: ".meta",
    prepare: (p) => p.locator('[data-servings="6"]').click(),
    place: (p) => pickElement(p, '[data-servings="6"]', 1),
    intent: "change",
    area: ["#title", "#ingredients"],
    resultArea: [".servings", "#ingredients"],
  },
  { n: 5, scroll: "#hero", place: (p) => drawRegion(p, { x: 236, y: 22, w: 168, h: 168 }), intent: "change", area: ["#hero"] },
];

async function scrollTo(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const top = el.getBoundingClientRect().top + scrollY - 160;
    scrollTo(0, Math.max(0, top));
  }, selector);
  await Bun.sleep(200);
}

async function main() {
  if (!existsSync(path.join(EXT, "manifest.json"))) fail(`no extension build at ${EXT}; set ANYNOTATE_EXTENSION_DIR to an e2e build (wxt build --mode e2e)`);
  if (!existsSync(path.join(SITE, "index.html"))) fail(`no demo site at ${SITE}; set ANYNOTATE_DEMO_SITE`);
  mkdirSync(OUT, { recursive: true });
  const before = copySite([]);
  const afters = STEPS.map((step) => copySite(FIXES[step.n]));
  const home = mkdtempSync(path.join(tmpdir(), "anynotate-shots-home-"));
  const servers = [before, ...afters].map(serve);
  const [beforeUrl, ...afterUrls] = servers.map((s) => `http://localhost:${s.port}/`);
  let bridge: ChildProcess | undefined;
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(path.join(home, "profile"), {
      channel: "chromium",
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
      viewport: VIEW,
      deviceScaleFactor: 2,
      colorScheme: "light",
    });
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const extensionId = worker.url().split("/")[2]!;
    if ((await worker.evaluate(() => typeof (globalThis as Record<string, unknown>).anynotateCommand)) !== "function") {
      fail("this extension build has no test hooks; build it with wxt build --mode e2e");
    }
    if (BRIDGE_REPO) {
      const b = await startBridge(home, extensionId);
      bridge = b.proc;
      await worker.evaluate(({ url, token }) => chrome.storage.local.set({ bridge: { url }, e2eToken: token }), b);
    } else {
      await worker.evaluate(() => chrome.storage.local.set({ bridge: { url: "http://127.0.0.1:9" } }));
    }
    const page = context.pages()[0] ?? (await context.newPage());

    for (const [i, step] of STEPS.entries()) {
      await page.goto(beforeUrl);
      await scrollTo(page, step.scroll);
      await step.prepare?.(page);
      await toggleAnnotate(worker);
      if (BRIDGE_REPO) {
        const option = page.locator('#target optgroup[label="Sessions"] option');
        await option.first().waitFor({ state: "attached", timeout: 10_000 });
        await page.locator("#target").selectOption({ index: await option.first().evaluate((o: HTMLOptionElement) => o.index) });
      }
      await step.place(page);
      await writeNote(page, NOTES[step.n], step.intent);
      const around = await union(page, [...step.area, "#popover", "#dock"], 20);
      const clip = { ...around, x: 0, width: VIEW.width };
      await save(page, `step-${step.n}-annotate.png`, clip);

      await page.goto(afterUrls[i]!);
      await scrollTo(page, step.scroll);
      await step.prepare?.(page);
      await page.mouse.move(2, 2);
      await Bun.sleep(300);
      await save(page, `step-${step.n}-result.png`, await union(page, step.resultArea ?? step.area, 14));
    }
  } finally {
    await context?.close();
    bridge?.kill();
    for (const s of servers) s.stop(true);
    for (const d of [before, ...afters, home]) rmSync(d, { recursive: true, force: true });
  }
}

await main();
