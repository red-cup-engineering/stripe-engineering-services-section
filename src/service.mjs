import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { createSettlementStore, relationalRwilDocument } from "@lenticule-science/rwil-rdf-projection-service/client";
import { CHECKOUT_CONTRACT, WEBHOOK_CONTRACT } from "./law.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ACTOR = "urn:ame:stripe-services-section";
export { CHECKOUT_CONTRACT, WEBHOOK_CONTRACT };
const SUPPORTED_EVENTS = new Set(["checkout.session.completed", "checkout.session.expired", "payment_intent.payment_failed", "charge.refunded"]);

export function digest(value) { return semanticId(relationalRwilDocument(value)); }
function reply(type, activity, object) { return { "@context": "https://www.w3.org/ns/activitystreams", id: `${activity?.id ?? `urn:request:${Date.now()}`}:${type.toLowerCase()}`, type, actor: ACTOR, target: activity?.actor, inReplyTo: activity?.id, object }; }
function reject(activity, reason, detail = undefined) { return reply("Reject", activity, { type: "ServiceRefusal", reason, ...(detail === undefined ? {} : { detail }) }); }

export function credentialMode(key) {
  if (typeof key !== "string" || key.length === 0) return "absent";
  if (/^(sk|rk)_test_/u.test(key)) return "test";
  if (/^(sk|rk)_live_/u.test(key)) return "live";
  return "unknown";
}

export function loadCatalog(path = join(ROOT, "content/config/offerings.json")) { return JSON.parse(readFileSync(path, "utf8")); }
function stripeKey(env) { return env.API_KEY_STRIPE || env.STRIPE_SECRET_KEY || ""; }
export function readiness({ env = process.env, catalog = loadCatalog() } = {}) {
  const mode = credentialMode(stripeKey(env));
  return {
    type: "StripePaymentAcceptanceReadiness",
    actor: ACTOR,
    legalMerchant: catalog.merchant.legalBody,
    credential: { present: mode !== "absent", recognizedMode: mode, sourceName: env.API_KEY_STRIPE ? "API_KEY_STRIPE" : env.STRIPE_SECRET_KEY ? "STRIPE_SECRET_KEY" : null },
    webhookSecretPresent: Boolean(env.STRIPE_WEBHOOK_SECRET),
    customerContractTokenPresent: Boolean(env.STRIPE_CUSTOMER_CONTRACT_TOKEN),
    offerings: catalog.offerings.map(({ id, status, mode: offeringMode, currency, unitAmount }) => ({ id, status, mode: offeringMode, currency, unitAmount })),
    liveReady: mode === "live" && catalog.offerings.some((offering) => offering.status === "live") && Boolean(env.STRIPE_WEBHOOK_SECRET) && Boolean(env.STRIPE_CUSTOMER_CONTRACT_TOKEN),
    secretsDisclosed: false
  };
}

function validUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)); } catch { return false; }
}
function requestFrom(activity) { return activity?.object?.type === "ServiceSolicitation" ? activity.object.request : undefined; }
function validateRequest(request, catalog, mode) {
  if (!request || typeof request !== "object") return { reason: "invalid-checkout-request" };
  const offering = catalog.offerings.find((candidate) => candidate.id === request.offeringId);
  if (!offering) return { reason: "unknown-offering" };
  if (offering.status !== "live" && !(offering.status === "test-only" && mode === "test")) return { reason: "offering-not-active-for-credential-mode" };
  if (mode === "live" && offering.status !== "live") return { reason: "live-credential-refused-for-non-live-offering" };
  if (!validUrl(request.successUrl) || !validUrl(request.cancelUrl)) return { reason: "invalid-redirect-url" };
  if (typeof request.customerReference !== "string" || request.customerReference.length < 1 || request.customerReference.length > 200) return { reason: "invalid-customer-reference" };
  const quantity = request.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < offering.quantity.minimum || quantity > offering.quantity.maximum) return { reason: "quantity-out-of-bounds" };
  return { offering, quantity };
}

