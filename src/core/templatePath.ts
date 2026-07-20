import {
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { ConfigError } from './errors.js';

export interface TemplatePathFileSystem {
  exists(path: string): boolean;
  realpath(path: string): string;
}

/** OS に依存せず絶対パス・親ディレクトリ参照を fail-closed に拒否する。 */
export function assertSafeTemplatePath(templatePath: string): void {
  const portable = templatePath.replaceAll('\\', '/');
  const normalized = posix.normalize(portable);
  const unsafe =
    templatePath.includes('\0') ||
    isAbsolute(templatePath) ||
    posix.isAbsolute(portable) ||
    win32.isAbsolute(templatePath) ||
    normalized === '..' ||
    normalized.startsWith('../');

  if (unsafe) {
    throw new ConfigError(
      `テンプレートパスは設定ディレクトリ配下の相対パスでなければなりません: ${templatePath}`,
      { stackKey: templatePath },
    );
  }
}

function isWithinDirectory(base: string, target: string): boolean {
  const rel = relative(base, target);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** 注入されたファイルシステムで symlink を検証し、安全な実パスを返す。 */
export function resolveTemplatePathWithinConfig(
  configDir: string,
  templatePath: string,
  fs: TemplatePathFileSystem,
): string {
  assertSafeTemplatePath(templatePath);
  const baseAbs = resolve(configDir);
  const candidate = resolve(baseAbs, templatePath);

  let ancestor = candidate;
  try {
    const baseReal = fs.realpath(baseAbs);
    while (ancestor !== baseAbs && !fs.exists(ancestor)) {
      ancestor = dirname(ancestor);
    }
    const ancestorReal = fs.realpath(ancestor);
    const resolvedTarget =
      ancestor === candidate
        ? ancestorReal
        : resolve(ancestorReal, relative(ancestor, candidate));

    if (!isWithinDirectory(baseReal, resolvedTarget)) {
      throw new ConfigError(
        `テンプレートパスが設定ディレクトリ外へ解決されます: ${templatePath}`,
        { stackKey: templatePath },
      );
    }
    return resolvedTarget;
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `テンプレートパスの実パスを検証できません: ${templatePath}`,
      { stackKey: templatePath, cause },
    );
  }
}
