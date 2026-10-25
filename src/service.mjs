import { CHECKOUT_EVENTS } from "./checkout-events.mjs";
import { resolveCurrentSubscriptionBilling } from "./subscription-access.mjs";
export { SUBSCRIPTION_READ_API_VERSION } from "./subscription-access.mjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/computer-data-engineering-services-section/semiotic-expression-notation/semantic-content-identity";
import { each, put } from "@red-cup-engineering/semiotic-eavt-services-section/store";

let cachedRoot;
/**
 * Resolves this package's root directory, lazily, on first actual need.
 * `import.meta.url` is touched only here, never at module-load time, so a
 * caller that always supplies `options.catalog` and `options.store` (a
 * Cloudflare Worker, for instance) never triggers it and this module has
 * no top-level Node/filesystem-only side effect.
 * @returns {string}
 */
function packageRoot() {
  if (cachedRoot === undefined) cachedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return cachedRoot;
}
export const ACTOR = "urn:ame:stripe-services-section";
const SUPPORTED_EVENTS = new Set([
  ...CHECKOUT_EVENTS, "checkout.session.expired", "payment_intent.payment_failed", "charge.refunded",
  "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
  "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated",
  "credit_note.created", "credit_note.updated", "credit_note.voided",
  "invoice.paid", "invoice.payment_failed",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"
]);
const RECURRING_INTERVALS = new Set(["day", "week", "month", "year"]);

export function digest(value) { return identifyJsonSemanticContent({ objectKind: "stripe.payment-service-record", value, witnessRoot: EMPTY_WITNESS_ROOT }).id; }
function reply(type, activity, object) { return { "@context": "https://www.w3.org/ns/activitystreams", id: `${activity?.id ?? `urn:request:${Date.now()}`}:${type.toLowerCase()}`, type, actor: ACTOR, target: activity?.actor, inReplyTo: activity?.id, object }; }
function reject(activity, reason, detail = undefined) { return reply("Reject", activity, { type: "ServiceRefusal", reason, ...(detail === undefined ? {} : { detail }) }); }

export function credentialMode(key) {
  if (typeof key !== "string" || key.length === 0) return "absent";
  if (/^(sk|rk)_test_/u.test(key)) return "test";
  if (/^(sk|rk)_live_/u.test(key)) return "live";
  return "unknown";
}

/**
 * Reads the offerings catalog from disk. Lazily requires `node:fs` on first
 * call so this module has no top-level Node-only import — a caller that
 * always supplies `options.catalog` (a Cloudflare Worker, for instance)
 * never triggers this and never needs `node:fs` to be present.
 * @param {string} [path] catalog file path
 * @returns {object} the parsed offerings catalog
 */
export function loadCatalog(path = join(packageRoot(), "content/config/offerings.json")) {
  const { readFileSync } = createRequire(import.meta.url)("node:fs");
  return JSON.parse(readFileSync(path, "utf8"));
}
function stripeKey(env) { return env.API_KEY_STRIPE || env.STRIPE_SECRET_KEY || ""; }
export function readiness({ env = process.env, catalog = loadCatalog() } = {}) {
  const mode = credentialMode(stripeKey(env));
  const liveOfferings = catalog.offerings.filter((offering) => offering.status === "live");
  const liveQualifications = liveOfferings.map((offering) => ({ id: offering.id, ...validateLiveOffering(offering) }));
  return {
    type: "StripePaymentAcceptanceReadiness",
    actor: ACTOR,
    legalMerchant: catalog.merchant.legalBody,
    credential: { present: mode !== "absent", recognizedMode: mode, sourceName: env.API_KEY_STRIPE ? "API_KEY_STRIPE" : env.STRIPE_SECRET_KEY ? "STRIPE_SECRET_KEY" : null },
    webhookSecretPresent: Boolean(env.STRIPE_WEBHOOK_SECRET),
    customerContractTokenPresent: Boolean(env.STRIPE_CUSTOMER_CONTRACT_TOKEN),
    offerings: catalog.offerings.map(({ id, status, mode: offeringMode, currency, unitAmount, recurring, customerChosenAmount }) => ({ id, status, mode: offeringMode, currency, unitAmount, ...(recurring ? { recurring } : {}), ...(customerChosenAmount ? { customerChosenAmount } : {}) })),
    liveReadinessBasis: "local-policy-only; provider account, payout and webhook delivery still require independent receiving",
    liveQualifications,
    liveReady: mode === "live" && Boolean(env.STRIPE_WEBHOOK_SECRET) && Boolean(env.STRIPE_CUSTOMER_CONTRACT_TOKEN)
      && typeof catalog.merchant?.legalBody === "string" && catalog.merchant.legalBody.trim() !== ""
      && liveQualifications.some((qualification) => qualification.valid),
    secretsDisclosed: false
  };
}

function validUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)); } catch { return false; }
}
function requestFrom(activity) { return activity?.object?.type === "ServiceSolicitation" ? activity.object.request : undefined; }

/**
 * Validates that an offering's `mode` and `recurring` declaration agree:
 * a subscription offering must declare a recurring interval, a payment
 * offering must not, and a declared recurring interval must be one Stripe
 * accepts. Also validates a `customerChosenAmount` declaration (Stripe's
 * `custom_unit_amount`, https://docs.stripe.com/payments/checkout/pay-what-you-want,
 * fetched 2026-09-05): payment mode only, one item, a minimum of at least
 * 100 minor units, and an optional maximum/preset bounded by it. Pure and
 * exported so a catalog author can check an offering shape without going
 * through a checkout request.
 * @param {{mode: string, recurring?: {interval: string, intervalCount?: number}, customerChosenAmount?: {minimum: number, maximum?: number, preset?: number}}} offering
 * @returns {{valid: true}|{valid: false, reason: string}}
 */
export function validateOfferingShape(offering) {
  const hasRecurring = offering?.recurring !== undefined && offering?.recurring !== null;
  if (offering?.mode === "subscription" && !hasRecurring) return { valid: false, reason: "subscription-offering-missing-recurring" };
  if (offering?.mode === "payment" && hasRecurring) return { valid: false, reason: "payment-offering-must-not-declare-recurring" };
  if (hasRecurring) {
    const { interval, intervalCount } = offering.recurring;
    if (!RECURRING_INTERVALS.has(interval)) return { valid: false, reason: "invalid-recurring-interval" };
    if (intervalCount !== undefined && (!Number.isInteger(intervalCount) || intervalCount < 1)) return { valid: false, reason: "invalid-recurring-interval-count" };
  }
  const hasCustomerChosenAmount = offering?.customerChosenAmount !== undefined && offering?.customerChosenAmount !== null;
  if (hasCustomerChosenAmount) {
    if (offering.mode !== "payment") return { valid: false, reason: "customer-chosen-amount-offering-must-be-payment-mode" };
    if (offering.quantity?.minimum !== 1 || offering.quantity?.maximum !== 1) return { valid: false, reason: "customer-chosen-amount-offering-must-be-single-quantity" };
    const { minimum, maximum, preset } = offering.customerChosenAmount;
    if (!Number.isInteger(minimum) || minimum < 100) return { valid: false, reason: "invalid-customer-chosen-amount-minimum" };
    if (maximum !== undefined && (!Number.isInteger(maximum) || maximum < minimum)) return { valid: false, reason: "invalid-customer-chosen-amount-maximum" };
    if (preset !== undefined && (!Number.isInteger(preset) || preset < minimum || (maximum !== undefined && preset > maximum))) return { valid: false, reason: "invalid-customer-chosen-amount-preset" };
  }
  return { valid: true };
}

/** Live catalog admission applies the merchant-authority policy *in addition*
 * to Stripe's recurring/custom-amount shape check. A live key is never by
 * itself authority to charge a customer. No provider secrets are inspected. */
