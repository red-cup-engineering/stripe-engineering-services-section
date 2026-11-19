/**
 * Read-only, provider-native Stripe balance reconciliation. Uses snapshots
 * from the original Stripe API; no new checkout, webhook, store or ledger.
 * Figures are processor movements, NOT a legal-entity revenue attribution,
 * independently received bank cash, customer acceptance or operating margin.
 * https://docs.stripe.com/api/balance_transactions/object
 * https://docs.stripe.com/reports/balance
 */
const SERIES = ['balanceTransactions', 'charges', 'payouts', 'checkoutSessions'];
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function minor(n) {
  if (!Number.isSafeInteger(n)) throw new TypeError('Money must be safe integer minor units');
  return n;
}
function add(a, b) {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new RangeError('Unsafe aggregated minor units');
  return n;
}
function utc(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s)
      || !Number.isFinite(Date.parse(s))
      || new Date(Date.parse(s)).toISOString().slice(0, 19) !== s.slice(0, 19))
    throw new TypeError('Period requires real explicit UTC ISO timestamps');
  return Date.parse(s) / 1000;
}
function selectPage(name, page, from, until, currency) {
  if (!isObject(page) || !Array.isArray(page.data) || typeof page.has_more !== 'boolean')
    throw new TypeError(name + ': actual list data and has_more required');
  const ids = new Set();
  let previous = Infinity;
  for (const r of page.data) {
    if (!isObject(r) || typeof r.id !== 'string' || !r.id || ids.has(r.id))
      throw new TypeError(name + ': duplicate/missing source identity');
    ids.add(r.id);
    if (!Number.isSafeInteger(r.created) || r.created < 0 || r.created > previous)
      throw new TypeError(name + ': invalid / non-descending created timestamp');
    if (typeof r.currency !== 'string' && name !== 'checkoutSessions')
      throw new TypeError(name + ': provider currency missing');
    previous = r.created;
  }
  // A Checkout Session with unknown currency must not silently disappear from
  // a requested currency's unpaid count and appear as complete zero exposure.
  const unknownCurrencyRows = name === 'checkoutSessions' ? page.data.filter(
    r => r.created >= from && r.created < until && typeof r.currency !== 'string').length : 0;
  const complete = (!page.has_more || (page.data.length > 0 && previous < from))
    && unknownCurrencyRows === 0;
  return {
    coverage: { complete, hasMore: page.has_more, observedRows: page.data.length,
      unknownCurrencyRows, olderThanWindowWitness: page.data.length > 0 && previous < from },
    rows: page.data.filter(r => r.created >= from && r.created < until && r.currency === currency),
  };
}
function category(r) {
  if (r.type === 'stripe_fee') return 'providerFee';
  const t = r.reporting_category || r.type;
  if (t === 'charge') return 'charge';
  if (t === 'refund' || t === 'payment_refund') return 'refund';
  if (t === 'payout') return 'payout';
  if (t === 'fee') return 'providerFee';
  return 'other';
}
const newBucket = () => ({ count: 0, grossCents: 0, feeCents: 0, netCents: 0 });
/**
 * input: { accountId, livemode, currency, observedAt, from, until,
 *          pages: { balanceTransactions, charges, payouts, checkoutSessions } }
 * All four pages are the actual Stripe list responses. The exclusive 'until'
 * must be no later than the observation. Pagination must extend before 'from'
 * or end, else monetary totals are null (unknown, not zero).
 */
