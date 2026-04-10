/**
 * Lite venue projection — the public JSON consumed by core-tulum.
 *
 * Filters: featured-on-core-tulum === true AND not closed AND not draft
 * AND not archived.
 */

import type { WebflowItem } from "./webflow/collections.js";
import type {
  VenueBaseData,
  VenueLocaleData,
} from "./transforms/venues.js";

export interface FullVenue {
  webflowItemId: string;
  base: VenueBaseData;
  locales: Record<string, VenueLocaleData>;
  lastPublished?: string;
  lastUpdated?: string;
}

export interface LiteVenueLocale {
  name: string;
  description: string;
}

export interface LiteVenue {
  slug: string;
  category: string | null;
  area: string | null;
  pricing: string | null;
  coverImage: string | null;
  isClosed: boolean;
  tulumBibleSlug: string;
  /** Opening hours — HTML stripped to plain text. */
  openingHours: string | null;
  locales: {
    en: LiteVenueLocale;
    es: LiteVenueLocale;
  };
}

function pickLocale(
  locales: Record<string, VenueLocaleData>,
  tag: string,
): LiteVenueLocale {
  const data = locales[tag];
  return {
    name: data?.name ?? "",
    description: data?.description ?? "",
  };
}

/**
 * Project a fully-normalized venue into the lite shape.
 * Returns null if the venue should be filtered out of the lite output.
 */
export function toLiteVenue(
  venue: FullVenue,
  rawItem: WebflowItem,
): LiteVenue | null {
  if (rawItem.isDraft === true || rawItem.isArchived === true) return null;
  if (!venue.base.isFeaturedOnCoreTulum) return null;
  if (venue.base.isClosed) return null;

  // Parse 7 <p> tags (Mon–Sun) into "Day: HH:MM - HH:MM" lines
  const rawHours = venue.base.openingHoursHtml?.trim();
  let openingHours: string | null = null;
  if (rawHours) {
    const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const times = rawHours
      .split(/<\/?p[^>]*>/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (times.length === 7) {
      openingHours = times
        .map((t, i) => `${dayLabels[i]}: ${t}`)
        .join("\n");
    } else {
      // Fallback — just strip tags
      openingHours = rawHours
        .replace(/<[^>]*>/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
    }
  }

  return {
    slug: venue.base.slug,
    category: venue.base.category,
    area: venue.base.area,
    pricing: venue.base.pricing,
    coverImage: venue.base.coverImage,
    isClosed: venue.base.isClosed,
    tulumBibleSlug: venue.base.slug,
    openingHours,
    locales: {
      en: pickLocale(venue.locales, "en"),
      es: pickLocale(venue.locales, "es"),
    },
  };
}
