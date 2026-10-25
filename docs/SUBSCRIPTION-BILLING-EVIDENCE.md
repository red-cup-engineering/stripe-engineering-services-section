# Current subscription billing evidence

`resolveSubscriptionAccess` is a read-only API of the original Stripe service.
It supplies current billing evidence to a trusted host's recurring-contract
resolver. The host remains responsible for authentication, subscriber identity,
the original offering contract, product and source rights, query limits, and
delivery. A successful result is not an access token or a fulfillment record.

## Public contract

Import from `@red-cup-engineering/stripe-services-section/service` or
`@red-cup-engineering/stripe-services-section/subscription-access`.

```js
const evidence = await resolveSubscriptionAccess({
  authenticatedActor, // Exact original Checkout invocation actor, bound by host.
  subscriptionId,    // Stripe sub_ identifier from that original host contract.
  requestDigest,     // Original admitted Checkout order digest.
  offeringId,        // Original recurring offering, not a newly selected product.
}, {
  expectedAccountId, // Host-owned acct_ identifier for this merchant.
  catalog,           // Host-owned original offering catalog snapshot.
  store,             // The original Stripe receipt/event store; or provide root.
  env,               // Original named Stripe credential supplier.
  now: new Date(),
});
```

`authenticatedActor` must come from the host's authenticated principal-to-order
binding. In particular, an email, Checkout `client_reference_id`, browser body,
unverified gift, or arbitrary Stripe metadata is not that binding. The host
must not spread a request body into this API's input or options. `catalog`,
`store`, `root`, `env`, `expectedAccountId`, `fetchImpl`, `now`, and all bounds
are trusted host dependencies.

The original store supplies `query({category, limit, strict})` and `record(entry)` as in
the existing Checkout/webhook API. Queries must return the original category's
records, not a caller-selected subset. The resolver reads at most
`maxJournalRecords + 1` records per category (default 10,000, maximum 100,000)
and refuses an overflow. The default SEAVT reader stops at that bound. Custom
stores must honor the limit or return their complete category; a complete
oversized array is also refused. Querying a selective or stale mirror is not a
qualified current journal. No new subscription database is created.

Billing and webhook identity reads require `strict: true`. The default reader
uses the original SEAVT `each(root, type, {strict: true})`, which refuses malformed,
unverifiable, misplaced, overlong or unterminated records instead of silently
omitting them. An omitted row could be the very deletion or conflict that
defeats admission. The iterator must finish successfully before its category
can be used; a bounded prefix only triggers the existing overflow refusal.
Custom stores must provide equivalent complete, verified custody or reject the
strict query. A corrupt category produces a journal-unavailable refusal, with
no provider request if encountered at initial admission and no evidence return
if encountered at the final check. Native filesystem diagnostics are not exposed.

Signed webhook redelivery also refuses an unreadable or corrupt original event
journal instead of declaring a duplicate or appending over missing evidence.
No dependency change or replacement journal is used. Strict traversal verifies
records that are present; it is not a sealed inventory proof for a wholly
removed historical file or an atomic snapshot across concurrent filesystem
changes.

Current billing also requires every retained event receipt to pass the original
service's public `isCompleteEventReceipt(record)` validator before any related
subscription, invoice or charge filtering, both initially and at final recheck.
The required native projection fields are derived directly from `projectEvent`.
An absent `stripeChargeId`, `stripeCreditNoteInvoiceId`, binding field or mode
cannot become the explicit null emitted by the original projector. Otherwise
a retained dispute or credit note could disappear from billing merely because
its relationship field was lost. Missing type and unknown event-record shapes
also refuse; the store must not omit them before calling this validator.
Current native receipts additionally require their original `eventContentDigest`.
Two concurrently retained signed bodies may disagree while their redacted
projections agree; losing one digest must not reinterpret that known conflict
as agreement through the historical comparison fallback. This requirement is
for current billing and does not change legacy webhook retry comparison.
Retained relationship values must also inhabit their original projector
domains: charge/invoice/subscription source IDs or explicit null, the original
metadata strings or null, and the original ordered subscription-reference list.
A number, object, empty charge/invoice ID or array cannot evade a relation
match while masquerading as a complete receipt. The validator reuses the
original projector's source-ID and metadata admission and never coerces an
invalid value into null. This is structural validation; it does not detect an
arbitrary rewrite from one valid source value to a different valid source value.
The same admission refuses non-string canceled-status values before the
billing reader evaluates a retained subscription cancellation.

