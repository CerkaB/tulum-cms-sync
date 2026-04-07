import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = { api: { bodyParser: false } };

/** Max age for webhook requests to prevent replay attacks (5 minutes). */
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

const TRIGGERS_THAT_SYNC = new Set([
  'collection_item_created',
  'collection_item_changed',
  'collection_item_deleted',
  'collection_item_published',
  'collection_item_unpublished',
]);

interface CityConfig {
  slug: string;
  webflowSiteId: string;
  active: boolean;
}

/**
 * Look up which city slug owns a Webflow site ID. Returns null if no
 * active city in cities.json matches — caller treats that as "trigger
 * a full multi-city sync" (safe default; the cron will pick it up too).
 */
async function getCitySlugForSiteId(
  siteId: string,
): Promise<string | null> {
  try {
    // cities.json sits at the repo root; this file is at api/webhook.ts
    // so we resolve up one level. In Vercel's serverless build the file
    // is bundled into the function package.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const path = resolve(__dirname, '..', 'cities.json');
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { cities: CityConfig[] };
    const match = parsed.cities.find(
      (c) => c.active && c.webflowSiteId === siteId,
    );
    return match?.slug ?? null;
  } catch (err) {
    console.error('Failed to read cities.json:', err);
    return null;
  }
}

/**
 * Verify Webflow webhook signature using HMAC-SHA256.
 * Per Webflow docs, the HMAC input is `${timestamp}:${body}`.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyWebflowSignature(
  body: string,
  signature: string,
  timestamp: string,
): boolean {
  const secret = process.env.WEBFLOW_WEBHOOK_SECRET;
  if (!secret) return false;

  const payload = `${timestamp}:${body}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const encoder = new TextEncoder();
  const sigBuf = encoder.encode(signature);
  const expBuf = encoder.encode(expected);
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const signature = req.headers['x-webflow-signature'];
  const timestamp = req.headers['x-webflow-timestamp'];
  const signatureStr = Array.isArray(signature) ? signature[0] : signature;
  const timestampStr = Array.isArray(timestamp) ? timestamp[0] : timestamp;

  if (!signatureStr || !timestampStr) {
    res.status(401).json({ error: 'Missing signature or timestamp' });
    return;
  }

  const timestampMs = parseInt(timestampStr, 10);
  if (
    Number.isNaN(timestampMs) ||
    Date.now() - timestampMs > MAX_WEBHOOK_AGE_MS
  ) {
    res.status(401).json({ error: 'Request too old or invalid timestamp' });
    return;
  }

  const body = await readRawBody(req);

  if (!verifyWebflowSignature(body, signatureStr, timestampStr)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const triggerType = payload.triggerType as string | undefined;

  if (!triggerType || !TRIGGERS_THAT_SYNC.has(triggerType)) {
    res.status(200).json({ ok: true, triggered: false });
    return;
  }

  // Extract identifying info from the payload
  const innerPayload = payload.payload as Record<string, unknown> | undefined;
  const collectionId =
    (innerPayload?.cmsCollectionId as string | undefined) ??
    (innerPayload?.collectionId as string | undefined) ??
    null;
  // Webflow includes the site ID at the top level of the webhook payload,
  // not inside `payload`. Source of truth: Webflow webhook docs.
  const siteId =
    (payload.siteId as string | undefined) ??
    (innerPayload?.siteId as string | undefined) ??
    null;

  // Resolve which city this webhook belongs to so the GitHub Action can
  // sync only that one city instead of every city in cities.json. Falls
  // back to a full multi-city sync if we can't identify the source.
  let citySlug: string | null = null;
  if (siteId) {
    citySlug = await getCitySlugForSiteId(siteId);
  }

  console.log(
    `Webflow webhook accepted: triggerType=${triggerType} ` +
      `collection=${collectionId ?? 'unknown'} ` +
      `siteId=${siteId ?? 'unknown'} ` +
      `citySlug=${citySlug ?? '(all)'}`,
  );

  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!repo || !token) {
    console.error('GITHUB_REPO or GITHUB_DISPATCH_TOKEN not set');
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  // Pass the resolved city slug as a workflow input. The GitHub Action
  // forwards it as the SYNC_ONLY_CITY env var, which sync.ts uses to
  // skip every city except the one matching.
  const dispatchBody: { ref: string; inputs?: Record<string, string> } = {
    ref: 'main',
  };
  if (citySlug) {
    dispatchBody.inputs = { citySlug };
  }

  const dispatch = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/sync.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dispatchBody),
    },
  );

  if (!dispatch.ok) {
    const detail = await dispatch.text().catch(() => '<no body>');
    console.error(
      `GitHub workflow dispatch failed: ${dispatch.status} ${dispatch.statusText} — ${detail}`,
    );
    res.status(502).json({ error: 'Upstream dispatch failed' });
    return;
  }

  res.status(200).json({
    ok: true,
    triggered: true,
    triggerType,
    citySlug: citySlug ?? null,
  });
}
