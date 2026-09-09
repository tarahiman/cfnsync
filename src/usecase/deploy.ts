// FR-4 / FR-5 の deploy 公開入口。実体は ./deploy/ に分割されており、このファイルは
// 既存の import パス(`src/cli/dependencies.ts` と 6 本のテスト)を保つための互換ファサード。
// biome-ignore lint/performance/noBarrelFile: 分割前の import パスを維持するための互換ファサードであり、新規の再エクスポートを足さない
export {
  type DeployDeps,
  type DeployOptions,
  type DeployResult,
  deploy,
} from './deploy/index.js';