export function validateLiveOffering(offering) {
  const shape = validateOfferingShape(offering);
  if (!shape.valid) return shape;
  if (offering?.status !== "live") return { valid: false, reason: "offering-is-not-live" };
  if (!["payment", "subscription"].includes(offering.mode)) return { valid: false, reason: "invalid-live-offering-mode" };
  if (typeof offering.currency !== "string" || !/^[a-z]{3}$/u.test(offering.currency)) return { valid: false, reason: "invalid-live-offering-currency" };
  if (offering.customerChosenAmount === undefined &&
      (!Number.isSafeInteger(offering.unitAmount) || offering.unitAmount < 1)) {
    return { valid: false, reason: "invalid-live-offering-price" };
  }
  if (!Number.isSafeInteger(offering.quantity?.minimum) || !Number.isSafeInteger(offering.quantity?.maximum)
      || offering.quantity.minimum < 1 || offering.quantity.maximum < offering.quantity.minimum) {
    return { valid: false, reason: "invalid-live-offering-quantity" };
  }
  for (const field of ["beneficiarySettlement", "terms", "taxPolicy", "refundPolicy"]) {
    if (typeof offering[field] !== "string" || offering[field].trim() === "") {
      return { valid: false, reason: "missing-live-offering-" + field };
    }
  }
  return { valid: true };
}

function validateRequest(request, catalog, mode) {
  if (!request || typeof request !== "object") return { reason: "invalid-checkout-request" };
  const offering = catalog.offerings.find((candidate) => candidate.id === request.offeringId);
  if (!offering) return { reason: "unknown-offering" };
  const shape = validateOfferingShape(offering);
  if (!shape.valid) return { reason: shape.reason };
  if (offering.status !== "live" && !(offering.status === "test-only" && mode === "test")) return { reason: "offering-not-active-for-credential-mode" };
  if (mode === "live" && offering.status !== "live") return { reason: "live-credential-refused-for-non-live-offering" };
  if (mode === "live") {
    const qualified = validateLiveOffering(offering);
    if (!qualified.valid) return { reason: qualified.reason };
  }
  if (!validUrl(request.successUrl) || !validUrl(request.cancelUrl)) return { reason: "invalid-redirect-url" };
  if (typeof request.customerReference !== "string" || request.customerReference.length < 1 || request.customerReference.length > 200) return { reason: "invalid-customer-reference" };
  const quantity = request.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < offering.quantity.minimum || quantity > offering.quantity.maximum) return { reason: "quantity-out-of-bounds" };
  return { offering, quantity };
}

export function solicitCheckout(activity, options = {}) {
  const catalog = options.catalog ?? loadCatalog(options.catalogPath);
  const mode = credentialMode(stripeKey(options.env ?? process.env));
  if (activity?.type !== "Offer" || activity?.target !== ACTOR) return reject(activity, "invalid-checkout-solicitation-envelope");
  if (mode === "absent" || mode === "unknown") return reject(activity, "stripe-credential-unavailable-or-unrecognized");
  const request = requestFrom(activity);
  const admitted = validateRequest(request, catalog, mode);
  if (!admitted.offering) return reject(activity, admitted.reason);
  if (mode === "live" && !readiness({ env: options.env ?? process.env, catalog }).liveReady) return reject(activity, "stripe-live-activation-not-ready");
  const requestDigest = digest({ actor: activity.actor, request, offering: admitted.offering });
  return reply("Offer", activity, { type: "ExecutableServiceOffer", request, requestDigest, offering: admitted.offering, idempotencyKey: requestDigest.replace("ni:///sha-256;", "checkout-"), credentialMode: mode });
}

/**
 * Resolves the receipt/event journal a call should use: an injected
 * `{ record(entry), query({category, limit, strict}) }` store (a Worker's own KV/D1/etc
 * adapter) when `options.store` is given, else the on-disk
 * semiotic-eavt store, a category being the store type `<law>-<kind>`. The disk fallback is the only path that
 * touches the filesystem, so a caller that always supplies `options.store`
 * never needs `node:fs`.
 * @param {{store?: {record: Function, query: Function}, root?: string}} options
 * @returns {{record: Function, query: Function}}
 */