The established `StripeExternalPaymentLinkObservation` is an explicit second
variant in that shared journal. Its closed original shape describes only the
outside-catalog Checkout observation, with no subscription/order/right binding
fields. Complete observations remain compatible, including support payments
which establish no Group treasury settlement. The source of that existing wire
contract is the original [storefront Checkout receiver](https://github.com/red-cup-engineering/digital-goods-storefront-engineering-services-section/blob/2e0f1f19e94967d9593bdbd6884cc0c843b90682/src/stripe-checkout-fulfillment.mjs).
Honest native null relationships and unrelated charge/invoice observations
remain distinct from missing properties.

The validator is structural and read-only. It neither verifies an HMAC or
stored-record address nor proves a complete inventory; the original strict
custody requirements still apply. Older incomplete projections remain
historical evidence for the unchanged webhook duplicate/conflict comparison,
but cannot qualify a new current-billing observation. No null field, raw-body
digest, successful payment or migration is invented. Original Checkout receipts
and their admission are unchanged. The helper is exported from the root,
`/service` and `/subscription-access` entrypoints for original store adapters.

Success has `type: "StripeSubscriptionBillingEvidence"`, `admitted: true`,
`billingStatus: "paid-current-period"`, exact `subscriptionId`, `requestDigest`,
`offeringId`, `customerSettlement`, merchant/account and provider record IDs,
`notBefore`, `expiresAt`, `billingRevision`, `observedAt`, `stripeApiVersion`,
and the original verified event IDs. The half-open interval is
`notBefore <= now < expiresAt`. `customerSettlement` is the original invocation
actor, not an invented mapping to the host's subscriber ID.

`billingRevision` identifies the relevant original binding and current funded
item, period, cancellation and payment state. It excludes observation time and
the set/order of duplicate webhook deliveries, so unchanged billing evidence
can survive the host's query and delivery rechecks. Provider renewal, a changed
paid item or payment, or changed cancellation changes that revision. The result
contains no query profile, channel grant, Newswire resource, entitlement, bank
settlement, access credential or claim of earned revenue.

Refusals have `type: "StripeSubscriptionBillingRefusal"`, `admitted: false`, and
a stable `reason`. A host must distinguish observed inactive/revoked/binding
refusals from unavailable, malformed or unsupported provider evidence. It must
not replace either with a cached active subscription. Provider response bodies,
credential values and contact data are neither returned nor journaled.

## Evidence required

1. A unique original live `StripeCheckoutSessionReceipt` binds the exact order,
   original actor, offering and merchant. Duplicate equivalent receipts are
   harmless; different Checkout sessions for the same order are ambiguous.
2. An original supported, signature-verified live event preserves the same
   subscription/order/actor/offering binding. A verified terminal deletion or a
   conflicting signed event prevents admission. Event arrival order does not
   select the current subscription or manufacture a renewal.
3. A read of `/v1/account` matches the host's merchant account. The original
   Checkout Session, retrieved under that credential, must be complete, live,
   and linked to this subscription and the same provider customer. Thus merely
   copying the order's metadata to an unrelated subscription is insufficient.
4. The current subscription is active, unended and unpaused, without a pending
   item update. Its one complete recurring item matches the original offering's
   licensed per-unit price, currency, quantity and recurrence. The current
   subscription item period contains the observation time.
5. The current latest invoice is fully paid, with no opening customer balance
   or credit note, and is an initial or recurring cycle invoice. Its one
   complete non-prorated subscription line names this subscription item and
   price, quantity and exact service period. Invoice-level `period_start` and
   `period_end` are not used as a service window.
6. A complete single InvoicePayment joins that invoice to a paid PaymentIntent.
   The current PaymentIntent and expanded latest Charge match the same
   customer, currency and full amount. The charge is paid and captured, with
   no refunded amount or dispute. This excludes invoices merely marked paid
   outside Stripe, credit-only invoices, split payments and unresolved refund
   or dispute evidence.
7. The subscription and original signed journal are read again before return.
   A changed item/window/cancellation state, newly received terminal deletion,
   conflicting identity, refund, dispute or current-invoice credit note refuses
   the observation. The paid window
   must still be current when the bounded observation finishes.

All seven provider requests are GETs to `https://api.stripe.com` with redirects
disabled and the explicit request header `Stripe-Version: 2025-03-31.basil`.
The key uses the existing `API_KEY_STRIPE` / `STRIPE_SECRET_KEY` supplier and
must identify live mode. A restricted read key must permit these exact account,
Checkout, subscription, invoice, InvoicePayment and PaymentIntent/charge reads.
There is no provider creation, mutation, price change, webhook registration,
account migration or change to the account's default API version.

The observation has a 10-second default budget (`timeoutMs`, maximum 30 seconds)
shared by all awaited journal queries, provider fetches and response-body reads,
and a 1 MiB decoded response limit per GET. A stalled asynchronous host supplier
therefore cannot leave the resolver waiting indefinitely. Synchronous native
journal traversal is bounded by record count, not preempted by a timer.
Provider lists must explicitly be
complete. A missing field, unsupported billing shape, failed GET, oversized
response or bounded-journal overflow refuses rather than filling in authority.

## Cancellation, ordering and scope limits

A scheduled `cancel_at_period_end` preserves only the already paid service
window. `cancel_at` can shorten it. `canceled_at` records the cancellation
request in this case and is not used as a replacement period end. Canceled,
trialing, incomplete, unpaid, past-due, paused and ended subscriptions do not
qualify. A historical failed invoice does not override a subsequently current,
provider-qualified paid invoice; a terminal deletion of this subscription ID
cannot be undone by replaying an older active event.

Signed redelivery with the same semantic event content is idempotent. A
different signed body under an already received event ID creates a redacted
`StripeWebhookEventConflictReceipt` in the existing event journal and is
refused. The event digest retains no raw body. Later retries cannot erase this
contradiction. For older receipts that predate the content digest, comparison
uses the redacted fields actually retained; no historical raw-payload digest is
invented. The resolver also checks incompatible same-ID rows left by concurrent
writers. The append-only store does not claim a transactional compare-and-swap
operation or distributed exactly-once processing.

This first receiving contract intentionally refuses mixed items, prorations,
split or manual payments, credit-funded access and partial collections. Such a
refusal describes unsupported evidence; it does not assert that the customer
owes money or lacks a separate legitimate contract. Weekly, monthly and annual
recurrence use the provider's item period rather than local calendar arithmetic.
No gift is counted as a paid customer by this API.

Signed dispute events retain their exact charge reference. Signed credit-note
events retain their exact invoice reference. A dispute on the current charge or
any credit-note evidence on the current invoice blocks this narrow qualification
even when the Charge still looks paid. Evidence for an older different invoice
or charge does not revoke the current paid period. This first version does not
resolve credit-note voiding or dispute outcomes by choosing the last event's
timestamp; supporting those cases requires their original current provider
state and a separately accepted billing contract.

The provider calls are not an atomic distributed snapshot. They supply a
bounded current observation and detect the changes described above. A change
not yet observed after the final check remains the host/transport owner's
responsibility. The host must call again immediately before delivery, must
never cache an active result across deliveries, and must not expose private
billing evidence through a public response.

## Receiving in Newswire commerce

Paid Data's `resolveSubscription({subscriptionId, subscriber, at, stage})`
supplier is a host adapter above this API. It must independently obtain the
existing principal/order/contract relation, call this API with the original
actor, order and offering, and verify those values again in the successful
billing projection. The `subscriber` value comes from original host
authentication, and the request subscription selector must match that
principal's original contract.

The exact adapter mapping is:

| Paid Data supplier input or host source | Stripe billing API input |
| --- | --- |
| Authenticated `subscriber` plus the host's original principal/order relation | `authenticatedActor` from that original Checkout invocation |
| `subscriptionId`, checked against that relation | Exact Stripe `subscriptionId` |
| Original accepted order and offering from the host contract | `requestDigest`, `offeringId` |
| Original merchant configuration and receipt owner | `expectedAccountId`, original `catalog`, `store` or `root`, `env` |
| Supplier `at` value | `now: new Date(at)` |
| Supplier `stage` (`subscription-query` or `subscription-delivery`) | Always perform the same current observation; no stage bypass or active-result cache |

For each supplier call, the result can support `admitted: true` and
`status: "active"` only after both the original host contract and this billing
evidence are admitted. Copy the exact selector `subscriptionId` and authenticated
`subscriber` to the host projection, not a browser-asserted actor or a provider
customer email. This mapping is a contract for the existing host owner; the
missing principal/order relation is not supplied by this document.

Only that host-owned immutable contract supplies `contractRef`, `wireUri`,
bounded query `profiles` and allowed `channels`. The host combines its contract
revision with `billingRevision`, copies the qualified validity window (or
narrows it to its contract's own bounds), and returns the exact authenticated
subscriber. It runs this process both before query execution and before
delivery. It must not put changing `observedAt` or webhook receipt lists into
the stable entitlement revision. Cancellation, changed scope or failed current
billing evidence must prevent the second delivery check from succeeding.

This package does not provide that host's identity mapping, catalog deployment,
merchant activation, paid price, Newswire scope or subscriber ledger. Source
qualification alone does not demonstrate an installed production receiver or
an actually purchased subscription.

## Provider references and verification

The pinned API shape and period semantics were checked against the provider's
original references:

- [Basil invoice parent migration](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects)
- [Basil InvoicePayment migration](https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices)
- [Invoice line object and service period](https://docs.stripe.com/api/invoice-line-item/object?api-version=2025-03-31.basil)
- [InvoicePayment object](https://docs.stripe.com/api/invoice-payment/object?api-version=2025-03-31.basil)
- [Invoice payment listing](https://docs.stripe.com/api/invoice-payment/list?api-version=2025-03-31.basil)
- [Subscription lifecycle fields](https://docs.stripe.com/api/subscriptions/object)
- [CreditNote object and invoice relationship](https://docs.stripe.com/api/credit_notes/object?api-version=2025-03-31.basil)
- [Credit notes for paid invoices](https://docs.stripe.com/invoicing/dashboard/credit-notes)

`test/subscription-access.test.mjs` starts with the actual original
`solicitCheckout`, `invokeCheckout` and HMAC-verified `ingestWebhook`. Its
provider GET responses are isolated receiving fixtures, never live financial
operations. It covers binding, current funding, narrow service periods,
cancellation, refund/dispute refusal, partial collections, changed provider
state, concurrent/conflicting journal identities, damaged native revocation and
conflict custody at initial and final reads, stable rechecks and privacy.
Run it with the existing service, projection and subscription-binding tests.