export function readStripeProviderBalance(input) {
  if (!isObject(input) || !/^acct_[A-Za-z0-9]+$/.test(input.accountId || '')
      || typeof input.livemode !== 'boolean' || !/^[a-z]{3}$/.test(input.currency || ''))
    throw new TypeError('Source account, live mode and exact currency required');
  const observed = utc(input.observedAt), from = utc(input.from), until = utc(input.until);
  if (from >= until || until > observed) throw new TypeError('Window exceeds read-only observation');
  if (!isObject(input.pages) || SERIES.some(n => !isObject(input.pages[n])))
    throw new TypeError('Four actual provider list pages required');
  const pages = Object.fromEntries(SERIES.map(n =>
    [n, selectPage(n, input.pages[n], from, until, input.currency)]));
  const coverage = Object.fromEntries(SERIES.map(n => [n, pages[n].coverage]));
  const fullyCovered = SERIES.every(n => coverage[n].complete);
  const result = {
    type: 'StripeProviderBalanceReadout/v1',
    provider: 'stripe', accountIdClaimedByReader: input.accountId,
    livemode: input.livemode, currency: input.currency, observedAt: input.observedAt,
    from: input.from, until: input.until, coverage, fullyCovered,
    source: 'Stripe provider list snapshots; never a financial ledger write',
    legalPayee: 'unverified', groupCorporateCash: 'unverified',
    bankCredit: 'unobserved', customerAcceptedDelivery: 'unobserved',
    recognizedRevenueCents: null, netOperatingMarginCents: null,
    financial: null, corroboration: null, unpaidCheckout: null,
  };
  if (!fullyCovered) return result;
  const b = pages.balanceTransactions.rows, charges = pages.charges.rows,
    payouts = pages.payouts.rows, sessions = pages.checkoutSessions.rows;
  const buckets = {charge: newBucket(), refund: newBucket(), payout: newBucket(),
    providerFee: newBucket(), other: newBucket()};
  let netBalanceChangeCents = 0, nonAvailableLedgerCount = 0;
  for (const r of b) {
    minor(r.amount); minor(r.fee); minor(r.net);
    if (r.net !== r.amount - r.fee)
      throw new TypeError('Balance transaction amount - fee != net: ' + r.id);
    if (typeof r.type !== 'string' || typeof r.status !== 'string')
      throw new TypeError('Balance transaction type/status missing');
    const group = category(r), bucket = buckets[group];
    if (group === 'charge' && (r.amount <= 0 || r.fee < 0))
      throw new TypeError('Charge gross/fee sign invalid');
    if (['refund', 'payout'].includes(group) && r.amount >= 0)
      throw new TypeError('Refund/payout must debit provider balance');
    if (group === 'providerFee' && r.amount > 0)
      throw new TypeError('Processor fee cannot create sales income');
    bucket.count++;
    bucket.grossCents = add(bucket.grossCents, r.amount);
    bucket.feeCents = add(bucket.feeCents, r.fee);
    bucket.netCents = add(bucket.netCents, r.net);
    netBalanceChangeCents = add(netBalanceChangeCents, r.net);
    if (r.status !== 'available') nonAvailableLedgerCount++;
  }
  const processorChargesAfterFeesAndRefundsCents = add(
    add(buckets.charge.netCents, buckets.refund.netCents), buckets.providerFee.netCents);
  if (add(add(processorChargesAfterFeesAndRefundsCents, buckets.other.netCents),
      buckets.payout.netCents) !== netBalanceChangeCents)
    throw new TypeError('Balance source categories do not sum');
  const paidCharges = charges.filter(c => c.status === 'succeeded' && c.paid === true);
  const paidPayouts = payouts.filter(p => p.status === 'paid');
  const ledgerCharges = b.filter(r => category(r) === 'charge');
  const ledgerPayouts = b.filter(r => category(r) === 'payout');
  const mismatchedCharges = paidCharges.filter(c =>
    !ledgerCharges.some(r => r.source === c.id && r.amount === c.amount
      && r.currency === c.currency && Number.isSafeInteger(c.amount) && c.amount > 0)).map(c => c.id);
  const unmatchedLedgerCharges = ledgerCharges.filter(r =>
    !paidCharges.some(c => c.id === r.source)).map(r => r.id);
  const mismatchedPayouts = paidPayouts.filter(p =>
    !ledgerPayouts.some(r => r.source === p.id && r.amount === -p.amount
      && r.currency === p.currency && Number.isSafeInteger(p.amount) && p.amount >= 0)).map(p => p.id);
  const unmatchedLedgerPayouts = ledgerPayouts.filter(r =>
    !paidPayouts.some(p => p.id === r.source)).map(r => r.id);
  const providerReportedPaidPayoutCents = paidPayouts.reduce((n,p) =>
    add(n, minor(p.amount)), 0);
  const unpaid = sessions.filter(s => s.status === 'open' && s.payment_status === 'unpaid');
  const knownUnpaid = unpaid.filter(s => Number.isSafeInteger(s.amount_total) && s.amount_total >= 0);
  result.financial = {
    buckets, netBalanceChangeCents,
    grossChargeCents: buckets.charge.grossCents,
    chargeProcessorFeeCents: buckets.charge.feeCents,
    separateStripeFeeBalanceCents: buckets.providerFee.netCents,
    refundBalanceCents: buckets.refund.netCents,
    processorChargesAfterFeesAndRefundsCents,
    otherMovementCents: buckets.other.netCents,
    payoutLedgerCents: buckets.payout.netCents,
    providerReportedPaidPayoutCents,
  };
  result.corroboration = {
    chargedCount: paidCharges.length, paidPayoutCount: paidPayouts.length,
    mismatchedCharges, unmatchedLedgerCharges,
    mismatchedPayouts, unmatchedLedgerPayouts, nonAvailableLedgerCount,
    providerMovementReconciled:
      mismatchedCharges.length === 0 && unmatchedLedgerCharges.length === 0
      && mismatchedPayouts.length === 0 && unmatchedLedgerPayouts.length === 0
      && nonAvailableLedgerCount === 0 && buckets.other.netCents === 0,
  };
  result.unpaidCheckout = {
    openUnpaidCount: unpaid.length, amountKnownCount: knownUnpaid.length,
    openUnpaidAmountCents: knownUnpaid.reduce((n,s) => add(n, s.amount_total), 0),
    countedAsPaidCents: 0,
  };
  return result;
}
