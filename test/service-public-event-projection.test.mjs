import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectEvent as direct} from '../src/service.mjs';
import {projectEvent as publicRoot} from '@red-cup-engineering/stripe-services-section';
import {projectEvent as publicService} from '@red-cup-engineering/stripe-services-section/service';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const expectedFields=[
 'stripeEventId','eventType','stripeObjectId','amountTotal','currency',
 'stripePaymentLinkId','stripePriceIdsObserved','stripeProductIdsObserved',
 'stripeLineItemCoverage','subscriptionId','invoiceId'
];

test('the actual Shop checkout consumer can import the original public Stripe event reader through both exported package entrances',()=>{
 assert.strictEqual(typeof direct,'function');
 assert.strictEqual(publicRoot,direct);
 assert.strictEqual(publicService,direct);
 const src=readFileSync(join(root,'src/service.mjs'),'utf8');
 assert.match(src,/^export function projectEvent\(event\) \{/mu);
 assert.doesNotMatch(src,/export \/\*\* Retain only provider/u);
 const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
 assert.equal(manifest.exports['.'],'./src/service.mjs');
 assert.equal(manifest.exports['./service'],'./src/service.mjs');
 assert.ok(manifest.receivingTests.includes('test/service-public-event-projection.test.mjs'));
 assert.ok(manifest.files.includes('test/service-public-event-projection.test.mjs'));
});

test('external buyer checkout is source-qualified for the existing Shop fulfillment interface without retaining customer PII',()=>{
 const event={
  id:'evt_original_checkout',type:'checkout.session.completed',livemode:true,
  created:1792670000,
  data:{object:{
   id:'cs_shop_checkout',payment_link:'plink_1USMywJ1vYnPQu2NWHtcqx0b',
   payment_status:'paid',status:'complete',currency:'usd',amount_total:1000,
   payment_intent:'pi_original',metadata:{
    offering_id:'book-offer',request_digest:'ni:///sha-256;test-original-source-identity'
   },customer_details:{name:'Private Buyer',email:'private@example.invalid'}
  }}
 };
 const output=publicRoot(event);
 for(const field of expectedFields)assert.ok(Object.hasOwn(output,field),'missing original buyer/source field '+field);
 assert.equal(output.stripeEventId,event.id);
 assert.equal(output.stripeObjectId,event.data.object.id);
 assert.equal(output.eventType,'checkout.session.completed');
 assert.equal(output.paymentStatus,'paid');
 assert.equal(output.stripePaymentLinkId,'plink_1USMywJ1vYnPQu2NWHtcqx0b');
 assert.equal(output.amountTotal,1000);
 assert.equal(output.currency,'usd');
 assert.deepEqual(output.stripePriceIdsObserved,[]);
 assert.equal(output.stripeLineItemCoverage,'not-provided');
 assert.ok(!JSON.stringify(output).includes('Private Buyer'));
 assert.ok(!JSON.stringify(output).includes('private@example.invalid'));
 assert.ok(!Object.hasOwn(output,'clearedCash'));
 assert.ok(!Object.hasOwn(output,'settledGroupTreasury'));
});

test('recurring prices are reported as signed-event observations, never inferred from the checkout link or a paid claim',()=>{
 const price='price_1UMnsuJ1vYnPQu2N7U1S22t2',product='prod_VNZ0v9uUHgXFb3';
 const created=publicService({
  id:'evt_subscription_observed',type:'customer.subscription.created',
  data:{object:{id:'sub_observed',items:{data:[{price:{id:price,product}}],has_more:false}}}
 });
 assert.deepEqual(created.stripePriceIdsObserved,[price]);
 assert.deepEqual(created.stripeProductIdsObserved,[product]);
 assert.equal(created.stripeLineItemCoverage,'complete');
 assert.equal(created.stripePaymentLinkId,null);
 const invoice=publicService({
  id:'evt_invoice_observed',type:'invoice.paid',
  data:{object:{id:'in_observed',subscription:'sub_observed',
   amount_total:1000,currency:'usd',
   lines:{data:[{pricing:{price_details:{price,product}}}],has_more:true}}
  }
 });
 assert.equal(invoice.invoiceId,'in_observed');
 assert.equal(invoice.subscriptionId,'sub_observed');
 assert.deepEqual(invoice.stripePriceIdsObserved,[price]);
 assert.equal(invoice.stripeLineItemCoverage,'possibly-partial');
 assert.equal(Object.hasOwn(invoice,'settledGroupTreasury'),false);
});
