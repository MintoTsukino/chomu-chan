// ちょむちゃん 1ファイル版ビルダー
// 使い方: node build.mjs  →  chomu.html が生成される（ダブルクリックで動く版）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// dict/ を全部読んで埋め込みオブジェクトを作る（engine.jsのloadDictと同じ形）
const D = { rules: [], words: null, tpl: null, fb: null };
const dictFiles = [];
for (const sub of ['innate', 'topics', 'core']) {
  for (const f of fs.readdirSync(path.join(ROOT, 'dict', sub)).filter(f => f.endsWith('.json')).sort()) {
    dictFiles.push(`${sub}/${f}`);
    const j = JSON.parse(read(`dict/${sub}/${f}`));
    if (f === 'words.json') D.words = j;
    else if (f === 'templates.json') D.tpl = j;
    else if (f === 'fallback.json') D.fb = j;
    else D.rules.push(j);
  }
}

const engine = read('engine.js');
let html = read('index.html');

// <script src="engine.js"> を 辞書埋め込み＋エンジン本体 に置き換え
html = html.replace(
  '<script src="engine.js"></script>',
  `<script>window.CHOMU_DICT = ${JSON.stringify(D)};</script>\n<script>\n${engine}\n</script>`
);

fs.writeFileSync(path.join(ROOT, 'chomu.html'), html);
const kb = (fs.statSync(path.join(ROOT, 'chomu.html')).size / 1024).toFixed(1);
console.log(`✅ chomu.html を生成したじょ！（${kb} KB）`);
console.log(`   辞書: ${dictFiles.join(', ')}`);
