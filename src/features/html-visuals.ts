import { createDebug } from "@grammyjs/debug";
import { chromium } from "playwright-core";
import { getRichMarkdownHtmlBlocks } from "../utils/markdown.ts";
import { fetchHtmlVisualAsset } from "./html-visual-assets.ts";

const logError = createDebug("app:html-visuals:error");
const WIDTH = 720;
const MAX_HEIGHT = 1600;
const MAX_VISUALS = 4;
const MAX_HTML_BYTES = 64 * 1024;
const RENDER_TIMEOUT_MS = 5_000;
const ASSET_TIMEOUT_MS = 2_500;
const MAX_ASSETS = 12;
const ASSET_TYPES = new Set(["image", "stylesheet", "font"]);
const VISUAL_URL = "http://html-visual.invalid/";

export async function renderHtmlVisual(
  html: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const browser = await chromium.launch({
    timeout: RENDER_TIMEOUT_MS,
    env: { LANG: "C.UTF-8", PATH: process.env.PATH },
  });
  const timeout = AbortSignal.timeout(RENDER_TIMEOUT_MS);
  const renderSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const abort = () => {
    void browser.close().catch(() => {});
  };
  renderSignal.addEventListener("abort", abort, { once: true });

  try {
    renderSignal.throwIfAborted();
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      serviceWorkers: "block",
      viewport: { width: WIDTH, height: 40 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);

    let served = false;
    let assetsLeft = MAX_ASSETS;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        !served &&
        request.isNavigationRequest() &&
        request.url() === VISUAL_URL
      ) {
        served = true;
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          headers: {
            "Content-Security-Policy":
              "sandbox; default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline' http: https:; font-src http: https: data:; base-uri 'none'; form-action 'none'",
            "X-DNS-Prefetch-Control": "off",
          },
          body: `<!doctype html>\n${html}`,
        });
        return;
      }

      if (
        request.method() === "GET" &&
        ASSET_TYPES.has(request.resourceType()) &&
        assetsLeft > 0
      ) {
        assetsLeft--;
        const assetSignal = AbortSignal.any([
          renderSignal,
          AbortSignal.timeout(ASSET_TIMEOUT_MS),
        ]);
        const asset = await fetchHtmlVisualAsset(
          request.url(),
          assetSignal,
        ).catch(() => undefined);
        if (asset) {
          await route.fulfill({
            ...asset,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
          return;
        }
      }
      await route.abort();
    });
    await page.goto(VISUAL_URL);

    const { width, height } = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    if (width > WIDTH || height > MAX_HEIGHT) {
      throw new Error("HTML visual exceeds the render dimensions.");
    }

    await page.setViewportSize({ width: WIDTH, height });
    const png = await page.screenshot({ animations: "disabled" });
    if (png.byteLength > 10_000_000) {
      throw new Error("HTML visual exceeds Telegram's photo size limit.");
    }
    return png;
  } finally {
    renderSignal.removeEventListener("abort", abort);
    await browser.close();
  }
}

export async function insertHtmlVisuals(
  markdown: string,
  insertImage: (html: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  let result = "";
  let cursor = 0;
  for (const [index, block] of getRichMarkdownHtmlBlocks(markdown).entries()) {
    signal?.throwIfAborted();
    let image = "*Visual unavailable.*";
    if (
      block.complete &&
      index < MAX_VISUALS &&
      Buffer.byteLength(block.html) <= MAX_HTML_BYTES
    ) {
      try {
        image = await insertImage(block.html);
      } catch (error) {
        signal?.throwIfAborted();
        logError("Failed to insert HTML visual", { error });
      }
    }
    result += markdown.slice(cursor, block.start) + image;
    cursor = block.end;
  }
  return result + markdown.slice(cursor);
}
