import { resolve } from 'node:path';

import { CloudFormationGatewayImpl } from '../aws/cloudformation.js';
import { S3StateBackend } from '../aws/s3state.js';
import { StsGatewayImpl } from '../aws/sts.js';
import { LOCAL_STATE_FILENAME, LocalStateBackend } from '../backend/local.js';
import type { CfnSyncConfig } from '../core/config.js';
import type {
  CloudFormationGateway,
  StateBackend,
  StsGateway,
} from '../ports/index.js';
import {
  type DeployDeps,
  type DeployOptions,
  type DeployResult,
  deploy,
} from '../usecase/deploy.js';
import { type ForceUnlockResult, forceUnlock } from '../usecase/forceUnlock.js';
import { type GraphResult, getGraph } from '../usecase/graph.js';
import {
  type ImportDeps,
  type ImportOptions,
  type ImportResult,
  runImport,
} from '../usecase/importer.js';
import { getStatus, type StatusResult } from '../usecase/status.js';
import {
  loadConfigFile,
  nodeFileSystem,
  readTemplateFiles,
} from './filesystem.js';

export interface CliDependencies {
  loadConfig(path: string): CfnSyncConfig;
  readTemplates(config: CfnSyncConfig, configDir: string): Map<string, string>;
  createBackend(input: {
    config: CfnSyncConfig;
    configDir: string;
    profile?: string;
  }): StateBackend;
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
    deps: Omit<ImportDeps, 'fs'>;
    options: ImportOptions;
  }): Promise<ImportResult>;
  forceUnlock(input: {
    backend: StateBackend;
    runId: string;
  }): Promise<ForceUnlockResult>;
  getStatus(input: {
    config: CfnSyncConfig;
    templates: Map<string, string>;
    backend: StateBackend;
  }): Promise<StatusResult>;
  getGraph(input: {
    config: CfnSyncConfig;
    templates: Map<string, string>;
  }): GraphResult;
}

export const defaultCliDependencies: CliDependencies = {
  loadConfig: loadConfigFile,
  readTemplates: readTemplateFiles,
  createBackend: ({ config, configDir, profile }) => {
    if (config.state.backend === 'local') {
      return new LocalStateBackend(resolve(configDir, LOCAL_STATE_FILENAME));
    }
    return new S3StateBackend({ ...config.state.s3, profile });
  },
  createCfn: ({ region, profile }) =>
    new CloudFormationGatewayImpl({ region, profile }),
  createSts: ({ region, profile }) => new StsGatewayImpl({ region, profile }),
  deploy,
  runImport: (input) =>
    runImport({
      ...input,
      deps: { ...input.deps, fs: nodeFileSystem },
    }),
  forceUnlock,
  getStatus,
  getGraph,
};