export function solicitCheckout(activity, options = {}) {
  const catalog = options.catalog ?? loadCatalog(options.catalogPath);
  const mode = credentialMode(stripeKey(options.env ?? process.env));
  if (activity?.type !== "Offer" || activity?.target !== ACTOR || activity?.object?.contract !== CHECKOUT_CONTRACT) return reject(activity, "invalid-checkout-solicitation-envelope");
  if (mode === "absent" || mode === "unknown") return reject(activity, "stripe-credential-unavailable-or-unrecognized");
  const request = requestFrom(activity);
  const admitted = validateRequest(request, catalog, mode);
  if (!admitted.offering) return reject(activity, admitted.reason);
  const requestDigest = digest({ actor: activity.actor, request, offering: admitted.offering });
  return reply("Offer", activity, { type: "ExecutableServiceOffer", contract: CHECKOUT_CONTRACT, request, requestDigest, offering: admitted.offering, idempotencyKey: requestDigest.replace("ni:///sha-256;", "checkout-"), credentialMode: mode });
}

function evidenceStore(options, env) {
  const settlementRoot = options.root ?? ROOT;
  return createSettlementStore({ settlementRoot: ROOT, agentUrl: options.agentUrl ?? env.RWIL_RDF_AGENT ?? process.env.RWIL_RDF_AGENT });
}
const category = (law, kind) => `${law}.${kind}`;
async function appendRecord(options, env, now, record, law, kind) { return evidenceStore(options, env).record({ category: category(law, kind), recordedAt: now.toISOString(), record }); }

