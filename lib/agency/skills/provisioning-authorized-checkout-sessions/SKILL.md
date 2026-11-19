---
name: provisioning-authorized-checkout-sessions
description: Provision a Stripe-hosted Checkout Session only from an admitted ActivityStreams request for a fixed catalog offering. Use for readiness checks, checkout-session solicitations, acceptance, and provider-local receipt review; never use it to choose a price, activate live mode, refund, or infer fulfillment.
requires-capabilities:
  - process-arrival
  - ledger-readings
id: provisioning-authorized-checkout-sessions

---
# Provisioning authorized Checkout Sessions

Use the **installed native Stripe package**, not an external ChatGPT Stripe connector. From this package's own current source root, invoke
`node src/cli.mjs --operation readiness` (or its installed
`stripe-payment-acceptance --operation readiness` executable).
The owning source is
`red-cup-engineering/computer-web-engineering-services-section/services/web-platform-services-section/services/web2-platform-services-section/services/web2-financial-platform-services-section/services/web2-payment-platform-services-section/services/stripe-services-section/`.
The previous Executive Office checkout-relative command referenced a directory
that is not this source's actual current path. The native CLI's accepted
operations are `readiness`, `solicit-checkout`, `invoke-checkout`, and
`ingest-webhook`, with the latter three reading JSON ActivityStreams input
from standard input. Refuse when the credential mode is absent or unknown,
the offered SKU is not active for that mode, or live readiness is false.
The actual checked-in catalog currently has **only test-only offers**, so
no live Weiqi SKU or paying order can be inferred from this operation.

The inter-enterprise request is an ActivityStreams `Offer` targeted at
`urn:ame:stripe-services-section`, carrying contract
`stripe-checkout-session-creation`. Solicit through the same CLI with
`--operation solicit-checkout`, then invoke only the returned provider-authored
offer through `--operation invoke-checkout`.

Use the fixed local offering catalog. Never accept a caller-supplied amount,
currency, product name, or credential. Return the hosted Checkout URL and the
minimal receipt only. A Checkout Session is evidence of an opened payment
attempt, not a completed payment or customer outcome.
