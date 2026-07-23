/**
 * Usecase 境界で AWS 由来テキストから NoEcho 実値を除去する共通 redactor。
 *
 * パラメータ名ではなく、対象スタックの設定上の実効パラメータ値を置換する。
 * 空文字・4 文字未満は一般的な断片まで過剰にマスクするため対象外とする。
 */

import { REQUIRED_PLACEHOLDER } from '../core/constants.js';

export type TextRedactor = (text: string) => string;

export const identityRedactor: TextRedactor = (text) => text;

export function createNoEchoRedactor(
  parameters: Record<string, string>,
  noEchoParams: string[],
  templateDefaults: Record<string, string> = {},
): TextRedactor {
  const effectiveParameters = { ...templateDefaults, ...parameters };
  const rawValues = [
    ...new Set(
      noEchoParams
        .map((name) => effectiveParameters[name])
        .filter(
          (value): value is string =>
            value !== undefined &&
            value.length >= 4 &&
            value !== REQUIRED_PLACEHOLDER,
        ),
    ),
  ];

  const values = [
    ...new Set(
      rawValues.flatMap((value) => {
        const json = JSON.stringify(value);
        const variants = [value, json, json.slice(1, -1)];
        try {
          variants.push(encodeURIComponent(value));
        } catch {
          // 不正な単独 surrogate 等は URI エンコード不能。生値/JSON 表現は引き続きマスクする。
        }
        return variants;
      }),
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
