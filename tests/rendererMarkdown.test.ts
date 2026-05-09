import { describe, expect, it } from 'vitest';
import { normalizeMarkdownForRender, renderMarkdownToHtml } from '../src/renderer/markdown.js';

function render(input: string): string {
  return renderMarkdownToHtml(normalizeMarkdownForRender(input));
}

describe('renderer markdown tables', () => {
  it('keeps escaped pipes inside table cells', () => {
    const input = [
      '| Name | Notes |',
      '| --- | --- |',
      '| Alpha | left \\| right |'
    ].join('\n');

    const html = render(input);

    expect(html).toContain('<table class="msg-table">');
    expect(html).toContain('<td>left | right</td>');
    expect(html).not.toContain('<td>right</td>');
  });

  it('keeps inline code pipes inside a single table cell', () => {
    const input = [
      '| Command | Result |',
      '| --- | --- |',
      '| `npm run a | b` | ok |'
    ].join('\n');

    const html = render(input);

    expect(html).toContain('<code>npm run a | b</code>');
    expect(html).toContain('<td><code>npm run a | b</code></td><td>ok</td>');
  });

  it('renders markdown table output as a stable html snapshot', () => {
    const input = [
      'Before table',
      '',
      '| Name | Score | Notes |',
      '| :--- | ---: | :---: |',
      '| Alpha | 42 | **ok** |',
      '| Beta | 7 | `npm run a | b` |',
      '',
      'After table'
    ].join('\n');

    expect(render(input)).toMatchInlineSnapshot(`"<p>Before table</p><div class="msg-table-wrap"><table class="msg-table"><thead><tr><th style="text-align:left">Name</th><th style="text-align:right">Score</th><th style="text-align:center">Notes</th></tr></thead><tbody><tr><td style="text-align:left">Alpha</td><td style="text-align:right">42</td><td style="text-align:center"><strong>ok</strong></td></tr><tr><td style="text-align:left">Beta</td><td style="text-align:right">7</td><td style="text-align:center"><code>npm run a | b</code></td></tr></tbody></table></div><p>After table</p>"`);
  });

  it('keeps table section rows with empty cells inside the table', () => {
    const input = [
      '---',
      '',
      '## 五、预算明细（按2人计算）',
      '',
      '| 项目 | 单价 | 数量 | 小计 | 备注 |',
      '|------|------|------|------|------|',
      '| **交通** | | | | |',
      '| 高铁往返 | ¥784/人 | 2人×2程 | ¥3,136 | 北京西↔成都东 |',
      '| 市内交通 | ¥50/天 | 5天 | ¥250 | 地铁/打车 |',
      '| **住宿** | | | | |',
      '| 酒店 | ¥150/晚 | 4晚 | ¥600 | 经济型酒店 |',
      '| **门票** | | | | |',
      '| 大熊猫基地 | ¥55/人 | 2人 | ¥110 | |',
      '| 都江堰 | ¥80/人 | 2人 | ¥160 | |',
      '| 青城山 | ¥80/人 | 2人 | ¥160 | |',
      '| 杜甫草堂 | ¥50/人 | 2人 | ¥100 | |',
      '| 武侯祠 | ¥50/人 | 2人 | ¥100 | |',
      '| **餐饮** | ¥150/天 | 5天 | ¥750 | 2人每日 |',
      '| **合计** | | | **¥5,366** | 人均约¥2,683 |',
      '',
      '---'
    ].join('\n');

    const html = render(input);

    expect(html).toContain('<td><strong>交通</strong></td><td></td><td></td><td></td><td></td>');
    expect(html).toContain('<td><strong>住宿</strong></td><td></td><td></td><td></td><td></td>');
    expect(html).toContain('<td>大熊猫基地</td><td>¥55/人</td><td>2人</td><td>¥110</td><td></td>');
    expect(html).toContain('<td><strong>合计</strong></td><td></td><td></td><td><strong>¥5,366</strong></td><td>人均约¥2,683</td>');
    expect(html.match(/<tr>/g)).toHaveLength(14);
  });

  it('renders the full markdown table example used in chat replies', () => {
    const input = [
      '# Markdown 表格示例',
      '',
      '## 基本表格',
      '',
      '| 姓名 | 年龄 | 城市 | 职业 |',
      '|------|------|------|------|',
      '| 张三 | 28 | 北京 | 工程师 |',
      '| 李四 | 32 | 上海 | 设计师 |',
      '| 王五 | 25 | 广州 | 产品经理 |',
      '',
      '## 带对齐的表格',
      '',
      '| 左对齐 | 居中对齐 | 右对齐 |',
      '|:-------|:--------:|-------:|',
      '| 苹果 | 香蕉 | 橙子 |',
      '| 红色 | 黄色 | 橙色 |',
      '| ¥5 | ¥8 | ¥10 |',
      '',
      '## 表格语法说明',
      '',
      '```markdown',
      '| 列1 | 列2 | 列3 |',
      '|-----|-----|-----|',
      '| 内容 | 内容 | 内容 |',
      '```',
      '',
      '**对齐方式：**',
      '- `:---` 左对齐（默认）',
      '- `:---:` 居中对齐',
      '- `---:` 右对齐',
      '',
      '需要我帮你创建特定内容的表格吗？ 测试这个markdown 的显示'
    ].join('\n');

    expect(render(input)).toMatchInlineSnapshot(`
      "<h1>Markdown 表格示例</h1><h2>基本表格</h2><div class="msg-table-wrap"><table class="msg-table"><thead><tr><th>姓名</th><th>年龄</th><th>城市</th><th>职业</th></tr></thead><tbody><tr><td>张三</td><td>28</td><td>北京</td><td>工程师</td></tr><tr><td>李四</td><td>32</td><td>上海</td><td>设计师</td></tr><tr><td>王五</td><td>25</td><td>广州</td><td>产品经理</td></tr></tbody></table></div><h2>带对齐的表格</h2><div class="msg-table-wrap"><table class="msg-table"><thead><tr><th style="text-align:left">左对齐</th><th style="text-align:center">居中对齐</th><th style="text-align:right">右对齐</th></tr></thead><tbody><tr><td style="text-align:left">苹果</td><td style="text-align:center">香蕉</td><td style="text-align:right">橙子</td></tr><tr><td style="text-align:left">红色</td><td style="text-align:center">黄色</td><td style="text-align:right">橙色</td></tr><tr><td style="text-align:left">¥5</td><td style="text-align:center">¥8</td><td style="text-align:right">¥10</td></tr></tbody></table></div><h2>表格语法说明</h2><pre class="msg-code-block"><code>
      | 列1 | 列2 | 列3 |
      |-----|-----|-----|
      | 内容 | 内容 | 内容 |</code></pre><p><strong>对齐方式：</strong></p><ul><li><code>:---</code> 左对齐（默认）</li><li><code>:---:</code> 居中对齐</li><li><code>---:</code> 右对齐</li></ul><p>需要我帮你创建特定内容的表格吗？ 测试这个markdown 的显示</p>"
    `);
  });
});
