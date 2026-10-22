import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { each } from "@red-cup-engineering/semiotic-eavt-services-section/store";

import { ACTOR, buildCheckoutSessionForm, ingestWebhook, invokeCheckout, projectEvent, readiness, solicitCheckout, validateLiveOffering, validateOfferingShape, verifyStripeSignature } from "../src/service.mjs";
import { CHECKOUT_EVENTS } from "../src/checkout-events.mjs";

test("paid Checkout completion events include delayed success and retain its true type", async () => {
  assert.deepEqual(CHECKOUT_EVENTS, ["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
  assert.equal(Object.isFrozen(CHECKOUT_EVENTS), true);
  const rawBody = JSON.stringify({ id: "evt_delayed_fixture", type: "checkout.session.async_payment_succeeded", livemode: false, data: { object: { id: "cs_fixture", payment_status: "paid", status: "complete", amount_total: 1200, currency: "usd" } } });
  const timestamp = Math.floor(Date.now() / 1000), secret = "offline-delayed-fixture";
  const signatureHeader = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const records = [];
  const result = await ingestWebhook({ rawBody, signatureHeader }, { env: { STRIPE_WEBHOOK_SECRET: secret }, store: { query: () => [], async record(value) { records.push(value); } } });
  assert.equal(result.supported, true);
  assert.equal(result.eventType, "checkout.session.async_payment_succeeded");
  assert.equal(records[0].record.eventType, result.eventType);
  assert.equal(records[0].record.livemode, false);
  assert.equal(records[0].record.amountTotal, 1200);
});

function memoryStore() {
  const rows = [];
  return { rows, record: async (entry) => { rows.push(entry); return entry; }, query: ({ category }) => rows.filter((entry) => entry.category === category).map((entry) => ({ record: entry.record })) };
}

const catalog = { merchant: { legalBody: "emsenn" }, offerings: [{ id: "smoke", status: "test-only", mode: "payment", currency: "usd", unitAmount: 100, name: "Smoke", description: "test", quantity: { minimum: 1, maximum: 1 } }] };
const solicitation = () => ({ "@context": "https://www.w3.org/ns/activitystreams", id: "urn:test:request", type: "Offer", actor: "urn:ame:customer", target: ACTOR, object: { type: "ServiceSolicitation", request: { offeringId: "smoke", quantity: 1, successUrl: "https://example.test/success", cancelUrl: "https://example.test/cancel", customerReference: "order-1" } } });

const subscriptionOffering = { id: "smoke-subscription", status: "test-only", mode: "subscription", currency: "usd", unitAmount: 500, name: "Smoke subscription", description: "test", quantity: { minimum: 1, maximum: 1 }, recurring: { interval: "month" } };
const subscriptionCatalog = { merchant: { legalBody: "emsenn" }, offerings: [...catalog.offerings, subscriptionOffering] };
const subscriptionSolicitation = () => ({ "@context": "https://www.w3.org/ns/activitystreams", id: "urn:test:request-subscription", type: "Offer", actor: "urn:ame:customer", target: ACTOR, object: { type: "ServiceSolicitation", request: { offeringId: "smoke-subscription", quantity: 1, successUrl: "https://example.test/success", cancelUrl: "https://example.test/cancel", customerReference: "order-2" } } });
function records(root, category) { return [...each(root, category.replace(".", "-"))].map(({ record }) => record); }

test("readiness reveals status but never credential bytes", () => {
  const value = readiness({ env: { API_KEY_STRIPE: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret" }, catalog });
  assert.equal(value.credential.recognizedMode, "test");
  assert.equal(value.secretsDisclosed, false);
  assert.doesNotMatch(JSON.stringify(value), /sk_test_secret|whsec_secret/u);
});

test("solicitation admits only the fixed test offering under a test key", () => {
  const result = solicitCheckout(solicitation(), { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog });
  assert.equal(result.type, "Offer");
  const changed = solicitation(); changed.object.request.offeringId = "caller-price";
  assert.equal(solicitCheckout(changed, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog }).type, "Reject");
});

test("a live credential cannot activate the test-only offering", () => {
  const result = solicitCheckout(solicitation(), { env: { API_KEY_STRIPE: "rk_live_secret" }, catalog });
  assert.equal(result.type, "Reject");
  assert.equal(result.object.reason, "offering-not-active-for-credential-mode");
});

test("invocation creates a Stripe form and records a redacted account-bound WitnessJournal receipt", async () => {
  const request = solicitation(), offered = solicitCheckout(request, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog });
  const accepted = { id: "urn:test:accept", type: "Accept", actor: request.actor, target: ACTOR, object: { offer: offered } };
  const root = mkdtempSync(join(tmpdir(), "stripe-enterprise-")); let captured;
  try {
    const fetchImpl = async (_url, options) => { captured = options; return { ok: true, status: 200, json: async () => ({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/test", amount_total: 100, currency: "usd", payment_status: "unpaid", status: "open" }) }; };
    const result = await invokeCheckout(accepted, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog, root, fetchImpl, now: new Date("2026-07-18T12:00:00Z") });
    assert.equal(result.type, "Accept");
    assert.match(String(captured.body), /line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=100/u);
    const [receipt] = records(root, "stripe-checkout-session-creation.receipts");
    assert.equal(receipt.stripeSessionId, "cs_test_1");
    assert.doesNotMatch(JSON.stringify(receipt), /sk_test_secret/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("webhook verification uses untouched bytes, tolerance, private projection, and WitnessJournal idempotency", async () => {
  const root = mkdtempSync(join(tmpdir(), "stripe-webhook-"));
  try {
    const rawBody = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", created: 1, livemode: false, data: { object: { id: "cs_test_1", amount_total: 100, currency: "usd", client_reference_id: "buyer-private-reference", metadata: { offering_id: "smoke", customer_settlement: "urn:ame:customer" }, customer_details: { email: "private@example.test" } } } });
    const timestamp = 1000, secret = "whsec_test", signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"), signatureHeader = `t=${timestamp},v1=${signature}`;
    assert.equal(verifyStripeSignature({ rawBody, signatureHeader, secret, now: timestamp }), true);
    assert.equal(verifyStripeSignature({ rawBody: `${rawBody} `, signatureHeader, secret, now: timestamp }), false);
    const options = { env: { STRIPE_WEBHOOK_SECRET: secret }, root, now: new Date(timestamp * 1000), nowSeconds: timestamp };
    const first = await ingestWebhook({ rawBody, signatureHeader }, options);
    assert.equal(first.accepted, true); assert.equal(first.duplicate, false);
    const [record] = records(root, "stripe-webhook-event-admission.events");
    assert.doesNotMatch(JSON.stringify(record), /private@example\.test|buyer-private-reference|clientReferenceId|client_reference_id/u);
    const duplicate = await ingestWebhook({ rawBody, signatureHeader }, options);
    assert.equal(duplicate.duplicate, true);
    assert.equal(records(root, "stripe-webhook-event-admission.events").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invokeCheckout records into an injected store instead of the on-disk journal", async () => {
  const request = solicitation(), offered = solicitCheckout(request, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog });
  const accepted = { id: "urn:test:accept", type: "Accept", actor: request.actor, target: ACTOR, object: { offer: offered } };
  const store = memoryStore();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: "cs_test_2", url: "https://checkout.stripe.com/c/pay/test-2", amount_total: 100, currency: "usd", payment_status: "unpaid", status: "open" }) });
  const result = await invokeCheckout(accepted, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog, store, fetchImpl, now: new Date("2026-07-18T12:00:00Z") });
  assert.equal(result.type, "Accept");
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].category, "stripe-checkout-session-creation.receipts");
  assert.equal(store.rows[0].record.stripeSessionId, "cs_test_2");
});

test("ingestWebhook admits and deduplicates through an injected store", async () => {
  const store = memoryStore();
  const rawBody = JSON.stringify({ id: "evt_store_1", type: "checkout.session.completed", created: 1, livemode: false, data: { object: { id: "cs_store_1", amount_total: 100, currency: "usd", metadata: { offering_id: "smoke", customer_settlement: "urn:ame:customer" } } } });
  const timestamp = 2000, secret = "whsec_store", signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"), signatureHeader = `t=${timestamp},v1=${signature}`;
  const options = { env: { STRIPE_WEBHOOK_SECRET: secret }, store, now: new Date(timestamp * 1000), nowSeconds: timestamp };
  const first = await ingestWebhook({ rawBody, signatureHeader }, options);
  assert.equal(first.accepted, true); assert.equal(first.duplicate, false);
  assert.equal(store.rows.length, 1);
  const duplicate = await ingestWebhook({ rawBody, signatureHeader }, options);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.rows.length, 1);
});

test("buildCheckoutSessionForm produces the exact wire form invokeCheckout posts, with no I/O", () => {
  const offering = catalog.offerings[0];
  const request = { successUrl: "https://example.test/success", cancelUrl: "https://example.test/cancel", customerReference: "order-1" };
  const form = buildCheckoutSessionForm(offering, request, 1, "ni:///sha-256;deadbeef");
  assert.equal(form.get("mode"), "payment");
  assert.equal(form.get("success_url"), request.successUrl);
  assert.equal(form.get("client_reference_id"), "order-1");
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "100");
  assert.equal(form.get("metadata[request_digest]"), "ni:///sha-256;deadbeef");
  assert.equal(form.get("metadata[offering_id]"), offering.id);
  assert.equal(form.has("metadata[customer_settlement]"), false);
});

test("projectEvent redacts a raw Stripe event to the recorded shape with no I/O", () => {
  const event = { id: "evt_pure_1", type: "checkout.session.completed", created: 42, livemode: false, data: { object: { id: "cs_pure_1", payment_status: "paid", status: "complete", amount_total: 100, currency: "usd", payment_intent: "pi_1", metadata: { request_digest: "ni:///sha-256;abc", offering_id: "smoke", customer_settlement: "urn:ame:customer" }, client_reference_id: "should-not-appear" } } };
  const projection = projectEvent(event);
  assert.equal(projection.stripeEventId, "evt_pure_1");
  assert.equal(projection.stripeObjectId, "cs_pure_1");
  assert.equal(projection.paymentIntentId, "pi_1");
  assert.equal(projection.requestDigest, "ni:///sha-256;abc");
  assert.equal(projection.offeringId, "smoke");
  assert.equal(projection.customerSettlement, "urn:ame:customer");
  assert.equal("clientReferenceId" in projection, false);
  assert.equal(projection.subscriptionId, null);
  assert.equal(projection.invoiceId, null);
  assert.equal(projection.currentPeriodStart, null);
  assert.equal(projection.currentPeriodEnd, null);
  assert.equal(projection.cancelAtPeriodEnd, null);
});

test("validateOfferingShape refuses a subscription offering without recurring and a payment offering with it", () => {
  assert.deepEqual(validateOfferingShape({ mode: "payment" }), { valid: true });
  assert.deepEqual(validateOfferingShape({ mode: "subscription", recurring: { interval: "month" } }), { valid: true });
  assert.equal(validateOfferingShape({ mode: "subscription" }).valid, false);
  assert.equal(validateOfferingShape({ mode: "subscription" }).reason, "subscription-offering-missing-recurring");
  assert.equal(validateOfferingShape({ mode: "payment", recurring: { interval: "month" } }).valid, false);
  assert.equal(validateOfferingShape({ mode: "payment", recurring: { interval: "month" } }).reason, "payment-offering-must-not-declare-recurring");
  assert.equal(validateOfferingShape({ mode: "subscription", recurring: { interval: "fortnight" } }).reason, "invalid-recurring-interval");
  assert.equal(validateOfferingShape({ mode: "subscription", recurring: { interval: "month", intervalCount: 0 } }).reason, "invalid-recurring-interval-count");
});

test("solicitCheckout refuses a subscription offering misconfigured without recurring", () => {
  const brokenCatalog = { merchant: { legalBody: "emsenn" }, offerings: [{ ...subscriptionOffering, recurring: undefined }] };
  const result = solicitCheckout(subscriptionSolicitation(), { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog: brokenCatalog });
  assert.equal(result.type, "Reject");
  assert.equal(result.object.reason, "subscription-offering-missing-recurring");
});

test("solicitCheckout admits a well-formed subscription offering", () => {
  const result = solicitCheckout(subscriptionSolicitation(), { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog: subscriptionCatalog });
  assert.equal(result.type, "Offer");
  assert.equal(result.object.offering.mode, "subscription");
});

test("buildCheckoutSessionForm emits the Stripe recurring price_data fields for subscription mode", () => {
  const request = { successUrl: "https://example.test/success", cancelUrl: "https://example.test/cancel", customerReference: "order-2" };
  const form = buildCheckoutSessionForm(subscriptionOffering, request, 1, "ni:///sha-256;deadbeef");
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("line_items[0][price_data][recurring][interval]"), "month");
  assert.equal(form.has("line_items[0][price_data][recurring][interval_count]"), false);

  const withCount = buildCheckoutSessionForm({ ...subscriptionOffering, recurring: { interval: "week", intervalCount: 2 } }, request, 1, "ni:///sha-256;deadbeef");
  assert.equal(withCount.get("line_items[0][price_data][recurring][interval]"), "week");
  assert.equal(withCount.get("line_items[0][price_data][recurring][interval_count]"), "2");
});

test("buildCheckoutSessionForm emits no recurring fields for payment mode", () => {
  const offering = catalog.offerings[0];
  const request = { successUrl: "https://example.test/success", cancelUrl: "https://example.test/cancel", customerReference: "order-1" };
  const form = buildCheckoutSessionForm(offering, request, 1, "ni:///sha-256;deadbeef");
  assert.equal(form.has("line_items[0][price_data][recurring][interval]"), false);
  assert.equal(form.has("line_items[0][price_data][recurring][interval_count]"), false);
});

test("invocation of a subscription offering posts the recurring wire form and records a receipt", async () => {
  const request = subscriptionSolicitation(), offered = solicitCheckout(request, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog: subscriptionCatalog });
  const accepted = { id: "urn:test:accept-subscription", type: "Accept", actor: request.actor, target: ACTOR, object: { offer: offered } };
  const store = memoryStore(); let captured;
  const fetchImpl = async (_url, options) => { captured = options; return { ok: true, status: 200, json: async () => ({ id: "cs_test_sub_1", url: "https://checkout.stripe.com/c/pay/test-sub", amount_total: 500, currency: "usd", payment_status: "unpaid", status: "open" }) }; };
  const result = await invokeCheckout(accepted, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog: subscriptionCatalog, store, fetchImpl, now: new Date("2026-07-18T12:00:00Z") });
  assert.equal(result.type, "Accept");
  assert.match(String(captured.body), /line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month/u);
  assert.equal(store.rows[0].record.stripeSessionId, "cs_test_sub_1");
});

