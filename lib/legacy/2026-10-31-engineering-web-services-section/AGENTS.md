# Stripe Payment Acceptance Enterprise

This is a sovereign, emsenn-owned payment-rail settlement. It may create a
Stripe Checkout Session only for a Leader-authorized local offering and may
admit a Stripe event only after verifying the signature over the untouched
request body. It owns its provider-side session and event receipts; it never
writes a customer settlement's order, entitlement, fulfillment, or books.

The legal merchant and Stripe account holder is emsenn. That fact does not
delegate the human Leader's authority to an office or runtime. Offerings,
prices, currency, tax posture, refund terms, live-mode activation, payout
destination, and customer-settlement contracts remain Leader-authorized
inputs. This settlement executes an admitted payment request; it does not
invent the thing sold or appropriate the receiving settlement's revenue.

Credentials arrive only through the Leader-provided ignored environment file.
Never write a Stripe key, webhook secret, buyer payment method, card data, or
unnecessary buyer personal data to source, logs, records, errors, or responses.
Prefer a restricted Stripe key limited to Checkout Session creation.

ActivityStreams is the inter-enterprise boundary. Durable provider acts are
normalized RMN effects witnessed through the hired RWIL/RDF provider. Event identifiers and request digests provide
idempotency. Finance and Market Services may later observe supplied receipts
under its own contract; it does not operate this payment rail.


<!-- installing-an-enterprise-in-codex: begin -->
# This node holds an enterprise

The enterprise seats at `services/stripe-services-section/lib/management`. Every office on its roster is
installed at this node as a subagent — one file per office under `.codex/agents/` —
and the session opened here holds NO office itself. It is the dispatcher: it decides
where work goes, and it does not do the offices' work.

## Classes and instances are never the same record

A CLASS says what a kind of record must look like: one JSON Schema per type,
seated in `services/stripe-services-section/lib/schemas/` ($node/lib). An INSTANCE is a particular thing —
one office, one task, one dispatch — a plain `<id>.json` record seated in
`services/stripe-services-section/content/<pool>/` ($node/content), validated against its class and never
itself a schema. No record is ever both: an instance carries no `$schema` and
no `$id`, and a class constrains records without being one. A term in the
glossary is an instance too — a definition entry, not a schema.

## The enterprise membrane

Protocol scale is not interchangeable. A2A is the coordination face among offices
and agents within this enterprise. ActivityPub is the messaging face between this
sovereign enterprise and another one. Receiving an ActivityPub message may create
local work only through this enterprise's own admission and authority; a sender
never writes this enterprise's pools. No umbrella platform participates in this
boundary; each required faculty is hired from its sovereign owner.

## The delegation rule

Work belongs to the office that owes it — delegate to the installed agent rather
than doing an office's work at the root. And records are written by the
enterprise's instruments, never by hand:

- a skill is one flat script in `services/stripe-services-section/lib/management/skills/`, projected by `services/stripe-services-section/lib/management/skills/project-a-skill.js`
- a class (schema) is written by `services/stripe-services-section/lib/management/skills/write-a-schema.js`
- an office by `services/stripe-services-section/lib/management/skills/write-an-office.js`
- a task by `services/stripe-services-section/lib/management/skills/make-a-task.js`
- a dispatch by `services/stripe-services-section/lib/management/skills/dispatch-a-task.js`

## The obligation loop

"Fulfill the obligations of your office" resolves here with no other context:

1. At session start, from the repository root, run
   `node services/stripe-services-section/lib/management/skills/list-open-obligations.js --pool services/stripe-services-section/content/dispatches --root .`.
   It reads the enterprise's dispatch board and derives which dispatches are
   OPEN — a dispatch is open while its task's goal is unachieved, and achievement
   is derived by re-running the goal, never read from any record.
2. Work each open dispatch by delegating its task to the office named on the
   dispatch.
3. The worker never verifies its own work. This enterprise seats no office
   bearing attesting-a-work-product — the operator is the witness — and
   `node services/stripe-services-section/lib/management/skills/make-a-task.js --verify <task> --pool services/stripe-services-section/content/tasks --root .`
   is the witness's instrument.

## The roster

- **checkout-session-provisioner** — The office answers for turning one admitted request for a Leader-authorized offering into one server-created Stripe Checkout Session and a provider-owned receipt, without choosing the offering, price, tax treatment, refund terms, beneficiary, or customer-settlement consequence.
- **stripe-event-receipt-reconciler** — The office answers for verifying a Stripe webhook signature over the untouched body, deduplicating the event identifier, and appending a minimal provider-owned event receipt.
<!-- installing-an-enterprise-in-codex: end -->
