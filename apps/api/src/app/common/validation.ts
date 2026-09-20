import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

export function parseRequest<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new BadRequestException({
    code: 'VALIDATION_FAILED',
    details: {
      fields: result.error.issues.map(({ message, path }) => ({
        field: path.join('.') || 'request',
        message,
      })),
    },
    message: 'Check the highlighted fields and try again',
  });
}
