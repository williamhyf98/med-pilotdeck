// ui/server/utils/routeErrors.js
//
// The one place that turns an error thrown inside a route handler into an HTTP
// response. It lives here (rather than inline in index.js) so the gateway-error
// mapping can be tested without booting the server.
import { toGatewayHttpError } from '../pilotdeck-bridge.js';

/**
 * Gateway pool errors (503 GATEWAY_UNAVAILABLE / POOL_EXHAUSTED / START_TIMEOUT)
 * carry their own status; so does a lease whose socket was closed underneath it
 * (revocation, LRU eviction, a crashed child), which arrives as a plain Error.
 * Both become a retryable 503 instead of a blanket 500.
 */
export function sendRouteError(res, error) {
    const gatewayError = toGatewayHttpError(error);
    if (gatewayError) {
        res.status(gatewayError.status).json({ error: gatewayError.message, code: gatewayError.code });
        return;
    }
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    const body = { error: error?.message || 'Request failed' };
    if (status !== 500 && typeof error?.code === 'string') body.code = error.code;
    res.status(status).json(body);
}
