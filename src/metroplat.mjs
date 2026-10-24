/** Stripe's native MetroPlat application: no second host, dispatcher or credential bridge. */
import { operation } from '@red-cup-engineering/computer-system-engine/rpc/operation';
import { schemaFrom } from '@red-cup-engineering/json-schema-services-section/contracts';
import {
  ACTOR, credentialMode, digest, invokeCheckout, loadCatalog, readiness, solicitCheckout,
} from './service.mjs';
import {observeStripeProviderBalance} from './provider-balance-source.mjs';

const emptyInput = schemaFrom({
  $id: 'stripe/metroplat/readiness-input/v1', type: 'object', additionalProperties: false,
});
const checkoutInput = schemaFrom({
  $id: 'stripe/metroplat/solicit-input/v1', type: 'object',
  required: ['offeringId', 'customerReference', 'successUrl', 'cancelUrl'],
  properties: {
    offeringId: { type: 'string', minLength: 1 },
    customerReference: { type: 'string', minLength: 1, maxLength: 200 },
    successUrl: { type: 'string', minLength: 1 },
    cancelUrl: { type: 'string', minLength: 1 },
    quantity: { type: 'integer', minimum: 1 },
  }, additionalProperties: false,
});
const balanceReadInput = schemaFrom({
  $id: 'stripe/metroplat/provider-balance-read-input/v1', type: 'object',
  required: ['from', 'until', 'currency'], additionalProperties: false,
  properties: {
    from: {type: 'string', minLength: 20}, until: {type: 'string', minLength: 20},
    currency: {type: 'string', pattern: '^[a-z]{3}$'},
  },
});
const acceptanceInput = schemaFrom({
  $id: 'stripe/metroplat/accept-input/v1', type: 'object', required: ['offer'],
  properties: { offer: { type: 'object' } }, additionalProperties: false,
});
const output = schemaFrom({
  $id: 'stripe/metroplat/response/v1', type: 'object', required: ['type'],
  properties: { type: { type: 'string' } },
});

const admittedConfigurationKeys = new Set(['merchant', 'catalog', 'allowedReturnOrigins', 'allowLiveCheckout', 'enableProviderBalanceReadout', 'providerBalanceAccountId']);
const secureOrigin = (value) => {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.href === url.origin + '/'; }
  catch { return false; }
};
const refused = (reason) => ({ type: 'StripeMetroplatRefusal', reason });
const subjectOf = (context) => {
  const subject = context?.invocation?.subject;
  return typeof subject === 'string' && subject.length > 0 ? subject : null;
};