function evidenceStore(options) {
  if (options.store) return options.store;
  const root = options.root ?? packageRoot(), typeOf = (name) => name.replace(".", "-");
  return {
    record: ({ category: name, record }) => ({ id: put(root, typeOf(name), record) }),
    query: ({ category: name, limit = Infinity }) => {
      const rows = [];
      // A skipped bad row could be the revocation/conflict that defeats access.
      // Successful billing reads must exhaust verified original custody;
      // bounded prefixes are returned only to trigger the caller's overflow refusal.
      for (const { address, record } of each(root, typeOf(name), { strict: true })) {
        rows.push({ id: address, record });
        if (rows.length >= limit) break;
      }
      return rows;
    },
  };
}
const category = (law, kind) => `${law}.${kind}`;
async function appendRecord(options, _env, now, record, law, kind) { return evidenceStore(options).record({ category: category(law, kind), recordedAt: now.toISOString(), record, told: { for: true, against: false } }); }

/**
 * Builds the exact `application/x-www-form-urlencoded` Stripe Checkout
 * Session creation body for one admitted offering + request, with no I/O
 * and no dependency on the ActivityStreams envelope — a Cloudflare Worker
 * (or any other caller) can reuse this to produce the identical form
 * `invokeCheckout` posts to Stripe.
 * @param {{mode: string, currency: string, unitAmount?: number, customerChosenAmount?: {minimum: number, maximum?: number, preset?: number}, name: string, description: string, id: string, recurring?: {interval: string, intervalCount?: number}}} offering an admitted catalog offering
 * @param {{successUrl: string, cancelUrl: string, customerReference: string}} request the caller's checkout request
 * @param {number} quantity the admitted line-item quantity
 * @param {string} digestValue the request digest to record as Stripe metadata
 * @returns {URLSearchParams} the Stripe Checkout Session creation form body; a `customerChosenAmount`
 *   offering sets Stripe's `custom_unit_amount` fields instead of a fixed `unit_amount`
 *   (https://docs.stripe.com/payments/checkout/pay-what-you-want, fetched 2026-09-05)
 */
export function buildCheckoutSessionForm(offering, request, quantity, digestValue) {
  const form = new URLSearchParams();
  form.set("mode", offering.mode); form.set("success_url", request.successUrl); form.set("cancel_url", request.cancelUrl);
  form.set("client_reference_id", request.customerReference); form.set("line_items[0][quantity]", String(quantity));
  form.set("line_items[0][price_data][currency]", offering.currency);
  if (offering.customerChosenAmount) {
    form.set("line_items[0][price_data][custom_unit_amount][enabled]", "true");
    form.set("line_items[0][price_data][custom_unit_amount][minimum]", String(offering.customerChosenAmount.minimum));
    if (offering.customerChosenAmount.maximum !== undefined) form.set("line_items[0][price_data][custom_unit_amount][maximum]", String(offering.customerChosenAmount.maximum));
    if (offering.customerChosenAmount.preset !== undefined) form.set("line_items[0][price_data][custom_unit_amount][preset]", String(offering.customerChosenAmount.preset));
  } else {
    form.set("line_items[0][price_data][unit_amount]", String(offering.unitAmount));
  }
  form.set("line_items[0][price_data][product_data][name]", offering.name); form.set("line_items[0][price_data][product_data][description]", offering.description);
  if (offering.mode === "subscription" && offering.recurring) {
    form.set("line_items[0][price_data][recurring][interval]", offering.recurring.interval);
    if (offering.recurring.intervalCount !== undefined) form.set("line_items[0][price_data][recurring][interval_count]", String(offering.recurring.intervalCount));
    // Checkout metadata is not copied to the Subscription. Its later invoices
    // need the same original order binding through subscription_data.metadata.
    form.set("subscription_data[metadata][request_digest]", digestValue);
    form.set("subscription_data[metadata][offering_id]", offering.id);
  }
  form.set("metadata[request_digest]", digestValue); form.set("metadata[offering_id]", offering.id);
  return form;
}

