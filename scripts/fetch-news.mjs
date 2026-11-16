#!/usr/bin/env node
/**
 * Fetches the Google News RSS feed for the Ukraine war and writes news.json.
 *
 * Runs server-side (GitHub Actions), which sidesteps the browser CORS problem:
 * news.google.com does not send Access-Control-Allow-Origin, so a static page
 * cannot read the feed directly. The page reads the generated file instead.
 *
 * Usage: node scripts/fetch-news.mjs [--out news.json] [--max 20] [--hours 24]
 */

import { writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const FEED_QUERY = "ukraine+russia+war+when:1d";
const FEED_URL = `https://news.google.com/rss/search?q=${FEED_QUERY}&hl=en-US&gl=US&ceid=US:en`;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(ROOT, arg("out", "news.json"));
const MAX = Number(arg("max", "20"));
const HOURS = Number(arg("hours", "24"));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : "";
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleTokens(value) {
  const text = normalizeKey(value);
  const common = new Set("about after against amid and are as at by for from has have in into is its of on or over says said that the their there these this to was were what when while with ukraine ukrainian russia russian war latest news report reports".split(" "));
  return text.split(/\s+/).filter((word) => word.length > 2 && !common.has(word));
}

function similarHeadline(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.length < 3 || b.length < 3) return normalizeKey(left) === normalizeKey(right);
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  setA.forEach((word) => { if (setB.has(word)) overlap += 1; });
  const smaller = Math.min(setA.size, setB.size);
  const dice = (2 * overlap) / (setA.size + setB.size);
  return overlap >= 3 && overlap / smaller >= 0.78 && dice >= 0.66;
}

function dedupeStories(items) {
  const seenLinks = new Set();
  const unique = [];
  items.forEach((item) => {
    if (unique.length >= MAX) return;
    const linkKey = normalizeKey(item.link);
    if (linkKey && seenLinks.has(linkKey)) return;
    if (unique.some((prior) => similarHeadline(prior.headline, item.headline))) return;
    if (linkKey) seenLinks.add(linkKey);
    unique.push(item);
  });
  return unique;
}

function parseFeed(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const cutoff = Date.now() - HOURS * 3600 * 1000;

  return dedupeStories(items
    .map((raw) => {
      const title = stripTags(pick(raw, "title"));
      const link = decodeEntities(pick(raw, "link")).trim();
      const pubDate = new Date(stripTags(pick(raw, "pubDate")));
      const source = stripTags(pick(raw, "source"));
      const idx = title.lastIndexOf(" - ");
      const headline = idx > 0 ? title.slice(0, idx) : title;
      const publisher = source || (idx > 0 ? title.slice(idx + 3) : "News source");
      return {
        headline: headline.trim(),
        publisher: publisher.trim(),
        date: pubDate.toISOString(),
        link,
        summary: "",
      };
    })
    .filter((x) => x.headline && x.link && !Number.isNaN(Date.parse(x.date)))
    .filter((x) => Date.parse(x.date) >= cutoff)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date)))
    .slice(0, MAX);
}

async function fetchFeed() {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(FEED_URL, {
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, */*" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      console.error(`attempt ${attempt} failed: ${err.message}`);
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

async function main() {
  const xml = await fetchFeed();
  const items = parseFeed(xml);

  if (!items.length) { throw new Error("feed parsed but produced 0 usable headlines"); }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: FEED_URL,
    windowHours: HOURS,
    count: items.length,
    items,
  };

  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.error(`wrote ${items.length} headlines -> ${OUT}`);
  console.log(`OK ${items.length}`);
}

main().catch(async (err) => {
  console.error(`FAILED: ${err.message}`);
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8"));
    console.error(`keeping previous news.json (${prev.count ?? "?"} items, generated ${prev.generatedAt})`);
  } catch {
    console.error("no previous news.json to keep");
  }
  process.exit(1);
});
