/** Readable messages for low-level network failures. */

interface ErrorWithCause { code?: unknown; cause?: unknown; address?: unknown; port?: unknown; name?: unknown; message?: unknown }

function causes(error: unknown): ErrorWithCause[] {
  const chain: ErrorWithCause[] = [];
  let current = error as ErrorWithCause | undefined;
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth++) {
    chain.push(current);
    current = current.cause as ErrorWithCause | undefined;
  }
  return chain;
}

/**
 * undici reports network failures as a bare "fetch failed"; the useful detail
 * (ECONNREFUSED, ENOTFOUND, a timeout) is buried in the cause chain.
 */
export function describeNetworkError(error: unknown): string {
  const chain = causes(error);
  const coded = chain.find(item => typeof item.code === 'string');
  const code = typeof coded?.code === 'string' ? coded.code : '';
  const where = coded && typeof coded.address === 'string'
    ? ` at ${coded.address}${typeof coded.port === 'number' ? `:${coded.port}` : ''}` : '';
  if (chain.some(item => item.name === 'TimeoutError')) return 'The provider timed out before answering.';
  switch (code) {
    case 'ECONNREFUSED': return `Connection refused${where}. Is the model server running?`;
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'The provider host name could not be resolved. Check the base URL.';
    case 'ECONNRESET': return `The connection was reset${where}.`;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return `The provider network is unreachable${where}.`;
    case 'ETIMEDOUT': case 'UND_ERR_CONNECT_TIMEOUT': return `Connecting to the provider timed out${where}.`;
    case 'UND_ERR_HEADERS_TIMEOUT': case 'UND_ERR_BODY_TIMEOUT': return 'The provider stopped responding.';
    case 'CERT_HAS_EXPIRED': case 'DEPTH_ZERO_SELF_SIGNED_CERT': case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The provider's TLS certificate was rejected (${code}).`;
    default: break;
  }
  const message = chain.map(item => (typeof item.message === 'string' ? item.message : '')).filter(Boolean);
  const unique = [...new Set(message)];
  return (unique.length > 1 && unique[0] === 'fetch failed' ? unique.slice(1) : unique).join(': ') || 'Request failed.';
}
