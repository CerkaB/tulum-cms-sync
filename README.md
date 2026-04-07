# core-cms-sync

> Repo name is still `tulum-cms-sync` for legacy reasons. The contents serve every Core market — Tulum, Cabos, Mykonos, etc. Add new cities by editing `cities.json`.

Standalone Webflow → JSON sync for the Core hospitality network. Pulls each city's venues collection from its own Webflow CMS, normalizes it, and writes per-city JSON files into `data/{slug}/` that downstream apps consume directly from this repo.

## Why a separate repo

This repo intentionally has zero coupling to the main core-tulum / concierge stacks. It only needs Webflow API credentials, runs on a GitHub Actions cron, and commits its output back to itself. Consumers fetch the raw JSON from GitHub.

## Multi-city architecture

Each city in `cities.json` points at its own Webflow site:

```json
{
  "cities": [
    {
      "slug": "tulum",
      "displayName": "Tulum",
      "webflowSiteId": "6357fd6cab073f81a8eb1b51",
      "venuesCollectionSlug": "venue",
      "active": true
    },
    {
      "slug": "los-cabos",
      "displayName": "Los Cabos",
      "webflowSiteId": "<future site id>",
      "venuesCollectionSlug": "venue",
      "active": false
    }
  ]
}
```

Each sync run iterates over the active cities and writes:

```
data/
├── tulum/
│   ├── venues-full.json
│   └── venues-lite.json
└── los-cabos/
    ├── venues-full.json
    └── venues-lite.json
```

Adding a new city = add a row to `cities.json` and toggle `active: true`. No code changes.

## Required env vars

| Variable | Description |
| --- | --- |
| `WEBFLOW_API_TOKEN` | Webflow Data API token. Shared across cities (typical case: one Webflow workspace, multiple sites). Per-city overrides via `webflowApiTokenEnvVar` in cities.json if a city lives in a different workspace. |

For local runs, copy `.env.example` to `.env.local` and fill in values. For the GitHub Action, add `WEBFLOW_API_TOKEN` as a repository secret.

## Run locally

```bash
pnpm install

# Sync every active city in cities.json:
pnpm sync

# Or sync just one city:
SYNC_ONLY_CITY=tulum pnpm sync
```

Outputs land in `data/{slug}/venues-lite.json` and `data/{slug}/venues-full.json`.

## Manually trigger the GitHub Action

```bash
# Sync every active city
gh workflow run sync.yml

# Sync just one city (passes citySlug to the workflow input)
gh workflow run sync.yml -f citySlug=tulum
```

The workflow also runs daily at 07:00 UTC via cron and syncs every active city.

## Webhook (instant updates)

A Vercel function at `api/webflow-webhook.ts` receives Webflow webhook events and triggers the sync GitHub Action via `workflow_dispatch`. End-to-end latency from CMS publish to live JSON is ~30 seconds.

The receiver inspects the webhook payload's `siteId`, looks it up in `cities.json`, and forwards just that city's slug to the workflow as the `citySlug` input. The workflow's `SYNC_ONLY_CITY` env var then scopes the sync to that single city, leaving other cities' data untouched.

### Setup

1. Deploy this repo to Vercel — link the GitHub repo from the Vercel dashboard. The deploy is essentially free: only the `api/` folder runs as a function.

2. Add these env vars in the Vercel project settings (Production + Preview):
   - `WEBFLOW_WEBHOOK_SECRET` — the secret Webflow shows you when you create the webhook
   - `GITHUB_REPO` — `CerkaB/tulum-cms-sync` (or whatever this repo's owner/repo is)
   - `GITHUB_DISPATCH_TOKEN` — a GitHub fine-grained PAT scoped to this repo with `Actions: write` permission

3. In each city's Webflow site → Site Settings → Webhooks → Add Webhook:
   - Trigger types: collection_item_created, collection_item_changed, collection_item_deleted, collection_item_published, collection_item_unpublished (one per webhook — Webflow only allows one trigger per webhook)
   - Filter: Venues collection only
   - URL: `https://tulum-cms-sync.vercel.app/api/webflow-webhook` (or your actual Vercel deployment URL)
   - Secret: the value from `WEBFLOW_WEBHOOK_SECRET`

4. Test from Webflow: edit a venue, publish it, watch the GitHub Action page — a new run should appear within seconds with the city slug in the run name.

## Output schema

### `data/{slug}/venues-lite.json`

The trimmed, public-facing payload consumed by each city's marketing app. Only includes venues where `featured-on-core-tulum === true` and which are not draft/archived/closed.

```ts
{
  syncedAt: string;            // ISO timestamp
  citySlug: string;            // "tulum", "los-cabos", ...
  venues: Array<{
    slug: string;
    category: string;
    coverImage: string | null;
    priceRange: string | null;
    openingHours: Record<string, string> | null;
    tulumBibleSlug: string;
    locales: {
      en: { name: string; description: string };
      es: { name: string; description: string };
    };
  }>;
}
```

### `data/{slug}/venues-full.json`

The full normalized corpus — every non-draft, non-archived venue with all fields the transforms know how to extract. Used by concierge for AI context and as the source of truth for any future downstream consumer. Includes `isClosed` so callers can filter or include closed venues as needed.

## Repo layout

```
cities.json                Multi-city config — one row per market
src/
├── webflow/
│   ├── locales.ts          discoverLocales, normalizeLocaleTag
│   └── collections.ts      discoverCollections, fetchAllItems, ...
├── transforms/
│   └── venues.ts           venue field mapping + mergeLocaleItems + option ID resolution
├── lite.ts                 toLiteVenue + filter logic
└── sync.ts                 entrypoint (iterates over cities.json)
api/
└── webflow-webhook.ts      Vercel function: HMAC verify + city-scoped dispatch
data/
├── tulum/                  Per-city JSON (committed by GitHub Action)
│   ├── venues-full.json
│   └── venues-lite.json
└── los-cabos/
    ├── venues-full.json
    └── venues-lite.json
.github/workflows/
└── sync.yml                Daily cron + workflow_dispatch with optional citySlug input
```

## Roadmap

- ✅ Single-city sync (Tulum)
- ✅ Webhook receiver (instant updates)
- ✅ Multi-city refactor (cities.json + per-city data folders + city-scoped webhook routing)
- ⏳ Add second city (Los Cabos) — drop in `cities.json`, set `active: true`, re-run
