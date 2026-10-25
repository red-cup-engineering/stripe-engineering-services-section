import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { each } from '@red-cup-engineering/semiotic-eavt-services-section/store';
import { recordFile } from '@red-cup-engineering/semiotic-eavt-services-section/layout';
import { ACTOR, digest, ingestWebhook, invokeCheckout, solicitCheckout, resolveSubscriptionAccess,
  SUBSCRIPTION_READ_API_VERSION } from '../src/service.mjs';
import * as originalService from '../src/service.mjs';

const NOW = new Date('2026-10-25T12:00:00.000Z');
const unix = value => Math.floor(new Date(value).getTime() / 1000);
const START = unix('2026-10-01T00:00:00Z'), END = unix('2026-11-01T00:00:00Z');
const list = data => ({ object: 'list', has_more: false, data });
const copy = value => structuredClone(value);
const NATIVE_EVENTS = 'stripe-webhook-event-admission-events';

function damageNativeRecord(root, predicate, mode) {
  const rows = [...each(root, NATIVE_EVENTS, { strict: true })];
  const row = rows.find(({ record }) => predicate(record));
  assert.ok(row, 'the target must be an originally verified native record');
  const file = recordFile(root, NATIVE_EVENTS, row.address);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const index = lines.findIndex(line => JSON.parse(line).id === row.address);
  assert.ok(index >= 0);
  if (mode === 'malformed') lines[index] = '{malformed native journal record';
  else if (mode === 'unverifiable') {
    const entry = JSON.parse(lines[index]); entry.record.custodyDamaged = true;
    lines[index] = JSON.stringify(entry); // Preserve the original address, not a new valid identity.
  } else if (mode === 'unterminated') {
    const [line] = lines.splice(index, 1);
    writeFileSync(file, [...lines, line].join('\n'));
    return;
  } else if (mode === 'misplaced') {
    const original = rows.find(({ record }) => record.stripeEventId === 'evt_fixture' && record.conflict !== true);
    assert.ok(original);
    const wrongBucket = recordFile(root, NATIVE_EVENTS, original.address);
    assert.notEqual(file, wrongBucket, 'the fixture requires distinct original custody buckets');
    const [line] = lines.splice(index, 1);
    writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
    appendFileSync(wrongBucket, line + '\n'); // Keep the valid record and its real address; change only its custody location.
    return;
  } else assert.fail('unknown native corruption fixture');
  writeFileSync(file, lines.join('\n') + '\n');
}