export async function invokeCheckout(activity, options = {}) {
  const env = options.env ?? process.env; const catalog = options.catalog ?? loadCatalog(options.catalogPath); const key = stripeKey(env); const mode = credentialMode(key);
  const offered = activity?.object?.offer;
  if (activity?.type !== "Accept" || activity?.target !== ACTOR || offered?.type !== "Offer" || offered?.actor !== ACTOR || offered?.target !== activity.actor) return reject(activity, "invalid-checkout-acceptance-envelope");
  const admitted = validateRequest(offered.object.request, catalog, mode);
  if (!admitted.offering) return reject(activity, admitted.reason);
  if (mode === "live" && !readiness({ env, catalog }).liveReady) return reject(activity, "stripe-live-activation-not-ready");
  const expectedDigest = digest({ actor: activity.actor, request: offered.object.request, offering: admitted.offering });
  if (offered.object.requestDigest !== expectedDigest || offered.object.idempotencyKey !== expectedDigest.replace("ni:///sha-256;", "checkout-")) return reject(activity, "provider-offer-digest-mismatch");
  const request = offered.object.request;
  const form = buildCheckoutSessionForm(admitted.offering, request, admitted.quantity, expectedDigest);
  form.set("metadata[customer_settlement]", activity.actor);
  if (admitted.offering.mode === "subscription") form.set("subscription_data[metadata][customer_settlement]", activity.actor);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try { response = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": offered.object.idempotencyKey }, body: form }); }
  catch { return reject(activity, "stripe-api-unavailable"); }
  let body; try { body = await response.json(); } catch { return reject(activity, "stripe-api-invalid-response"); }
  if (!response.ok) return reject(activity, "stripe-api-refusal", { status: response.status, code: body?.error?.code ?? null, type: body?.error?.type ?? null });
  if (typeof body?.id !== "string" || typeof body?.url !== "string") return reject(activity, "stripe-api-incomplete-session");
  const now = options.now ?? new Date(); const receipt = { id: `urn:stripe-checkout-receipt:${body.id}`, type: "StripeCheckoutSessionReceipt", recordedAt: now.toISOString(), legalMerchant: catalog.merchant.legalBody, customerSettlement: activity.actor, offeringId: admitted.offering.id, requestDigest: expectedDigest, stripeSessionId: body.id, stripeMode: mode, amountTotal: body.amount_total ?? (admitted.offering.unitAmount !== undefined ? admitted.offering.unitAmount * admitted.quantity : null), currency: body.currency ?? admitted.offering.currency, paymentStatus: body.payment_status ?? "unpaid", status: body.status ?? "open", expiresAt: body.expires_at ?? null, secretRecorded: false, buyerPaymentDataRecorded: false };
  await appendRecord(options, env, now, receipt, "stripe-checkout-session-creation", "receipts");
  return reply("Accept", activity, { ...receipt, checkoutUrl: body.url });
}

export function verifyStripeSignature({ rawBody, signatureHeader, secret, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) }) {
  if (typeof rawBody !== "string" || typeof signatureHeader !== "string" || typeof secret !== "string" || !secret) return false;
  const fields = signatureHeader.split(",").map((part) => part.split("=", 2)); const timestamp = Number(fields.find(([key]) => key === "t")?.[1]);
  const signatures = fields.filter(([key, value]) => key === "v1" && /^[a-f0-9]{64}$/iu.test(value ?? "")).map(([, value]) => value);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > toleranceSeconds || signatures.length === 0) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"), "hex");
  return signatures.some((signature) => { const actual = Buffer.from(signature, "hex"); return actual.length === expected.length && timingSafeEqual(actual, expected); });
}
function eventReceiptsAgree(left, right) {
  if (left.eventContentDigest && right.eventContentDigest) return left.eventContentDigest === right.eventContentDigest;
  // Older accepted receipts retained only the redacted projection. Compare all
  // fields they actually retained; do not invent a historical payload digest.
  const keys = Object.keys(projectEvent({ id: null, type: '', data: { object: {} } }))
    .filter(key => Object.hasOwn(left, key) && Object.hasOwn(right, key));
  return keys.every(key => digest(left[key]) === digest(right[key]));
}
/**
 * Projects a raw Stripe webhook event onto the redacted, no-PII shape this
 * service records — pure, so a Worker can compute the same projection it
 * will hand to an injected store without pulling in the journal machinery.
 * @param {{id: string, type: string, created?: number, livemode?: boolean, data?: {object?: object}}} event a verified Stripe event
 * @returns {object} the redacted event projection
 */
