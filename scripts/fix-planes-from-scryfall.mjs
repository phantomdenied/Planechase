#!/usr/bin/env node
/**
 * fix-planes-from-scryfall.mjs
 *
 * Fetches every planechase plane from the Scryfall API, compares oracle
 * text + world against src/data/planes.js, and rewrites the file in-place
 * with any corrections.
 *
 * Run locally OR via the sync-plane-texts GitHub Actions workflow.
 * Requires Node 18+ and network access to api.scryfall.com.
 */

import { readFile, writeFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { fileURLToPath } from 'url';
import path from 'path';
import https from 'https';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PLANES_PATH = path.resolve(__dirname, '..', 'src', 'data', 'planes.js');

// Scryfall set codes for planechase oversized card sets
const SCRYFALL_SETS = [
  'ohop',   // Planechase 2009 Planes
  'opc2',   // Planechase 2012 Planes
  'opca',   // Planechase Anthology Planes
];
// MOC and WHO planechase planes live in layout:planar cards within the
// regular commander set itself.  We query those separately below.

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'planechase-oracle-fixer/1.0' },
    }, (res) => {
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
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchBySet(setCode) {
  const cards = [];
  let url = `https://api.scryfall.com/cards/search?q=set%3A${setCode}+layout%3Aplanar&order=name&unique=prints`;
  while (url) {
    const data = await httpsGet(url);
    cards.push(...data.data);
    url = data.has_more ? data.next_page : null;
    if (url) await sleep(110); // respect Scryfall's 10 req/s limit
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Oracle-text parsing
// ---------------------------------------------------------------------------

/** Split "static\nWhenever chaos ensues, chaos" → { static, chaos }  */
function parseOracleText(text) {
  if (!text) return { static: null, chaos: null };
  const sep = '\nWhenever chaos ensues, ';
  const idx = text.indexOf(sep);
  if (idx !== -1) {
    return {
      static: text.slice(0, idx).trim(),
      chaos:  text.slice(idx + sep.length).trim(),
    };
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

/**
 * Build a JS string literal for `value` using the most readable quote style:
 *   - null  → "null" (unquoted, for chaos on phenomena)
 *   - apostrophes but no double-quotes → double-quoted string
 *   - otherwise → single-quoted string with escaped apostrophes
 */
function jsString(value) {
  if (value === null) return 'null';
  if (value.includes("'") && !value.includes('"')) {
    return `"${value}"`;
  }
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Regex that matches a quoted JS string value for a given field name.
 * Handles both single- and double-quoted strings with escape sequences.
 * The field name must appear at the start of a line (after whitespace).
 */
function fieldRegex(fieldName) {
  // Matches:  static: 'text'  or  static: "text"  (with escapes inside)
  return new RegExp(
    `(?<=(^|\\n)[\\t ]*${fieldName}:\\s{0,10})` +   // lookbehind: "  static:  "
    `(['"])(?:(?!\\2).|\\\\[\\s\\S])*?\\2`,           // the quoted string
    'g',
  );
}

/**
 * Apply corrections to `fileText`.
 * `entryRanges` is an array of {id, start, end} giving each plane entry's
 * character span in the file.
 * `corrections` is Map<id, {world, static, chaos}>.
 */
function applyCorrections(fileText, entryRanges, corrections) {
  // Work from back to front so character offsets stay valid.
  const sorted = [...entryRanges].sort((a, b) => b.start - a.start);
  let result = fileText;

  for (const { id, start, end } of sorted) {
    const corr = corrections.get(id);
    if (!corr) continue;

    let block = result.slice(start, end);

    if (corr.world !== undefined) {
      block = block.replace(
        /(?<=(^|\n)[\t ]*world:\s{0,10})(['"])(?:(?!\2).|\\[\s\S])*?\2/g,
        jsString(corr.world),
      );
    }
    if (corr.static !== undefined) {
      block = block.replace(
        /(?<=(^|\n)[\t ]*static:\s{0,10})(['"])(?:(?!\2).|\\[\s\S])*?\2/g,
        jsString(corr.static),
      );
    }
    if (corr.chaos !== undefined) {
      block = block.replace(
        /(?<=(^|\n)[\t ]*chaos:\s{0,10})(['"])(?:(?!\2).|\\[\s\S])*?\2/g,
        jsString(corr.chaos),
      );
    }

    result = result.slice(0, start) + block + result.slice(end);
  }

  return result;
}

/**
 * Find the character ranges of each plane entry in the file.
 * Returns [{id, start, end}] where the span covers from "{ id: 'X'" to the
 * closing "}," of that entry.
 */
function findEntryRanges(fileText) {
  const ranges = [];
  // Match "{ id: 'some-id'," or '{ id: "some-id",'
  const idRe = /\{[\t ]*id:\s*(['"])([^'"]+)\1,/g;
  let m;
  while ((m = idRe.exec(fileText)) !== null) {
    const id    = m[2];
    const start = m.index;
    // Find the closing "}," for this entry
    let depth = 0;
    let i = start;
    let end = -1;
    while (i < fileText.length) {
      if (fileText[i] === '{') depth++;
      if (fileText[i] === '}') {
        depth--;
        if (depth === 0) {
          // skip optional comma + whitespace after '}'
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
  // --- Load PLANES from the JS module ---
  console.log('Loading planes.js …');
  const planesUrl = pathToFileURL(PLANES_PATH).href + '?t=' + Date.now();
  const { PLANES } = await import(planesUrl);
  const planeEntries = PLANES.filter(p => p.type === 'plane');
  console.log(`  ${planeEntries.length} plane entries.\n`);

  // Index local planes by name (primary) and id (fallback)
  const localByName = new Map(planeEntries.map(p => [p.name, p]));

  // --- Fetch from Scryfall ---
  console.log('Fetching from Scryfall …');
  const sfByName = new Map(); // card name → scryfall card

  for (const setCode of SCRYFALL_SETS) {
    try {
      const cards = await fetchBySet(setCode);
      for (const c of cards) {
        if (!sfByName.has(c.name)) sfByName.set(c.name, c);
      }
      console.log(`  ${setCode}: ${cards.length} cards`);
    } catch (e) {
      console.error(`  WARN: ${setCode} failed: ${e.message}`);
    }
  }

  // MOC planes: layout:planar in the 'moc' (March of the Machine Commander) set
  try {
    const mocUrl = `https://api.scryfall.com/cards/search?q=set%3Amoc+layout%3Aplanar&order=name`;
    const mocData = await httpsGet(mocUrl);
    for (const c of mocData.data) {
      if (!sfByName.has(c.name)) sfByName.set(c.name, c);
    }
    console.log(`  MOC: ${mocData.data.length} cards`);
  } catch (e) {
    console.error(`  WARN: MOC fetch failed: ${e.message}`);
  }

  // WHO planes: layout:planar in the 'who' set
  try {
    const whoUrl = `https://api.scryfall.com/cards/search?q=set%3Awho+layout%3Aplanar&order=name`;
    const whoData = await httpsGet(whoUrl);
    for (const c of whoData.data) {
      if (!sfByName.has(c.name)) sfByName.set(c.name, c);
    }
    console.log(`  WHO: ${whoData.data.length} cards`);
  } catch (e) {
    console.error(`  WARN: WHO fetch failed: ${e.message}`);
  }

  console.log(`  Total unique names: ${sfByName.size}\n`);

  if (sfByName.size === 0) {
    console.error('ERROR: No cards fetched from Scryfall — all requests failed. Check connectivity.');
    process.exit(1);
  }

  // --- Build correction map ---
  const corrections  = new Map(); // planeId → {world?, static?, chaos?}
  const mismatches   = [];

  for (const plane of planeEntries) {
    const sf = sfByName.get(plane.name);
    if (!sf) continue;

    const sfParsed = parseOracleText(sf.oracle_text);
    const sfWorld  = parseWorld(sf.type_line);
    const corr     = {};

    if (sfWorld && sfWorld !== plane.world) {
      corr.world = sfWorld;
    }
    if (sfParsed.static && sfParsed.static !== plane.static) {
      corr.static = sfParsed.static;
    }
    // For chaos, null means no chaos on Scryfall (phenomena) — only update
    // when Scryfall has a value that differs.
    if (sfParsed.chaos !== null && sfParsed.chaos !== plane.chaos) {
      corr.chaos = sfParsed.chaos;
    }

    if (Object.keys(corr).length > 0) {
      corrections.set(plane.id, corr);
      mismatches.push({ plane, sfParsed, sfWorld, corr });
    }
  }

  if (mismatches.length === 0) {
    console.log('✓  All plane texts match Scryfall — no changes needed.');
    return;
  }

  // --- Log what will change ---
  console.log(`Found ${mismatches.length} plane(s) to correct:\n`);
  for (const { plane, sfParsed, sfWorld, corr } of mismatches) {
    console.log(`  ${plane.name} [${plane.id}]`);
    if (corr.world  !== undefined) console.log(`    world : "${plane.world}" → "${corr.world}"`);
    if (corr.static !== undefined) console.log(`    static: "${plane.static?.slice(0, 60)}…" → "${corr.static?.slice(0, 60)}…"`);
    if (corr.chaos  !== undefined) console.log(`    chaos : "${plane.chaos?.slice(0, 60)}…"  → "${corr.chaos?.slice(0, 60)}…"`);
  }
  console.log();

  // --- Patch planes.js ---
  const fileText   = await readFile(PLANES_PATH, 'utf-8');
  const ranges     = findEntryRanges(fileText);
  const corrected  = applyCorrections(fileText, ranges, corrections);

  if (corrected === fileText) {
    console.warn('WARNING: patch produced no changes — check regex assumptions.');
    process.exitCode = 1;
    return;
  }

  await writeFile(PLANES_PATH, corrected, 'utf-8');
  console.log(`✓  planes.js updated with ${mismatches.length} correction(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
