#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFParse } from "pdf-parse";

process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  let format = "text";
  let input = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--format") {
      format = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--format=")) {
      format = arg.slice("--format=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    }
    if (input) {
      fail("Expected a single PDF URL or file path");
    }
    input = arg;
  }

  if (!input) {
    fail("Missing PDF URL or file path");
  }
  if (!["text", "fragments"].includes(format)) {
    fail(`Unsupported format: ${format}`);
  }

  return { format, input };
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

async function extractPdfText(data) {
  const parser = new PDFParse({ data, disableWorker: true });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractPdfFragments(data) {
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useWorkerFetch: false,
  });
  const document = await loadingTask.promise;

  try {
    const fragments = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (!("str" in item)) {
            continue;
          }
          const text = item.str.replace(/\s+/g, " ").trim();
          if (!text) {
            continue;
          }
          fragments.push({
            page: pageNumber,
            x: Number(item.transform[4].toFixed(2)),
            y: Number(item.transform[5].toFixed(2)),
            text,
          });
        }
      } finally {
        page.cleanup();
      }
    }
    return JSON.stringify(fragments);
  } finally {
    await loadingTask.destroy();
  }
}

const { format, input } = parseArgs(process.argv.slice(2));
const data = await loadPdfBytes(input);
const output = format === "fragments" ? await extractPdfFragments(data) : await extractPdfText(data);
process.stdout.write(output);
