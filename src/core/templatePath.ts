import { ConfigError } from './errors.js';

/**
 * FR-11-11: 予約プレフィックス。削除待ちのスタックキー名前空間
 * (`cfnsync:pending/<スタック名>@<リージョン>`、core/state)と設定由来の
 * スタックキーが衝突しないよう、このプレフィックスで始まるテンプレートパスを拒否する。
 */
export const RESERVED_TEMPLATE_PATH_PREFIX = 'cfnsync:';

/** OS に依存しない字句正規化。実パス検証は filesystem adapter が担う。 */
export function normalizeTemplatePath(templatePath: string): string {
  const segments: string[] = [];
  for (const segment of templatePath.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

/** OS に依存せず絶対パス・親ディレクトリ参照・予約プレフィックスを fail-closed に拒否する。 */
export function assertSafeTemplatePath(templatePath: string): void {
  if (templatePath.startsWith(RESERVED_TEMPLATE_PATH_PREFIX)) {
    throw new ConfigError(
      `テンプレートパスに予約プレフィックス '${RESERVED_TEMPLATE_PATH_PREFIX}' は使用できません: ${templatePath}`,
      { stackKey: templatePath },
    );
  }
  const portable = templatePath.replaceAll('\\', '/');
  const normalized = normalizeTemplatePath(templatePath);
  let depth = 0;
  let escapesParent = false;
  for (const segment of portable.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) escapesParent = true;
    } else {
      depth += 1;
    }
  }
  const unsafe =
    templatePath.includes('\0') ||
    portable.startsWith('/') ||
    /^[A-Za-z]:\//.test(portable) ||
    escapesParent ||
    normalized === '';

  if (unsafe) {
    throw new ConfigError(
      `テンプレートパスは設定ディレクトリ配下の相対パスでなければなりません: ${templatePath}`,
      { stackKey: templatePath },
    );
  }
}
