// Internal implementation of the original Stripe service's read-only billing
// evidence boundary. Public callers use resolveSubscriptionAccess in service.mjs.
// No provider write, access policy, customer ledger or entitlement is created.
export const SUBSCRIPTION_READ_API_VERSION = '2025-03-31.basil';
const CHECKOUT_CATEGORY = 'stripe-checkout-session-creation.receipts';
const EVENT_CATEGORY = 'stripe-webhook-event-admission.events';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const bindingFields = ['requestDigest', 'offeringId', 'customerSettlement'];
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const reference = (value, prefix) => {
  const id = typeof value === 'object' && value !== null ? value.id : value;
  return typeof id === 'string' && id.length <= 200 && new RegExp(`^${prefix}_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$`, 'u').test(id) ? id : null;
};
const completeSingle = value => value?.object === 'list' && value.has_more === false && Array.isArray(value.data) && value.data.length === 1;
class Refusal extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const requireEvidence = (condition, reason) => { if (!condition) throw new Refusal(reason); };

function withinBudget(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = callback => value => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => settle(reject)(new Refusal('subscription-observation-timeout'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(settle(resolve), settle(reject));
  });
}

async function readJson(response) {
  requireEvidence(response?.ok === true, 'stripe-subscription-provider-refusal');
  requireEvidence(response.body?.getReader, 'stripe-subscription-provider-invalid-response');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Refusal('stripe-subscription-provider-response-too-large');
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } finally { reader.releaseLock(); }
}

async function journal(store, category, limit, isCompleteEventReceipt) {
  let rows;
  try { rows = await store.query({ category, limit: limit + 1, strict: true }); }
  catch { throw new Refusal('subscription-evidence-journal-unavailable'); }
  requireEvidence(Array.isArray(rows) && rows.length <= limit, 'subscription-evidence-journal-incomplete-or-too-large');
  requireEvidence(rows.every(row => row?.record && typeof row.record === 'object'), 'subscription-evidence-journal-invalid');
  if (category === EVENT_CATEGORY) requireEvidence(rows.every(row => isCompleteEventReceipt(row.record)),
    'subscription-event-journal-incomplete');
  return rows.map(row => row.record);
}

function selectCheckout(receipts, binding, catalog, digest) {
  const rows = receipts.filter(row => row.type === 'StripeCheckoutSessionReceipt' && row.requestDigest === binding.requestDigest);
  requireEvidence(rows.length > 0, 'original-checkout-receipt-required');
  requireEvidence(rows.every(row => row.customerSettlement === binding.customerSettlement && row.offeringId === binding.offeringId &&
    row.stripeMode === 'live' && row.legalMerchant === catalog.merchant?.legalBody), 'original-checkout-binding-conflict');
  const identities = rows.map(row => ({ stripeSessionId: row.stripeSessionId, requestDigest: row.requestDigest,
    customerSettlement: row.customerSettlement, offeringId: row.offeringId, legalMerchant: row.legalMerchant, stripeMode: row.stripeMode }));
  requireEvidence(new Set(identities.map(digest)).size === 1, 'original-checkout-session-ambiguous');
  requireEvidence(reference(rows[0].stripeSessionId, 'cs'), 'original-checkout-session-invalid');
  return rows[0];
}

