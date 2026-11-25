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
    colorScheme: "light",
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
        darkMode: false,
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
        clusterBkg: color("--paper-2"),
        clusterBorder: color("--rule-2"),
        actorBkg: color("--paper"),
        actorBorder: color("--rule-2"),
        actorTextColor: color("--ink"),
        actorLineColor: color("--ink-3"),
        signalColor: color("--ink"),
        signalTextColor: color("--ink"),
        noteBkgColor: color("--accent-tint"),
        noteBorderColor: color("--accent-line"),
        noteTextColor: color("--ink"),
        labelBoxBkgColor: color("--paper"),
        labelBoxBorderColor: color("--rule-2"),
        labelTextColor: color("--ink"),
        loopTextColor: color("--ink-2"),
        activationBkgColor: color("--paper-2"),
        activationBorderColor: color("--ink-3"),
        fontSize: "18px",
      },
      // Nodes and actors match .v-card: paper fill, hairline rule border,
      // 12px corners, and the same soft lifted shadow. Theme variables cannot
      // express these, and the kit tokens resolve inside the inlined SVG.
      themeCSS: `
        rect.actor, .node rect, .node polygon, .node circle, .node ellipse,
        .node path {
          fill: var(--paper) !important;
          stroke: var(--rule-2) !important;
          stroke-width: 1px !important;
          stroke-linejoin: round;
          filter: drop-shadow(0 1px 0 rgb(74 56 32 / 0.05))
            drop-shadow(0 4px 7px rgb(74 56 32 / 0.1));
        }
        rect.actor, .node rect { rx: 12px; ry: 12px; }
        text.actor, text.actor > tspan {
          font-family: ${color("--serif")};
          font-size: 20px;
        }
        .nodeLabel, .node text { fill: var(--ink) !important; }
        .actor-line { stroke-dasharray: 3 4; stroke-width: 1px; }
        rect.note { rx: 10px; ry: 10px; }
        .noteText, .noteText > tspan { font-family: ${color("--serif")}; font-style: italic; }
        .messageLine0, .messageLine1 { stroke-width: 1.4px; }
        .cluster rect {
          rx: 12px; ry: 12px;
          fill: var(--paper-2) !important;
          stroke: var(--rule) !important;
        }
        .edgeLabel rect, .labelBkg {
          fill: var(--bg) !important;
          opacity: 1 !important;
        }
      `,
      flowchart: {
        useMaxWidth: false,
        wrappingWidth: 155,
        curve: "linear",
        nodeSpacing: 36,
        rankSpacing: 40,
        padding: 16,
      },
      sequence: {
        useMaxWidth: false,
        mirrorActors: false,
        // Messages render at the theme's 18px, so lifelines need room for
        // a typical label (about 280px) to sit between them unwrapped.
        width: 160,
        height: 56,
        actorMargin: 130,
        messageMargin: 44,
        boxMargin: 12,
        noteMargin: 14,
        wrapPadding: 16,
        actorFontSize: 18,
        messageFontSize: 18,
        noteFontSize: 17,
        wrap: true,
      },
    });
    await document.fonts.load(`18px ${fontFamily}`, "Diagram labels");
    await document.fonts.load(`20px ${color("--serif")}`, "Diagram actors");
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
