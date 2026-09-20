import type { Environment } from '@analytics-admin/config';
import { ConfigService } from '@nestjs/config';
import { CredentialCipher } from './credential-cipher';

describe('CredentialCipher', () => {
  const config = new ConfigService<Environment, true>({
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
  } as Environment);
  const cipher = new CredentialCipher(config);

  it('round trips values with authenticated context', () => {
    const encrypted = cipher.encrypt('private-value', 'source:42');

    expect(cipher.decrypt(encrypted, 'source:42').toString()).toBe(
      'private-value',
    );
    expect(encrypted.ciphertext.toString()).not.toContain('private-value');
  });

  it('rejects ciphertext in a different context', () => {
    const encrypted = cipher.encrypt('private-value', 'source:42');

    expect(() => cipher.decrypt(encrypted, 'source:43')).toThrow();
  });
});
