/**
 * Build step: inflate the listing data, pull every photo from the source CDN,
 * and write two sizes per photo into dist/p/.
 *
 *   <id>_<n>_t.jpg   440px  card + strip thumbnail
 *   <id>_<n>_f.jpg   1200px lightbox
 *
 * Photos are baked into the deployment, so the finished site serves its own
 * images and never calls back out to the portals.
 */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import sharp from "sharp";

const OUT = "dist";
const P = `${OUT}/p`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const CONCURRENCY = 12;

await mkdir(P, { recursive: true });

/** Read a source file locally, falling back to the repo over HTTPS.
 *  Lets the Vercel deployment carry only this script. */
const SRC = "https://raw.githubusercontent.com/nandikaharahap-bot/jakarta-property-gallery/main/";
async function source(name) {
  try {
    return await readFile(name, "utf8");
  } catch {
    const r = await fetch(SRC + name);
    if (!r.ok) throw new Error(`cannot read ${name}: HTTP ${r.status}`);
    return await r.text();
  }
}

const data = JSON.parse(
  gunzipSync(Buffer.from(await source("data.b64"), "base64")).toString("utf8")
);
const { pfx, items } = data;

/** Lamudi refs are stored as "L:<key>" and rebuilt into the resizer payload. */
function lamudiUrls(key, w = 1200, h = 900) {
  const keys = key.startsWith("ingester/") ? [key] : [`properties/${key}`, key];
  return keys.map((k) => {
    const payload = {
      bucket: "prd-lifullconnect-backend-b2b-images",
      key: k,
      brand: "lamudi",
      edits: { rotate: null, resize: { width: w, height: h, fit: "cover" } },
    };
    return "https://img.lamudi.com/" + Buffer.from(JSON.stringify(payload)).toString("base64");
  });
}

function candidates(ref) {
  if (ref.startsWith("L:")) return lamudiUrls(ref.slice(2));
  if (/^https?:/.test(ref)) return [ref];
  const base = pfx + ref;
  return [base, base.replace(/\.jpg$/, ".png"), base.replace(/\.jpg$/, ".webp")];
}

async function grab(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://www.rumah123.com/" },
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const ct = r.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) throw new Error("not an image: " + ct);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 900) throw new Error("too small");
  return buf;
}

const jobs = [];
for (const it of items) {
  it.ph.forEach((ref, n) => jobs.push({ id: it.id, n, ref }));
}
console.log(`fetching ${jobs.length} photos for ${items.length} listings`);

let done = 0, failed = 0;
const missing = new Set();

async function work(job) {
  const { id, n, ref } = job;
  for (const url of candidates(ref)) {
    try {
      const buf = await grab(url);
      await Promise.all([
        sharp(buf).resize({ width: 440, withoutEnlargement: true })
          .jpeg({ quality: 74, progressive: true, mozjpeg: true })
          .toFile(`${P}/${id}_${n}_t.jpg`),
        sharp(buf).resize({ width: 1200, withoutEnlargement: true })
          .jpeg({ quality: 80, progressive: true, mozjpeg: true })
          .toFile(`${P}/${id}_${n}_f.jpg`),
      ]);
      if (++done % 100 === 0) console.log(`  ${done}/${jobs.length}`);
      return;
    } catch {
      /* try the next candidate extension */
    }
  }
  failed++;
  missing.add(`${id}_${n}`);
  console.warn(`  MISS ${id}_${n}`);
}

// simple fixed-size worker pool
let cursor = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < jobs.length) await work(jobs[cursor++]);
  })
);
console.log(`photos ok=${done} failed=${failed}`);

// Drop any photo that failed, then renumber the survivors onto contiguous
// indices so the page can address them as _0.._n without gaps.
let dropped = 0;
for (const it of items) {
  const surv = [];
  it.ph.forEach((_, n) => {
    if (missing.has(`${it.id}_${n}`)) dropped++;
    else surv.push(n);
  });
  for (let k = 0; k < surv.length; k++) {
    if (surv[k] === k) continue;
    for (const suf of ["t", "f"]) {
      await copyFile(`${P}/${it.id}_${surv[k]}_${suf}.jpg`,
                     `${P}/${it.id}_${k}_${suf}.jpg`).catch(() => {});
    }
  }
  it.ph = surv.map((n) => it.ph[n]);
  it.lb = surv.map((n) => (it.lb && it.lb[n]) || "");
}
const kept = items.filter((it) => it.ph.length > 0);
console.log(`dropped ${dropped} photos; ${kept.length}/${items.length} listings kept`);

await writeFile(`${OUT}/data.json`, JSON.stringify({ eur: data.eur, items: kept }));
await writeFile(`${OUT}/index.html`, await source("template.html"));
console.log("build complete");
