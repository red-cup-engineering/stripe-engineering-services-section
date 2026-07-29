---
name: provisioning-authorized-checkout-sessions
description: Provision a Stripe-hosted Checkout Session only from an admitted ActivityStreams request for a fixed Leader-authorized local offering. Use for readiness checks, checkout-session solicitations, acceptance, and provider-local receipt review; never use it to choose a price, activate live mode, refund, or infer fulfillment.
---

# Provisioning authorized Checkout Sessions

Begin with
`node services/stripe-services-section/src/cli.mjs --operation readiness`
from the Executive Office repository root. Refuse when the credential
mode is absent or unknown, when the offering is not potential for that mode, or
when live readiness is false for a live request.

The inter-enterprise request is an ActivityStreams `Offer` targeted at
`urn:ame:stripe-services-section`, carrying contract
`stripe-checkout-session-creation`. Solicit through the same CLI with
`--operation solicit-checkout`, then invoke only the returned provider-authored
offer through `--operation invoke-checkout`.

Use the fixed local offering catalog. Never accept a caller-supplied amount,
currency, product name, or credential. Return the hosted Checkout URL and the
minimal receipt only. A Checkout Session is evidence of an opened payment
attempt, not a completed payment or customer outcome.
