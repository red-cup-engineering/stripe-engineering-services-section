---
name: reconciling-verified-stripe-events
description: Verify and reconcile Stripe webhook events into minimal provider-owned receipts. Use when handling an untouched webhook body and Stripe-Signature header, testing replay/idempotency behavior, or reviewing the event journal; never parse before verification or infer fulfillment, entitlement, tax, refund, or customer book entries.
requires-capabilities:
  - ledger-readings
  - ledger-reconciliation-proposal
---

# Reconciling verified Stripe events

The HTTP route is `POST /webhooks/stripe`. It must receive the untouched body
and the exact `Stripe-Signature` header. Verification uses the endpoint-specific
`STRIPE_WEBHOOK_SECRET` and a five-minute default tolerance. Never disable the
recency check.

After verification, deduplicate by Stripe event identifier and append only the
minimal projection under `data/events/YYYY/MM/DD/`. Never persist the raw body,
customer email/address, payment method, card data, API key, or webhook secret.

The Stripe payment service's event journal is **provider-side evidence**, not
the customer's received product. For a game or other paid digital good, the
already installed downstream operation is
`@red-cup-engineering/digital-goods-storefront-engineering-services-section` in
`services/digital-goods-storefront-services-section/src/stripe-checkout-fulfillment.mjs`
(sibling of this package). It consumes the untouched webhook body,
validates `Stripe-Signature`, projects only accepted Checkout events, and
calls the existing `DigitalGoodsFulfillment` durable store to compare the
recorded Checkout Session, exact offering, price, currency, mode and request
digest before one idempotent entitlement. Its separate
`paid-release.mjs` verifies the delivered bytes/digest; the client never
grants itself purchased content merely by returning from the hosted Checkout
page. A Game SKU should use that **same** native catalog-derived offering,
Checkout, verified receipt and fulfillment path—not a new Weiqi-specific
Stripe mock, duplicated payment service or generic payment-complete flag.

Event order is not guaranteed; unpaid, forged, contradictory and late
callbacks cannot open or reactivate entitlements. In the current source,
only test-mode catalog offers are admitted. The merchant's real live
activation, an actual game deliverable, and customer receipt must be
separately received before claiming revenue.