export async function invokeCheckout(activity, options = {}) {
  const env = options.env ?? process.env; const catalog = options.catalog ?? loadCatalog(options.catalogPath); const key = stripeKey(env); const mode = credentialMode(key);
  const offered = activity?.object?.offer;
  if (activity?.type !== "Accept" || activity?.target !== ACTOR || activity?.object?.contract !== CHECKOUT_CONTRACT || offered?.type !== "Offer" || offered?.actor !== ACTOR || offered?.target !== activity.actor || offered?.object?.contract !== CHECKOUT_CONTRACT) return reject(activity, "invalid-checkout-acceptance-envelope");
  const admitted = validateRequest(offered.object.request, catalog, mode);
  if (!admitted.offering) return reject(activity, admitted.reason);
  const expectedDigest = digest({ actor: activity.actor, request: offered.object.request, offering: admitted.offering });
  if (offered.object.requestDigest !== expectedDigest || offered.object.idempotencyKey !== expectedDigest.replace("ni:///sha-256;", "checkout-")) return reject(activity, "provider-offer-digest-mismatch");
  const request = offered.object.request; const form = new URLSearchParams();
  form.set("mode", admitted.offering.mode); form.set("success_url", request.successUrl); form.set("cancel_url", request.cancelUrl);
  form.set("client_reference_id", request.customerReference); form.set("line_items[0][quantity]", String(admitted.quantity));
  form.set("line_items[0][price_data][currency]", admitted.offering.currency); form.set("line_items[0][price_data][unit_amount]", String(admitted.offering.unitAmount));
  form.set("line_items[0][price_data][product_data][name]", admitted.offering.name); form.set("line_items[0][price_data][product_data][description]", admitted.offering.description);
  form.set("metadata[request_digest]", expectedDigest); form.set("metadata[offering_id]", admitted.offering.id); form.set("metadata[customer_settlement]", activity.actor);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try { response = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": offered.object.idempotencyKey }, body: form }); }
  catch { return reject(activity, "stripe-api-unavailable"); }
  let body; try { body = await response.json(); } catch { return reject(activity, "stripe-api-invalid-response"); }
  if (!response.ok) return reject(activity, "stripe-api-refusal", { status: response.status, code: body?.error?.code ?? null, type: body?.error?.type ?? null });
  if (typeof body?.id !== "string" || typeof body?.url !== "string") return reject(activity, "stripe-api-incomplete-session");
  const now = options.now ?? new Date(); const receipt = { id: `urn:stripe-checkout-receipt:${body.id}`, type: "StripeCheckoutSessionReceipt", recordedAt: now.toISOString(), legalMerchant: catalog.merchant.legalBody, customerSettlement: activity.actor, offeringId: admitted.offering.id, requestDigest: expectedDigest, stripeSessionId: body.id, stripeMode: mode, amountTotal: body.amount_total ?? admitted.offering.unitAmount * admitted.quantity, currency: body.currency ?? admitted.offering.currency, paymentStatus: body.payment_status ?? "unpaid", status: body.status ?? "open", expiresAt: body.expires_at ?? null, secretRecorded: false, buyerPaymentDataRecorded: false };
  await appendRecord(options, env, now, receipt, CHECKOUT_CONTRACT, "receipts");
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
function eventSeen(provider, eventId) { return provider.records(category(WEBHOOK_CONTRACT, "events")).some((record) => record.stripeEventId === eventId); }
function projectEvent(event) {
  const object = event?.data?.object ?? {}; const metadata = object.metadata ?? {};
  return { stripeEventId: event.id, eventType: event.type, created: event.created ?? null, livemode: event.livemode ?? null, stripeObjectId: typeof object.id === "string" ? object.id : null, paymentStatus: object.payment_status ?? null, status: object.status ?? null, amountTotal: object.amount_total ?? object.amount ?? null, currency: object.currency ?? null, paymentIntentId: typeof object.payment_intent === "string" ? object.payment_intent : null, requestDigest: metadata.request_digest ?? null, offeringId: metadata.offering_id ?? null, customerSettlement: metadata.customer_settlement ?? null };
}
export async function ingestWebhook({ rawBody, signatureHeader }, options = {}) {
  const env = options.env ?? process.env; const secret = env.STRIPE_WEBHOOK_SECRET; const now = options.now ?? new Date(); const nowSeconds = options.nowSeconds ?? Math.floor(now.getTime() / 1000);
  if (!secret) return { type: "StripeWebhookRefusal", reason: "webhook-secret-unavailable" };
  if (Buffer.byteLength(rawBody ?? "", "utf8") > (options.maxBodyBytes ?? 1024 * 1024)) return { type: "StripeWebhookRefusal", reason: "webhook-body-too-large" };
  if (!verifyStripeSignature({ rawBody, signatureHeader, secret, toleranceSeconds: options.toleranceSeconds ?? 300, now: nowSeconds })) return { type: "StripeWebhookRefusal", reason: "invalid-or-stale-stripe-signature" };
  let event; try { event = JSON.parse(rawBody); } catch { return { type: "StripeWebhookRefusal", reason: "invalid-json-after-signature-verification" }; }
  if (typeof event?.id !== "string" || typeof event?.type !== "string") return { type: "StripeWebhookRefusal", reason: "invalid-stripe-event-shape" };
  const provider = evidenceStore(options, env); if (eventSeen(provider, event.id)) return { type: "StripeWebhookReceipt", law: WEBHOOK_CONTRACT, stripeEventId: event.id, duplicate: true, accepted: true };
  const projection = projectEvent(event); const record = { id: `urn:stripe-event-receipt:${event.id}`, type: "StripeWebhookEventReceipt", law: WEBHOOK_CONTRACT, recordedAt: now.toISOString(), supported: SUPPORTED_EVENTS.has(event.type), ...projection, signatureVerified: true, duplicate: false, rawBodyRecorded: false, buyerPersonalDataRecorded: false, consequence: SUPPORTED_EVENTS.has(event.type) ? "customer-settlement-must-independently-admit" : "ignored-unsupported-event" };
  await provider.record({ category: category(WEBHOOK_CONTRACT, "events"), recordedAt: now.toISOString(), record });
  return { type: "StripeWebhookReceipt", law: WEBHOOK_CONTRACT, stripeEventId: event.id, eventType: event.type, supported: record.supported, duplicate: false, accepted: true, consequence: record.consequence };
}
