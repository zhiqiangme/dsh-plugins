import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BUNDLE = '@zhiqiangme/dsh-tavily-search';
const DEFAULT_SEARCH = 'deepseek-search-api';
const LEGACY_CREDENTIAL = 'DSH_TAVILY_SEARCH_PLACEHOLDER';

function bundleSelected(dir) {
  // startedBundles 只记录宿主启动时的组合。热安装后以 profile 清单为准。
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return manifest.dsh?.profile?.bundles?.includes(BUNDLE) === true;
}

function canSelectTavily(configuration, web, current, resolved) {
  if (Object.hasOwn(web.override, 'searchProvider') ||
      web.inherited.searchProvider !== DEFAULT_SEARCH ||
      current.searchProvider !== DEFAULT_SEARCH ||
      process.env.DSH_WEB_SEARCH_PROVIDER !== undefined) return false;

  // 旧版 Tavily 接入和单独配置过的 DeepSeek Search API 都是已有的使用方式。
  for (const { entry, override } of configuration) {
    switch (entry.options.id) {
      case 'web-deepseek-api':
        if (override.searchBaseURL || override.searchApiKeyEnv ||
            override.apiKeyEnv === LEGACY_CREDENTIAL || override.baseURL === resolved.apiEndpoint) return false;
        break;
      case 'web-search-deepseek':
        if (override.apiKeyEnv === LEGACY_CREDENTIAL || override.baseURL === resolved.endpoint) return false;
        break;
    }
  }
  return true;
}

/** 每个 profile 首次加载时处理一次，保留用户之后在任一设置页做出的选择。 */
export async function autoConnect({ profile, editor, providerId, resolved, signal }) {
  // 临时 overlay 装载的提供方不能写成持久默认值。
  if (!profile?.dir || typeof editor?.configuration !== 'function' || typeof editor.edit !== 'function') return;
  const marker = join(profile.dir, '.dsh-tavily-search-initialized');
  if (signal.aborted || existsSync(marker) || !bundleSelected(profile.dir)) return;

  const entries = editor.configuration();
  const web = entries.find(({ entry }) => entry.options.name === '@deepseek-ai/dsh-web' && entry.options.id === 'web');
  if (!web) return;
  if (canSelectTavily(entries, web, web.entry.options.config ?? {}, resolved)) {
    const skipped = new Error('Search settings changed during Tavily setup');
    try {
      await editor.edit(web.entry, (current) => {
        // change 在 DSH 的 profile 锁内运行，安装期间保存的新设置优先。
        if (signal.aborted || existsSync(marker) || !bundleSelected(profile.dir)) throw skipped;
        const latest = editor.configuration();
        const active = latest.find(({ entry }) => entry === web.entry);
        if (!active || !canSelectTavily(latest, active, current, resolved)) throw skipped;
        return { ...current, searchProvider: providerId };
      });
    } catch (error) {
      if (error !== skipped) throw error;
      if (signal.aborted || !bundleSelected(profile.dir)) return;
    }
  }

  // 只有读取到已有选择或成功保存后才标记，保存失败可以在下次加载时重试。
  try {
    await writeFile(marker, '', { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}
