#!/usr/bin/env node
/**
 * fix-planes-from-scryfall.mjs
 *
 * Fetches every planechase plane from the MTGJSON API, compares oracle
 * text + world against src/data/planes.js, and rewrites the file in-place
 * with any corrections.
 *
 * Run locally OR via the sync-plane-texts GitHub Actions workflow.
 * Requires Node 18+ and network access to mtgjson.com.
 */

import { readFile, writeFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { fileURLToPath } from 'url';
import path from 'path';
import https from 'https';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PLANES_PATH = path.resolve(__dirname, '..', 'src', 'data', 'planes.js');

// MTGJSON set codes for planechase-only sets (every card is a plane/phenomenon)
const PLANE_ONLY_SETS = ['OHOP', 'OPC2', 'OPCA', 'PUNK'];

// Sets that contain planes mixed with regular cards — filter by layout
const MIXED_SETS = ['MOC', 'WHO'];

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'planechase-oracle-fixer/1.0 (+github.com/phantomdenied/Planechase)' },
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse: ${e.message}\n${body.slice(0, 300)}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

async function fetchMtgjsonSet(setCode) {
  const url = `https://mtgjson.com/api/v5/${setCode}.json`;
  console.log(`  Fetching ${url} …`);
  const data = await httpsGet(url);
  // MTGJSON structure: { data: { cards: [...], ... }, meta: {...} }
  return data.data.cards;
}

// ---------------------------------------------------------------------------
// Oracle-text parsing
// ---------------------------------------------------------------------------

/** Split "static\nWhenever chaos ensues, chaos" → { static, chaos }
 *  Handles:
 *   - "Whenever chaos ensues, effect"       (standard)
 *   - "When chaos ensues, effect"           (WHO variant)
 *   - "Name — Whenever chaos ensues, eff."  (WHO named ability)
 *   - "Chaos: effect"                       (PUNK short format)
 */
function parseOracleText(text) {
  if (!text) return { static: null, chaos: null };

  // Optional "Name — " prefix before the chaos trigger keyword, or bare "Chaos:" label
  const chaosRe = /\n((?:[^\n]+?[—–]\s+)?(?:Whenever |When )chaos ensues,\s*|Chaos:\s*)/;
  const m = text.match(chaosRe);

  if (m) {
    const staticPart  = text.slice(0, m.index).trim();
    const fullSep     = m[1];
    const chaosEffect = text.slice(m.index + m[0].length).trim();

    // If a named ability prefix was present, include it in the chaos output
    const namedMatch = fullSep.match(/^(.*?[—–]\s+)(?:Whenever |When )chaos ensues,\s*$/);
    if (namedMatch) {
      return { static: staticPart, chaos: namedMatch[1] + chaosEffect };
    }

    return { static: staticPart, chaos: chaosEffect };
  }

  return { static: text.trim(), chaos: null };
}

