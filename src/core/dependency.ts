import { makeStackKey, type StackKey } from './types.js';

/** dependsOn のテンプレートパスを依存元と同じリージョンのスタックキーへ解決する。 */
export function resolveDependsOnKey(raw: string, region: string): StackKey {
  const at = raw.lastIndexOf('@');
  const templatePath = at > 0 && at < raw.length - 1 ? raw.slice(0, at) : raw;
  return makeStackKey(templatePath, region);
}