async function fixture({ root } = {}) {
  const rows = [], reads = [];
  const store = {
    record(entry) { rows.push(copy(entry)); return { id: `fixture-record-${rows.length}` }; },
    query({ category, limit = Infinity }) { return rows.filter(row => row.category === category).slice(0, limit); },
  };
  const evidence = root ? { root } : { store };
  const offering = { id: 'news-subscription', status: 'live', mode: 'subscription', currency: 'usd', unitAmount: 500,
    name: 'Fixture subscription', description: 'An isolated receiving fixture', recurring: { interval: 'month' },
    quantity: { minimum: 1, maximum: 1 }, beneficiarySettlement: 'urn:fixture:merchant', terms: 'urn:fixture:terms',
    taxPolicy: 'urn:fixture:tax-policy', refundPolicy: 'urn:fixture:refund-policy' };
  const catalog = { merchant: { legalBody: 'fixture-merchant' }, offerings: [offering] };
  const env = { STRIPE_SECRET_KEY: 'sk_live_fixture_not_a_real_key', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_CUSTOMER_CONTRACT_TOKEN: 'fixture-host-contract' };
  const actor = 'urn:person:fixture-subscriber';
  const solicitation = { id: 'urn:fixture:solicitation', type: 'Offer', actor, target: ACTOR,
    object: { type: 'ServiceSolicitation', request: { offeringId: offering.id, quantity: 1,
      customerReference: 'opaque-order-reference', successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' } } };
  const offer = solicitCheckout(solicitation, { catalog, env });
  assert.equal(offer.type, 'Offer');
  const invocation = await invokeCheckout({ id: 'urn:fixture:invoke', type: 'Accept', actor, target: ACTOR, object: { offer } },
    { catalog, env, ...evidence, now: NOW, fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions'); assert.equal(init.method, 'POST');
      assert.equal(init.body.get('metadata[customer_settlement]'), actor);
      return Response.json({ id: 'cs_live_fixture', url: 'https://checkout.stripe.com/c/pay/fixture',
        amount_total: 500, currency: 'usd', payment_status: 'unpaid', status: 'open' });
    } });
  assert.equal(invocation.type, 'Accept');
  const input = { authenticatedActor: actor, subscriptionId: 'sub_fixture', requestDigest: offer.object.requestDigest, offeringId: offering.id };
  const metadata = { customer_settlement: actor, offering_id: offering.id, request_digest: input.requestDigest };
  const item = { id: 'si_fixture', object: 'subscription_item', subscription: input.subscriptionId, quantity: 1,
    current_period_start: START, current_period_end: END,
    price: { id: 'price_fixture', object: 'price', product: 'prod_fixture', livemode: true, type: 'recurring',
      billing_scheme: 'per_unit', transform_quantity: null, currency: 'usd', unit_amount: 500,
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } };
  const subscription = { id: input.subscriptionId, object: 'subscription', metadata, livemode: true, status: 'active',
    customer: 'cus_fixture', latest_invoice: 'in_fixture', items: list([item]), ended_at: null,
    pause_collection: null, pending_update: null, cancel_at_period_end: false, cancel_at: null };
  const checkout = { id: 'cs_live_fixture', object: 'checkout.session', subscription: input.subscriptionId, customer: 'cus_fixture',
    livemode: true, mode: 'subscription', status: 'complete', payment_status: 'paid', metadata };
  const line = { id: 'il_fixture', object: 'line_item', livemode: true, amount: 500, currency: 'usd', quantity: 1,
    parent: { type: 'subscription_item_details', subscription_item_details: { subscription: input.subscriptionId,
      subscription_item: item.id, proration: false } },
    pricing: { type: 'price_details', price_details: { price: item.price.id, product: item.price.product } }, period: { start: START, end: END } };
  const invoice = { id: 'in_fixture', object: 'invoice', livemode: true, customer: 'cus_fixture', status: 'paid',
    parent: { type: 'subscription_details', subscription_details: { subscription: input.subscriptionId, metadata } },
    amount_paid: 500, amount_due: 500, amount_remaining: 0, total: 500, currency: 'usd', starting_balance: 0,
    pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, billing_reason: 'subscription_cycle',
    // Stripe invoice accounting periods are deliberately NOT the service period.
    period_start: START - 30 * 86400, period_end: START, lines: list([line]) };
  const payment = { id: 'inpay_fixture', object: 'invoice_payment', invoice: invoice.id, livemode: true,
    status: 'paid', amount_paid: 500, amount_requested: 500, currency: 'usd', payment: { type: 'payment_intent', payment_intent: 'pi_fixture' } };
  const charge = { id: 'ch_fixture', object: 'charge', payment_intent: 'pi_fixture', customer: 'cus_fixture', livemode: true,
    status: 'succeeded', paid: true, captured: true, amount: 500, amount_captured: 500, currency: 'usd',
    refunded: false, amount_refunded: 0, disputed: false };
  const intent = { id: 'pi_fixture', object: 'payment_intent', livemode: true, customer: 'cus_fixture', status: 'succeeded',
    amount_received: 500, currency: 'usd', latest_charge: charge };
  const objects = { account: { id: 'acct_fixture', object: 'account' }, checkout, subscription, invoice, payments: list([payment]), intent };
  const event = (id, type, object) => ({ id, type, created: unix(NOW), livemode: true, data: { object } });
  const ingest = async value => {
    const rawBody = JSON.stringify(value), timestamp = unix(NOW);
    const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
    return ingestWebhook({ rawBody, signatureHeader: `t=${timestamp},v1=${signature}` }, { env, ...evidence, now: NOW });
  };
  const originalEvent = event('evt_fixture', 'customer.subscription.created', copy(subscription));
  assert.equal((await ingest(originalEvent)).accepted, true);
  const routes = { '/v1/account': 'account', '/v1/checkout/sessions/cs_live_fixture': 'checkout',
    '/v1/subscriptions/sub_fixture': 'subscription', '/v1/invoices/in_fixture': 'invoice',
    '/v1/invoice_payments': 'payments', '/v1/payment_intents/pi_fixture': 'intent' };
  let hook;
  const options = { catalog, env, ...evidence, now: NOW, expectedAccountId: 'acct_fixture', fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.stripe.com'); assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers['Stripe-Version'], SUBSCRIPTION_READ_API_VERSION);
    reads.push({ path: parsed.pathname, parameters: Object.fromEntries(parsed.searchParams) });
    const hooked = await hook?.({ parsed, init, reads });
    if (hooked) return hooked;
    assert.ok(routes[parsed.pathname], `unanticipated provider read: ${parsed.pathname}`);
    return Response.json(copy(objects[routes[parsed.pathname]]));
  } };
  return { input, options, objects, item, line, payment, charge, rows, reads, catalog, env, metadata,
    originalEvent, event, ingest, setReadHook(value) { hook = value; },
    resolve(extra = {}) { return resolveSubscriptionAccess(input, { ...options, ...extra }); } };
}

test('original invocation + signed journal + current Basil provider joins yield billing evidence only', async () => {
  const f = await fixture(), result = await f.resolve();
  assert.equal(result.admitted, true, JSON.stringify(result));
  assert.equal(result.type, 'StripeSubscriptionBillingEvidence');
  assert.equal(result.customerSettlement, f.input.authenticatedActor);
  assert.equal(result.requestDigest, f.input.requestDigest);
  assert.equal(result.notBefore, new Date(START * 1000).toISOString());
  assert.equal(result.expiresAt, new Date(END * 1000).toISOString());
  assert.equal(result.stripeSubscriptionItemId, 'si_fixture'); assert.equal(result.stripeChargeId, 'ch_fixture');
  assert.match(result.billingRevision, /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u);
  assert.equal(Object.hasOwn(result, 'queryProfiles'), false); assert.equal(Object.hasOwn(result, 'rights'), false);
  assert.equal(Object.hasOwn(result, 'subscriber'), false); assert.equal(Object.hasOwn(result, 'accessGranted'), false);
  assert.equal(f.reads.length, 7);
  assert.deepEqual(f.reads.find(row => row.path === '/v1/invoice_payments').parameters, { invoice: 'in_fixture', limit: '2' });
  assert.deepEqual(f.reads.find(row => row.path === '/v1/payment_intents/pi_fixture').parameters, { 'expand[]': 'latest_charge' });
  assert.equal(f.rows.length, 2, 'billing reads never create a new ledger or provider action');
});

test('same paid period retains revision across HTTP rechecks and unrelated/deduplicated events', async () => {
  const f = await fixture(), first = await f.resolve();
  assert.equal((await f.ingest(f.originalEvent)).duplicate, true);
  await f.ingest(f.event('evt_unrelated', 'invoice.payment_failed', { id: 'in_other', subscription: 'sub_other' }));
  const second = await f.resolve({ now: new Date(NOW.getTime() + 60000) });
  assert.equal(first.billingRevision, second.billingRevision);
  assert.notEqual(first.observedAt, second.observedAt);
});

test('actor, original order, live credential and host account are required before reads', async () => {
  for (const change of [
    f => { f.input.authenticatedActor = 'urn:person:other'; },
    f => { f.input.requestDigest = digest('different-order'); },
    f => { f.options.env = { ...f.env, STRIPE_SECRET_KEY: 'sk_test_fixture' }; },
    f => { delete f.options.expectedAccountId; },
    f => { f.rows[1].record.signatureVerified = false; },
    f => { f.rows[0].record.stripeMode = 'test'; },
  ]) {
    const f = await fixture(); change(f);
    assert.equal((await f.resolve()).admitted, false); assert.equal(f.reads.length, 0);
  }
});

test('original receipt ambiguity cannot choose a preferred Checkout session', async () => {
  const f = await fixture(), other = copy(f.rows[0]); other.record.stripeSessionId = 'cs_live_other'; f.rows.push(other);
  assert.equal((await f.resolve()).reason, 'original-checkout-session-ambiguous');
});

test('account, Checkout subscription, customer and metadata mismatches cannot admit access', async () => {
  for (const change of [
    f => { f.objects.account.id = 'acct_other'; },
    f => { f.objects.checkout.subscription = 'sub_other'; },
    f => { f.objects.checkout.customer = 'cus_other'; },
    f => { f.objects.subscription.metadata = { ...f.metadata, customer_settlement: 'urn:person:other' }; },
    f => { f.objects.invoice.parent.subscription_details.subscription = 'sub_other'; },
    f => { f.objects.invoice.customer = 'cus_other'; },
  ]) { const f = await fixture(); change(f); assert.equal((await f.resolve()).admitted, false); }
});

test('cancel at period end retains only the already paid window; canceled_at is not a period end', async () => {
  const f = await fixture();
  Object.assign(f.objects.subscription, { cancel_at_period_end: true, cancel_at: END, canceled_at: unix(NOW) - 100 });
  const result = await f.resolve(); assert.equal(result.admitted, true, JSON.stringify(result));
  assert.equal(result.expiresAt, new Date(END * 1000).toISOString());
  f.objects.subscription.cancel_at = unix(NOW) + 300;
  assert.equal((await f.resolve()).expiresAt, new Date((unix(NOW) + 300) * 1000).toISOString());
  assert.equal((await f.resolve({ now: new Date((unix(NOW) + 300) * 1000) })).admitted, false);
});

test('trial, overdue, unpaid, paused, canceled and ended states never become paid access', async () => {
  for (const status of ['trialing', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete', 'incomplete_expired']) {
    const f = await fixture(); f.objects.subscription.status = status;
    assert.equal((await f.resolve()).reason, 'subscription-not-currently-active', status);
  }
  for (const change of [
    f => { f.objects.subscription.ended_at = unix(NOW) - 1; },
    f => { f.objects.subscription.pause_collection = { behavior: 'void' }; },
    f => { f.objects.subscription.pending_update = { expires_at: END }; },
  ]) { const f = await fixture(); change(f); assert.equal((await f.resolve()).admitted, false); }
});

test('only the exact current item and invoice line service period qualify', async () => {
  for (const change of [
    f => { f.item.current_period_end = unix(NOW); },
    f => { f.item.current_period_start = unix(NOW) + 100; },
    f => { delete f.line.period; },
    f => { f.line.period.end = END + 100; },
    f => { f.line.parent.subscription_item_details.subscription_item = 'si_other'; },
    f => { f.line.parent.subscription_item_details.proration = true; },
    f => { f.line.pricing.price_details.price = 'price_other'; },
    f => { f.item.price.recurring.interval = 'week'; },
    f => { f.item.price.unit_amount = 1; },
    f => { f.item.quantity = 2; },
  ]) { const f = await fixture(); change(f); assert.equal((await f.resolve()).admitted, false); }
});

test('incomplete and mixed collections cannot widen or pool subscription access', async () => {
  for (const select of [f => f.objects.subscription.items, f => f.objects.invoice.lines, f => f.objects.payments]) {
    for (const mutation of [collection => { collection.has_more = true; }, collection => { collection.data.push(copy(collection.data[0])); }]) {
      const f = await fixture(); mutation(select(f)); assert.equal((await f.resolve()).admitted, false);
    }
  }
});

test('invoice paid status alone, credits, out-of-band payment and wrong allocations are insufficient', async () => {
  for (const change of [
    f => { f.objects.invoice.status = 'open'; },
    f => { f.objects.invoice.amount_remaining = 1; },
    f => { f.objects.invoice.amount_paid = 0; },
    f => { f.objects.invoice.post_payment_credit_notes_amount = 1; },
    f => { f.objects.invoice.starting_balance = -500; },
    f => { f.objects.invoice.billing_reason = 'subscription_update'; },
    f => { f.payment.payment = { type: 'payment_record', payment_record: 'pyr_fixture' }; },
    f => { f.payment.amount_paid = 100; },
    f => { f.payment.invoice = 'in_other'; },
    f => { f.objects.payments.data = []; },
    f => { f.objects.intent.amount_received = 1000; },
  ]) { const f = await fixture(); change(f); assert.equal((await f.resolve()).admitted, false); }
});

test('current charge must be paid, captured, unrefunded, undisputed and owned by the same customer', async () => {
  for (const change of [
    f => { f.charge.refunded = true; },
    f => { f.charge.amount_refunded = 1; },
    f => { f.charge.disputed = true; },
    f => { f.charge.captured = false; },
    f => { f.charge.customer = 'cus_other'; },
    f => { f.charge.payment_intent = 'pi_other'; },
    f => { f.objects.intent.latest_charge = 'ch_fixture'; },
  ]) { const f = await fixture(); change(f); assert.equal((await f.resolve()).admitted, false); }
});

test('older failure does not override current funding, while a verified terminal deletion cannot reactivate', async () => {
  const f = await fixture();
  const old = f.event('evt_old', 'invoice.payment_failed', { id: 'in_old', subscription: f.input.subscriptionId,
    metadata: f.metadata, status: 'open' }); old.created = START - 100;
  await f.ingest(old);
  assert.equal((await f.resolve()).admitted, true);
  await f.ingest(f.event('evt_deleted', 'customer.subscription.deleted', { ...copy(f.objects.subscription), status: 'canceled' }));
  assert.equal((await f.resolve()).reason, 'subscription-revoked-by-verified-event');
});

test('same signed event identity is idempotent; conflicting content is retained once and blocks the subscription', async () => {
  const f = await fixture();
  assert.equal((await f.ingest(f.originalEvent)).duplicate, true); assert.equal(f.rows.length, 2);
  const conflict = copy(f.originalEvent); conflict.data.object.status = 'canceled';
  assert.equal((await f.ingest(conflict)).reason, 'conflicting-stripe-event-identity');
  assert.equal(f.rows.length, 3); assert.equal(f.rows[2].record.conflict, true);
  await f.ingest(conflict); assert.equal(f.rows.length, 3);
  assert.equal((await f.resolve()).reason, 'subscription-event-conflict');
  assert.equal((await f.ingest(f.originalEvent)).accepted, false, 'original retry cannot erase a known conflict');
});

test('conflicting concurrent journal receipts remain unresolvable even if their actors or mode differ', async () => {
  const f = await fixture(), conflicting = copy(f.rows[1]);
  conflicting.record.customerSettlement = 'urn:person:other'; conflicting.record.livemode = false;
  conflicting.record.eventContentDigest = digest('different-signed-event'); f.rows.push(conflicting);
  assert.equal((await f.resolve()).reason, 'subscription-event-conflict');
});

test('legacy redacted event receipts remain idempotent but incomplete projection cannot qualify current billing', async () => {
  const f = await fixture(); delete f.rows[1].record.eventContentDigest; delete f.rows[1].record.stripeSubscriptionIdsObserved;
  assert.equal((await f.ingest(f.originalEvent)).duplicate, true); assert.equal(f.rows.length, 2);
  assert.equal((await f.resolve()).reason, 'subscription-event-journal-incomplete');
  const conflict = copy(f.originalEvent); conflict.data.object.metadata.offering_id = 'other-offer';
  assert.equal((await f.ingest(conflict)).reason, 'conflicting-stripe-event-identity');
});

test('current state and verified journal are rechecked before evidence is returned', async () => {
  const f = await fixture();
  f.setReadHook(({ parsed, reads }) => {
    if (parsed.pathname === '/v1/subscriptions/sub_fixture' && reads.filter(row => row.path === parsed.pathname).length === 2) {
      return Response.json({ ...copy(f.objects.subscription), status: 'canceled' });
    }
  });
  assert.equal((await f.resolve()).admitted, false);
  const g = await fixture();
  g.setReadHook(async ({ parsed, reads }) => {
    if (parsed.pathname === '/v1/subscriptions/sub_fixture' && reads.filter(row => row.path === parsed.pathname).length === 2) {
      await g.ingest(g.event('evt_refund', 'charge.refunded', { ...copy(g.charge), refunded: true, amount_refunded: 500 }));
    }
  });
  assert.equal((await g.resolve()).reason, 'subscription-payment-refunded');
});

test('a signed dispute arriving after the current charge read prevents delivery', async () => {
  for (const type of ['charge.dispute.created', 'charge.dispute.funds_withdrawn']) {
    const f = await fixture();
    f.setReadHook(async ({ parsed, reads }) => {
      if (parsed.pathname === '/v1/subscriptions/sub_fixture' && reads.filter(row => row.path === parsed.pathname).length === 2) {
        await f.ingest(f.event('evt_dispute', type, { id: 'dp_fixture', object: 'dispute',
          charge: 'ch_fixture', payment_intent: 'pi_fixture', status: 'needs_response' }));
      }
    });
    assert.equal((await f.resolve()).reason, 'subscription-payment-disputed');
    assert.equal(f.rows.at(-1).record.stripeChargeId, 'ch_fixture');
  }
  const unrelated = await fixture();
  await unrelated.ingest(unrelated.event('evt_otherdispute', 'charge.dispute.created', { id: 'dp_other', charge: 'ch_other' }));
  assert.equal((await unrelated.resolve()).admitted, true);
});

test('current invoice credit-note arrivals remain outside the uncredited contract even if the charge stays paid', async () => {
  for (const type of ['credit_note.created', 'credit_note.updated', 'credit_note.voided']) {
    const f = await fixture();
    f.setReadHook(async ({ parsed, reads }) => {
      if (parsed.pathname === '/v1/subscriptions/sub_fixture' && reads.filter(row => row.path === parsed.pathname).length === 2) {
        await f.ingest(f.event('evt_credit', type, { id: 'cn_fixture', object: 'credit_note', invoice: { id: 'in_fixture' },
          type: 'post_payment', status: type.endsWith('voided') ? 'void' : 'issued', amount: 500 }));
      }
    });
    assert.equal((await f.resolve()).reason, 'subscription-current-invoice-credit-note-unsupported');
    assert.equal(f.rows.at(-1).record.stripeCreditNoteInvoiceId, 'in_fixture');
  }
  const unrelated = await fixture();
  await unrelated.ingest(unrelated.event('evt_oldcredit', 'credit_note.created', { id: 'cn_old', invoice: 'in_old', status: 'issued' }));
  assert.equal((await unrelated.resolve()).admitted, true);
});

test('default native SEAVT receipts and signed events receive the same billing evidence and conflict refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stripe-subscription-native-'));
  try {
    const f = await fixture({ root });
    const evidence = await f.resolve(); assert.equal(evidence.admitted, true, JSON.stringify(evidence));
    assert.equal((await f.ingest(f.originalEvent)).duplicate, true);
    const conflict = copy(f.originalEvent); conflict.data.object.metadata.customer_settlement = 'urn:person:other';
    assert.equal((await f.ingest(conflict)).accepted, false);
    assert.equal((await f.resolve()).reason, 'subscription-event-conflict');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ['malformed', 'unverifiable', 'unterminated', 'misplaced']) {
  test(`native ${mode} revocation custody refuses before any provider read while the original binding remains intact`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'stripe-subscription-corrupt-'));
    try {
      const f = await fixture({ root });
      await f.ingest(f.event('evt_deleted', 'customer.subscription.deleted', { ...copy(f.objects.subscription), status: 'canceled' }));
      damageNativeRecord(root, record => record.stripeEventId === 'evt_deleted', mode);
      const readable = [...each(root, NATIVE_EVENTS)];
      assert.ok(readable.some(({ record }) => record.stripeEventId === 'evt_fixture'), 'the original bound event remains readable');
      assert.equal(readable.some(({ record }) => record.stripeEventId === 'evt_deleted'), false, 'non-strict discovery silently omits the damaged revocation');
      const result = await f.resolve();
      assert.equal(result.admitted, false, 'damaged revocation custody must not be interpreted as an active subscription');
      assert.equal(result.reason, 'subscription-evidence-journal-unavailable');
      assert.equal(f.reads.length, 0);
      assert.equal(JSON.stringify(result).includes(root), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('a damaged native same-event conflict cannot disappear behind the original valid binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stripe-subscription-conflict-corrupt-'));
  try {
    const f = await fixture({ root }), conflict = copy(f.originalEvent);
    conflict.data.object.metadata.customer_settlement = 'urn:person:other';
    assert.equal((await f.ingest(conflict)).accepted, false);
    damageNativeRecord(root, record => record.conflict === true, 'unverifiable');
    assert.ok([...each(root, NATIVE_EVENTS)].some(({ record }) => record.stripeEventId === 'evt_fixture' && record.conflict !== true));
    const result = await f.resolve();
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'subscription-evidence-journal-unavailable');
    assert.equal(f.reads.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native corruption arriving during the final provider read refuses the final journal boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stripe-subscription-final-corrupt-'));
  try {
    const f = await fixture({ root });
    f.setReadHook(async ({ parsed, reads }) => {
      if (parsed.pathname === '/v1/subscriptions/sub_fixture' && reads.filter(row => row.path === parsed.pathname).length === 2) {
        await f.ingest(f.event('evt_final_deleted', 'customer.subscription.deleted', { ...copy(f.objects.subscription), status: 'canceled' }));
        damageNativeRecord(root, record => record.stripeEventId === 'evt_final_deleted', 'unterminated');
      }
    });
    const result = await f.resolve();
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'subscription-evidence-journal-unavailable');
    assert.equal(f.reads.length, 7, 'the initial journal was valid; final custody is separately required');
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('signed redelivery refuses damaged original event custody without appending or declaring a duplicate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stripe-webhook-corrupt-'));
  try {
    const f = await fixture({ root });
    await f.ingest(f.event('evt_deleted', 'customer.subscription.deleted', { ...copy(f.objects.subscription), status: 'canceled' }));
    damageNativeRecord(root, record => record.stripeEventId === 'evt_deleted', 'malformed');
    const before = [...each(root, NATIVE_EVENTS)].map(({ address }) => address);
    for (const value of [f.originalEvent, f.event('evt_new', 'customer.subscription.updated', copy(f.objects.subscription))]) {
      const result = await f.ingest(value);
      assert.equal(result.type, 'StripeWebhookRefusal');
      assert.equal(result.reason, 'stripe-webhook-event-journal-unavailable');
      assert.equal(result.accepted, false); assert.equal(result.duplicate, undefined);
      assert.equal(JSON.stringify(result).includes(root), false);
    }
    assert.deepEqual([...each(root, NATIVE_EVENTS)].map(({ address }) => address), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('observation budget and paid-period boundary remain binding while provider reads are in progress', async () => {
  const f = await fixture();
  f.setReadHook(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.equal((await f.resolve({ timeoutMs: 1 })).admitted, false);
  const g = await fixture();
  g.setReadHook(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.equal((await g.resolve({ now: new Date(END * 1000 - 10) })).reason, 'subscription-paid-period-not-current');
});

test('one observation deadline bounds a stalled original journal, provider fetch and provider body', async () => {
  const f = await fixture();
  for (const override of [
    { store: { query: () => new Promise(() => {}) } },
    { fetchImpl: () => new Promise(() => {}) },
    { fetchImpl: async () => new Response(new ReadableStream({ start() {} })) },
  ]) {
    const result = await f.resolve({ ...override, timeoutMs: 20 });
    assert.equal(result.reason, 'subscription-observation-timeout');
  }
});

test('provider errors, oversized bodies, journal limits and missing current provider state fail closed without raw diagnostics', async () => {
  const f = await fixture();
  const refused = await f.resolve({ fetchImpl: async () => { throw new Error('private provider details sk_live_secret'); } });
  assert.equal(refused.admitted, false); assert.equal(JSON.stringify(refused).includes('sk_live_secret'), false);
  assert.equal((await f.resolve({ maxJournalRecords: 0 })).admitted, false);
  assert.equal((await f.resolve({ maxJournalRecords: 1 })).admitted, true);
  f.rows.push(copy(f.rows[1]));
  assert.equal((await f.resolve({ maxJournalRecords: 1 })).reason, 'subscription-evidence-journal-incomplete-or-too-large');
  const g = await fixture();
  assert.equal((await g.resolve({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) })).reason,
    'stripe-subscription-provider-response-too-large');
  assert.equal((await g.resolve({ fetchImpl: async () => Response.json({ error: { message: 'private contact data' } }, { status: 403 }) })).reason,
    'stripe-subscription-provider-refusal');
});

test('provider contact data and credentials are never returned or added to the original journals', async () => {
  const f = await fixture();
  Object.assign(f.objects.invoice, { customer_email: 'private@example.test', customer_name: 'Private Customer' });
  const before = copy(f.rows), result = await f.resolve();
  assert.equal(result.admitted, true); assert.deepEqual(f.rows, before);
  for (const privateValue of ['private@example.test', 'Private Customer', f.env.STRIPE_SECRET_KEY, f.env.STRIPE_WEBHOOK_SECRET]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.equal(JSON.stringify(f.rows).includes(privateValue), false);
  }
});

for (const [type, object, field, expected] of [
  ['charge.dispute.created', { id: 'dp_custody', object: 'dispute', charge: 'ch_fixture' }, 'stripeChargeId', 'subscription-payment-disputed'],
  ['credit_note.created', { id: 'cn_custody', object: 'credit_note', invoice: 'in_fixture' }, 'stripeCreditNoteInvoiceId', 'subscription-current-invoice-credit-note-unsupported'],
]) test(`original billing cannot lose a retained ${type} when its projected ${field} field disappears`, async () => {
  const f = await fixture(); assert.equal((await f.resolve()).admitted, true);
  assert.equal((await f.ingest(f.event('evt_custody', type, object))).accepted, true);
  assert.equal((await f.resolve()).reason, expected);
  const record = f.rows.find(row => row.record.stripeEventId === 'evt_custody').record;
  assert.equal(typeof record[field], 'string'); delete record[field];
  f.reads.length = 0;
  const result = await f.resolve(); assert.equal(result.admitted, false);
  assert.equal(result.reason, 'subscription-event-journal-incomplete'); assert.equal(f.reads.length, 0);
  assert.equal(Object.hasOwn(record, field), false, 'no fabricated historical null or migration');
});

test('final billing recheck refuses a newly incomplete retained native projection', async () => {
  const f = await fixture();
  f.setReadHook(async ({ parsed, reads }) => {
    if (parsed.pathname === '/v1/subscriptions/sub_fixture' && reads.filter(row => row.path === parsed.pathname).length === 2) {
      await f.ingest(f.event('evt_final_custody', 'credit_note.created', { id: 'cn_custody', object: 'credit_note', invoice: 'in_fixture' }));
      delete f.rows.at(-1).record.stripeCreditNoteInvoiceId;
    }
  });
  const result = await f.resolve(); assert.equal(result.admitted, false);
  assert.equal(result.reason, 'subscription-event-journal-incomplete'); assert.equal(f.reads.length, 7);
});

const externalSupportObservation = () => ({
  id: 'urn:stripe-event-receipt:evt_external_support', type: 'StripeExternalPaymentLinkObservation', schemaVersion: 1,
  stripeEventId: 'evt_external_support', eventType: 'checkout.session.completed', stripePaymentLinkId: 'plink_support',
  stripeCheckoutSessionId: 'cs_support', amountTotal: 1000, currency: 'usd', paymentStatus: 'paid', status: 'complete',
  livemode: true, stripeEventCreatedAt: unix(NOW), signatureVerified: true, buyerPersonalDataRecorded: false, rawBodyRecorded: false,
  consequence: 'outside-catalog-checkout-observed-not-group-treasury-settlement',
});

test('canonical null, unrelated native events and original external support observations keep their distinct meaning', async () => {
  const f = await fixture();
  for (const object of [{ id: 'dp_null', object: 'dispute' }, { id: 'dp_other', object: 'dispute', charge: 'ch_other' }]) {
    await f.ingest(f.event(`evt_${object.id}`, 'charge.dispute.created', object));
    assert.equal(Object.hasOwn(f.rows.at(-1).record, 'stripeChargeId'), true);
    assert.equal(f.rows.at(-1).record.stripeChargeId, object.charge ?? null);
  }
  f.rows.push({ category: 'stripe-webhook-event-admission.events', record: externalSupportObservation() });
  assert.equal((await f.resolve()).admitted, true);
});

test('shared original validator is public and distinguishes incomplete native evidence from explicit absence', async () => {
  assert.equal(typeof originalService.isCompleteEventReceipt, 'function');
  const f = await fixture(), native = f.rows[1].record;
  assert.equal(originalService.isCompleteEventReceipt(native), true);
  for (const field of Object.keys(originalService.projectEvent({ id: null, type: '', data: { object: {} } }))) {
    const partial = copy(native); delete partial[field];
    assert.equal(originalService.isCompleteEventReceipt(partial), false, field);
  }
  for (const field of ['type', 'livemode', 'signatureVerified', 'supported', 'eventContentDigest']) {
    const partial = copy(native); delete partial[field];
    assert.equal(originalService.isCompleteEventReceipt(partial), false, field);
  }
  let called = false;
  const accessor = { ...native }; Object.defineProperty(accessor, 'stripeChargeId', { get() { called = true; return null; }, enumerable: true });
  assert.equal(originalService.isCompleteEventReceipt(accessor), false); assert.equal(called, false);
  const observed = []; Object.defineProperty(observed, '0', { get() { called = true; return 'sub_fixture'; }, enumerable: true });
  assert.equal(originalService.isCompleteEventReceipt({ ...native, stripeSubscriptionIdsObserved: observed }), false);
  assert.equal(called, false, 'structural admission must not execute a nested reference accessor');
  assert.equal(originalService.isCompleteEventReceipt(Object.create(native)), false);
  const support = externalSupportObservation(); assert.equal(originalService.isCompleteEventReceipt(support), true);
  for (const field of ['type', 'livemode', 'stripePaymentLinkId']) {
    const partial = { ...support }; delete partial[field]; assert.equal(originalService.isCompleteEventReceipt(partial), false);
  }
  assert.equal(originalService.isCompleteEventReceipt({ ...support, subscriptionId: 'sub_fixture' }), false);
  for (const name of ['@red-cup-engineering/stripe-services-section', '@red-cup-engineering/stripe-services-section/service',
    '@red-cup-engineering/stripe-services-section/subscription-access'])
    assert.equal((await import(name)).isCompleteEventReceipt, originalService.isCompleteEventReceipt);
});

test('current receipt completeness preserves concurrent same-ID signed content conflicts when projection alone agrees', async () => {
  const f = await fixture();
  const first = f.event('evt_parallel_identity', 'customer.subscription.updated', { ...copy(f.objects.subscription), nativeUnprojectedFact: 'first' });
  const second = f.event('evt_parallel_identity', 'customer.subscription.updated', { ...copy(f.objects.subscription), nativeUnprojectedFact: 'second' });
  const admitted = await Promise.all([f.ingest(first), f.ingest(second)]);
  assert.ok(admitted.every(result => result.accepted === true));
  const records = f.rows.filter(row => row.record.stripeEventId === first.id).map(row => row.record);
  assert.equal(records.length, 2); assert.notEqual(records[0].eventContentDigest, records[1].eventContentDigest);
  assert.equal((await f.resolve()).reason, 'subscription-event-conflict');
  delete records[1].eventContentDigest;
  const result = await f.resolve(); assert.equal(result.admitted, false);
  assert.equal(result.reason, 'subscription-event-journal-incomplete');
  assert.equal(originalService.isCompleteEventReceipt(records[1]), false);
  assert.equal(Object.hasOwn(records[1], 'eventContentDigest'), false, 'no invented historical raw-body identity');
});

test('non-native relation values cannot hide a retained dispute or credit note from current billing', async () => {
  for (const [type, object, field, expected] of [
    ['charge.dispute.created', { id: 'dp_domains', object: 'dispute', charge: 'ch_fixture' }, 'stripeChargeId', 'subscription-payment-disputed'],
    ['credit_note.created', { id: 'cn_domains', object: 'credit_note', invoice: 'in_fixture' }, 'stripeCreditNoteInvoiceId', 'subscription-current-invoice-credit-note-unsupported'],
  ]) for (const invalid of [42, {}, '', []]) {
    const f = await fixture(); assert.equal((await f.resolve()).admitted, true);
    await f.ingest(f.event('evt_relation_domain', type, object)); assert.equal((await f.resolve()).reason, expected);
    const record = f.rows.find(row => row.record.stripeEventId === 'evt_relation_domain').record;
    record[field] = invalid;
    const result = await f.resolve(); assert.equal(result.admitted, false, `${field}: ${JSON.stringify(invalid)}`);
    assert.equal(result.reason, 'subscription-event-journal-incomplete');
    assert.equal(originalService.isCompleteEventReceipt(record), false);
  }
});

test('non-native status values cannot hide a retained canceled subscription', async () => {
  for (const invalid of [42, {}, '', []]) {
    const f = await fixture();
    await f.ingest(f.event('evt_canceled_domain', 'customer.subscription.updated', { ...copy(f.objects.subscription), status: 'canceled' }));
    assert.equal((await f.resolve()).reason, 'subscription-revoked-by-verified-event');
    const record = f.rows.find(row => row.record.stripeEventId === 'evt_canceled_domain').record;
    record.status = invalid;
    const result = await f.resolve(); assert.equal(result.admitted, false, JSON.stringify(invalid));
    assert.equal(result.reason, 'subscription-event-journal-incomplete');
  }
});
