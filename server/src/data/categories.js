/**
 * Predefined search dictionaries.
 *
 * The raw lists are kept verbatim (including the duplicates that exist in the
 * source specification, e.g. テラス / VCK) so that the source of truth is easy to
 * diff against the spec.  `getCategory()` de-duplicates while preserving order,
 * because the UI renders one input row per term.
 */

const WAKUGUMI = [
  '木目調天井パネル', 'SA', 'ｱ-ﾁﾀﾚ壁', 'ｱｰﾁﾀﾚ壁', 'DL', 'ｽﾘｯﾄﾙｰﾊ', '中段', 'CT',
  '深基礎', '壁下地', '天井下地', '仏間', 'テラス', '文机', '手摺', '床補強',
  'ﾍﾞｰｽ', '高基礎', 'CH=', '天井下がる', '天井下がり', '下がり天井', 'ﾒﾝ', 'VCK',
  '室内窓', '窓', '防音', 'ドア', '建具', 'ｽﾘｯﾄｽﾗｲﾀﾞｰ', '(H)', '(B)', 'WF', '補強',
  'PL', 'PM', 'BS-', '33B', 'E-', 'E_', '_遮', '_断', '+レ', '_レ', '-180', '611',
  'SG11H', 'SG611H', 'テラス', 'ﾏｽ', 'ｽﾃﾝﾊﾟｲﾌﾟ', 'ｽﾃﾝﾊﾟｲﾌﾟｰ', '施-', '24(', '24-',
  'VL', 'V-08', 'V-12', 'FY', 'VFM', 'V10', 'VCK', 'V15', 'V-15', 'ｱ', '勾配天井',
  'FD', '腰板ﾊﾟﾈﾙ', 'JMF', 'JMK', 'FUKIAGE', 'koubai yane', 'HB',
  'BALCONY FINE TESURI', 'U-chi doma',
];

const JIKUGUMI = [
  'SA', 'ｱ-ﾁﾀﾚ壁', 'ｱｰﾁﾀﾚ壁', 'DL', '中段', 'CT', '深基礎', '壁下地', '天井下地',
  '仏間', '換気扇', '室内窓', 'CH=', '天井下がる', '壁ふかす', '手摺', 'FL+',
  'NO.7', '天井下がり', '下がり天井', '補強', '式台', '高基礎', '窓', '(H)', 'ドア',
  '(B)', 'ﾗﾝﾏ', '文机', '書院', '建具', 'ﾒﾝ', 'ｸﾛｽ', '化粧', '梁', '表', '本', '内',
  'WF', '小窓', 'ルーフウィンドウ', 'ﾙｰﾌｳｨﾝﾄﾞｳ', 'ぬれ縁', '南欧風霧除',
  'ルーバー手摺', 'ぬき', '抜き', '抜け', 'ぬけ', '飾り棚', '飾ﾘ棚', '天袋', '地袋',
  '書院障子', '踏み込', '踏込', '棟換気', 'FD', 'PL', 'PM', 'BS-', '33B', 'E_',
  '_遮', '_断', '_レ', 'ｿﾘｯﾄﾞｳｯﾄﾞﾊﾟﾈﾙ', 'ｽﾃﾝﾊﾟｲﾌﾟ', 'ｽﾃﾝﾊﾟｲﾌﾟｰ', 'check hood',
  'check slant wall', 'check koshi', 'F2 TD CHECK KAIDAN TWIN PITCH HANDRAIL',
  '24(', '24-', 'VL', 'V-08', 'V-12', 'FY', 'VFM', 'V10', 'VCK', 'V15', 'V-15',
  '吊押', '神棚', '勾配天井', 'E-',
];

const RAW = { Wakugumi: WAKUGUMI, Jikugumi: JIKUGUMI };

export const CATEGORY_NAMES = Object.keys(RAW);

export function isCategory(name) {
  return Object.prototype.hasOwnProperty.call(RAW, name);
}

/** Ordered, de-duplicated term list for a category. */
export function getCategory(name) {
  if (!isCategory(name)) return null;
  return [...new Set(RAW[name])];
}

export function getAllCategories() {
  return CATEGORY_NAMES.map((name) => ({ name, items: getCategory(name) }));
}
