import assert from 'node:assert/strict';
import test from 'node:test';
import {observeStripeProviderBalance} from '../src/provider-balance-source.mjs';

const from='2026-10-22T00:00:00Z',until='2026-10-23T00:00:00Z',
  observedAt='2026-10-24T00:00:00Z';
const created=Date.parse('2026-10-22T12:00:00Z')/1000;
const bt=(id,amount,fee,source,reporting_category)=>({
  id,amount,fee,net:amount-fee,source,reporting_category,
  currency:'usd',created,status:'available',type:reporting_category,
});
const rows={
  '/v1/balance_transactions':[
    bt('txn_charge',1000,59,'ch_fixture','charge'),
    bt('txn_refund',-200,0,'re_fixture','refund'),
    bt('txn_fee',-20,0,null,'fee'),
    bt('txn_payout',-721,0,'po_fixture','payout'),
  ],
  '/v1/charges':[{id:'ch_fixture',amount:1000,currency:'usd',
    created,paid:true,status:'succeeded',livemode:false}],
  '/v1/payouts':[{id:'po_fixture',amount:721,currency:'usd',
    created,status:'paid',livemode:false}],
  '/v1/checkout/sessions':[{id:'cs_fixture',amount_total:500,currency:'usd',
    created,status:'open',payment_status:'unpaid',livemode:false,
    customer_details:{email:'private-not-for-readout@example.test'}}],
};
const options={key:'rk_test_fixture_not_real',expectedAccountId:'acct_Example123',
  from,until,currency:'usd',observedAt};
function mock({list=rows,account='acct_Example123',fail,hasMore={}}={}) {
  const calls=[];
  const fetchImpl=async (url,opts)=>{
    const u=new URL(url);calls.push([u,opts]);
    assert.equal(u.origin,'https://api.stripe.com');
    assert.equal(opts.method,'GET');
    assert.equal(opts.headers.Authorization,'Bearer '+options.key);
    if (u.pathname===fail) return {ok:false};
    if (u.pathname==='/v1/account')
      return {ok:true,json:async()=>({object:'account',id:account})};
    if (!Object.hasOwn(list,u.pathname)) return {ok:false};
    return {ok:true,json:async()=>({
      object:'list',data:list[u.pathname],has_more:Boolean(hasMore[u.pathname]),
    })};
  };
  return {fetchImpl,calls};
}

test('sourced provider movements and unpaid sessions do not become recognized cash',async()=>{
  const x=mock(),result=await observeStripeProviderBalance({...options,fetchImpl:x.fetchImpl});
  assert.equal(result.type,'StripeProviderBalanceReadout/v1');
  assert.equal(result.accountIdentity,'provider-verified-self-account');
  assert.equal(result.accountIdClaimedByReader,options.expectedAccountId);
  assert.equal(result.fullyCovered,true);
  assert.equal(result.financial.grossChargeCents,1000);
  assert.equal(result.financial.chargeProcessorFeeCents,59);
  assert.equal(result.financial.processorChargesAfterFeesAndRefundsCents,721);
  assert.equal(result.financial.providerReportedPaidPayoutCents,721);
  assert.equal(result.financial.netBalanceChangeCents,0);
  assert.equal(result.corroboration.providerMovementReconciled,true);
  assert.equal(result.unpaidCheckout.openUnpaidAmountCents,500);
  assert.equal(result.unpaidCheckout.countedAsPaidCents,0);
  assert.equal(result.recognizedRevenueCents,null);
  assert.equal(result.netOperatingMarginCents,null);
  assert.equal(result.bankCredit,'unobserved');
  assert.equal(x.calls.length,5);
  assert.ok(x.calls.every(([url])=>!url.href.includes(options.key)));
  assert.doesNotMatch(JSON.stringify(result),/private-not-for-readout|rk_test_fixture_not_real/);
});

test('wrong merchant, missing key, invalid window and provider refusal fail closed',async()=>{
  const x=mock();
  assert.equal((await observeStripeProviderBalance({
    ...options,expectedAccountId:'acct_Other',fetchImpl:x.fetchImpl,
  })).reason,'provider-account-proof-unavailable-or-mismatched');
  assert.equal((await observeStripeProviderBalance({
    ...options,key:'',fetchImpl:x.fetchImpl,
  })).reason,'merchant-read-credential-unavailable');
  assert.equal((await observeStripeProviderBalance({
    ...options,from:'2026-10-23T10:00:00Z',fetchImpl:x.fetchImpl,
  })).reason,'invalid-observation-window');
  assert.equal((await observeStripeProviderBalance({
    ...options,fetchImpl:mock({fail:'/v1/payouts'}).fetchImpl,
  })).reason,'provider-payouts-read-unavailable');
});

test('truncated provider pagination returns unknown financial figures, not zero',async()=>{
  const x=mock({hasMore:{'/v1/charges':true}});
  const r=await observeStripeProviderBalance({...options,maxPages:1,fetchImpl:x.fetchImpl});
  assert.equal(r.fullyCovered,false);
  assert.equal(r.financial,null);
  assert.equal(r.recognizedRevenueCents,null);
  assert.equal(r.coverage.charges.hasMore,true);
});

test('mode conflict, contradictory balance and nonprogressing provider page refuse',async()=>{
  const wrong={...rows,'/v1/payouts':[{...rows['/v1/payouts'][0],livemode:true}]};
  assert.equal((await observeStripeProviderBalance({
    ...options,fetchImpl:mock({list:wrong}).fetchImpl,
  })).reason,'provider-payouts-mode-or-identity-conflict');
  const broken={...rows,'/v1/balance_transactions':[
    {...rows['/v1/balance_transactions'][0],net:999},
    ...rows['/v1/balance_transactions'].slice(1),
  ]};
  assert.equal((await observeStripeProviderBalance({
    ...options,fetchImpl:mock({list:broken}).fetchImpl,
  })).reason,'provider-balance-data-invalid-or-contradictory');
  const empty={...rows,'/v1/charges':[]};
  assert.equal((await observeStripeProviderBalance({
    ...options,fetchImpl:mock({list:empty,hasMore:{'/v1/charges':true}}).fetchImpl,
  })).reason,'provider-charges-pagination-nonprogress');
});

test('a Checkout Session with unknown currency keeps unpaid exposure unknown',async()=>{
  const uncertain={...rows,'/v1/checkout/sessions':[
    {...rows['/v1/checkout/sessions'][0],currency:null},
  ]};
  const result=await observeStripeProviderBalance({
    ...options,fetchImpl:mock({list:uncertain}).fetchImpl,
  });
  assert.equal(result.fullyCovered,false);
  assert.equal(result.financial,null);
  assert.equal(result.unpaidCheckout,null);
  assert.equal(result.coverage.checkoutSessions.unknownCurrencyRows,1);
});