test("projectEvent projects subscription and invoice identifiers and period fields when present", () => {
  const subscriptionEvent = { id: "evt_sub_1", type: "customer.subscription.updated", created: 42, livemode: false, data: { object: { id: "sub_1", status: "active", current_period_start: 1000, current_period_end: 2000, cancel_at_period_end: true, metadata: { offering_id: "smoke-subscription", customer_settlement: "urn:ame:customer" } } } };
  const subscriptionProjection = projectEvent(subscriptionEvent);
  assert.equal(subscriptionProjection.subscriptionId, "sub_1");
  assert.equal(subscriptionProjection.currentPeriodStart, 1000);
  assert.equal(subscriptionProjection.currentPeriodEnd, 2000);
  assert.equal(subscriptionProjection.cancelAtPeriodEnd, true);
  assert.equal(subscriptionProjection.invoiceId, null);

  const invoiceEvent = { id: "evt_inv_1", type: "invoice.paid", created: 43, livemode: false, data: { object: { id: "in_1", subscription: "sub_1", status: "paid", amount_total: 500, currency: "usd", metadata: { offering_id: "smoke-subscription", customer_settlement: "urn:ame:customer" } } } };
  const invoiceProjection = projectEvent(invoiceEvent);
  assert.equal(invoiceProjection.invoiceId, "in_1");
  assert.equal(invoiceProjection.subscriptionId, "sub_1");
});

