import { lookup } from "node:dns/promises";
import { get as getHttp, type IncomingMessage } from "node:http";
import { get as getHttps } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

async function requestPublicAsset(
  url: URL,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Visual assets require an HTTP(S) URL without credentials.",
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  signal.throwIfAborted();
  const address = addresses.find(
    ({ address }) => ipaddr.process(address).range() === "unicast",
  );
  if (!address) throw new Error("Visual assets require a public address.");

  const get = url.protocol === "https:" ? getHttps : getHttp;
  // Connect to the checked address. Keep the original host for HTTP and TLS.
  return await new Promise((resolve, reject) => {
    get(
      {
        hostname: address.address,
        port: url.port,
        path: url.pathname + url.search,
        servername: isIP(hostname) ? undefined : hostname,
        headers: { host: url.host, "accept-encoding": "identity" },
        agent: false,
        signal,
      },
      resolve,
    ).once("error", reject);
  });
}

export async function fetchHtmlVisualAsset(
  url: string,
  signal: AbortSignal,
): Promise<{ body: Buffer; contentType?: string }> {
  let target = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await requestPublicAsset(target, signal);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.destroy();
      target = new URL(location, target);
      continue;
    }
    if (
      status < 200 ||
      status >= 300 ||
      Number(response.headers["content-length"]) > MAX_ASSET_BYTES
    ) {
      response.destroy();
      throw new Error("Visual asset was unavailable or too large.");
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_ASSET_BYTES)
        throw new Error("Visual asset was too large.");
      chunks.push(chunk);
    }
    return {
      body: Buffer.concat(chunks, size),
      contentType: response.headers["content-type"],
    };
  }
  throw new Error("Visual asset exceeded the redirect limit.");
}
