/**
 * core-cms-sync entrypoint (multi-city).
 *
 * Reads cities.json, iterates over each active city, pulls its Webflow
 * venues collection (primary + secondary locales), normalizes it, and
 * writes two JSON files PER CITY:
 *   - data/{slug}/venues-full.json   all non-draft, non-archived venues
 *   - data/{slug}/venues-lite.json   only featured-on-core-tulum venues
 *
 * Adding a new city = adding a row to cities.json. No code changes.
 *
 * The Webflow API token is shared across cities (typical case — one
 * workspace, multiple sites). If a city lives in a different Webflow
 * workspace, set its `webflowApiTokenEnvVar` field to point at a
 * different env var name.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebflowClient } from "webflow-api";
import { discoverLocales } from "./webflow/locales.js";
import {
  discoverCollections,
  fetchAllItems,
  findCollectionBySlug,
  type WebflowItem,
} from "./webflow/collections.js";
import {
  mergeLocaleItems,
  transformVenueBase,
  transformVenueLocale,
  type VenueLocaleData,
} from "./transforms/venues.js";
import { toLiteVenue, type FullVenue, type LiteVenue } from "./lite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT_DIR, "data");
const CITIES_CONFIG = resolve(ROOT_DIR, "cities.json");

// ---------------------------------------------------------------------------
// Cities config types
// ---------------------------------------------------------------------------

interface CityConfig {
  slug: string;
  displayName: string;
  webflowSiteId: string;
  venuesCollectionSlug: string;
  active: boolean;
  /** Optional env var name override if this city's Webflow site lives in a different workspace */
  webflowApiTokenEnvVar?: string;
}

interface CitiesConfigFile {
  cities: CityConfig[];
}

async function loadCitiesConfig(): Promise<CityConfig[]> {
  const raw = await readFile(CITIES_CONFIG, "utf8");
  const parsed = JSON.parse(raw) as CitiesConfigFile;
  if (!Array.isArray(parsed.cities)) {
    throw new Error(`cities.json: missing or invalid "cities" array`);
  }
  return parsed.cities;
}

// ---------------------------------------------------------------------------
// JSON output helpers
// ---------------------------------------------------------------------------

async function writeCityJson(
  citySlug: string,
  filename: string,
  payload: unknown,
): Promise<void> {
  const cityDir = resolve(DATA_DIR, citySlug);
  await mkdir(cityDir, { recursive: true });
  const path = resolve(cityDir, filename);
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`    wrote ${path}`);
}

// ---------------------------------------------------------------------------
// Per-city sync
// ---------------------------------------------------------------------------

interface CitySyncResult {
  slug: string;
  full: number;
  lite: number;
  skipped: number;
  failed: number;
}