test("ingestWebhook recognizes invoice.paid and customer.subscription.* as supported events", async () => {
  const store = memoryStore();
  const rawBody = JSON.stringify({ id: "evt_sub_2", type: "customer.subscription.created", created: 1, livemode: false, data: { object: { id: "sub_2", current_period_start: 1000, current_period_end: 2000, cancel_at_period_end: false, metadata: { offering_id: "smoke-subscription", customer_settlement: "urn:ame:customer" } } } });
  const timestamp = 3000, secret = "whsec_subscription", signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"), signatureHeader = `t=${timestamp},v1=${signature}`;
  const options = { env: { STRIPE_WEBHOOK_SECRET: secret }, store, now: new Date(timestamp * 1000), nowSeconds: timestamp };
  const result = await ingestWebhook({ rawBody, signatureHeader }, options);
  assert.equal(result.accepted, true);
  assert.equal(result.supported, true);
  assert.equal(result.consequence, "customer-settlement-must-independently-admit");
  assert.equal(store.rows[0].record.subscriptionId, "sub_2");
});

test("readiness reports each offering's mode, including subscription offerings' recurring interval", () => {
  const value = readiness({ env: { API_KEY_STRIPE: "sk_test_secret" }, catalog: subscriptionCatalog });
  const modes = Object.fromEntries(value.offerings.map((offering) => [offering.id, offering]));
  assert.equal(modes.smoke.mode, "payment");
  assert.equal("recurring" in modes.smoke, false);
  assert.equal(modes["smoke-subscription"].mode, "subscription");
  assert.deepEqual(modes["smoke-subscription"].recurring, { interval: "month" });
});

