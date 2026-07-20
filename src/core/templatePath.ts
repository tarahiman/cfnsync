import { ConfigError } from './errors.js';

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

/** OS に依存せず絶対パス・親ディレクトリ参照を fail-closed に拒否する。 */
export function assertSafeTemplatePath(templatePath: string): void {
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