/** Retain only provider offer/price identifiers from signed events.
 * Line items may be partial; observed IDs are not proof of complete amounts.
 */
const stripeSourceId=(value,prefix)=>typeof value==='string'&&
 new RegExp('^'+prefix+'_[A-Za-z0-9]+$','u').test(value)?value:null;
function signedEventPriceIdentities(eventType,object){
 const container=eventType?.startsWith('customer.subscription.')
  ?object?.items:eventType?.startsWith('invoice.')?object?.lines:null;
 const rows=Array.isArray(container?.data)?container.data:null;
 if(!rows)return {stripePriceIdsObserved:[],stripeProductIdsObserved:[],
  stripeLineItemCoverage:'not-provided'};
 const prices=new Set(),products=new Set();
 for(const row of rows){
  const rawPrice=row?.price?.id??row?.price??row?.pricing?.price_details?.price;
  const rawProduct=row?.price?.product??row?.pricing?.price_details?.product;
  const price=stripeSourceId(rawPrice,'price'),product=stripeSourceId(rawProduct,'prod');
  if(price)prices.add(price);
  if(product)products.add(product);
 }
 return {stripePriceIdsObserved:[...prices].sort(),
  stripeProductIdsObserved:[...products].sort(),
  stripeLineItemCoverage:container.has_more===false?'complete':'possibly-partial'};
}
/** Stripe API invoice events use amount_paid, amount_due, total and
 * amount_remaining. These are invoice-level source numbers, not the Checkout
 * amount_total, a subscription-specific allocation, fees or settled cash. */
const invoiceMinor=(value)=>Number.isSafeInteger(value)&&value>=0?value:null;
const invoiceUnixSeconds=(value)=>Number.isSafeInteger(value)&&value>=0?value:null;

const SUBSCRIPTION_BINDING_FIELDS = Object.freeze(["request_digest", "offering_id", "customer_settlement"]);
const subscriptionReference = value => stripeSourceId(typeof value === "object" && value !== null ? value.id : value, "sub");
const metadataValue = value => typeof value === "string" && value.length > 0 && value.length <= 500 ? value : null;
function billingPeriod(object) {
  const start = invoiceUnixSeconds(object?.current_period_start), end = invoiceUnixSeconds(object?.current_period_end);
  return start !== null && end !== null && end > start
    ? { currentPeriodStart: start, currentPeriodEnd: end }
    : { currentPeriodStart: null, currentPeriodEnd: null };
}

/** Preserve the provider's current/legacy invoice relationship without treating
 * metadata as payment, current membership or authority. Conflicting source
 * bindings remain non-resolvable; never pick one customer's claim silently. */
function subscriptionBinding(eventType, object) {
  const isInvoice = typeof eventType === "string" && eventType.startsWith("invoice.");
  const isSubscription = typeof eventType === "string" && eventType.startsWith("customer.subscription.");
  const parent = isInvoice && object.parent?.type === "subscription_details" ? object.parent.subscription_details : null;
  const metadataSources = [object.metadata, ...(isInvoice ? [object.subscription_details?.metadata, parent?.metadata] : [])];
  const references = [
    subscriptionReference(isSubscription ? object.id : object.subscription),
    ...(isInvoice ? [subscriptionReference(parent?.subscription)] : []),
  ].filter(value => value !== null);
  const stripeSubscriptionIdsObserved = [...new Set(references)].sort();
  const bindings = SUBSCRIPTION_BINDING_FIELDS.map(field => [...new Set(metadataSources.map(source => metadataValue(source?.[field])).filter(value => value !== null))]);
  if (new Set(references).size > 1 || bindings.some(values => values.length > 1)) {
    return { subscriptionId: null, stripeSubscriptionIdsObserved, subscriptionBindingStatus: "conflicting", requestDigest: null, offeringId: null, customerSettlement: null };
  }
  const [requestDigest, offeringId, customerSettlement] = bindings.map(values => values[0] ?? null);
  return {
    subscriptionId: references[0] ?? null,
    stripeSubscriptionIdsObserved,
    subscriptionBindingStatus: references.length && bindings.every(values => values.length === 1) ? "bound" : references.length || bindings.some(values => values.length) ? "partial" : "absent",
    requestDigest, offeringId, customerSettlement,
  };
}