const tipOffering = { id: "tip", status: "test-only", mode: "payment", currency: "usd", customerChosenAmount: { minimum: 100, maximum: 100000, preset: 500 }, name: "Tip", description: "A tip.", quantity: { minimum: 1, maximum: 1 } };
const tipCatalog = { merchant: { legalBody: "emsenn" }, offerings: [...catalog.offerings, tipOffering] };
const tipSolicitation = () => ({ "@context": "https://www.w3.org/ns/activitystreams", id: "urn:test:request-tip", type: "Offer", actor: "urn:ame:customer", target: ACTOR, object: { type: "ServiceSolicitation", request: { offeringId: "tip", quantity: 1, successUrl: "https://example.test/success", cancelUrl: "https://example.test/cancel", customerReference: "order-tip" } } });

test("validateOfferingShape admits a well-formed customer-chosen-amount offering and refuses a malformed one", () => {
  assert.deepEqual(validateOfferingShape(tipOffering), { valid: true });
  assert.equal(validateOfferingShape({ ...tipOffering, mode: "something-else" }).reason, "customer-chosen-amount-offering-must-be-payment-mode");
  assert.equal(validateOfferingShape({ ...tipOffering, quantity: { minimum: 1, maximum: 2 } }).reason, "customer-chosen-amount-offering-must-be-single-quantity");
  assert.equal(validateOfferingShape({ ...tipOffering, customerChosenAmount: { minimum: 50 } }).reason, "invalid-customer-chosen-amount-minimum");
  assert.equal(validateOfferingShape({ ...tipOffering, customerChosenAmount: { minimum: 100, maximum: 50 } }).reason, "invalid-customer-chosen-amount-maximum");
  assert.equal(validateOfferingShape({ ...tipOffering, customerChosenAmount: { minimum: 100, maximum: 200, preset: 500 } }).reason, "invalid-customer-chosen-amount-preset");
});

