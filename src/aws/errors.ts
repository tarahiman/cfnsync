import { AwsError, type ErrorContext } from '../core/errors.js';

export function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? ((error as { name?: unknown }).name as string | undefined)
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function httpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && '$metadata' in error) {
    const metadata = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata;
    return metadata?.httpStatusCode;
  }
  return undefined;
}

/** SDK 例外を adapter 境界の共通 AwsError へ変換する。 */
export function toAwsError(
  operation: string,
  cause: unknown,
  context: Omit<ErrorContext, 'cause'> = {},
): AwsError {
  if (cause instanceof AwsError) return cause;
  return new AwsError(`${operation} failed`, {
    ...context,
    cause,
  });
}
