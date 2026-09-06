/**
 * 管理単位「スタックキー」(design.md §4.1)と変更分類(§4.4)の共有型。
 */

import { ConfigError } from './errors.js';

/** `<テンプレート相対パス>@<リージョン>` 形式の識別子。 */
export type StackKey = string;

export type ChangeType = 'added' | 'modified' | 'deleted' | 'unchanged';

export function makeStackKey(templatePath: string, region: string): StackKey {
  return `${templatePath}@${region}`;
}

function splitStackKey(
  key: string,
): { templatePath: string; region: string } | undefined {
  const at = key.lastIndexOf('@');
  if (at <= 0 || at === key.length - 1) return undefined;
  return { templatePath: key.slice(0, at), region: key.slice(at + 1) };
}

export function parseStackKey(key: StackKey): {
  templatePath: string;
  region: string;
} {
  const parts = splitStackKey(key);
  if (parts === undefined) {
    throw new ConfigError(`Invalid stack key: ${key}`, {
      stackKey: key,
    });
  }
  return parts;
}

/** dependsOn のテンプレートパスを依存元と同じリージョンのスタックキーへ解決する。 */
export function resolveDependsOnKey(raw: string, region: string): StackKey {
  const templatePath = splitStackKey(raw)?.templatePath ?? raw;
  return makeStackKey(templatePath, region);
}

/** 明示依存を同一リージョンの管理対象へ解決し、無効な参照を拒否する。 */
export function resolveManagedDependsOn(
  raw: string,
  ownerKey: StackKey,
  region: string,
  managed: ReadonlySet<StackKey>,
): StackKey {
  const resolved = resolveDependsOnKey(raw, region);
  if (resolved === ownerKey) {
    throw new ConfigError(
      `Explicit dependsOn '${raw}' cannot reference itself`,
      {
        stackKey: ownerKey,
        region,
      },
    );
  }
  if (!managed.has(resolved)) {
    throw new ConfigError(
      `Explicit dependsOn '${raw}' does not resolve to a managed target in the same region: ${resolved}`,
      { stackKey: ownerKey, region },
    );
  }
  return resolved;
}