/** Since Stripe's 2025-03-31 API, billing periods belong to subscription
 * items. Mixed intervals must not be widened into one subscription window. */
function subscriptionItems(eventType, object) {
  if (typeof eventType !== "string" || !eventType.startsWith("customer.subscription.") || !Array.isArray(object.items?.data)) return [];
  return object.items.data.map(item => {
    return {
      stripeSubscriptionItemId: stripeSourceId(item?.id, "si"),
      stripePriceId: stripeSourceId(item?.price?.id ?? item?.price, "price"),
      stripeProductId: stripeSourceId(item?.price?.product, "prod"),
      ...billingPeriod(item),
    };
  });
}

export function projectEvent(event) {
  const object = event?.data?.object ?? {};
  const isInvoiceEvent = typeof event?.type === "string" && event.type.startsWith("invoice.");
  return {
    stripeEventId: event.id, eventType: event.type, created: event.created ?? null, livemode: event.livemode ?? null,
    stripeObjectId: typeof object.id === "string" ? object.id : null,
    paymentStatus: object.payment_status ?? null, status: object.status ?? null,
    amountTotal: object.amount_total ?? object.amount ?? null, currency: object.currency ?? null,
    stripeInvoiceAmountPaidCents:isInvoiceEvent?invoiceMinor(object.amount_paid):null,
    stripeInvoiceAmountDueCents:isInvoiceEvent?invoiceMinor(object.amount_due):null,
    stripeInvoiceTotalCents:isInvoiceEvent?invoiceMinor(object.total):null,
    stripeInvoiceAmountRemainingCents:isInvoiceEvent?invoiceMinor(object.amount_remaining):null,
    stripeInvoiceBillingReason:isInvoiceEvent&&typeof object.billing_reason==='string'?object.billing_reason:null,
    stripeInvoicePeriodStartUnixSeconds:isInvoiceEvent?invoiceUnixSeconds(object.period_start):null,
    stripeInvoicePeriodEndUnixSeconds:isInvoiceEvent?invoiceUnixSeconds(object.period_end):null,
    paymentIntentId: typeof object.payment_intent === "string" ? object.payment_intent : null,
    stripeChargeId: stripeSourceId(event.type?.startsWith('charge.dispute.') ? object.charge?.id ?? object.charge
      : event.type?.startsWith('charge.') ? object.id : null, 'ch'),
    stripeCreditNoteInvoiceId: event.type?.startsWith('credit_note.') ? stripeSourceId(object.invoice?.id ?? object.invoice, 'in') : null,
    stripePaymentLinkId: stripeSourceId(object.payment_link,'plink'),
    stripeBalanceTransactionId: stripeSourceId(object.balance_transaction,'txn'),
    ...signedEventPriceIdentities(event.type,object),
    stripeSubscriptionItemsObserved: subscriptionItems(event.type, object),
    ...subscriptionBinding(event.type, object),
    invoiceId: isInvoiceEvent && typeof object.id === "string" ? object.id : null,
    ...billingPeriod(object),
    cancelAtPeriodEnd: typeof object.cancel_at_period_end === "boolean" ? object.cancel_at_period_end : null
  };
}
export async function ingestWebhook({ rawBody, signatureHeader }, options = {}) {
  const env = options.env ?? process.env; const secret = env.STRIPE_WEBHOOK_SECRET; const now = options.now ?? new Date(); const nowSeconds = options.nowSeconds ?? Math.floor(now.getTime() / 1000);
  if (!secret) return { type: "StripeWebhookRefusal", reason: "webhook-secret-unavailable" };
  if (Buffer.byteLength(rawBody ?? "", "utf8") > (options.maxBodyBytes ?? 1024 * 1024)) return { type: "StripeWebhookRefusal", reason: "webhook-body-too-large" };
  if (!verifyStripeSignature({ rawBody, signatureHeader, secret, toleranceSeconds: options.toleranceSeconds ?? 300, now: nowSeconds })) return { type: "StripeWebhookRefusal", reason: "invalid-or-stale-stripe-signature" };
  let event; try { event = JSON.parse(rawBody); } catch { return { type: "StripeWebhookRefusal", reason: "invalid-json-after-signature-verification" }; }
  if (typeof event?.id !== "string" || typeof event?.type !== "string") return { type: "StripeWebhookRefusal", reason: "invalid-stripe-event-shape" };
  const provider = evidenceStore(options), projection = projectEvent(event), eventContentDigest = digest(event);
  const identity = { ...projection, eventContentDigest };
  let prior;
  try {
    prior = (await provider.query({ category: category("stripe-webhook-event-admission", "events"), strict: true }))
      .map(({ record }) => record).filter(record => record.stripeEventId === event.id);
  } catch {
    return { type: 'StripeWebhookRefusal', reason: 'stripe-webhook-event-journal-unavailable', accepted: false };
  }
  if (prior.length) {
    if (prior.some(record => record.conflict === true || !eventReceiptsAgree(record, identity))) {
      if (!prior.some(record => record.conflict === true && record.eventContentDigest === eventContentDigest)) {
        await provider.record({ category: category("stripe-webhook-event-admission", "events"), recordedAt: now.toISOString(),
          record: { id: `urn:stripe-event-conflict:${event.id}:${eventContentDigest.slice('ni:///sha-256;'.length)}`,
            type: 'StripeWebhookEventConflictReceipt', recordedAt: now.toISOString(), ...identity,
            signatureVerified: true, supported: false, conflict: true, rawBodyRecorded: false, buyerPersonalDataRecorded: false,
            consequence: 'conflicting-event-identity-must-not-authorize-access' }, told: { for: false, against: true } });
      }
      return { type: 'StripeWebhookRefusal', reason: 'conflicting-stripe-event-identity', stripeEventId: event.id, accepted: false };
    }
    return { type: "StripeWebhookReceipt", stripeEventId: event.id, duplicate: true, accepted: true };
  }
  const record = { id: `urn:stripe-event-receipt:${event.id}`, type: "StripeWebhookEventReceipt", recordedAt: now.toISOString(), supported: SUPPORTED_EVENTS.has(event.type), ...identity, signatureVerified: true, duplicate: false, rawBodyRecorded: false, buyerPersonalDataRecorded: false, consequence: SUPPORTED_EVENTS.has(event.type) ? "customer-settlement-must-independently-admit" : "ignored-unsupported-event" };
  await provider.record({ category: category("stripe-webhook-event-admission", "events"), recordedAt: now.toISOString(), record, told: { for: true, against: false } });
  return { type: "StripeWebhookReceipt", stripeEventId: event.id, eventType: event.type, supported: record.supported, duplicate: false, accepted: true, consequence: record.consequence };
}

/** Read-only billing evidence for one original Checkout order. The caller is a
 * trusted host adapter: authenticatedActor, account, catalog and store must be
 * derived by that host, never accepted as authority from a request body. The
 * result deliberately carries no product rights, profiles or access token. */
export async function resolveSubscriptionAccess(input, options = {}) {
  const env = options.env ?? process.env;
  return resolveCurrentSubscriptionBilling(input, { key: stripeKey(env),
    catalog: options.catalog ?? loadCatalog(options.catalogPath), store: evidenceStore(options),
    digest, projectEvent, eventReceiptsAgree, validateLiveOffering, options });
}

