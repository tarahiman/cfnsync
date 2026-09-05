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

export function parseStackKey(key: StackKey): {
  templatePath: string;
  region: string;
} {
  const at = key.lastIndexOf('@');
  if (at <= 0 || at === key.length - 1) {
    throw new ConfigError(`Invalid stack key: ${key}`, {
      stackKey: key,
    });
  }
  return { templatePath: key.slice(0, at), region: key.slice(at + 1) };
}
