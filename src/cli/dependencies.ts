import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CloudFormationGatewayImpl } from '../aws/cloudformation.js';
import { StsGatewayImpl } from '../aws/sts.js';
import { createStateBackend } from '../backend/factory.js';
import { loadConfig, type CfnSyncConfig } from '../core/config.js';
import type { CloudFormationGateway, StateBackend, StsGateway } from '../ports/index.js';
import { deploy, type DeployDeps, type DeployOptions, type DeployResult } from '../usecase/deploy.js';
import { forceUnlock, type ForceUnlockResult } from '../usecase/forceUnlock.js';
import {
  runImport,
  type ImportDeps,
  type ImportOptions,
  type ImportResult,
} from '../usecase/importer.js';

export interface CliDependencies {
  loadConfig(path: string): CfnSyncConfig;
  readTemplates(config: CfnSyncConfig, configDir: string): Map<string, string>;
  createBackend(input: { config: CfnSyncConfig; configDir: string; profile?: string }): StateBackend;
  createCfn(input: { region: string; profile?: string }): CloudFormationGateway;
  createSts(input: { region?: string; profile?: string }): StsGateway;
  deploy(input: {
    config: CfnSyncConfig;
    configDir: string;
    templates: Map<string, string>;
    deps: DeployDeps;
    options: DeployOptions;
  }): Promise<DeployResult>;
  runImport(input: {
    config: CfnSyncConfig;
    configPath: string;
    deps: ImportDeps;
    options: ImportOptions;
  }): Promise<ImportResult>;
  forceUnlock(input: { backend: StateBackend; runId: string }): Promise<ForceUnlockResult>;
}

export const defaultCliDependencies: CliDependencies = {
  loadConfig,
  readTemplates(config, configDir) {
    return new Map(
      Object.keys(config.stacks).map((templatePath) => [
        templatePath,
        readFileSync(resolve(configDir, templatePath), 'utf8'),
      ]),
    );
  },
  createBackend: ({ config, configDir, profile }) =>
    createStateBackend({ stateConfig: config.state, configDir, profile }),
  createCfn: ({ region, profile }) => new CloudFormationGatewayImpl({ region, profile }),
  createSts: ({ region, profile }) => new StsGatewayImpl({ region, profile }),
  deploy,
  runImport,
  forceUnlock,
};
