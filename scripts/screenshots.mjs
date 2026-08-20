/**
 * Regenerates the screenshots used in the README.
 *
 * Not part of the build. To run it:
 *
 *   npm i -D puppeteer-core
 *   just dev                       # or any local instance with seeded mail
 *   POSTBOX_URL=http://localhost:8787 POSTBOX_PASSWORD=... node scripts/screenshots.mjs
 *
 * CHROME_PATH defaults to Google Chrome on macOS.
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.POSTBOX_URL ?? "http://127.0.0.1:8790";
const PASSWORD = process.env.POSTBOX_PASSWORD ?? "shots-pass";
const OUT = process.env.POSTBOX_SHOTS_DIR ?? "docs/screenshots";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"],
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage({ width, height, dark, mobile = false }) {
  const page = await browser.newPage();
  await page.setViewport({
    width,
    height,
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
  });
  if (mobile) {
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    );
  }
  await page.evaluateOnNewDocument((isDark) => {
    localStorage.setItem("postbox:theme", isDark ? "dark" : "light");
  }, dark);
  return page;
}

async function login(page) {
  await page.goto(BASE, { waitUntil: "networkidle0" });
  const field = await page.$('input[type="password"]');
  if (field) {
    await field.type(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("li[data-thread-id]", { timeout: 15000 });
  }
  await wait(900);
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("→", name);
}

const openThread = async (page, index) =>
  page.evaluate((i) => document.querySelectorAll("li[data-thread-id]")[i]?.click(), index);

// ── 1. Inbox, dark, desktop ─────────────────────────────────────────────────
{
  const page = await newPage({ width: 1440, height: 900, dark: true });
  await login(page);
  await shot(page, "inbox-dark");

  await openThread(page, 4); // the two-message client thread
  await wait(1100);
  await shot(page, "thread-dark");
  await page.close();
}

// ── 2. Inbox + reading pane, light ──────────────────────────────────────────
{
  const page = await newPage({ width: 1440, height: 900, dark: false });
  await login(page);
  await openThread(page, 0); // the HTML newsletter — shows image blocking
  await wait(1100);
  await shot(page, "reading-light");
  await page.close();
}

// ── 3. Composer ─────────────────────────────────────────────────────────────
{
  const page = await newPage({ width: 1440, height: 900, dark: true });
  await login(page);
  await openThread(page, 4);
  await wait(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Reply");
    b?.click();
  });
  await wait(900);
  await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(
      ta,
      "Joy — two more in the typographic direction, both with the series mark bottom-left so you can see it against the stacked serif.\n\nI've deliberately kept the second one tighter than feels comfortable; I think it earns it at trim size.\n\nDeadline Friday is fine.",
    );
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait(1400);
  await shot(page, "composer-dark");
  await page.close();
}

// ── 4. Command palette ──────────────────────────────────────────────────────
{
  const page = await newPage({ width: 1440, height: 900, dark: true });
  await login(page);
  await page.keyboard.down("Meta");
  await page.keyboard.press("k");
  await page.keyboard.up("Meta");
  await wait(700);
  await page.keyboard.type("cover", { delay: 60 });
  await wait(1200);
  await shot(page, "command-palette");
  await page.close();
}

// ── 5. Mobile: list, thread, drawer ─────────────────────────────────────────
{
  const page = await newPage({ width: 390, height: 844, dark: false, mobile: true });
  await login(page);
  await shot(page, "mobile-inbox");

  await page.evaluate(() => document.querySelector('button[aria-label="Open mailboxes"]')?.click());
  await wait(900);
  await shot(page, "mobile-drawer");
  await page.keyboard.press("Escape");
  await wait(700);

  await openThread(page, 4);
  await wait(1100);
  await shot(page, "mobile-thread");
  await page.close();
}

// ── 6. Sign-in ──────────────────────────────────────────────────────────────
{
  const page = await newPage({ width: 1100, height: 700, dark: true });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await wait(800);
  await shot(page, "signin-dark");
  await page.close();
}

await browser.close();
console.log("done");