function inspectEvents(events, binding, eventReceiptsAgree, providerIds = {}) {
  const related = events.filter(row => row.signatureVerified === true && row.livemode === true && (
    row.subscriptionId === binding.subscriptionId || row.stripeObjectId === binding.subscriptionId ||
    row.requestDigest === binding.requestDigest || row.stripeSubscriptionIdsObserved?.includes(binding.subscriptionId) ||
    [providerIds.invoiceId, providerIds.chargeId].filter(Boolean).includes(row.stripeObjectId) ||
    (providerIds.chargeId && row.stripeChargeId === providerIds.chargeId) ||
    (providerIds.invoiceId && row.stripeCreditNoteInvoiceId === providerIds.invoiceId) ||
    (providerIds.paymentIntentId && row.paymentIntentId === providerIds.paymentIntentId)));
  const relatedIds = new Set(related.map(row => row.stripeEventId));
  const identityRows = events.filter(row => row.signatureVerified === true && relatedIds.has(row.stripeEventId));
  const first = new Map();
  for (const row of identityRows) {
    requireEvidence(row.conflict !== true && (!first.has(row.stripeEventId) || eventReceiptsAgree(first.get(row.stripeEventId), row)), 'subscription-event-conflict');
    first.set(row.stripeEventId, row);
  }
  requireEvidence(!related.some(row => row.subscriptionBindingStatus === 'conflicting'), 'subscription-event-conflict');
  requireEvidence(!related.some(row => bindingFields.some(field => row[field] != null && row[field] !== binding[field]) ||
    (row.subscriptionId != null && row.subscriptionId !== binding.subscriptionId)), 'subscription-event-binding-conflict');
  requireEvidence(!related.some(row => row.eventType === 'customer.subscription.deleted' ||
    (row.stripeObjectId === binding.subscriptionId && row.status === 'canceled')), 'subscription-revoked-by-verified-event');
  requireEvidence(!related.some(row => row.eventType === 'charge.refunded' && row.stripeObjectId === providerIds.chargeId), 'subscription-payment-refunded');
  requireEvidence(!related.some(row => row.eventType?.startsWith('charge.dispute.') && row.stripeChargeId === providerIds.chargeId),
    'subscription-payment-disputed');
  requireEvidence(!related.some(row => row.eventType?.startsWith('credit_note.') && row.stripeCreditNoteInvoiceId === providerIds.invoiceId),
    'subscription-current-invoice-credit-note-unsupported');
  const bound = related.filter(row => row.type === 'StripeWebhookEventReceipt' && row.supported === true &&
    row.subscriptionBindingStatus === 'bound' && row.subscriptionId === binding.subscriptionId &&
    bindingFields.every(field => row[field] === binding[field]));
  requireEvidence(bound.length > 0, 'verified-original-subscription-binding-required');
  return [...new Set(bound.map(row => row.stripeEventId))].sort();
}

function requireBinding(projection, binding) {
  requireEvidence(projection.subscriptionBindingStatus === 'bound' && projection.subscriptionId === binding.subscriptionId &&
    bindingFields.every(field => projection[field] === binding[field]), 'provider-subscription-binding-conflict');
}

function inspectSubscription(subscription, binding, offering, at, projectEvent) {
  requireEvidence(subscription?.object === 'subscription' && subscription.id === binding.subscriptionId && subscription.livemode === true,
    'provider-subscription-identity-invalid');
  requireBinding(projectEvent({ type: 'customer.subscription.updated', data: { object: subscription } }), binding);
  requireEvidence(subscription.status === 'active' && subscription.ended_at === null && subscription.pause_collection === null &&
    subscription.pending_update === null, 'subscription-not-currently-active');
  requireEvidence(completeSingle(subscription.items), 'subscription-items-not-single-and-complete');
  const item = subscription.items.data[0], price = item?.price;
  requireEvidence(reference(item?.id, 'si') && reference(item.subscription, 'sub') === subscription.id && reference(price?.id, 'price') &&
    reference(price?.product, 'prod') && price.object === 'price' && price.livemode === true && price.type === 'recurring' &&
    price.billing_scheme === 'per_unit' && price.transform_quantity == null && price.currency === offering.currency &&
    price.unit_amount === offering.unitAmount && price.recurring?.interval === offering.recurring.interval &&
    price.recurring?.interval_count === (offering.recurring.intervalCount ?? 1) && price.recurring?.usage_type === 'licensed' &&
    Number.isSafeInteger(item.quantity) && item.quantity >= offering.quantity.minimum && item.quantity <= offering.quantity.maximum,
  'subscription-item-does-not-match-original-offering');
  const start = item.current_period_start, end = item.current_period_end;
  requireEvidence(integer(start) && integer(end) && start < end, 'subscription-item-period-invalid');
  requireEvidence(typeof subscription.cancel_at_period_end === 'boolean' &&
    (subscription.cancel_at === null || integer(subscription.cancel_at)), 'subscription-cancellation-state-invalid');
  const expires = subscription.cancel_at === null ? end : Math.min(end, subscription.cancel_at);
  requireEvidence(start <= at && at < expires, 'subscription-paid-period-not-current');
  const customer = reference(subscription.customer, 'cus'), invoiceId = reference(subscription.latest_invoice, 'in');
  requireEvidence(customer && invoiceId, 'subscription-current-customer-or-invoice-missing');
  return { subscriptionId: subscription.id, customer, invoiceId, itemId: item.id, priceId: price.id,
    productId: reference(price.product, 'prod'), quantity: item.quantity, currency: price.currency, unitAmount: price.unit_amount,
    interval: price.recurring.interval, intervalCount: price.recurring.interval_count, start, end, expires,
    cancelAtPeriodEnd: subscription.cancel_at_period_end, cancelAt: subscription.cancel_at };
}

