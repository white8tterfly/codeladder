// 自测脚本（Node 环境运行，不依赖 VS Code）：
// 读取演示代码，走完整「解析 → 语义单元 → 四档投影」链路并打印结果。
// 用法：node out/selftest.js [文件] [语言] [zh|en]

import * as fs from 'fs';
import * as path from 'path';
import { ensureParser, parseSource } from './parser/tree';
import { deriveSemanticUnits } from './parser/semantic';
import { buildProjection } from './projector/projector';
import type { LanguageId } from './lang/languages';
import { fromExtension } from './lang/languages';
import type { Lang } from './i18n';

async function main(): Promise<void> {
  const demo = process.argv[2]
    ?? path.join(__dirname, '..', '..', '0-min-checkpoint-reducer.py');
  const source = fs.readFileSync(demo, 'utf8');
  const dot = demo.lastIndexOf('.');
  const language = (process.argv[3] as LanguageId | undefined)
    ?? (dot >= 0 ? fromExtension(demo.slice(dot)) : undefined)
    ?? 'python';
  const uiLang: Lang = process.argv[4] === 'en' ? 'en' : 'zh';

  await ensureParser(language);
  const parsed = parseSource(language, source);
  const units = deriveSemanticUnits(parsed.root, language);
  const payload = buildProjection(units, source, { lang: uiLang });

  console.log(`解析文件: ${demo}（语言: ${language}）`);
  console.log(`语义单元数量: ${units.length}`);
  console.log('='.repeat(70));

  const tierNames: Record<string, string> = uiLang === 'en'
    ? { L1: 'Intent', L2: 'Steps', L3: 'Logic', L4: 'Code' }
    : { L1: '意图', L2: '步骤', L3: '逻辑', L4: '代码' };
  const tiers = ['L1', 'L2', 'L3', 'L4'] as const;

  units.forEach((u, i) => {
    const lr = u.lines.map((r) => (r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`)).join(',');
    console.log(`#${i} [${lr}] ${u.facts.kind}  ${u.facts.name ?? u.facts.target ?? ''}`);
  });

  console.log('='.repeat(70));
  for (const t of tiers) {
    console.log(`\n--- ${t} ${tierNames[t]} ---`);
    payload.tiers[t].forEach((b) => {
      const fid = b.fidelity === 'ai' ? 'AI' : b.fidelity === 'inferred' ? 'INF' : 'OK';
      const lr = b.lines.map((r) => (r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`)).join(',');
      const content = b.content.replace(/\n/g, ' / ');
      console.log(`  [${fid}][${lr}] ${b.title}: ${content}`);
    });
  }

  parsed.tree.delete();
}

main().catch((e) => {
  console.error('自测失败:', e);
  process.exit(1);
});