test("solicitCheckout admits the tip offering under a test key", () => {
  const result = solicitCheckout(tipSolicitation(), { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog: tipCatalog });
  assert.equal(result.type, "Offer");
  assert.deepEqual(result.object.offering.customerChosenAmount, tipOffering.customerChosenAmount);
});

test("buildCheckoutSessionForm emits custom_unit_amount fields and no fixed unit_amount for a tip offering", () => {
  const request = { successUrl: "https://example.test/success", cancelUrl: "https://example.test/cancel", customerReference: "order-tip" };
  const form = buildCheckoutSessionForm(tipOffering, request, 1, "ni:///sha-256;deadbeef");
  assert.equal(form.get("line_items[0][price_data][custom_unit_amount][enabled]"), "true");
  assert.equal(form.get("line_items[0][price_data][custom_unit_amount][minimum]"), "100");
  assert.equal(form.get("line_items[0][price_data][custom_unit_amount][maximum]"), "100000");
  assert.equal(form.get("line_items[0][price_data][custom_unit_amount][preset]"), "500");
  assert.equal(form.has("line_items[0][price_data][unit_amount]"), false);
});

test("invocation of the tip offering posts custom_unit_amount and records a receipt with the customer's chosen amount", async () => {
  const request = tipSolicitation(), offered = solicitCheckout(request, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog: tipCatalog });
  const accepted = { id: "urn:test:accept-tip", type: "Accept", actor: request.actor, target: ACTOR, object: { offer: offered } };
  const store = memoryStore(); let captured;
  const fetchImpl = async (_url, options) => { captured = options; return { ok: true, status: 200, json: async () => ({ id: "cs_test_tip_1", url: "https://checkout.stripe.com/c/pay/test-tip", amount_total: 750, currency: "usd", payment_status: "unpaid", status: "open" }) }; };
  const result = await invokeCheckout(accepted, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog: tipCatalog, store, fetchImpl, now: new Date("2026-09-05T12:00:00Z") });
  assert.equal(result.type, "Accept");
  assert.match(String(captured.body), /custom_unit_amount%5D%5Benabled%5D=true/u);
  assert.equal(store.rows[0].record.amountTotal, 750);
  assert.equal(store.rows[0].record.offeringId, "tip");
});


