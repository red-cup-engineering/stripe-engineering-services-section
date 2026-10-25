import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ACTOR, buildCheckoutSessionForm, invokeCheckout, solicitCheckout, projectEvent, ingestWebhook } from '../src/service.mjs';

const binding = { request_digest: 'ni:///sha-256;original-order', offering_id: 'assist-bundle', customer_settlement: 'urn:person:buyer' };
const offering = interval => ({ id: binding.offering_id, status: 'test-only', mode: 'subscription', currency: 'usd', unitAmount: 500, name: 'ASSIST bundle', description: 'Fixture plan', quantity: { minimum: 1, maximum: 1 }, recurring: { interval } });
const request = { offeringId: binding.offering_id, quantity: 1, successUrl: 'https://assist.example/success', cancelUrl: 'https://assist.example/cancel', customerReference: 'opaque-order-reference' };
const event = (type, object) => ({ id: 'evt_subscription_fixture', type, created: 1792930000, livemode: false, data: { object } });

test('weekly, monthly and annual checkout propagate the original order into subscription metadata', () => {
  for (const interval of ['week', 'month', 'year']) {
    const form = buildCheckoutSessionForm(offering(interval), request, 1, binding.request_digest);
    assert.equal(form.get('line_items[0][price_data][recurring][interval]'), interval);
    assert.equal(form.get('subscription_data[metadata][offering_id]'), binding.offering_id);
    assert.equal(form.get('subscription_data[metadata][request_digest]'), binding.request_digest);
    assert.equal(form.has('subscription_data[metadata][customer_settlement]'), false, 'the pure form cannot invent an authenticated actor');
    assert.equal(form.has('payment_method_types[0]'), false);
  }
  const form = buildCheckoutSessionForm({ ...offering('month'), mode: 'payment', recurring: undefined }, request, 1, binding.request_digest);
  assert.equal([...form.keys()].some(key => key.startsWith('subscription_data[')), false);
});

test('subscription invocation binds the authenticated actor at both provider objects, not a customer-supplied reference', async () => {
  const catalog = { merchant: { legalBody: 'test-merchant' }, offerings: [offering('month')] };
  const options = { catalog, env: { STRIPE_SECRET_KEY: 'sk_test_fixture' } };
  const solicitation = { id: 'urn:test:subscription', type: 'Offer', actor: binding.customer_settlement, target: ACTOR, object: { type: 'ServiceSolicitation', request } };
  const offer = solicitCheckout(solicitation, options);
  const acceptance = { id: 'urn:test:accept', type: 'Accept', actor: solicitation.actor, target: ACTOR, object: { offer } };
  let captured;
  const result = await invokeCheckout(acceptance, { ...options, store: { record() {}, query() { return []; } }, fetchImpl: async (_url, init) => {
    captured = new URLSearchParams(init.body);
    return Response.json({ id: 'cs_test_fixture', url: 'https://checkout.stripe.com/c/pay/test_fixture' });
  } });
  assert.equal(result.type, 'Accept');
  assert.equal(captured.get('metadata[customer_settlement]'), solicitation.actor);
  assert.equal(captured.get('subscription_data[metadata][customer_settlement]'), solicitation.actor);
  assert.notEqual(captured.get('subscription_data[metadata][customer_settlement]'), request.customerReference);
});

