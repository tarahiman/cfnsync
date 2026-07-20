/**
 * Usecase 境界で AWS 由来テキストから NoEcho 実値を除去する共通 redactor。
 *
 * パラメータ名ではなく、対象スタックの設定上の実効パラメータ値を置換する。
 * 空文字・4 文字未満は一般的な断片まで過剰にマスクするため対象外とする。
 */

export type TextRedactor = (text: string) => string;

export const identityRedactor: TextRedactor = (text) => text;

export function createNoEchoRedactor(
  parameters: Record<string, string>,
  noEchoParams: string[],
): TextRedactor {
  const values = [
    ...new Set(
      noEchoParams
        .map((name) => parameters[name])
        .filter(
          (value): value is string => value !== undefined && value.length >= 4,
        ),
    ),
  ].sort((a, b) => b.length - a.length);

  if (values.length === 0) return identityRedactor;

  return (text) => {
    let redacted = text;
    for (const value of values) {
      redacted = redacted.replaceAll(value, '****');
    }
    return redacted;
  };
}
