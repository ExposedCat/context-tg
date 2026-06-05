import { createDebug } from "@grammyjs/debug";
import type { FunctionToolRunner } from "./types.ts";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TRANSCRIPT_CHARS = 80_000;
const SUBTITLE_LANGUAGES = "en";
const SYSTEM_YOUTUBE_DL_PATH = "/usr/local/bin/yt-dlp";

const logError = createDebug("app:llm-tools:youtube:error");

export const toolDefinition = {
  type: "function",
  name: "read_youtube_video",
  description:
    "Download English YouTube closed captions/subtitles for a video URL and return the transcript. Use this when the user asks to read, summarize, or answer questions about a YouTube video from its captions.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "A YouTube video URL.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  strict: true,
} as const;

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    return (
      hostname === "youtu.be" ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtube-nocookie.com" ||
      hostname.endsWith(".youtube-nocookie.com")
    );
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value: string): string {
  return value.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    const namedEntities: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"',
    };
    const normalizedCode = String(code).toLowerCase();

    if (normalizedCode.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(normalizedCode.slice(2), 16));
    }

    if (normalizedCode.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(normalizedCode.slice(1), 10));
    }

    return namedEntities[normalizedCode] ?? entity;
  });
}

function cleanCueText(value: string): string {
  return decodeHtmlEntities(
    value
      .replaceAll(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, " ")
      .replaceAll(/<[^>]*>/g, " ")
      .replaceAll(/\s+/g, " ")
      .trim(),
  );
}

function parseVttTranscript(content: string): string {
  const cues: string[] = [];
  let block: string[] = [];
  let skippingBlock = false;

  const flushBlock = () => {
    if (block.length === 0 || skippingBlock) {
      block = [];
      skippingBlock = false;
      return;
    }

    const text = cleanCueText(block.join(" "));
    const previous = cues.at(-1);

    if (text && text !== previous) {
      if (previous && text.startsWith(`${previous} `)) {
        cues.push(text.slice(previous.length).trim());
      } else if (!previous?.startsWith(`${text} `)) {
        cues.push(text);
      }
    }

    block = [];
  };

  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      flushBlock();
      continue;
    }

    if (
      line === "WEBVTT" ||
      line.includes("-->") ||
      /^\d+$/.test(line) ||
      /^(Kind|Language):\s/.test(line)
    ) {
      continue;
    }

    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
      flushBlock();
      skippingBlock = true;
      continue;
    }

    block.push(line);
  }

  flushBlock();

  return cues.join("\n").trim();
}

function truncateTranscript(transcript: string) {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
    return { transcript, truncated: false };
  }

  return {
    transcript: transcript.slice(0, MAX_TRANSCRIPT_CHARS).trimEnd(),
    truncated: true,
  };
}

async function findSubtitleFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.toLowerCase().endsWith(".vtt")) {
      files.push(`${directory}/${entry.name}`);
    }
  }

  return files.sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }

    throw error;
  }
}

async function getYoutubeDl() {
  const { create, youtubeDl } = await import("youtube-dl-exec");
  const configuredPath =
    Deno.env.get("YOUTUBE_DL_PATH") ?? Deno.env.get("YT_DLP_PATH");

  if (configuredPath) {
    return create(configuredPath);
  }

  if (await pathExists(SYSTEM_YOUTUBE_DL_PATH)) {
    return create(SYSTEM_YOUTUBE_DL_PATH);
  }

  return youtubeDl;
}

async function downloadCaptions(url: string, directory: string) {
  const youtubeDl = await getYoutubeDl();

  await youtubeDl(
    url,
    {
      noCheckCertificates: true,
      noPlaylist: true,
      noProgress: true,
      noWarnings: true,
      output: `${directory}/captions`,
      quiet: true,
      skipDownload: true,
      subFormat: "vtt",
      subLang: SUBTITLE_LANGUAGES,
      writeAutoSub: true,
      writeSub: true,
    },
    {
      killSignal: "SIGKILL",
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
}

export const execute: FunctionToolRunner = async (args) => {
  const url = getString(args?.url);

  if (!url || !isYouTubeUrl(url)) {
    return JSON.stringify({
      error: "read_youtube_video requires a valid YouTube video URL.",
    });
  }

  const directory = await Deno.makeTempDir({ prefix: "youtube-captions-" });

  try {
    await downloadCaptions(url, directory);

    const subtitleFiles = await findSubtitleFiles(directory);
    if (subtitleFiles.length === 0) {
      return JSON.stringify({
        url,
        error: "No English closed captions or subtitles were found.",
      });
    }

    const sourceFile = subtitleFiles[0];
    const content = await Deno.readTextFile(sourceFile);
    const transcript = parseVttTranscript(content);
    const truncated = truncateTranscript(transcript);

    return JSON.stringify({
      url,
      sourceFile: sourceFile.split("/").at(-1),
      ...truncated,
    });
  } catch (error) {
    logError("Failed to read YouTube captions", { url, error });

    return JSON.stringify({
      url,
      error:
        error instanceof Error
          ? `Failed to download captions: ${error.message}`
          : "Failed to download captions.",
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};
