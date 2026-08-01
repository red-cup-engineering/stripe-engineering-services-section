import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { querySettlementRecords } from "@lenticule-science/witness-journal-rdf-projection-service/client";
import { startWitnessJournalProviderProcess } from "@lenticule-science/witness-journal-rdf-projection-service/test-provider";

import { ACTOR, CHECKOUT_CONTRACT, WEBHOOK_CONTRACT, ingestWebhook, invokeCheckout, readiness, solicitCheckout, verifyStripeSignature } from "../src/service.mjs";

const catalog = { merchant: { legalBody: "emsenn" }, offerings: [{ id: "smoke", status: "test-only", mode: "payment", currency: "usd", unitAmount: 100, name: "Smoke", description: "test", quantity: { minimum: 1, maximum: 1 } }] };
const solicitation = () => ({ "@context": "https://www.w3.org/ns/activitystreams", id: "urn:test:request", type: "Offer", actor: "urn:ame:customer", target: ACTOR, object: { type: "ServiceSolicitation", contract: CHECKOUT_CONTRACT, request: { offeringId: "smoke", quantity: 1, successUrl: "https://example.test/success", cancelUrl: "https://example.test/cancel", customerReference: "order-1" } } });
let witnessJournal;
test.before(async () => { witnessJournal = await startWitnessJournalProviderProcess(); });
test.after(async () => { await witnessJournal.close(); });

test("readiness reveals status but never credential bytes", () => {
  const value = readiness({ env: { API_KEY_STRIPE: "sk_test_secret", STRIPE_WEBHOOK_SECRET: "whsec_secret" }, catalog });
  assert.equal(value.credential.recognizedMode, "test");
  assert.equal(value.secretsDisclosed, false);
  assert.doesNotMatch(JSON.stringify(value), /sk_test_secret|whsec_secret/u);
});

test("solicitation admits only the fixed test offering under a test key", () => {
  const result = solicitCheckout(solicitation(), { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog });
  assert.equal(result.type, "Offer");
  assert.match(result.object.contract, /^ni:\/\/\/sha-256;/u);
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
  const accepted = { id: "urn:test:accept", type: "Accept", actor: request.actor, target: ACTOR, object: { contract: CHECKOUT_CONTRACT, offer: offered } };
  const root = mkdtempSync(join(tmpdir(), "stripe-enterprise-")); let captured;
  try {
    const fetchImpl = async (_url, options) => { captured = options; return { ok: true, status: 200, json: async () => ({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/test", amount_total: 100, currency: "usd", payment_status: "unpaid", status: "open" }) }; };
    const result = await invokeCheckout(accepted, { env: { API_KEY_STRIPE: "sk_test_secret" }, catalog, root, agentUrl: witnessJournal.agentCardUrl, fetchImpl, now: new Date("2026-07-18T12:00:00Z") });
    assert.equal(result.type, "Accept");
    assert.match(String(captured.body), /line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=100/u);
    const [receipt] = await querySettlementRecords(`${CHECKOUT_CONTRACT}.receipts`);
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
    const options = { env: { STRIPE_WEBHOOK_SECRET: secret }, root, agentUrl: witnessJournal.agentCardUrl, now: new Date(timestamp * 1000), nowSeconds: timestamp };
    const first = await ingestWebhook({ rawBody, signatureHeader }, options);
    assert.equal(first.accepted, true); assert.equal(first.duplicate, false);
    const [record] = await querySettlementRecords(`${WEBHOOK_CONTRACT}.events`);
    assert.doesNotMatch(JSON.stringify(record), /private@example\.test|buyer-private-reference|clientReferenceId|client_reference_id/u);
    const duplicate = await ingestWebhook({ rawBody, signatureHeader }, options);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await querySettlementRecords(`${WEBHOOK_CONTRACT}.events`)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
