import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// リリースワークフロー(.github/workflows/publish.yml)の fail-closed 検証。
// タグ名と package.json の version が一致しない公開、および既に公開済みの
// バージョンの再公開を、npm へ到達する前に分かりやすいメッセージで止める。
// ローカルでも `GITHUB_REF_NAME=v0.2.0 node scripts/verify-release-tag.mjs`
// で同じ検証を実行できる。
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(
  readFileSync(join(root, 'package.json'), { encoding: 'utf8' }),
);

const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
  throw new Error(
    'GITHUB_REF_NAME が未設定です。タグ名を指定して実行してください(例: GITHUB_REF_NAME=v0.2.0)。',
  );
}

const expectedTag = `v${manifest.version}`;
if (tag !== expectedTag) {
  throw new Error(
    `タグ名と package.json の version が一致しません: タグ=${tag} / 期待値=${expectedTag}。` +
      ' package.json の version を上げた commit に対して、その version と同じタグを打ち直してください。',
  );
}

// 既に公開済みなら npm 側が 403 を返すが、原因の分かりにくいエラーになる。
// レジストリを先に引いて、明示的なメッセージで止める。レジストリの一時障害で
// リリース全体を落とさないよう、404 以外の異常応答は警告に留めて続行する
// (重複公開の最終的な防止は npm 側が担保する)。
const packageUrl = `https://registry.npmjs.org/${manifest.name.replace('/', '%2F')}/${manifest.version}`;
let response;
try {
  response = await fetch(packageUrl, {
    headers: { accept: 'application/json' },
  });
} catch (cause) {
  console.warn(
    `警告: npm レジストリへの問い合わせに失敗しました(${packageUrl}): ${cause}. 重複公開のチェックをスキップします。`,
  );
}

if (response?.status === 200) {
  throw new Error(
    `${manifest.name}@${manifest.version} は既に npm に公開されています。version を上げてから新しいタグを打ってください。`,
  );
}
if (response && response.status !== 404) {
  console.warn(
    `警告: npm レジストリが予期しないステータスを返しました(${response.status} ${packageUrl})。重複公開のチェックをスキップします。`,
  );
}

console.log(
  `検証 OK: タグ ${tag} は ${manifest.name}@${manifest.version} の公開に対応しています。`,
);
