import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripeMetroplatApplication, stripeMetroplatOperations } from '../src/metroplat.mjs';

const merchant = 'emsenn';
const allowedReturnOrigins = ['https://shop.561.group/'];
const request = {
  offeringId: 'stripe-integration-smoke-test', customerReference: 'order-typed-1',
  successUrl: 'https://shop.561.group/thanks', cancelUrl: 'https://shop.561.group/cancel',
  quantity: 1,
};
const subject = 'urn:561:actor:buyer-one';
const context = (actor = subject) => ({ invocation: { subject: actor } });
const call = (operations, verb, input, actor = subject) =>
  operations.find(item => item.verb === verb).execute(input, {}, context(actor));
const make = (t, config = {}, extra = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'stripe-metroplat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return stripeMetroplatOperations({ dataRoot: root }, {
    configuration: { merchant, allowedReturnOrigins, ...config },
    environment: { STRIPE_SECRET_KEY: 'sk_test_local-only-fixture', ...extra.environment },
    ...(extra.fetchImpl === undefined ? {} : { fetchImpl: extra.fetchImpl }),
  });
};

test('exports an installable native app and typed operations', t => {
  assert.equal(stripeMetroplatApplication.kind, 'metroplat.application/v1');
  const operations = make(t);
  assert.deepEqual(operations.map(x => x.verb), [
    'stripe-checkout-readiness', 'stripe-checkout-solicit', 'stripe-checkout-invoke',
  ]);
  assert.equal(operations[2].effects.class, 'external');
  assert.equal(operations[2].effects.replay, 'idempotency-key');
  assert.equal(operations[2].effects.coordination, 'coordination-required');
  assert.ok(operations.every(x => x.domain && x.codomain));
});

test('requires host custody and exact merchant; never admits instance secrets', () => {
  const binding = { dataRoot: '/tmp/stripe-mount-fixture' };
  const options = configuration => ({ configuration, environment: {} });
  assert.throws(() => stripeMetroplatOperations(null, options({ merchant })), /data root/);
  assert.throws(() => stripeMetroplatOperations(binding, options({})), /legal merchant/);
  assert.throws(() => stripeMetroplatOperations(binding, options({ merchant: '561 Group' })), /must belong/);
  assert.throws(() => stripeMetroplatOperations(binding, options({ merchant, STRIPE_SECRET_KEY: 'sk_live_not_for_instance_json' })), /configuration accepts only/);
  assert.throws(() => stripeMetroplatOperations(binding, options({ merchant, allowedReturnOrigins: ['http://evil.test/'] })), /HTTPS origin/);
  assert.throws(() => stripeMetroplatOperations(binding, options({ merchant, allowLiveCheckout: 'yes' })), /boolean/);
});

test('readiness never returns credential material or claims live payment', t => {
  const secret = 'sk_test_do_not_reveal_this_key';
  const operations = make(t, {}, { environment: { STRIPE_SECRET_KEY: secret } });
  const status = call(operations, 'stripe-checkout-readiness', {});
  assert.equal(status.type, 'StripePaymentAcceptanceReadiness');
  assert.equal(status.credential.recognizedMode, 'test');
  assert.equal(status.metroplat.merchant, merchant);
  assert.equal(status.liveReady, false);
  assert.doesNotMatch(JSON.stringify(status), /sk_test_do_not_reveal_this_key/);
});

test('the solicitation binds the actual MetroPlat subject, not a user-supplied actor', t => {
  const operations = make(t);
  const result = call(operations, 'stripe-checkout-solicit', request);
  assert.equal(result.type, 'Offer');
  assert.equal(result.target, subject);
  assert.equal(result.object.offering.id, request.offeringId);
  assert.equal(call(operations, 'stripe-checkout-solicit', request, null).reason, 'authenticated-metroplat-subject-required');
});

