/*
 * StockTrax — self-hosted barcode inventory.
 * Copyright (C) 2026 Ultra Pest Control.
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed WITHOUT ANY WARRANTY; without even
 * the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU AGPL for more details: <https://www.gnu.org/licenses/>.
 */
'use strict';

/**
 * Pluggable barcode → product lookup.
 *
 * Each provider is a function (barcode, apiKey) => Promise<Product|null>
 * where Product = { name, brand, image_url, source }.
 *
 * To add a provider (e.g. a pest-control distributor API, or Barcode Lookup),
 * write a function below and register it in `providers`. No other file changes.
 */

async function upcitemdb(barcode /*, apiKey */) {
  // Free trial endpoint — no key required, but rate-limited.
  // For production volume, switch to the keyed endpoint and read the key from settings.
  const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(
    barcode
  )}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`upcitemdb responded ${res.status}`);
  const data = await res.json();
  const item = data && Array.isArray(data.items) && data.items[0];
  if (!item) return null;
  return {
    name: item.title || '',
    brand: item.brand || '',
    image_url: (item.images && item.images[0]) || '',
    source: 'upcitemdb',
  };
}

async function openfoodfacts(barcode /*, apiKey */) {
  // Food-skewed, but free and keyless — handy fallback / example provider.
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
    barcode
  )}.json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`openfoodfacts responded ${res.status}`);
  const data = await res.json();
  if (!data || data.status !== 1 || !data.product) return null;
  const p = data.product;
  return {
    name: p.product_name || '',
    brand: p.brands || '',
    image_url: p.image_url || '',
    source: 'openfoodfacts',
  };
}

const providers = { upcitemdb, openfoodfacts };

/**
 * Look up a barcode using the configured provider.
 * Returns null on no-match; throws on network/provider error so the caller
 * can distinguish "not found" from "lookup failed" and fall back to manual entry.
 */
async function lookup(barcode, { provider = 'upcitemdb', apiKey = '' } = {}) {
  const fn = providers[provider];
  if (!fn) throw new Error(`Unknown barcode provider: ${provider}`);
  return fn(barcode, apiKey);
}

module.exports = { lookup, providers };