const policyQualifiedLiveOffering = {
  ...catalog.offerings[0], id: "live-product", status: "live",
  unitAmount: 1500, beneficiarySettlement: "house-product-seller",
  terms: "customer-contract:live-product:v1", taxPolicy: "tax-policy:v1",
  refundPolicy: "refund-policy:v1",
};
const qualifiedLiveCatalog = { merchant: { legalBody: "emsenn" }, offerings: [policyQualifiedLiveOffering] };
const qualifiedLiveEnv = {
  STRIPE_SECRET_KEY: "rk_live_offline_fixture", STRIPE_WEBHOOK_SECRET: "whsec_offline_fixture",
  STRIPE_CUSTOMER_CONTRACT_TOKEN: "contract-accepted-offline",
};
const liveSolicitation = () => {
  const activity = solicitation();
  activity.object.request.offeringId = policyQualifiedLiveOffering.id;
  return activity;
};

test("live merchant readiness requires more than a live key and a live catalog marker", () => {
  const incomplete = { ...policyQualifiedLiveOffering, refundPolicy: undefined };
  assert.deepEqual(validateLiveOffering(incomplete), { valid: false, reason: "missing-live-offering-refundPolicy" });
  assert.equal(readiness({ env: qualifiedLiveEnv, catalog: { merchant: { legalBody: "emsenn" }, offerings: [incomplete] } }).liveReady, false);
  assert.equal(readiness({ env: { ...qualifiedLiveEnv, STRIPE_WEBHOOK_SECRET: undefined }, catalog: qualifiedLiveCatalog }).liveReady, false);
  assert.equal(readiness({ env: { ...qualifiedLiveEnv, STRIPE_CUSTOMER_CONTRACT_TOKEN: undefined }, catalog: qualifiedLiveCatalog }).liveReady, false);
  const qualified = readiness({ env: qualifiedLiveEnv, catalog: qualifiedLiveCatalog });
  assert.equal(qualified.liveReady, true);
  assert.deepEqual(qualified.liveQualifications, [{ id: "live-product", valid: true }]);
  assert.equal(qualified.secretsDisclosed, false);
  assert.doesNotMatch(JSON.stringify(qualified), /rk_live_offline_fixture|whsec_offline_fixture|contract-accepted-offline/u);
  for (const field of ["beneficiarySettlement", "terms", "taxPolicy", "refundPolicy"]) {
    assert.equal(validateLiveOffering({ ...policyQualifiedLiveOffering, [field]: " " }).reason,
      "missing-live-offering-" + field);
  }
});

test("live checkout solicitation and invocation both refuse absent webhook or customer contract", async () => {
  const request = liveSolicitation(), allowed = solicitCheckout(request, { env: qualifiedLiveEnv, catalog: qualifiedLiveCatalog });
  assert.equal(allowed.type, "Offer");
  const accepted = { id: "urn:test:live-accept", type: "Accept", actor: request.actor, target: ACTOR, object: { offer: allowed } };
  for (const name of ["STRIPE_WEBHOOK_SECRET", "STRIPE_CUSTOMER_CONTRACT_TOKEN"]) {
    const env = { ...qualifiedLiveEnv, [name]: undefined };
    const solicitationRefusal = solicitCheckout(request, { env, catalog: qualifiedLiveCatalog });
    assert.equal(solicitationRefusal.type, "Reject");
    assert.equal(solicitationRefusal.object.reason, "stripe-live-activation-not-ready");
    let providerRequests = 0;
    const store = memoryStore();
    const invocationRefusal = await invokeCheckout(accepted, {
      env, catalog: qualifiedLiveCatalog, store,
      fetchImpl: async () => { providerRequests += 1; throw new Error("must not contact Stripe"); },
    });
    assert.equal(invocationRefusal.type, "Reject");
    assert.equal(invocationRefusal.object.reason, "stripe-live-activation-not-ready");
    assert.equal(providerRequests, 0);
    assert.equal(store.rows.length, 0);
  }
});

