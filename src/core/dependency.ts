// Compatibility export for usecase callers outside this batch's ownership.
import {
  resolveDependsOnKey as resolveDependsOnKeyFromTypes,
  type StackKey,
} from './types.js';

export function resolveDependsOnKey(raw: string, region: string): StackKey {
  return resolveDependsOnKeyFromTypes(raw, region);
}
