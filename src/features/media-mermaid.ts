import { fileURLToPath } from "node:url";
import type mermaid from "mermaid";
import type { Browser, Page } from "playwright-core";
import {
  HTML_VISUAL_KIT_FONT_PATH,
  type HtmlVisualKit,
} from "./html-visual-kit.ts";

const MERMAID =
  /<media-mermaid(?=[\s>])(?:"[^"]*"|'[^']*'|[^'"<>])*?>([\s\S]*?)<\/media-mermaid\s*>/gi;
const ORIGIN = "http://mermaid-render.invalid";
const ENGINE_URL = `${ORIGIN}/mermaid.js`;
const MAX_DIAGRAMS = 4;
const MAX_SOURCE_LENGTH = 10_000;
const UNAVAILABLE =
  '<aside class="v-note is-warn"><b>Diagram unavailable</b>Check the Mermaid syntax or simplify the diagram.</aside>';

export async function expandMediaMermaid(
  browser: Browser,
  html: string,
  kit: HtmlVisualKit,
  signal: AbortSignal,
): Promise<string> {
  const matches = [...html.matchAll(MERMAID)];
  if (!matches.length) return html;

  // Only this separate page runs JavaScript. It never receives the reply HTML,
  // and can load only the packaged Mermaid script and the kit's bundled fonts.
  const context = await browser.newContext({
    colorScheme: "dark",
    offline: true,
    serviceWorkers: "block",
  });
  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET" || url.origin !== ORIGIN) {
        await route.abort();
      } else if (request.isNavigationRequest() && url.href === `${ORIGIN}/`) {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          headers: {
            "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src ${ENGINE_URL}; font-src ${ORIGIN}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`,
          },
          body: `<!doctype html><style>${kit.css}</style><body></body>`,
        });
      } else if (
        request.resourceType() === "script" &&
        url.href === ENGINE_URL
      ) {
        await route.fulfill({
          contentType: "text/javascript",
          path: fileURLToPath(
            import.meta.resolve("mermaid/dist/mermaid.min.js"),
          ),
        });
      } else if (url.pathname.startsWith(HTML_VISUAL_KIT_FONT_PATH)) {
        const font = kit.fonts.get(
          url.pathname.slice(HTML_VISUAL_KIT_FONT_PATH.length),
        );
        if (!font || request.resourceType() !== "font") {
          await route.abort();
          return;
        }
        await route.fulfill({
          path: font,
          contentType: "font/woff2",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } else {
        await route.abort();
      }
    });

    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ url: ENGINE_URL });
    await initMermaid(page);
    const diagrams: string[] = [];
    for (const [, body] of matches.slice(0, MAX_DIAGRAMS)) {
      signal.throwIfAborted();
      const source = body.trim();
      if (
        !source ||
        source.length > MAX_SOURCE_LENGTH ||
        /^---(?:\s|$)|%%\s*\{/.test(source)
      ) {
        diagrams.push(UNAVAILABLE);
        continue;
      }

      try {
        const svg = await renderDiagram(page, source, diagrams.length);
        diagrams.push(`<figure class="v-mermaid">${svg}</figure>`);
      } catch {
        signal.throwIfAborted();
        diagrams.push(UNAVAILABLE);
      }
    }

    let index = 0;
    return html.replace(MERMAID, () => diagrams[index++] ?? UNAVAILABLE);
  } finally {
    await context.close();
  }
}

type MermaidWindow = typeof window & { mermaid: typeof mermaid };

function initMermaid(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const engine = (window as MermaidWindow).mermaid;
    const styles = getComputedStyle(document.documentElement);
    const color = (name: string) => styles.getPropertyValue(name).trim();
    const fontFamily = color("--sans");
    engine.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      maxTextSize: 10_000,
      maxEdges: 80,
      fontFamily,
      fontSize: 18,
      theme: "base",
      look: "classic",
      themeVariables: {
        darkMode: true,
        background: color("--bg"),
        mainBkg: color("--paper"),
        primaryColor: color("--paper"),
        primaryTextColor: color("--ink"),
        primaryBorderColor: color("--ink-3"),
        secondaryColor: color("--paper-2"),
        secondaryTextColor: color("--ink"),
        tertiaryColor: color("--paper-2"),
        tertiaryTextColor: color("--ink"),
        lineColor: color("--ink-2"),
        textColor: color("--ink"),
        edgeLabelBackground: color("--bg"),
        actorBkg: color("--paper"),
        actorBorder: color("--ink-3"),
        actorTextColor: color("--ink"),
        actorLineColor: color("--ink-3"),
        signalColor: color("--ink-2"),
        signalTextColor: color("--ink"),
        noteBkgColor: color("--paper-2"),
        noteTextColor: color("--ink"),
        fontSize: "18px",
      },
      flowchart: {
        useMaxWidth: false,
        wrappingWidth: 155,
        curve: "linear",
        nodeSpacing: 36,
        rankSpacing: 40,
        padding: 10,
      },
      sequence: {
        useMaxWidth: false,
        mirrorActors: false,
        actorFontSize: 18,
        messageFontSize: 17,
        noteFontSize: 16,
        wrap: true,
      },
    });
    await document.fonts.load(`18px ${fontFamily}`, "Diagram labels");
  });
}

function renderDiagram(
  page: Page,
  source: string,
  index: number,
): Promise<string> {
  return page.evaluate(
    async ({ source, index }) => {
      await document.fonts.load('18px "Inter Variable"', source);
      const container = document.createElement("div");
      document.body.append(container);
      try {
        const { svg } = await (window as MermaidWindow).mermaid.render(
          `media-diagram-${index}`,
          source,
          container,
        );
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        const root = parsed.documentElement;
        if (root.localName !== "svg")
          throw new Error("Mermaid did not produce SVG.");
        for (const element of root.querySelectorAll(
          "script, foreignObject, image, iframe",
        ))
          element.remove();
        for (const element of [root, ...root.querySelectorAll("*")]) {
          for (const attr of Array.from(element.attributes)) {
            if (
              attr.name.toLowerCase().startsWith("on") ||
              (attr.localName === "href" && !attr.value.startsWith("#"))
            ) {
              element.removeAttributeNode(attr);
            }
          }
        }
        return new XMLSerializer().serializeToString(root);
      } finally {
        container.remove();
      }
    },
    { source, index },
  );
}
