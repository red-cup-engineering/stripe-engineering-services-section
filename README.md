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

## Source-owned Shop webhook contract: required named export and installed tests

The existing `shop.561.group` Worker imports `projectEvent` from `@red-cup-engineering/stripe-services-section` while receiving authenticated `checkout.session.completed` records. This package's previous source edit retained internal `stripePaymentLinkId` and observed price identities but inadvertently attached the original `export` keyword to a new helper rather than to `projectEvent`. The module remained syntactically valid while losing a public named export. That breaks the Shop's **original import contract** if the affected source is published as an installed package.

The original `src/service.mjs` now exports `projectEvent` explicitly and keeps provider-identity helpers private. The native `test/service-public-event-projection.test.mjs` imports through the package's `.` and `./service` exports (not merely by relative source), verifies a paid Checkout receipt's exact origin, exercises the observed subscription and possibly-partial invoice price keys, and rejects buyer PII or presumed treasury cash. Both that test and the existing source test are now required `receivingTests` in the original npm package `files` set, to be checked by the house publisher against the **actual tarball**.

The source package still declares version `0.1.12`, and the original Shop dependency currently pins `0.1.11`. This edit creates no new package release or deployed Shop Worker; the competent npm publisher must choose an actually unoccupied immutable version, run native receiving and verify the Shop's installed import before any deployment claim. The live `shop.561.group/webhooks/stripe` endpoint currently subscribes only to `checkout.session.completed`; adding invoice/subscription events at Stripe is separately unsafe until the Shop's source-owned signed receiver can accept and retain them without corrupting book entitlement processing.

## Payment-Link-to-price identity in original signed event receipts

The original `ingestWebhook` source reader already verifies Stripe's HMAC over the untouched HTTP request body and records redacted, idempotent `StripeWebhookEventReceipt` entries to its existing Semiotic EAVT provider store. This source now retains additional **provider-native economic identities** in that same record: `stripePaymentLinkId` from an actual `checkout.session.completed`, `stripeBalanceTransactionId` when present, and `stripePriceIdsObserved` / `stripeProductIdsObserved` from source-carried invoice or subscription line items. The `stripeLineItemCoverage` classification distinguishes `not-provided`, `possibly-partial`, and `complete`; a `possibly-partial` collection must not be used to assert the total billed products on an invoice. All fields come from a verified provider event; do not reconstruct missing identities from product descriptions, YouTube titles, customer emails, revenue estimates or a local offer ledger.

This closes a concrete future receiving gap for existing Stripe-hosted Payment Links such as the observed live 561 Group monthly support offer. A valid link ID and a subsequent observed price on a different event can be joined through independently qualified Stripe subscriber/invoice events where the provider includes sufficient identifiers and the receiving office has lawful account scope. The service does **not** claim a link click was a checkout, that `checkout.session.completed` proves an invoice paid, that `invoice.paid` proves fees were deducted, that provider payout equals cash received by the Group, or that the historical emsenn Stripe account is necessarily identical to a 561 Group treasury. A live account read on October 22, 2026 found zero subscriptions for the new `price_1UMnsuJ1vYnPQu2N7U1S22t2`; this is a dated observation, not a permanent zero or an absence of other subscriptions.

This projection is **not an alternative checkout engine, webhook listener or money database**. The existing installed HTTP webhook receiver must be separately configured with a signed Stripe endpoint and its source-owned merchant context; changing this package alone will not cause Stripe to deliver new events. Its original test `node --test test/service.test.mjs` now exercises checkout, recurring-price, signed-writer/idempotency, PII and incomplete line-item refusals. No real provider event or settlement effect is performed by the tests.

## Source qualification

With the original registry dependencies installed, run `npm run check && npm test`. The new `test/metroplat.test.mjs` exercises native operation declarations, actor-binding, merchant and return-origin gates, test-mode session creation through an injected fake provider, and live-mode refusal. Independently qualify the exact published package, installed FeltOS/MetroPlat instance, MCP authorization and real merchant webhook before calling the application operational.