async function syncCity(city: CityConfig): Promise<CitySyncResult> {
  console.log(`\n→ ${city.displayName} (${city.slug})`);

  // Resolve the API token — default WEBFLOW_API_TOKEN, optionally
  // overridden per city for multi-workspace setups.
  const tokenEnvVar = city.webflowApiTokenEnvVar ?? "WEBFLOW_API_TOKEN";
  const accessToken = process.env[tokenEnvVar];
  if (!accessToken) {
    throw new Error(
      `${city.slug}: env var ${tokenEnvVar} is not set`,
    );
  }
  const client = new WebflowClient({ accessToken });

  // Discover locales for this site
  console.log("  → discovering locales");
  const locales = await discoverLocales(client, city.webflowSiteId);
  const primaryTag = locales.byCmsLocaleId[locales.primary.cmsLocaleId] ?? "en";
  const secondaryLocale = locales.secondary[0];
  const secondaryTag = secondaryLocale
    ? (locales.byCmsLocaleId[secondaryLocale.cmsLocaleId] ?? "es")
    : "";
  console.log(
    `    primary=${primaryTag} secondary=${secondaryTag || "(none)"}`,
  );

  // Discover the venues collection by slug
  console.log("  → discovering collections");
  const collections = await discoverCollections(client, city.webflowSiteId);
  const venueCollection = findCollectionBySlug(
    collections,
    city.venuesCollectionSlug,
  );
  if (!venueCollection) {
    throw new Error(
      `${city.slug}: no "${city.venuesCollectionSlug}" collection found. ` +
        `Available: ${collections.map((c) => c.slug).join(", ")}`,
    );
  }
  console.log(
    `    venues collection: ${venueCollection.slug} (${venueCollection.id})`,
  );

  // Fetch primary + secondary locale items
  console.log("  → fetching venue items");
  const primaryItems = await fetchAllItems(client, venueCollection.id);
  console.log(`    ${primaryTag}: ${primaryItems.length} items`);

  let secondaryItems: WebflowItem[] = [];
  if (secondaryLocale?.cmsLocaleId) {
    secondaryItems = await fetchAllItems(
      client,
      venueCollection.id,
      secondaryLocale.cmsLocaleId,
    );
    console.log(`    ${secondaryTag}: ${secondaryItems.length} items`);
  }

  // Merge by item ID
  const merged = mergeLocaleItems(
    primaryItems,
    secondaryItems,
    primaryTag,
    secondaryTag,
  );

  // Transform → full + lite
  console.log("  → transforming");
  const fullVenues: FullVenue[] = [];
  const liteVenues: LiteVenue[] = [];
  let skippedDraftOrArchived = 0;
  let failed = 0;

  for (const [, entry] of merged) {
    const item = entry.primary;
    if (item.isArchived === true || item.isDraft === true) {
      skippedDraftOrArchived++;
      continue;
    }
    try {
      const localesObj: Record<string, VenueLocaleData> = {};
      for (const [tag, fieldData] of Object.entries(entry.localeFieldData)) {
        localesObj[tag] = transformVenueLocale(fieldData);
      }

      const base = transformVenueBase(item);

      const full: FullVenue = {
        webflowItemId: item.id,
        base,
        locales: localesObj,
        lastPublished: item.lastPublished,
        lastUpdated: item.lastUpdated,
      };
      fullVenues.push(full);

      const lite = toLiteVenue(full, item);
      if (lite) liteVenues.push(lite);
    } catch (err) {
      failed++;
      console.warn(
        `    ! failed to transform ${item.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const syncedAt = new Date().toISOString();

  console.log("  → writing JSON");
  await writeCityJson(city.slug, "venues-full.json", {
    syncedAt,
    citySlug: city.slug,
    venues: fullVenues,
  });
  await writeCityJson(city.slug, "venues-lite.json", {
    syncedAt,
    citySlug: city.slug,
    venues: liteVenues,
  });

  console.log(
    `  ✓ ${city.displayName}: ${fullVenues.length} full / ${liteVenues.length} lite ` +
      `(${skippedDraftOrArchived} skipped, ${failed} failed)`,
  );

  return {
    slug: city.slug,
    full: fullVenues.length,
    lite: liteVenues.length,
    skipped: skippedDraftOrArchived,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Main: loop over cities
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("→ loading cities config");
  const allCities = await loadCitiesConfig();
  const activeCities = allCities.filter((c) => c.active);

  console.log(
    `  ${activeCities.length}/${allCities.length} cities active: ` +
      activeCities.map((c) => c.slug).join(", "),
  );

  if (activeCities.length === 0) {
    console.log("  ! no active cities — nothing to sync");
    return;
  }

  // Optional: filter to a single city via env var (used by the webhook
  // receiver to sync only the city whose Webflow site fired the event).
  const onlyCitySlug = process.env.SYNC_ONLY_CITY;
  const citiesToSync = onlyCitySlug
    ? activeCities.filter((c) => c.slug === onlyCitySlug)
    : activeCities;

  if (onlyCitySlug && citiesToSync.length === 0) {
    throw new Error(
      `SYNC_ONLY_CITY="${onlyCitySlug}" but no matching active city in cities.json`,
    );
  }

  if (onlyCitySlug) {
    console.log(`  ! filtered by SYNC_ONLY_CITY=${onlyCitySlug}`);
  }

  // Sync each city. We don't bail on the first failure — if Cabos fails,
  // we still want Tulum's sync to complete (and vice versa).
  const results: CitySyncResult[] = [];
  const errors: { slug: string; error: string }[] = [];

  for (const city of citiesToSync) {
    try {
      const result = await syncCity(city);
      results.push(result);
    } catch (err) {
      errors.push({
        slug: city.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(
        `  ✗ ${city.slug} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Summary
  console.log("\n→ summary");
  for (const r of results) {
    console.log(
      `  ✓ ${r.slug}: ${r.full} full / ${r.lite} lite ` +
        `(${r.skipped} skipped, ${r.failed} failed)`,
    );
  }
  for (const e of errors) {
    console.log(`  ✗ ${e.slug}: ${e.error}`);
  }

  if (errors.length > 0) {
    console.error(`\n✗ sync completed with ${errors.length} failed cities`);
    process.exit(1);
  }
  console.log("\n✓ all cities synced");
}

main().catch((err) => {
  console.error("✗ sync failed:", err);
  process.exit(1);
});
