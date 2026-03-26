#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";

const input = process.argv[2];

if (!input) {
  console.error("Missing PDF URL or file path");
  process.exit(1);
}

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://www.amundietf.lu/",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPdfBytes(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(url, {
        headers: DEFAULT_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Unexpected server response (${response.status}) while retrieving PDF "${url}".`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length === 0) {
        throw new Error(`Downloaded empty response for PDF "${url}".`);
      }

      if (!contentType.includes("pdf") && buffer[0] === 0x3c) {
        throw new Error(`Expected PDF bytes from "${url}" but received HTML instead.`);
      }

      return buffer;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(500 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error(`Could not download PDF "${url}".`);
}

async function loadPdfBytes(value) {
  if (/^https?:\/\//i.test(value)) {
    return fetchPdfBytes(value);
  }
  return new Uint8Array(await readFile(value));
}

const data = await loadPdfBytes(input);
const parser = new PDFParse({ data, disableWorker: true });

try {
  const result = await parser.getText();
  process.stdout.write(result.text);
} finally {
  await parser.destroy();
}
