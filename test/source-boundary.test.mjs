import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

// 本地合成来源：按路径返回当前状态，可在两次领取之间改变资料。
async function startStatefulSource() {
  const state = {
    topicRevision: 1,
    modelRevision: 'r1',
    selection: ['c2'],
    exceptions: ['c3'],
    coloring: [{componentId: 'c1', color: '#00ff00'}],
    modelStatus: 200,
    snapshot: 'snapshot-bytes',
    documents: ['/doc/a'],
  };
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const send = (status, body, type = 'application/json') => {
      const bytes = Buffer.from(type === 'application/json' ? JSON.stringify(body) : body);
      response.writeHead(status, {'content-type': type, 'content-length': bytes.length});
      response.end(bytes);
    };
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/issues') return send(200, {topics: ['/topic/1']});
    if (path === '/topic/1') return send(200, {
      topicId: 't1',
      revision: state.topicRevision,
      viewpoints: ['/view/1'],
      documents: state.documents,
    });
    if (path === '/view/1') return send(200, {
      id: 'v1',
      model: {project: 'p', revision: state.modelRevision},
      visibility: {default: true, exceptions: state.exceptions},
      selection: state.selection,
      coloring: state.coloring,
      snapshot: '/snapshot/v1',
    });
    if (path === `/models/p/${state.modelRevision}`) {
      if (state.modelStatus !== 200) return send(state.modelStatus, {error: 'unavailable'});
      return send(200, {components: ['c1', 'c2', 'c3']});
    }
    if (path === '/models/p/r2') return send(200, {components: ['c1', 'c9']});
    if (path === '/snapshot/v1') return send(200, state.snapshot, 'image/png');
    if (path === '/doc/a') return send(200, 'document-body', 'text/plain');
    return send(404, 'missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    state,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

test('选择、显隐、着色分别保留，不互相推导', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  const source = await startStatefulSource();
  try {
    const [record] = (await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'})).records;
    assert.deepEqual(record.selected, ['p/r1/c2']);
    assert.deepEqual(record.visibility, {default: true, exceptions: ['p/r1/c3']});
    assert.deepEqual(record.coloring, [{componentId: 'p/r1/c1', color: '#00ff00'}]);
    // 可见但未选中的 c1 不能因为默认可见就进入 selected。
    assert.equal(record.selected.includes('p/r1/c1'), false);
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('问题单文档与视点截图都经 HTTP 领取并作为原文归档', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attachments-'));
  const source = await startStatefulSource();
  try {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.ok(source.requests.includes('/snapshot/v1'));
    assert.ok(source.requests.includes('/doc/a'));
    const [record] = result.records;
    assert.equal(record.snapshot.hash, archive.snapshot().evidence.find(item => item.url.endsWith('/snapshot/v1')).hash);
    assert.equal(record.documents[0].hash, archive.snapshot().evidence.find(item => item.url.endsWith('/doc/a')).hash);
    const stored = archive.snapshot().evidence.map(item => item.hash);
    assert.ok(stored.includes(record.snapshot.hash));
    assert.ok(stored.includes(record.documents[0].hash));
    assert.equal((await archive.raw(record.snapshot.hash)).toString(), 'snapshot-bytes');
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('状态更新后同 id 增加修订，旧视点仍可回查', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-'));
  const source = await startStatefulSource();
  try {
    await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    source.state.topicRevision = 2;
    source.state.selection = ['c1'];
    await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});

    const archive = await openArchive(directory);
    const versions = archive.history('topic:t1/viewpoint:v1');
    assert.equal(versions.length, 2);
    assert.deepEqual(versions[0].selected, ['p/r1/c2']);
    assert.equal(versions[0].topicRevision, 1);
    assert.deepEqual(versions[1].selected, ['p/r1/c1']);
    assert.equal(versions[1].topicRevision, 2);
    assert.equal(archive.latest('topic:t1/viewpoint:v1').topicRevision, 2);
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('旧模型版本缺失时不回退同名的当前版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'no-fallback-'));
  const source = await startStatefulSource();
  try {
    source.state.modelRevision = 'r2';
    source.state.modelStatus = 404;
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    // 明确请求的是视点所指版本；不得改用 r1 或其他同名构件顶替。
    assert.ok(source.requests.includes('/models/p/r2'));
    assert.equal(source.requests.includes('/models/p/r1'), false);
    const [record] = result.records;
    assert.equal(record.model.revision, 'r2');
    assert.deepEqual(record.selected, []);
    // selection（c2、c3）与 coloring（c1）都无法在缺失的 r2 索引中确认。
    assert.deepEqual(record.unresolvedComponents.sort(), ['p/r2/c1', 'p/r2/c2', 'p/r2/c3']);
    assert.ok(result.unresolved.some(item => item.kind === 'model' && item.modelKey === 'p/r2'));
    assert.ok(result.issues.every(item => item.reference !== 'p/r1/c1'));
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('重复导入同一待补资料缺口不重复记账', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issues-dedupe-'));
  const source = await startStatefulSource();
  try {
    source.state.modelStatus = 404;
    source.state.modelRevision = 'r2';
    for (let iteration = 0; iteration < 2; iteration++) {
      await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    }
    const archive = await openArchive(directory);
    assert.equal(archive.snapshot().records.length, 1);
    const unresolved = archive.snapshot().issues.filter(item => item.code === 'unresolved-component');
    assert.equal(new Set(unresolved.map(item => item.reference)).size, unresolved.length);
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});