test('return origins and caller-supplied prices refuse', t => {
  const operations = make(t);
  assert.equal(call(operations, 'stripe-checkout-solicit', { ...request, successUrl: 'https://untrusted.example/thanks' }).reason, 'checkout-return-origin-not-admitted');
  assert.equal(call(operations, 'stripe-checkout-solicit', { ...request, cancelUrl: 'https://untrusted.example/cancel' }).reason, 'checkout-return-origin-not-admitted');
  assert.throws(() => call(operations, 'stripe-checkout-solicit', { ...request, unitAmount: 1 }));
});

test('a stolen offer cannot change actors or create a checkout session', async t => {
  let calls = 0;
  const operations = make(t, {}, { fetchImpl: async (_url, opts) => {
    calls++;
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['Idempotency-Key'].startsWith('checkout-'), true);
    return { ok: true, status: 200, json: async () => ({
      id: 'cs_test_metroplat', url: 'https://checkout.stripe.com/c/pay/test',
      amount_total: 100, currency: 'usd', payment_status: 'unpaid', status: 'open',
    }) };
  } });
  const offered = call(operations, 'stripe-checkout-solicit', request);
  assert.equal(offered.type, 'Offer');
  const switched = await call(operations, 'stripe-checkout-invoke', { offer: offered }, 'urn:561:actor:other-buyer');
  assert.equal(switched.reason, 'stripe-offer-actor-or-redirect-not-admitted');
  assert.equal(calls, 0);
  const accepted = await call(operations, 'stripe-checkout-invoke', { offer: offered });
  assert.equal(accepted.type, 'Accept');
  assert.equal(accepted.object.stripeSessionId, 'cs_test_metroplat');
  assert.equal(calls, 1);
});

test('read-only provider balance power requires deliberate merchant scope and authenticated actor', async t => {
  assert.throws(() => make(t, {enableProviderBalanceReadout: true}), /exact original merchant account/);
  assert.throws(() => make(t, {enableProviderBalanceReadout: 'yes'}), /must be boolean/);
  let reads = 0;
  const ops = make(t, {
    enableProviderBalanceReadout: true, providerBalanceAccountId: 'acct_Source123',
  }, {fetchImpl: async (url, options) => {
    reads++;
    assert.equal(options.method, 'GET');
    assert.equal(new URL(url).origin, 'https://api.stripe.com');
    const data = new URL(url).pathname === '/v1/account'
      ? {object: 'account', id: 'acct_Source123'} : {data: [], has_more: false};
    return {ok: true, json: async () => data};
  }});
  assert.equal(ops.at(-1).verb, 'stripe-provider-balance-read');
  const read = {from: '2026-10-21T00:00:00Z', until: '2026-10-22T00:00:00Z', currency: 'usd'};
  const denied = await call(ops, 'stripe-provider-balance-read', read, null);
  assert.equal(denied.reason, 'authenticated-metroplat-subject-required');
  assert.equal(reads, 0, 'unheld / unauthenticated actor causes no Stripe request');
  const accepted = await call(ops, 'stripe-provider-balance-read', read);
  assert.equal(accepted.type, 'StripeProviderBalanceReadout/v1');
  assert.equal(accepted.accountIdentity, 'provider-verified-self-account');
  assert.equal(accepted.recognizedRevenueCents, null);
  assert.equal(accepted.bankCredit, 'unobserved');
  assert.equal(reads, 5, 'four read-only list calls after exact own-account proof');
});

test('mounting a live key does not authorize live checkout', t => {
  let calls = 0;
  const operations = make(t, {}, { environment: { STRIPE_SECRET_KEY: 'rk_live_fixture_not_a_real_key' }, fetchImpl: async () => { calls++; throw Error('should not call'); } });
  assert.equal(call(operations, 'stripe-checkout-solicit', request).reason, 'stripe-live-checkout-not-enabled-by-instance');
  assert.equal(call(operations, 'stripe-checkout-invoke', { offer: { type: 'Offer', target: subject } }).reason, 'stripe-live-checkout-not-enabled-by-instance');
  assert.equal(calls, 0);
});
