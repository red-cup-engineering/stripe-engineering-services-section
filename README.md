# Stripe — MetroPlat native application

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

This is the existing Group-owned Stripe Checkout service, not a separate ChatGPT/Stripe adapter. Source functions in `src/service.mjs` own the provider interaction, offering admission, HMAC webhook verification, idempotency and redacted receipts. `src/provisioning.mjs` owns assisted credential setup. MetroPlat installs the native application from this exact package export; it does not implement Stripe again.

## Install in an authorized MetroPlat world

Add the package at a published, qualified immutable version to the selected FeltOS/MetroPlat **host's** package graph, then add one application entry to that instance declaration:

```json
{
  "module": "@red-cup-engineering/stripe-services-section/metroplat",
  "export": "stripeMetroplatApplication",
  "configuration": {
    "merchant": "emsenn",
    "allowedReturnOrigins": ["https://shop.561.group/"],
    "allowLiveCheckout": false
  }
}
```

This illustrative merchant matches the repository's *test-only* source catalog. It does not make personal Stripe revenues Group revenue, arm shop.561.group, or authorize a public charge. For a different legal seller, select that seller's source-owned catalog in `configuration.catalog` with its matching `merchant`, independent terms and account custody. Do not mount two sellers through one ambiguous key or an inferred corporate identity.

MetroPlat projects the native operation family to its existing CLI/HTTP/MCP catalog:

- `stripe-checkout-readiness` — credential mode and source-defined offering readiness, without key bytes.
- `stripe-checkout-solicit` — creates an actor-bound offer for a catalog-approved item and approved HTTPS return origin, without touching the payment provider.
- `stripe-checkout-invoke` — uses that original offer and the authenticated MetroPlat principal to create an idempotent Checkout Session. This operation declares an external coordinated effect. The host must grant appropriate current operation standing; package installation is not that grant.

The host, **not instance JSON, prompts or tool inputs**, supplies `STRIPE_SECRET_KEY` (or `API_KEY_STRIPE`), `STRIPE_WEBHOOK_SECRET` and `STRIPE_CUSTOMER_CONTRACT_TOKEN` through controlled credential custody. The app writes original Stripe EAVT receipt categories under the world host's data root, not its source checkout. No environment value or signing secret is copied into the instance.

Even with a live key, checkout refuses until `allowLiveCheckout: true` is intentionally set by the authorized instance owner and the original Stripe engine admits a genuinely qualified live offering, settlement agreement, webhook secret and customer contract. This source-level flag is **not** a substitute for host standing, Stripe account verification, tax/refund decisions or actual payment receiving.

Stripe webhook HTTP ingress must continue to use the original **raw-body** receiver and `ingestWebhook` signature check; a generic JSON-transcoding MCP operation is not a Stripe webhook endpoint. Verified events still require their rightful order/entitlement/ledger receiver. A provider key is not proof of settled money.

## Source qualification

With the original registry dependencies installed, run `npm run check && npm test`. The new `test/metroplat.test.mjs` exercises native operation declarations, actor-binding, merchant and return-origin gates, test-mode session creation through an injected fake provider, and live-mode refusal. Independently qualify the exact published package, installed FeltOS/MetroPlat instance, MCP authorization and real merchant webhook before calling the application operational.
