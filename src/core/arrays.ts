/**
 * 配列比較の共有ユーティリティ。
 *
 * capabilities のように「順序に意味がなく、要素が文字列」の集合を比較する用途に限る。
 * `usecase` 側に同じ式が複数回書かれていたため core へ寄せた(#28)。
 */

/** 順序を無視して 2 つの文字列配列が同一の要素からなるかを判定する。 */
export function arraysEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
