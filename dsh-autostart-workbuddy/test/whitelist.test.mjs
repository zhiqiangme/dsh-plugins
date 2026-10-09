/**
 * 白名单写回测试：Web 面板里点"保存"改的就是这段。
 *
 * 这是"改用户 profile"的第二个入口（另一个是 syncModels 改模型清单），
 * 所以重点覆盖：只动 only 段、其余字节原样、认不出结构就不写、空勾选怎么写。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPluginModelsConfig, updatePluginOnlyList } from '../lib/models.js';

/** 与真实 profile 同构：providers 缩进 4、provider 6、models 8、条目 10。 */
const PATCH = `# 测试用 profile patch（结构与真实文件一致）
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        baseURL: http://127.0.0.1:7863/v1/
        models:
          - id: cn:alpha
            name: CN Alpha 0.11
- id: dsh-autostart-workbuddy
  name: dsh-autostart-workbuddy
  config:
    models:
      enabled: true
      only:
        - cn:alpha
        - global:beta
`;

test('写白名单：只替换 only 段，其余内容逐字节保留', () => {
  const updated = updatePluginOnlyList(PATCH, ['global:beta', 'global:gamma']);
  assert.equal(updated.ok, true);
  assert.equal(updated.changed, true);

  // 另一个插件（llm-pi-ai）的段落与注释原样不动
  assert.ok(updated.text.includes('# 测试用 profile patch（结构与真实文件一致）\n'));
  assert.ok(updated.text.includes('          - id: cn:alpha\n            name: CN Alpha 0.11\n'));
  assert.ok(updated.text.includes('      enabled: true\n'));
  // 新白名单就位，且保持传入顺序
  assert.deepEqual(readPluginModelsConfig(updated.text).only, ['global:beta', 'global:gamma']);
  assert.ok(updated.text.endsWith('\n'));
});

test('写白名单：内容相同判为无变化（changed: false，文件不用重写）', () => {
  const updated = updatePluginOnlyList(PATCH, ['cn:alpha', 'global:beta']);
  assert.equal(updated.ok, true);
  assert.equal(updated.changed, false);
  assert.equal(updated.text, PATCH);
});

test('写白名单：空勾选写成 only: []，读回来是空数组而不是字符串 "[]"', () => {
  const updated = updatePluginOnlyList(PATCH, []);
  assert.equal(updated.ok, true);
  assert.ok(updated.text.includes('      only: []\n'));
  assert.deepEqual(readPluginModelsConfig(updated.text).only, []);
});

test('写白名单：没有 only 段时插到 models 之后', () => {
  const text = `- id: dsh-autostart-workbuddy
  name: dsh-autostart-workbuddy
  config:
    models:
      enabled: true
`;
  const updated = updatePluginOnlyList(text, ['cn:alpha']);
  assert.equal(updated.ok, true);
  assert.equal(updated.changed, true);
  assert.ok(updated.text.includes('    models:\n      only:\n        - cn:alpha\n      enabled: true\n'));
  assert.deepEqual(readPluginModelsConfig(updated.text), { enabled: true, only: ['cn:alpha'] });
});

test('写白名单：CRLF 文件不引入裸 LF', () => {
  const updated = updatePluginOnlyList(PATCH.replace(/\n/g, '\r\n'), ['cn:alpha']);
  assert.equal(updated.ok, true);
  assert.equal(/(?<!\r)\n/.test(updated.text), false);
  assert.ok(updated.text.includes('\r\n      only:\r\n        - cn:alpha\r\n'));
});

test('写白名单：认不出结构就拒绝写', () => {
  const noEntry = updatePluginOnlyList('- id: other\n  name: other\n', ['cn:alpha']);
  assert.equal(noEntry.ok, false);
  assert.match(noEntry.reason, /dsh-autostart-workbuddy/);

  const noModels = updatePluginOnlyList('- id: dsh-autostart-workbuddy\n  name: x\n  config:\n    port: 1\n', ['cn:alpha']);
  assert.equal(noModels.ok, false);
  assert.match(noModels.reason, /config\.models/);
});

test('写白名单：非字符串数组直接拒绝', () => {
  assert.equal(updatePluginOnlyList(PATCH, 'cn:alpha').ok, false);
  assert.equal(updatePluginOnlyList(PATCH, [1, 2]).ok, false);
  assert.equal(updatePluginOnlyList(PATCH, undefined).ok, false);
});