test("one qualified offering cannot authorize an incomplete second live offering", () => {
  const broken = { ...policyQualifiedLiveOffering, id: "other-live", refundPolicy: undefined };
  const mixedCatalog = { ...qualifiedLiveCatalog, offerings: [policyQualifiedLiveOffering, broken] };
  assert.equal(readiness({ env: qualifiedLiveEnv, catalog: mixedCatalog }).liveReady, true);
  const request = liveSolicitation();
  request.object.request.offeringId = broken.id;
  const refused = solicitCheckout(request, { env: qualifiedLiveEnv, catalog: mixedCatalog });
  assert.equal(refused.type, "Reject");
  assert.equal(refused.object.reason, "missing-live-offering-refundPolicy");
  for (const [change, reason] of [
    [{ unitAmount: 0 }, "invalid-live-offering-price"],
    [{ currency: "US D" }, "invalid-live-offering-currency"],
    [{ quantity: { minimum: 0, maximum: 0 } }, "invalid-live-offering-quantity"],
  ]) {
    const validation = validateLiveOffering({ ...policyQualifiedLiveOffering, ...change });
    assert.equal(validation.valid, false);
    assert.equal(validation.reason, reason);
  }
});

test("qualified live checkout preserves the existing idempotent session path with an injected provider", async () => {
  const request = liveSolicitation(), offered = solicitCheckout(request, { env: qualifiedLiveEnv, catalog: qualifiedLiveCatalog });
  assert.equal(offered.type, "Offer");
  const store = memoryStore();
  let calls = 0;
  const response = await invokeCheckout({
    id: "urn:test:accepted-live", type: "Accept", actor: request.actor, target: ACTOR, object: { offer: offered },
  }, {
    env: qualifiedLiveEnv, catalog: qualifiedLiveCatalog, store,
    now: new Date("2026-10-13T12:00:00Z"),
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.match(String(options.body), /line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1500/u);
      return { ok: true, status: 200, json: async () => ({
        id: "cs_offline_live_fixture", url: "https://checkout.stripe.com/c/pay/offline-fixture",
        amount_total: 1500, currency: "usd", payment_status: "unpaid", status: "open",
      }) };
    },
  });
  assert.equal(response.type, "Accept");
  assert.equal(calls, 1);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].record.stripeMode, "live");
  assert.equal(store.rows[0].record.paymentStatus, "unpaid");
});



test("signed Stripe support checkout keeps its provider Payment Link identity, not private buyer information", () => {
 const event={
  id:"evt_original_group_checkout",type:"checkout.session.completed",created:1792670000,
  livemode:true,data:{object:{
   id:"cs_paid_original",status:"complete",payment_status:"paid",
   payment_link:"plink_1USMywJ1vYnPQu2NWHtcqx0b",
   payment_intent:"pi_original_test",amount_total:1000,currency:"usd",
   customer_details:{email:"private@example.invalid"},
   metadata:{internal_note:"never-copy",customer_settlement:"urn:ame:buyer"}
  }}
 };
 const receipt=projectEvent(event);
 assert.equal(receipt.stripePaymentLinkId,"plink_1USMywJ1vYnPQu2NWHtcqx0b");
 assert.equal(receipt.amountTotal,1000);
 assert.equal(receipt.paymentStatus,"paid");
 assert.equal(receipt.stripeLineItemCoverage,"not-provided");
 assert.deepEqual(receipt.stripePriceIdsObserved,[]);
 assert.deepEqual(receipt.stripeProductIdsObserved,[]);
 assert.equal(receipt.stripeBalanceTransactionId,null);
 assert.equal("customerDetails" in receipt,false);
 assert.equal("customer" in receipt,false);
 assert.equal("customerEmail" in receipt,false);
 assert.equal("cashReceived" in receipt,false);
 assert.equal("payoutId" in receipt,false);
});