/** "Plane — Dominaria" → "Dominaria" */
function parseWorld(typeLine) {
  const m = typeLine?.match(/^Plane\s+[—–-]\s+(.+)$/);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// In-place file patching
// ---------------------------------------------------------------------------

function jsString(value) {
  if (value === null) return 'null';
  const safe = value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n');
  if (safe.includes("'") && !safe.includes('"')) {
    return `"${safe}"`;
  }
  return `'${safe.replace(/'/g, "\\'")}'`;
}

function applyCorrections(fileText, entryRanges, corrections) {
  const sorted = [...entryRanges].sort((a, b) => b.start - a.start);
  let result = fileText;

  for (const { id, start, end } of sorted) {
    const corr = corrections.get(id);
    if (!corr) continue;

    let block = result.slice(start, end);

    if (corr.type !== undefined) {
      block = block.replace(
        /(\btype:\s{0,10})(['"])(?:\\[\s\S]|(?!\2).)*\2/g,
        (_, key) => key + jsString(corr.type),
      );
    }
    if (corr.world !== undefined) {
      // world: sits mid-line (same line as id/name/set), so can't use a line-start lookbehind
      block = block.replace(
        /(\bworld:\s{0,10})(['"])(?:\\[\s\S]|(?!\2).)*\2/g,
        (_, key) => key + jsString(corr.world),
      );
    }
    if (corr.static !== undefined) {
      block = block.replace(
        /(?<=(^|\n)[\t ]*static:\s{0,10})(['"])(?:\\[\s\S]|(?!\2).)*\2/g,
        jsString(corr.static),
      );
    }
    if (corr.chaos !== undefined) {
      block = block.replace(
        /(?<=(^|\n)[\t ]*chaos:\s{0,10})(['"])(?:\\[\s\S]|(?!\2).)*\2/g,
        jsString(corr.chaos),
      );
    }

    result = result.slice(0, start) + block + result.slice(end);
  }

  return result;
}

function findEntryRanges(fileText) {
  const ranges = [];
  const idRe = /\{[\t ]*id:\s*(['"])([^'"]+)\1,/g;
  let m;
  while ((m = idRe.exec(fileText)) !== null) {
    const id    = m[2];
    const start = m.index;
    let depth = 0;
    let i = start;
    let end = -1;
    while (i < fileText.length) {
      if (fileText[i] === '{') depth++;
      if (fileText[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          if (fileText[end] === ',') end++;
          break;
        }
      }
      i++;
    }
    if (end !== -1) ranges.push({ id, start, end });
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // --- Load PLANES ---
  console.log('Loading planes.js …');
  const planesUrl = pathToFileURL(PLANES_PATH).href + '?t=' + Date.now();
  const { PLANES } = await import(planesUrl);
  const planeEntries = PLANES.filter(p => p.type === 'plane' || p.type === 'phenomenon');
  console.log(`  ${planeEntries.length} plane/phenomenon entries.\n`);

  // --- Fetch from MTGJSON ---
  console.log('Fetching from MTGJSON …');
  const byName = new Map(); // card name → { text, type }

  for (const setCode of PLANE_ONLY_SETS) {
    try {
      const cards = await fetchMtgjsonSet(setCode);
      let added = 0;
      for (const c of cards) {
        if (!byName.has(c.name)) { byName.set(c.name, c); added++; }
      }
      console.log(`    ${setCode}: ${cards.length} cards (${added} new)`);
    } catch (e) {
      console.error(`  WARN: ${setCode} failed: ${e.message}`);
    }
  }

  for (const setCode of MIXED_SETS) {
    try {
      const cards = await fetchMtgjsonSet(setCode);
      const planes = cards.filter(c => c.layout === 'planar');
      let added = 0;
      for (const c of planes) {
        if (!byName.has(c.name)) { byName.set(c.name, c); added++; }
      }
      console.log(`    ${setCode}: ${planes.length} planes from ${cards.length} cards (${added} new)`);
    } catch (e) {
      console.error(`  WARN: ${setCode} failed: ${e.message}`);
    }
  }

  console.log(`\n  Total unique plane names: ${byName.size}\n`);

  if (byName.size === 0) {
    console.error('ERROR: No cards fetched — all requests failed. Check connectivity.');
    process.exit(1);
  }

  // --- Build correction map ---
  const corrections = new Map();
  const mismatches  = [];

  for (const plane of planeEntries) {
    const card = byName.get(plane.name);
    if (!card) continue;

    // MTGJSON uses `text` for oracle text and `type` for type line
    const parsed     = parseOracleText(card.text);
    const world      = parseWorld(card.type);
    const cardIsPhen = /^Phenomenon\b/i.test(card.type);
    const corr       = {};

    // Type mismatch (plane ↔ phenomenon)
    if (cardIsPhen && plane.type === 'plane')        corr.type = 'phenomenon';
    if (!cardIsPhen && plane.type === 'phenomenon')  corr.type = 'plane';

    if (!cardIsPhen && world && world !== plane.world) corr.world = world;
    if (cardIsPhen && plane.world !== null)            corr.world = null;

    if (parsed.static && parsed.static !== plane.static) corr.static = parsed.static;
    if (parsed.chaos !== null && parsed.chaos !== plane.chaos) corr.chaos = parsed.chaos;
    if (cardIsPhen && plane.chaos !== null) corr.chaos = null;

    if (Object.keys(corr).length > 0) {
      corrections.set(plane.id, corr);
      mismatches.push({ plane, parsed, world, corr });
    }
  }

  if (mismatches.length === 0) {
    console.log('✓  All plane texts match MTGJSON — no changes needed.');
    return;
  }

  console.log(`Found ${mismatches.length} plane(s) to correct:\n`);
  for (const { plane, parsed, world, corr } of mismatches) {
    console.log(`  ${plane.name} [${plane.id}]`);
    if (corr.type   !== undefined) console.log(`    type  : "${plane.type}" → "${corr.type}"`);
    if (corr.world  !== undefined) console.log(`    world : "${plane.world}" → "${corr.world}"`);
    if (corr.static !== undefined) console.log(`    static: "${plane.static?.slice(0, 60)}…" → "${corr.static?.slice(0, 60)}…"`);
    if (corr.chaos  !== undefined) console.log(`    chaos : "${plane.chaos?.slice(0, 60)}…"  → "${corr.chaos?.slice(0, 60)}…"`);
  }
  console.log();

  const fileText  = await readFile(PLANES_PATH, 'utf-8');
  const ranges    = findEntryRanges(fileText);
  const corrected = applyCorrections(fileText, ranges, corrections);

  if (corrected === fileText) {
    console.warn('WARNING: patch produced no changes — check regex assumptions.');
    process.exitCode = 1;
    return;
  }

  await writeFile(PLANES_PATH, corrected, 'utf-8');
  console.log(`✓  planes.js updated with ${mismatches.length} correction(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
