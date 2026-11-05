/** 大文件落盘并保留断点；只在完整读完后发布缓存，网络断开不会变成一个损坏的“已下载”文件。 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function downloadCached(url, file, { signal, onProgress, stage = 'download', detail = '正在下载',
  attempts = 3, timeoutMs = 300_000, fetchImpl = fetch, retryMs = 1000 } = {}) {
  signal?.throwIfAborted();
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.part`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let fd;
    try {
      signal?.throwIfAborted();
      let received = existsSync(partial) ? statSync(partial).size : 0;
      const response = await fetchImpl(url, { headers: received ? { range: `bytes=${received}-` } : {},
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (response.status === 206 && (!range || Number(range[1]) !== received)) throw new Error('下载断点范围不匹配');
      if (response.status !== 206) received = 0;
      const total = range ? Number(range[3]) : Number(response.headers.get('content-length')) || undefined;
      fd = openSync(partial, received ? 'a' : 'w');
      let last = 0;
      const report = () => onProgress?.({ stage, detail, received, total, attempt });
      report();
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        writeSync(fd, chunk);
        received += chunk.length;
        if (Date.now() - last > 300) { report(); last = Date.now(); }
      }
      if (total && total !== received) throw new Error(`下载不完整 (${received}/${total})`);
      closeSync(fd); fd = undefined;
      renameSync(partial, file);
      report();
      return readFileSync(file);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      signal?.throwIfAborted();
      if (attempt === attempts) throw new Error(`${detail}失败（已尝试 ${attempts} 次，缓存已保留）：${error.cause?.code || error.message}`);
      onProgress?.({ stage, detail: `${detail}：连接中断，准备第 ${attempt + 1}/${attempts} 次重试`, attempt });
      await sleep(retryMs * attempt, undefined, { signal });
    }
  }
}
