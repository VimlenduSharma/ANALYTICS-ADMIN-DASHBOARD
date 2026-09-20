import type { Environment } from '@analytics-admin/config';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
} from 'node:crypto';

export interface EncryptedValue {
  authTag: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
}

@Injectable()
export class CredentialCipher {
  private readonly key: ReturnType<typeof createSecretKey>;

  constructor(config: ConfigService<Environment, true>) {
    this.key = createSecretKey(
      Buffer.from(
        config.getOrThrow<string>('CREDENTIAL_ENCRYPTION_KEY'),
        'base64url',
      ),
    );
  }

  encrypt(value: Buffer | string, context: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(typeof value === 'string' ? Buffer.from(value) : value),
      cipher.final(),
    ]);
    return {
      authTag: cipher.getAuthTag(),
      ciphertext,
      iv,
    };
  }

  decrypt(value: EncryptedValue, context: string): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(value.authTag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
  }
}
