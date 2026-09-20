import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

export const edgeProxyHeader = 'x-edge-proxy-secret';
export const edgeClientIpHeader = 'x-edge-client-ip';

const publicHealthPaths = new Set([
  '/api/v1/health/live',
  '/api/v1/health/ready',
]);

export function acceptsEdgeRequest(
  request: Pick<FastifyRequest, 'headers' | 'url'>,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret || publicHealthPaths.has(pathname(request.url))) {
    return true;
  }

  const supplied = request.headers[edgeProxyHeader];
  return typeof supplied === 'string' && safeEqual(expectedSecret, supplied);
}

export function trustedClientIdentity(
  request: Pick<FastifyRequest, 'headers' | 'ip'>,
  edgeProxyEnabled: boolean,
): string {
  const supplied = request.headers[edgeClientIpHeader];
  return edgeProxyEnabled && typeof supplied === 'string' && supplied.length
    ? supplied
    : request.ip;
}

function pathname(url: string): string {
  return url.split('?', 1)[0] ?? url;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
