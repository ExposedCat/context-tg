import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HTML_VISUAL_KIT_FONT_PATH = "/__visual-kit/fonts/";

const FONT_STYLESHEETS = [
  "@fontsource-variable/source-serif-4/opsz.css",
  "@fontsource-variable/source-serif-4/opsz-italic.css",
  "@fontsource-variable/inter/wght.css",
  "@fontsource-variable/jetbrains-mono/wght.css",
];

export type HtmlVisualKit = {
  /** Font faces and component styles injected before every visual. */
  css: string;
  /** Bundled font files by name, served under HTML_VISUAL_KIT_FONT_PATH. */
  fonts: ReadonlyMap<string, string>;
};

let kit: Promise<HtmlVisualKit> | undefined;

async function loadHtmlVisualKit(): Promise<HtmlVisualKit> {
  const fonts = new Map<string, string>();
  const faces = await Promise.all(
    FONT_STYLESHEETS.map(async (specifier) => {
      const path = fileURLToPath(import.meta.resolve(specifier));
      const css = await Bun.file(path).text();
      // Block rendering until the face loads so screenshots never capture
      // fallback fonts or measure the page with different metrics.
      return css
        .replaceAll("font-display: swap", "font-display: block")
        .replace(/url\(\.\/files\/([\w.-]+\.woff2)\)/g, (_, name: string) => {
          fonts.set(name, join(dirname(path), "files", name));
          return `url(${HTML_VISUAL_KIT_FONT_PATH}${name})`;
        });
    }),
  );
  const components = await Bun.file(
    new URL("./html-visual-kit.css", import.meta.url),
  ).text();
  return { css: [...faces, components].join("\n"), fonts };
}

export function getHtmlVisualKit(): Promise<HtmlVisualKit> {
  kit ??= loadHtmlVisualKit().catch((error) => {
    kit = undefined;
    throw error;
  });
  return kit;
}
