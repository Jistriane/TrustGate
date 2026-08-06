/**
 * Records one real TrustGate run from the dev server and writes the raw assets
 * the Remotion composition consumes.
 *
 * Outputs into capture/out/:
 *   video/*.webm   the whole run, one continuous take
 *   timings.json   seconds-from-recording-start for every lifecycle milestone
 *   stills/*.png   2x screenshots of the key states
 *
 * The frontend must be on http://localhost:5173 with the API reachable
 * (the header has to read "API online" or the run fails).
 *
 * Usage: npm run capture          (both passes)
 *        npm run capture -- video (video only)
 *        npm run capture -- stills
 */
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const URL = process.env.APP_URL || "http://localhost:5173/";
const OUT = path.join(__dirname, "out");
const W = 1600;
const H = 1000;

// The result panel prints the throwaway secret keys of the run. Blur them so
// the footage is safe to publish while the layout stays authentic.
const REDACT_CSS = `
  .result .kv__row:nth-child(4) .kv__val,
  .result .kv__row:nth-child(6) .kv__val { filter: blur(7px); }
`;

const launch = () =>
  chromium.launch({
    executablePath: CHROME,
    args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars"],
  });

const stepDone = (page, idx) =>
  page.waitForFunction(
    (i) => {
      const el = document.querySelectorAll("li.flow__step")[i];
      return !!el && el.dataset.status === "done";
    },
    idx,
    { timeout: 180000 }
  );

async function ready(page) {
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: REDACT_CSS });
  await page.waitForSelector('.badge[data-state="online"]', { timeout: 20000 });
  await page.waitForTimeout(900);
}

async function smoothScroll(page, to, ms) {
  await page.evaluate(
    ([target, duration]) =>
      new Promise((resolve) => {
        const from = window.scrollY;
        const t0 = performance.now();
        const tick = (now) => {
          const p = Math.min((now - t0) / duration, 1);
          const eased = 1 - Math.pow(1 - p, 3);
          window.scrollTo(0, from + (target - from) * eased);
          p < 1 ? requestAnimationFrame(tick) : resolve();
        };
        requestAnimationFrame(tick);
      }),
    [to, ms]
  );
}

async function passVideo() {
  const browser = await launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: path.join(OUT, "video"), size: { width: W, height: H } },
  });
  // Recording starts with the first page, so that is the closest reference to t=0.
  const page = await ctx.newPage();
  const t0 = Date.now();
  const marks = {};
  const mark = (name) => {
    marks[name] = (Date.now() - t0) / 1000;
    console.log(`  ${name.padEnd(16)} ${marks[name].toFixed(2)}s`);
  };

  await ready(page);
  mark("ready");
  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: /Start run/i }).click();
  mark("click");

  const labels = ["register", "create", "bid", "assign", "publish", "complete"];
  for (let i = 0; i < labels.length; i++) {
    await stepDone(page, i);
    mark(labels[i]);
  }

  await page.waitForSelector(".result", { timeout: 180000 });
  mark("result");
  await page.waitForTimeout(1400);

  const height = await page.evaluate(() => document.body.scrollHeight - window.innerHeight);
  mark("scrollStart");
  await smoothScroll(page, Math.max(height, 0), 2800);
  mark("scrollEnd");
  await page.waitForTimeout(2000);
  mark("end");

  await ctx.close();
  await browser.close();
  fs.writeFileSync(path.join(OUT, "timings.json"), JSON.stringify(marks, null, 2));
  console.log("video pass done — feed timings.json into capture/build-hero.sh");
}

async function passStills() {
  const browser = await launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const shot = (name, opts = {}) =>
    page.screenshot({ path: path.join(OUT, "stills", `${name}.png`), ...opts });

  await ready(page);
  await shot("01-idle");

  await page.getByRole("button", { name: /Start run/i }).click();
  await stepDone(page, 0);
  await shot("02-register");
  await stepDone(page, 2);
  await shot("03-bid");
  await stepDone(page, 3);
  await shot("04-assigned");
  await stepDone(page, 4);
  await shot("05-publish");

  await page.waitForSelector(".result", { timeout: 180000 });
  await page.waitForTimeout(800);
  await shot("06-complete");
  await shot("07-fullpage", { fullPage: true });

  await page.locator("header.topbar").screenshot({ path: path.join(OUT, "stills", "08-topbar.png") });
  await page.locator("aside.run__side").screenshot({ path: path.join(OUT, "stills", "09-side.png") });
  await page.locator(".panel.result").screenshot({ path: path.join(OUT, "stills", "10-result.png") });
  await page.locator("ol.flow").screenshot({ path: path.join(OUT, "stills", "11-flow.png") });

  await browser.close();
  console.log("stills pass done — 10-result.png becomes public/result.png");
}

(async () => {
  fs.mkdirSync(path.join(OUT, "stills"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "video"), { recursive: true });
  const only = process.argv[2];
  if (only !== "video") await passStills();
  if (only !== "stills") await passVideo();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