/** Bind the provider's original capabilities to one installed world's merchant and custody. */
export function stripeMetroplatOperations(binding, options = {}) {
  if (typeof binding?.dataRoot !== 'string' || !binding.dataRoot) {
    throw new TypeError('Stripe MetroPlat application requires the installed world data root');
  }
  const configuration = options.configuration ?? {};
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
      || Object.keys(configuration).some(key => !admittedConfigurationKeys.has(key))) {
    throw new TypeError('Stripe MetroPlat configuration accepts only merchant, catalog, allowedReturnOrigins and allowLiveCheckout');
  }
  const merchant = configuration.merchant;
  if (typeof merchant !== 'string' || merchant.trim() === '') {
    throw new TypeError('Stripe MetroPlat application requires an explicit legal merchant');
  }
  const catalog = configuration.catalog ?? loadCatalog();
  if (!catalog || !Array.isArray(catalog.offerings) || catalog.merchant?.legalBody !== merchant) {
    throw new TypeError('Stripe MetroPlat catalog must belong to the configured legal merchant');
  }
  const returnOrigins = configuration.allowedReturnOrigins ?? [];
  if (!Array.isArray(returnOrigins) || returnOrigins.some(origin => !secureOrigin(origin))) {
    throw new TypeError('Stripe MetroPlat allowedReturnOrigins must be HTTPS origin URLs');
  }
  if (configuration.allowLiveCheckout !== undefined && typeof configuration.allowLiveCheckout !== 'boolean') {
    throw new TypeError('Stripe MetroPlat allowLiveCheckout must be a boolean');
  }
  if (configuration.enableProviderBalanceReadout !== undefined &&
      typeof configuration.enableProviderBalanceReadout !== 'boolean')
    throw new TypeError('Stripe provider balance enablement must be boolean');
  if (configuration.enableProviderBalanceReadout === true &&
      !/^acct_[A-Za-z0-9]+$/.test(configuration.providerBalanceAccountId || ''))
    throw new TypeError('Stripe provider balance requires the exact original merchant account identity');
  // The environment comes from the host, never from instance JSON or tool input.
  // Use the installed world's root and the provider's existing Stripe-prefixed EAVT categories.
  const env = options.environment ?? {};
  const serviceOptions = { env, catalog, root: binding.dataRoot };
  const mode = () => credentialMode(env.API_KEY_STRIPE || env.STRIPE_SECRET_KEY || '');
  const liveAllowed = () => mode() !== 'live' || configuration.allowLiveCheckout === true;
  const redirectAllowed = (request) => [request?.successUrl, request?.cancelUrl].every(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && returnOrigins.includes(url.origin + '/'); }
    catch { return false; }
  });

  return Object.freeze([
    operation({
      verb: 'stripe-checkout-readiness', inputFormat: 'json', outputFormat: 'json',
      summary: 'Read the selected merchant checkout readiness without exposing Stripe credentials.',
      domain: emptyInput, codomain: output, reads: ['stripe-checkout-merchant-configuration'],
      run: () => ({ ...readiness(serviceOptions), metroplat: {
        merchant, returnOriginsConfigured: returnOrigins.length > 0,
        liveCheckoutAllowedByInstance: configuration.allowLiveCheckout === true,
      } }),
    }),
    operation({
      verb: 'stripe-checkout-solicit', inputFormat: 'json', outputFormat: 'json',
      summary: 'Offer one source-owned Stripe Checkout product to the authenticated actor; no charge is made.',
      domain: checkoutInput, codomain: output, reads: ['stripe-merchant-offerings'],
      run: (request, _args, context) => {
        const actor = subjectOf(context);
        if (!actor) return refused('authenticated-metroplat-subject-required');
        if (!redirectAllowed(request)) return refused('checkout-return-origin-not-admitted');
        if (!liveAllowed()) return refused('stripe-live-checkout-not-enabled-by-instance');
        const activity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: 'urn:metroplat:stripe:solicitation:' + digest({ actor, request }).split(';').at(-1),
          type: 'Offer', actor, target: ACTOR,
          object: { type: 'ServiceSolicitation', request },
        };
        return solicitCheckout(activity, serviceOptions);
      },
    }),
    operation({
      verb: 'stripe-checkout-invoke', inputFormat: 'json', outputFormat: 'json',
      summary: 'Create an idempotent Stripe Checkout Session for a previously admitted actor-bound offer.',
      domain: acceptanceInput, codomain: output, writes: ['stripe-checkout-session-receipt'],
      effects: { class: 'external', replay: 'idempotency-key', coordination: 'coordination-required', deterministic: 'unmeasured', totality: 'unmeasured' },
      run: ({ offer }, _args, context) => {
        const actor = subjectOf(context);
        if (!actor) return refused('authenticated-metroplat-subject-required');
        if (!liveAllowed()) return refused('stripe-live-checkout-not-enabled-by-instance');
        // The authenticated hand, merchant catalog and permitted redirects are immutable to callers.
        if (offer?.type !== 'Offer' || offer.target !== actor || !redirectAllowed(offer.object?.request)) {
          return refused('stripe-offer-actor-or-redirect-not-admitted');
        }
        const accepted = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: 'urn:metroplat:stripe:acceptance:' + digest({ actor, offer }).split(';').at(-1),
          type: 'Accept', actor, target: ACTOR, object: { offer },
        };
        return invokeCheckout(accepted, { ...serviceOptions, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
      },
    }),
    ...(configuration.enableProviderBalanceReadout === true ? [operation({
      verb: 'stripe-provider-balance-read', inputFormat: 'json', outputFormat: 'json',
      summary: 'Read source-verified Stripe charges, fees, refunds and payouts without recognizing unreceived revenue.',
      domain: balanceReadInput, codomain: output, reads: ['stripe-provider-balance-account'],
      run: (input, _args, context) => {
        if (!subjectOf(context)) return refused('authenticated-metroplat-subject-required');
        return observeStripeProviderBalance({
          key: env.API_KEY_STRIPE || env.STRIPE_SECRET_KEY || '',
          expectedAccountId: configuration.providerBalanceAccountId,
          from: input.from, until: input.until, currency: input.currency,
          observedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
        });
      },
    })] : []),
  ]);
}

export const stripeMetroplatApplication = Object.freeze({
  kind: 'metroplat.application/v1',
  operations: stripeMetroplatOperations,
});