test("subscription and invoice provider price identities are observed without inventing complete line-item or cleared-cash coverage", () => {
 const price="price_1UMnsuJ1vYnPQu2N7U1S22t2";
 const product="prod_VNZ0v9uUHgXFb3";
 const subscription=projectEvent({
  id:"evt_group_support_sub",type:"customer.subscription.created",
  livemode:true,data:{object:{id:"sub_fixture",status:"active",
   items:{has_more:false,data:[{price:{id:price,product}}]},
   metadata:{extra:"private"}
  }}
 });
 assert.equal(subscription.subscriptionId,"sub_fixture");
 assert.equal(subscription.stripeLineItemCoverage,"complete");
 assert.deepEqual(subscription.stripePriceIdsObserved,[price]);
 assert.deepEqual(subscription.stripeProductIdsObserved,[product]);
 assert.equal(subscription.stripePaymentLinkId,null);

 const invoice=projectEvent({
  id:"evt_group_support_invoice",type:"invoice.paid",livemode:true,
  data:{object:{id:"in_fixture",subscription:"sub_fixture",status:"paid",
   amount_total:1000,currency:"usd",
   lines:{has_more:true,data:[
    {pricing:{price_details:{price,product}}},
    {pricing:{price_details:{price,product}}}
   ]}
  }}
 });
 assert.equal(invoice.invoiceId,"in_fixture");
 assert.equal(invoice.subscriptionId,"sub_fixture");
 assert.equal(invoice.stripeLineItemCoverage,"possibly-partial");
 assert.deepEqual(invoice.stripePriceIdsObserved,[price]);
 assert.deepEqual(invoice.stripeProductIdsObserved,[product]);
 assert.equal("clearedCash" in invoice,false);
 assert.equal("payoutStatus" in invoice,false);
});

test("unrecognized provider IDs and absent line items remain unknown, not a fabricated support sale", () => {
 const rejected=projectEvent({
  id:"evt_wrong_ids",type:"checkout.session.completed",
  data:{object:{payment_link:"unknown_link",balance_transaction:"payout_123",
   lines:{data:[{price:{id:"suspicious_price",product:"unknown"}}]},
   payment_status:"unpaid"
  }}
 });
 assert.equal(rejected.stripePaymentLinkId,null);
 assert.equal(rejected.stripeBalanceTransactionId,null);
 assert.deepEqual(rejected.stripePriceIdsObserved,[]);
 assert.equal(rejected.stripeLineItemCoverage,"not-provided");

 const absent=projectEvent({
  id:"evt_missing_price",type:"invoice.paid",
  data:{object:{id:"in_unknown",subscription:"sub_unknown",lines:{data:[]}}}
 });
 assert.deepEqual(absent.stripePriceIdsObserved,[]);
 assert.equal(absent.stripeLineItemCoverage,"possibly-partial");
});

test("the ORIGINAL signature-verified webhook writer retains recurring support IDs once per event", async () => {
 const timestamp=Math.floor(Date.now()/1000),secret="offline-original-support-secret";
 const rawBody=JSON.stringify({
  id:"evt_support_signed_original",type:"checkout.session.completed",
  livemode:false,data:{object:{
   id:"cs_original_support",payment_link:"plink_1USMywJ1vYnPQu2NWHtcqx0b",
   payment_status:"paid",status:"complete",amount_total:1000,currency:"usd",
   customer_details:{email:"do-not-retain@example.invalid"}
  }}
 });
 const signatureHeader="t="+timestamp+",v1="+createHmac("sha256",secret)
  .update(timestamp+"."+rawBody).digest("hex");
 const writes=[];
 const store={
  query:()=>writes.map(x=>({record:x.record})),
  async record(value){writes.push(value)}
 };
 const request={rawBody,signatureHeader};
 const first=await ingestWebhook(request,{env:{STRIPE_WEBHOOK_SECRET:secret},store});
 assert.equal(first.supported,true);
 assert.equal(first.accepted,true);
 assert.equal(writes.length,1);
 const row=writes[0].record;
 assert.equal(row.stripePaymentLinkId,"plink_1USMywJ1vYnPQu2NWHtcqx0b");
 assert.equal(row.signatureVerified,true);
 assert.equal(row.livemode,false);
 assert.equal("customerDetails" in row,false);
 assert.equal("clearedCash" in row,false);
 const again=await ingestWebhook(request,{env:{STRIPE_WEBHOOK_SECRET:secret},store});
 assert.equal(again.duplicate,true);
 assert.equal(writes.length,1);
});
