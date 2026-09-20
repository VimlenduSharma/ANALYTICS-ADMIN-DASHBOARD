import type {
  OrganizationAuthorization,
  RequestIdentity,
} from './app/identity/request-identity';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: RequestIdentity;
    organization?: OrganizationAuthorization;
  }
}