function inspectInvoice(invoice, state, binding, projectEvent) {
  requireEvidence(invoice?.object === 'invoice' && invoice.id === state.invoiceId && invoice.livemode === true &&
    reference(invoice.customer, 'cus') === state.customer, 'provider-invoice-identity-invalid');
  requireBinding(projectEvent({ type: 'invoice.paid', data: { object: invoice } }), binding);
  requireEvidence(invoice.status === 'paid' && integer(invoice.amount_paid) && invoice.amount_paid > 0 &&
    invoice.amount_remaining === 0 && invoice.amount_due === invoice.amount_paid && invoice.total === invoice.amount_paid &&
    invoice.currency === state.currency && invoice.starting_balance === 0 && invoice.post_payment_credit_notes_amount === 0 &&
    invoice.pre_payment_credit_notes_amount === 0 && ['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason),
  'invoice-is-not-an-uncredited-paid-subscription-period');
  requireEvidence(completeSingle(invoice.lines), 'invoice-lines-not-single-and-complete');
  const line = invoice.lines.data[0], parent = line?.parent?.subscription_item_details;
  requireEvidence(line?.object === 'line_item' && reference(line.id, 'il') && line.livemode === true &&
    line.parent?.type === 'subscription_item_details' && reference(parent?.subscription, 'sub') === binding.subscriptionId &&
    reference(parent?.subscription_item, 'si') === state.itemId && parent?.proration === false &&
    line.pricing?.type === 'price_details' && reference(line.pricing.price_details?.price, 'price') === state.priceId &&
    reference(line.pricing.price_details?.product, 'prod') === state.productId && line.quantity === state.quantity &&
    line.currency === state.currency && integer(line.amount) && line.amount > 0 &&
    line.period?.start === state.start && line.period?.end === state.end,
  'invoice-line-does-not-fund-current-subscription-item');
  return { invoiceId: invoice.id, invoiceLineId: line.id, amountPaid: invoice.amount_paid, currency: invoice.currency };
}

function inspectPayment(payments, invoice, state) {
  requireEvidence(completeSingle(payments), 'invoice-payments-not-single-and-complete');
  const payment = payments.data[0];
  requireEvidence(payment?.object === 'invoice_payment' && reference(payment.id, 'inpay') && payment.livemode === true &&
    reference(payment.invoice, 'in') === invoice.invoiceId && payment.status === 'paid' &&
    payment.amount_paid === invoice.amountPaid && payment.currency === state.currency && payment.payment?.type === 'payment_intent' &&
    reference(payment.payment.payment_intent, 'pi'), 'invoice-payment-is-not-provider-funded');
  return { invoicePaymentId: payment.id, paymentIntentId: reference(payment.payment.payment_intent, 'pi') };
}

function inspectCharge(intent, payment, invoice, state) {
  requireEvidence(intent?.object === 'payment_intent' && intent.id === payment.paymentIntentId && intent.livemode === true &&
    intent.status === 'succeeded' && intent.amount_received === invoice.amountPaid && intent.currency === state.currency &&
    reference(intent.customer, 'cus') === state.customer, 'subscription-payment-intent-not-paid');
  const charge = intent.latest_charge;
  requireEvidence(charge?.object === 'charge' && reference(charge.id, 'ch') && charge.livemode === true &&
    reference(charge.payment_intent, 'pi') === intent.id && reference(charge.customer, 'cus') === state.customer &&
    charge.status === 'succeeded' && charge.paid === true && charge.captured === true && charge.currency === state.currency &&
    charge.amount === invoice.amountPaid && charge.amount_captured === invoice.amountPaid,
  'subscription-current-charge-not-qualified');
  requireEvidence(charge.refunded === false && charge.amount_refunded === 0 && charge.disputed === false, 'subscription-payment-refunded-or-disputed');
  return charge.id;
}

/** Receives only host-owned dependencies from service.mjs. No request body can
 * supply a credential, a store, an actor mapping or an offering scope. */
export async function resolveCurrentSubscriptionBilling(input, context) {
  const { key, catalog, store, digest, projectEvent, eventReceiptsAgree, isCompleteEventReceipt, validateLiveOffering, options } = context;
  const started = performance.now();
  let timer;
  try {
    const binding = { subscriptionId: input?.subscriptionId, requestDigest: input?.requestDigest,
      offeringId: input?.offeringId, customerSettlement: input?.authenticatedActor };
    requireEvidence(reference(binding.subscriptionId, 'sub') && nonempty(binding.offeringId) && nonempty(binding.customerSettlement) &&
      typeof binding.requestDigest === 'string' && /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(binding.requestDigest), 'invalid-host-subscription-binding');
    requireEvidence(/^(sk|rk)_live_/u.test(key), 'live-stripe-read-credential-required');
    const expectedAccountId = options.expectedAccountId;
    requireEvidence(reference(expectedAccountId, 'acct'), 'host-stripe-account-binding-required');
    const limit = options.maxJournalRecords ?? 10000, timeoutMs = options.timeoutMs ?? 10000;
    requireEvidence(Number.isSafeInteger(limit) && limit > 0 && limit <= 100000 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000,
      'invalid-subscription-observation-bounds');
    const now = options.now ?? new Date(), nowMs = now instanceof Date ? now.getTime() : NaN;
    requireEvidence(Number.isFinite(nowMs), 'invalid-subscription-observation-time');
    const at = Math.floor(nowMs / 1000);
    const offerings = catalog?.offerings?.filter(value => value.id === binding.offeringId) ?? [];
    requireEvidence(offerings.length === 1 && offerings[0].mode === 'subscription' && validateLiveOffering(offerings[0]).valid &&
      nonempty(catalog.merchant?.legalBody), 'original-recurring-offering-not-qualified');
    const offering = offerings[0];
    const remaining = timeoutMs - (performance.now() - started);
    requireEvidence(remaining > 0, 'subscription-observation-timeout');
    const controller = new AbortController(), signal = controller.signal;
    timer = setTimeout(() => controller.abort(), Math.ceil(remaining));
    const boundedJournal = name => withinBudget(() => journal(store, name, limit, isCompleteEventReceipt), signal);
    const receipts = await boundedJournal(CHECKOUT_CATEGORY);
    const receipt = selectCheckout(receipts, binding, catalog, digest);
    inspectEvents(await boundedJournal(EVENT_CATEGORY), binding, eventReceiptsAgree);
    const fetchImpl = options.fetchImpl ?? fetch;
    const get = (path, parameters = {}) => withinBudget(async () => {
      signal.throwIfAborted();
      const url = new URL(path, 'https://api.stripe.com');
      for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', cache: 'no-store', signal,
        headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': SUBSCRIPTION_READ_API_VERSION, Accept: 'application/json' } });
      return readJson(response);
    }, signal);
    const account = await get('/v1/account');
    requireEvidence(account?.object === 'account' && account.id === expectedAccountId, 'stripe-provider-account-mismatch');
    const checkout = await get(`/v1/checkout/sessions/${encodeURIComponent(receipt.stripeSessionId)}`);
    requireEvidence(checkout?.object === 'checkout.session' && checkout.id === receipt.stripeSessionId && checkout.livemode === true &&
      checkout.mode === 'subscription' && checkout.status === 'complete' && reference(checkout.subscription, 'sub') === binding.subscriptionId,
    'current-checkout-does-not-bind-subscription');
    requireBinding(projectEvent({ type: 'checkout.session.completed', data: { object: checkout } }), binding);
    const subscription = await get(`/v1/subscriptions/${encodeURIComponent(binding.subscriptionId)}`);
    const state = inspectSubscription(subscription, binding, offering, at, projectEvent);
    requireEvidence(reference(checkout.customer, 'cus') === state.customer, 'checkout-subscription-customer-mismatch');
    const invoice = inspectInvoice(await get(`/v1/invoices/${encodeURIComponent(state.invoiceId)}`), state, binding, projectEvent);
    const payment = inspectPayment(await get('/v1/invoice_payments', { invoice: invoice.invoiceId, limit: '2' }), invoice, state);
    const chargeId = inspectCharge(await get(`/v1/payment_intents/${encodeURIComponent(payment.paymentIntentId)}`, { 'expand[]': 'latest_charge' }), payment, invoice, state);
    const confirmed = inspectSubscription(await get(`/v1/subscriptions/${encodeURIComponent(binding.subscriptionId)}`), binding, offering, at, projectEvent);
    requireEvidence(digest(confirmed) === digest(state), 'subscription-changed-during-observation');
    const eventIds = inspectEvents(await boundedJournal(EVENT_CATEGORY), binding, eventReceiptsAgree, { ...payment, ...invoice, chargeId });
    const elapsed = performance.now() - started, observedMs = nowMs + Math.ceil(elapsed);
    requireEvidence(elapsed <= timeoutMs && !signal.aborted, 'subscription-observation-timeout');
    requireEvidence(observedMs < state.expires * 1000, 'subscription-paid-period-not-current');
    const basis = { type: 'StripeSubscriptionBillingBasis', stripeAccountId: expectedAccountId, legalMerchant: receipt.legalMerchant,
      ...binding, stripeSessionId: receipt.stripeSessionId, stripeSubscriptionItemId: state.itemId, stripePriceId: state.priceId,
      stripeProductId: state.productId, stripeInvoiceId: invoice.invoiceId, stripeInvoiceLineId: invoice.invoiceLineId,
      stripeInvoicePaymentId: payment.invoicePaymentId, stripePaymentIntentId: payment.paymentIntentId, stripeChargeId: chargeId,
      amountPaid: invoice.amountPaid, currency: invoice.currency, quantity: state.quantity,
      interval: state.interval, intervalCount: state.intervalCount, notBefore: new Date(state.start * 1000).toISOString(),
      expiresAt: new Date(state.expires * 1000).toISOString(), cancelAtPeriodEnd: state.cancelAtPeriodEnd, cancelAt: state.cancelAt };
    return { ...basis, type: 'StripeSubscriptionBillingEvidence', admitted: true, billingStatus: 'paid-current-period',
      billingRevision: digest(basis), observedAt: new Date(observedMs).toISOString(),
      stripeApiVersion: SUBSCRIPTION_READ_API_VERSION, verifiedEventIds: eventIds,
      authority: 'billing-evidence-only; host-authentication-and-product-scope-required', secretRecorded: false, buyerPersonalDataRecorded: false };
  } catch (error) {
    return { type: 'StripeSubscriptionBillingRefusal', admitted: false,
      reason: error instanceof Refusal ? error.reason : 'stripe-subscription-observation-unavailable' };
  } finally { clearTimeout(timer); }
}
