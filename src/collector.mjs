import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {createSourceCollector} from './source.mjs';

export async function collect({baseUrl, archive, mode = 'legacy'}) {
  if (mode === 'source') return createSourceCollector({baseUrl, archive}).collect();
  if (mode !== 'legacy') throw new Error(`不支持来源模式：${mode}`);
  const transport = createTransport(baseUrl);
  const response = await transport.request('/legacy');
  if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
  const records = [normalizeLegacy(response.json())];
  await archive.commit({records, exchanges: transport.exchanges});
  return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
}
