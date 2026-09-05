import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { type CfnSyncConfig, parseConfig } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { assertSafeTemplatePath } from '../core/templatePath.js';
import type { ImportFileSystem } from '../usecase/importer.js';

/** Node.js の同期ファイル I/O adapter。CLI の composition root から usecase へ注入する。 */
export const nodeFileSystem: ImportFileSystem = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => writeFileSync(path, content),
  exists: existsSync,
  realpath: realpathSync,
  isFile: (path) => statSync(path).isFile(),
};

function isWithinDirectory(base: string, target: string): boolean {
  const rel = relative(base, target);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** symlink を含む実パスを検証する CLI filesystem adapter。 */
export function resolveTemplatePathWithinConfig(
  configDir: string,
  templatePath: string,
  fs: Pick<ImportFileSystem, 'exists' | 'realpath'>,
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
        `The template path resolves outside the config directory: ${templatePath}`,
        { stackKey: templatePath },
      );
    }
    return resolvedTarget;
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(
      `Cannot verify the real path of the template path: ${templatePath}`,
      { stackKey: templatePath, cause },
    );
  }
}

export interface LoadConfigFileOptions {
  /** import --write-template は安全な不存在パスを許可する。 */
  allowMissingTemplates?: boolean;
  /** force-unlock はテンプレートへ触れないため字句検証だけ行う。 */
  validateTemplateFiles?: boolean;
}

export function loadConfigFile(
  configPath: string,
  options: LoadConfigFileOptions = {},
): CfnSyncConfig {
  const absolute = resolve(configPath);
  let content: string;
  try {
    content = nodeFileSystem.readFile(absolute);
  } catch (cause) {
    throw new ConfigError(`Cannot read the config file: ${configPath}`, {
      cause,
    });
  }

  const configDir = dirname(absolute);
  const config = parseConfig(content);
  if (options.validateTemplateFiles !== false) {
    for (const templatePath of Object.keys(config.stacks)) {
      const path = resolveTemplatePathWithinConfig(
        configDir,
        templatePath,
        nodeFileSystem,
      );
      if (!nodeFileSystem.exists(path)) {
        if (options.allowMissingTemplates) continue;
        throw new ConfigError(
          `The referenced template file does not exist: ${templatePath}`,
          { stackKey: templatePath },
        );
      }
      if (!nodeFileSystem.isFile(path)) {
        throw new ConfigError(
          `The referenced template path is not a regular file: ${templatePath}`,
          { stackKey: templatePath },
        );
      }
    }
  }
  return config;
}

export function readTemplateFiles(
  config: CfnSyncConfig,
  configDir: string,
): Map<string, string> {
  return new Map(
    Object.keys(config.stacks).map((templatePath) => [
      templatePath,
      nodeFileSystem.readFile(
        resolveTemplatePathWithinConfig(
          configDir,
          templatePath,
          nodeFileSystem,
        ),
      ),
    ]),
  );
}

export function resolveTemplatePaths(
  config: CfnSyncConfig,
  configDir: string,
): Map<string, string> {
  return new Map(
    Object.keys(config.stacks).map((templatePath) => [
      templatePath,
      resolveTemplatePathWithinConfig(configDir, templatePath, nodeFileSystem),
    ]),
  );
}
