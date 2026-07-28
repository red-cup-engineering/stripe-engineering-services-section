---
name: reconciling-verified-stripe-events
description: Verify and reconcile Stripe webhook events into minimal provider-owned receipts. Use when handling an untouched webhook body and Stripe-Signature header, testing replay/idempotency behavior, or reviewing the event journal; never parse before verification or infer fulfillment, entitlement, tax, refund, or customer book entries.
---

# Reconciling verified Stripe events

The HTTP route is `POST /webhooks/stripe`. It must receive the untouched body
and the exact `Stripe-Signature` header. Verification uses the endpoint-specific
`STRIPE_WEBHOOK_SECRET` and a five-minute default tolerance. Never disable the
recency check.

After verification, deduplicate by Stripe event identifier and append only the
minimal projection under `data/events/YYYY/MM/DD/`. Never persist the raw body,
customer email/address, payment method, card data, API key, or webhook secret.

Supported event types still create only provider-side evidence. The receiving
customer settlement must independently admit the receipt and decide its own
fulfillment or entitlement consequence. Event delivery order is not assumed.

