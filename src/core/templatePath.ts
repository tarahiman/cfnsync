import { ConfigError } from './errors.js';

/**
 * FR-11-11: 予約プレフィックス。削除待ちのスタックキー名前空間
 * (`cfnsync:pending/<スタック名>@<リージョン>`、core/state)と設定由来の
 * スタックキーが衝突しないよう、このプレフィックスで始まるテンプレートパスを拒否する。
 */
export const RESERVED_TEMPLATE_PATH_PREFIX = 'cfnsync:';

function normalizeTemplatePathInternal(templatePath: string): {
  normalized: string;
  escapesParent: boolean;
} {
  const segments: string[] = [];
  let escapesParent = false;
  for (const segment of templatePath.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) escapesParent = true;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return { normalized: segments.join('/'), escapesParent };
}

/** OS に依存しない字句正規化。実パス検証は filesystem adapter が担う。 */
export function normalizeTemplatePath(templatePath: string): string {
  return normalizeTemplatePathInternal(templatePath).normalized;
}

/** OS に依存せず絶対パス・親ディレクトリ参照・予約プレフィックスを fail-closed に拒否する。 */
export function assertSafeTemplatePath(templatePath: string): void {
  if (templatePath.startsWith(RESERVED_TEMPLATE_PATH_PREFIX)) {
    throw new ConfigError(
      `Template paths cannot use the reserved prefix '${RESERVED_TEMPLATE_PATH_PREFIX}': ${templatePath}`,
      { stackKey: templatePath },
    );
  }
  const portable = templatePath.replaceAll('\\', '/');
  const { normalized, escapesParent } =
    normalizeTemplatePathInternal(templatePath);
  const unsafe =
    templatePath.includes('\0') ||
    portable.startsWith('/') ||
    /^[A-Za-z]:\//.test(portable) ||
    escapesParent ||
    normalized === '';

  if (unsafe) {
    throw new ConfigError(
      `Template paths must be relative paths under the config directory: ${templatePath}`,
      { stackKey: templatePath },
    );
  }
}
