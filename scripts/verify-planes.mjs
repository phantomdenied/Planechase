#!/usr/bin/env node
/**
 * verify-planes.mjs
 * Run locally (not in the CI container) to cross-check planes.js oracle
 * texts against the Scryfall API.
 *
 * Usage:
 *   node scripts/verify-planes.mjs
 *
 * Prerequisites: Node 18+, internet access to api.scryfall.com
 */

import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLANES_PATH = path.join(__dirname, '..', 'src', 'data', 'planes.js');

// ---------------------------------------------------------------------------
// Scryfall sets that contain planechase plane oversized cards
// ---------------------------------------------------------------------------
const SCRYFALL_SETS = [
  'ohop',  // Planechase 2009 Planes
  'opc2',  // Planechase 2012 Planes
  'opca',  // Planechase Anthology Planes
  'omoc',  // March of the Machine Commander Planes
];
// NOTE: WHO (Doctor Who) planechase planes live in the regular WHO set under
// layout:planar.  Add 'who' here if you want to check those too — the IDs on
// Scryfall are the same oversized-card style but may sit in the main WHO set.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'planechase-verifier/1.0 (+local)' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} for ${url}\n${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSet(setCode) {
  const cards = [];
  let url = `https://api.scryfall.com/cards/search?q=set%3A${setCode}+layout%3Aplanar&order=name&unique=prints`;
  while (url) {
    const data = await httpsGet(url);
    cards.push(...data.data);
    url = data.has_more ? data.next_page : null;
    if (url) await sleep(120); // Scryfall rate-limit: 10 req/s max
  }
  return cards;
}

/**
 * Split Scryfall oracle_text into static + chaos parts.
 * Scryfall stores the full oracle text as one string; chaos abilities
 * always start with "Whenever chaos ensues, " (never split across lines).
 */
function splitOracleText(oracleText) {
  if (!oracleText) return { static: null, chaos: null };

  // Match "Whenever chaos ensues, <rest>" which may span multiple lines
  const idx = oracleText.indexOf('\nWhenever chaos ensues, ');
  if (idx !== -1) {
    return {
      static: oracleText.slice(0, idx).trim(),
      chaos:  oracleText.slice(idx + '\nWhenever chaos ensues, '.length).trim(),
    };
  }
  // No chaos section (phenomena, or static-only planes)
  return { static: oracleText.trim(), chaos: null };
}

/** Extract world from Scryfall type_line, e.g. "Plane — Dominaria" → "Dominaria" */
function extractWorld(typeLine) {
  const m = typeLine.match(/^Plane\s+[—–-]\s+(.+)$/);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Load planes.js as a dynamic import (it's an ES module)
// ---------------------------------------------------------------------------
async function loadPlanesJs() {
  // Use a cache-busting query so Node doesn't cache stale data during dev
  const url = pathToFileURL(PLANES_PATH).href + '?t=' + Date.now();
  const mod = await import(url);
  return mod.PLANES;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Loading planes.js …');
  const PLANES = await loadPlanesJs();
  const localPlanes = PLANES.filter(p => p.type === 'plane');
  console.log(`  ${localPlanes.length} plane entries found.\n`);

  console.log('Fetching planechase planes from Scryfall …');
  const scryfallByName = new Map(); // canonical card name → Scryfall card object

  for (const setCode of SCRYFALL_SETS) {
    try {
      const cards = await fetchSet(setCode);
      let added = 0;
      for (const card of cards) {
        if (!scryfallByName.has(card.name)) {
          scryfallByName.set(card.name, card);
          added++;
        }
      }
      console.log(`  ${setCode.toUpperCase()}: ${cards.length} cards (${added} new unique names)`);
    } catch (e) {
      console.error(`  WARN: could not fetch ${setCode}: ${e.message}`);
    }
  }
  console.log(`  Total unique plane names from Scryfall: ${scryfallByName.size}\n`);

  // ---------------------------------------------------------------------------
  // Compare
  // ---------------------------------------------------------------------------
  const MISSING   = [];
  const MISMATCHES = [];

  for (const plane of localPlanes) {
    const sf = scryfallByName.get(plane.name);

    if (!sf) {
      MISSING.push(plane);
      continue;
    }

    const sfParsed = splitOracleText(sf.oracle_text);
    const sfWorld  = extractWorld(sf.type_line);

    const staticOk = sfParsed.static === plane.static;
    const chaosOk  = sfParsed.chaos  === plane.chaos;
    const worldOk  = sfWorld         === plane.world;

    if (!staticOk || !chaosOk || !worldOk) {
      MISMATCHES.push({ plane, sfParsed, sfWorld, staticOk, chaosOk, worldOk });
    }
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  if (MISSING.length) {
    console.log(`=== NOT FOUND ON SCRYFALL (${MISSING.length}) ===`);
    for (const p of MISSING) {
      console.log(`  • ${p.name}  (set: ${p.set}, id: ${p.id})`);
    }
    console.log();
  }

  if (MISMATCHES.length === 0 && MISSING.length === 0) {
    console.log('✓ All plane oracle texts and worlds match Scryfall!');
    return;
  }

  console.log(`=== MISMATCHES (${MISMATCHES.length}) ===\n`);

  for (const { plane, sfParsed, sfWorld, staticOk, chaosOk, worldOk } of MISMATCHES) {
    console.log(`── ${plane.name}  [${plane.set}] ──`);

    if (!worldOk) {
      console.log(`  WORLD`);
      console.log(`    planes.js : ${plane.world}`);
      console.log(`    Scryfall  : ${sfWorld}`);
    }
    if (!staticOk) {
      console.log(`  STATIC`);
      console.log(`    planes.js : ${plane.static}`);
      console.log(`    Scryfall  : ${sfParsed.static}`);
    }
    if (!chaosOk) {
      console.log(`  CHAOS`);
      console.log(`    planes.js : ${plane.chaos}`);
      console.log(`    Scryfall  : ${sfParsed.chaos}`);
    }
    console.log();
  }

  console.log(`Summary: ${MISMATCHES.length} mismatch(es), ${MISSING.length} not found.`);
  console.log('\nTip: Scryfall set codes for planechase planes:');
  console.log('  ohop = Planechase 2009 Planes');
  console.log('  opc2 = Planechase 2012 Planes');
  console.log('  opca = Planechase Anthology Planes (use to supplement opc2)');
  console.log('  omoc = March of the Machine Commander Planes');
  console.log('  Add "who" to SCRYFALL_SETS for Doctor Who planes (layout:planar)');
}

main().catch((e) => { console.error(e); process.exit(1); });
