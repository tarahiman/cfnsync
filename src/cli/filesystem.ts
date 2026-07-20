import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type CfnSyncConfig, parseConfig } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { resolveTemplatePathWithinConfig } from '../core/templatePath.js';
import type { ImportFileSystem } from '../usecase/importer.js';

/** Node.js の同期ファイル I/O adapter。CLI の composition root から usecase へ注入する。 */
export const nodeFileSystem: ImportFileSystem = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => writeFileSync(path, content),
  exists: existsSync,
  realpath: realpathSync,
};

export function loadConfigFile(configPath: string): CfnSyncConfig {
  const absolute = resolve(configPath);
  let content: string;
  try {
    content = nodeFileSystem.readFile(absolute);
  } catch (cause) {
    throw new ConfigError(`設定ファイルを読み込めません: ${configPath}`, {
      cause,
    });
  }

  const configDir = dirname(absolute);
  try {
    return parseConfig(content, {
      templateExists: (templatePath) =>
        nodeFileSystem.exists(
          resolveTemplatePathWithinConfig(
            configDir,
            templatePath,
            nodeFileSystem,
          ),
        ),
    });
  } catch (cause) {
    if (cause instanceof ConfigError) {
      throw new ConfigError(
        `設定ファイルの検証に失敗しました: ${configPath}: ${cause.message}`,
        {
          stackKey: cause.stackKey,
          region: cause.region,
          cause,
        },
      );
    }
    throw cause;
  }
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
