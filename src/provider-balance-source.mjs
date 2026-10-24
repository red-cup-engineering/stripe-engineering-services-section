/**
 * Credential-bound read-only Stripe provider observation in the original Stripe
 * application. GET only, never raw buyer records or payment secrets.
 */
import {readStripeProviderBalance} from './provider-balance-readout.mjs';

const ENDPOINTS = Object.freeze({
  balanceTransactions: '/v1/balance_transactions',
  charges: '/v1/charges',
  payouts: '/v1/payouts',
  checkoutSessions: '/v1/checkout/sessions',
});
const refusal = reason => Object.freeze({type:'StripeProviderBalanceRefusal', reason});
const validUtc = v => typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v.slice(0, -1) + '.000Z';
const modeOf = key => /^(sk|rk)_live_/.test(key) ? 'live'
  : /^(sk|rk)_test_/.test(key) ? 'test' : null;

/** Account is read from Stripe's own credential, never a caller's assertion. */
export async function observeStripeProviderBalance({
  key, expectedAccountId, from, until, currency, observedAt,
  fetchImpl = fetch, maxPages = 4,
} = {}) {
  const mode = modeOf(key);
  if (!mode) return refusal('merchant-read-credential-unavailable');
  if (!/^acct_[A-Za-z0-9]+$/.test(expectedAccountId || ''))
    return refusal('exact-merchant-account-required');
  if (!/^[a-z]{3}$/.test(currency || '') || !validUtc(from) ||
      !validUtc(until) || !validUtc(observedAt) ||
      !(Date.parse(from) < Date.parse(until) && Date.parse(until) <= Date.parse(observedAt)))
    return refusal('invalid-observation-window');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10)
    return refusal('unsafe-provider-page-budget');
  const requestOptions = {method:'GET',headers:{Authorization:'Bearer ' + key}};
  async function get(path, query) {
    const u = new URL(path, 'https://api.stripe.com');
    for (const [name, value] of Object.entries(query || {})) u.searchParams.set(name, String(value));
    try {
      const response = await fetchImpl(u.toString(), requestOptions);
      if (!response?.ok) return null;
      const data = await response.json();
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch { return null; }
  }
  const account = await get('/v1/account');
  if (account?.object !== 'account' || account.id !== expectedAccountId)
    return refusal('provider-account-proof-unavailable-or-mismatched');
  const pages = {};
  const start = Date.parse(from)/1000, stop = Date.parse(until)/1000;
  for (const [series, endpoint] of Object.entries(ENDPOINTS)) {
    let cursor;
    const data=[];
    let hasMore=true;
    for (let page=0; page<maxPages; page++) {
      const query={limit:100,'created[gte]':start,'created[lt]':stop};
      if (cursor) query.starting_after=cursor;
      const response=await get(endpoint,query);
      if (!Array.isArray(response?.data) || typeof response.has_more !== 'boolean')
        return refusal('provider-' + series + '-read-unavailable');
      if (response.data.some(r => !r || typeof r.id !== 'string' || !r.id ||
        (typeof r.livemode === 'boolean' && r.livemode !== (mode === 'live'))))
        return refusal('provider-' + series + '-mode-or-identity-conflict');
      data.push(...response.data);
      hasMore=response.has_more;
      if (!hasMore) break;
      const next=response.data.at(-1)?.id;
      if (!next || next===cursor) return refusal('provider-' + series + '-pagination-nonprogress');
      cursor=next;
    }
    pages[series]={data,has_more:hasMore};
  }
  try {
    const reading=readStripeProviderBalance({
      accountId:account.id,livemode:mode==='live',currency,from,until,observedAt,pages,
    });
    return Object.freeze({...reading,accountIdentity:'provider-verified-self-account',
      legalPayee:'not-established-by-provider-account-id',credentialMaterialReturned:false});
  } catch {
    return refusal('provider-balance-data-invalid-or-contradictory');
  }
}
