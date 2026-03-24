#!/usr/bin/env node

import { PDFParse } from "pdf-parse";

const url = process.argv[2];

if (!url) {
  console.error("Missing PDF URL");
  process.exit(1);
}

const parser = new PDFParse({ url, disableWorker: true });

try {
  const result = await parser.getText();
  process.stdout.write(result.text);
} finally {
  await parser.destroy();
}
