import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('source text encoding', () => {
  it('keeps native context menu labels readable', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'main.ts'), 'utf8');

    for (const label of ['撤销', '重做', '剪切', '复制', '粘贴', '删除', '全选', '打开链接', '复制链接地址']) {
      expect(source).toContain(label);
    }
    for (const mojibake of ['澶嶅埗', '绮樿创', '鎵撳紑', '鍓垏', '鍒犻櫎', '濯掍綋', '鍥剧墖']) {
      expect(source).not.toContain(mojibake);
    }
  });
});