test('current and prior invoice layouts preserve the subscription order binding and exclude unrelated metadata', () => {
  for (const object of [
    { id: 'in_current', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_source', metadata: { ...binding, private_note: 'exclude-me' } } } },
    { id: 'in_prior', subscription: 'sub_source', subscription_details: { metadata: binding } },
    { id: 'in_legacy', subscription: 'sub_source', metadata: binding },
  ]) {
    const receipt = projectEvent(event('invoice.paid', object));
    assert.equal(receipt.subscriptionId, 'sub_source');
    assert.equal(receipt.requestDigest, binding.request_digest);
    assert.equal(receipt.offeringId, binding.offering_id);
    assert.equal(receipt.customerSettlement, binding.customer_settlement);
    assert.equal(JSON.stringify(receipt).includes('exclude-me'), false);
    assert.equal(Object.hasOwn(receipt, 'accessGranted'), false);
  }
});

test('incompatible invoice sources cannot silently choose a different customer or subscription', () => {
  for (const conflicting of [
    { metadata: { ...binding, customer_settlement: 'urn:person:other' } },
    { subscription: 'sub_other' },
  ]) {
    const receipt = projectEvent(event('invoice.paid', { id: 'in_conflict', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_source', metadata: binding } }, ...conflicting }));
    assert.equal(receipt.subscriptionBindingStatus, 'conflicting');
    assert.equal(receipt.subscriptionId, null);
    assert.equal(receipt.customerSettlement, null);
    assert.equal(receipt.offeringId, null);
    assert.equal(receipt.requestDigest, null);
  }
  const unrelated = projectEvent(event('invoice.paid', { id: 'in_quote', parent: { type: 'quote_details', subscription_details: { subscription: 'sub_forged', metadata: binding } } }));
  assert.equal(unrelated.subscriptionId, null);
  assert.equal(unrelated.customerSettlement, null);
});

test('mixed subscription item periods remain separate and partial collections remain partial', () => {
  const items = [
    { id: 'si_week', price: { id: 'price_week', product: 'prod_app' }, current_period_start: 100, current_period_end: 200 },
    { id: 'si_year', price: { id: 'price_year', product: 'prod_bundle' }, current_period_start: 90, current_period_end: 900 },
  ];
  const receipt = projectEvent(event('customer.subscription.updated', { id: 'sub_mixed', status: 'active', metadata: binding, items: { data: items, has_more: true } }));
  assert.equal(receipt.currentPeriodStart, null);
  assert.equal(receipt.currentPeriodEnd, null);
  assert.equal(receipt.stripeLineItemCoverage, 'possibly-partial');
  assert.deepEqual(receipt.stripeSubscriptionItemsObserved, [
    { stripeSubscriptionItemId: 'si_week', stripePriceId: 'price_week', stripeProductId: 'prod_app', currentPeriodStart: 100, currentPeriodEnd: 200 },
    { stripeSubscriptionItemId: 'si_year', stripePriceId: 'price_year', stripeProductId: 'prod_bundle', currentPeriodStart: 90, currentPeriodEnd: 900 },
  ]);
});

test('invalid item and legacy periods never become an access window', () => {
  for (const [start, end] of [[200, 100], [-1, 100], [1.5, 100], ['1', 100], [1, null]]) {
    const receipt = projectEvent(event('customer.subscription.updated', { id: 'sub_bad', items: { data: [{ id: 'si_bad', current_period_start: start, current_period_end: end }], has_more: false } }));
    assert.equal(receipt.stripeSubscriptionItemsObserved[0].currentPeriodStart, null);
    assert.equal(receipt.stripeSubscriptionItemsObserved[0].currentPeriodEnd, null);
    const legacy = projectEvent(event('customer.subscription.updated', { id: 'sub_bad', current_period_start: start, current_period_end: end }));
    assert.equal(legacy.currentPeriodStart, null);
    assert.equal(legacy.currentPeriodEnd, null);
  }
});

test('the original signed webhook journal receives current invoice bindings once, without issuing access', async () => {
  const rows = [];
  const store = { query: () => rows, record: row => rows.push(row) };
  const rawBody = JSON.stringify(event('invoice.paid', { id: 'in_signed', status: 'paid', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_source', metadata: binding } } }));
  const secret = 'whsec_fixture', timestamp = 1792930000;
  const signatureHeader = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const input = { rawBody, signatureHeader }, options = { env: { STRIPE_WEBHOOK_SECRET: secret }, store, nowSeconds: timestamp };
  assert.equal((await ingestWebhook(input, options)).accepted, true);
  assert.equal((await ingestWebhook(input, options)).duplicate, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record.customerSettlement, binding.customer_settlement);
  assert.equal(rows[0].record.subscriptionId, 'sub_source');
  assert.equal(rows[0].record.consequence, 'customer-settlement-must-independently-admit');
  assert.equal((await ingestWebhook({ ...input, signatureHeader: 'invalid' }, options)).accepted, undefined);
});

test('metadata alone cannot claim a complete subscription binding', () => {
  const receipt = projectEvent(event('invoice.paid', { id: 'in_missing', metadata: binding }));
  assert.equal(receipt.subscriptionId, null);
  assert.equal(receipt.subscriptionBindingStatus, 'partial');
});
