import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource, fixtures} from '../provider/server.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive, digest} from '../src/archive.mjs';

async function withArchive() {
  const directory = await mkdtemp(join(tmpdir(), 'source-edge-'));
  return {directory, archive: await openArchive(directory)};
}

// 最小同源 HTTP 来源，用于表达 scenarios.json 之外的边界响应。
function startStub(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    await handler(request, Buffer.concat(chunks), response);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(done => { server.closeAllConnections(); server.close(done); })
      });
    });
  });
}

const json = (response, status, body) => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {'content-type': 'application/json', 'content-length': bytes.length});
  response.end(bytes);
};

test('空的有效结果：没有问题单时记录为空但领取完整，与错误状态区分', async () => {
  const stub = await startStub((request, body, response) => json(response, 200, {topics: []}));
  const {directory, archive} = await withArchive();
  try {
    const result = await collect({baseUrl: stub.baseUrl, archive, mode: 'source'});
    assert.deepEqual(result.records, []);
    assert.equal(result.complete, true, '空有效结果不等于未决缺口');
    assert.deepEqual(result.issues, []);
    assert.equal(result.evidenceCount, 1);
    const snapshot = archive.snapshot();
    assert.equal(snapshot.records.length, 0);
    assert.equal(snapshot.evidence.length, 1);
  } finally {
    await stub.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('问题单入口错误直接失败，不伪造结果也不冒充摘要来源', async () => {
  const stub = await startStub((request, body, response) => json(response, 500, {error: 'upstream'}));
  const {directory, archive} = await withArchive();
  try {
    await assert.rejects(collect({baseUrl: stub.baseUrl, archive, mode: 'source'}), /问题单领取失败：HTTP 500/);
    assert.equal(archive.snapshot().records.length, 0);
  } finally {
    await stub.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('问题单入口响应畸形按错误处理，不产出任何业务记录', async () => {
  const stub = await startStub((request, body, response) => {
    response.writeHead(200, {'content-type': 'application/json'}).end('{坏');
  });
  const {directory, archive} = await withArchive();
  try {
    await assert.rejects(collect({baseUrl: stub.baseUrl, archive, mode: 'source'}), /不是有效JSON/);
  } finally {
    await stub.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('选中与可见性互不包含：隐藏构件仍可被选中，默认可见不变成选中', async () => {
  const source = await startSource('selection-not-visibility');
  const {directory, archive} = await withArchive();
  try {
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, true);
    const record = result.records[0];
    assert.deepEqual(record.selected, ['p/r1/c2']);
    assert.deepEqual(record.visibility, {default: true, exceptions: ['p/r1/c2']});
    assert.equal(record.selected.length, 1, '默认可见的c1不得因为看得见而进入选中集');
    assert.ok(record.visibility.exceptions.includes('p/r1/c2'));
    assert.ok(record.selected.includes('p/r1/c2'), '被隐藏的c2仍然是协调员选中的问题构件');
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('旧版模型缺失：引用单列未决且禁止回退同名当前模型', async () => {
  const source = await startSource('missing-model');
  const {directory, archive} = await withArchive();
  try {
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    const record = result.records[0];
    assert.deepEqual(record.selected, []);
    assert.deepEqual(record.unresolvedComponents, ['p/old/c1']);
    assert.equal(record.modelKey, 'p/old', '视点锚定来源声明的模型版本');
    const requested = source.requests().map(item => item.path);
    assert.ok(requested.includes('/models/p/old'));
    assert.equal(requested.some(path => path.includes('latest')), false, '不得构造latest回退');
    assert.ok(result.issues.some(issue => issue.code === 'model-missing' && issue.location === '/models/p/old'));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('附件原文内容寻址落库，snapshot 只作证据不参与构件集合', async () => {
  const source = await startSource('attachments-and-coloring');
  const {directory, archive} = await withArchive();
  try {
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    const record = result.records[0];
    assert.equal(record.attachments.length, 2);
    const [snapshot, document] = record.attachments;
    assert.equal(snapshot.kind, 'snapshot');
    assert.equal(snapshot.byteLength, 8);
    assert.equal(snapshot.hash, digest(Buffer.from('89504e470d0a1a0a', 'hex')));
    assert.equal(document.kind, 'document');
    const raw = await archive.raw(snapshot.hash);
    assert.deepEqual([...raw], [...Buffer.from('89504e470d0a1a0a', 'hex')]);
    // 着色集合独立保留，未知构件只进入未决清单
    assert.deepEqual(record.coloring[0], {color: 'red', components: ['p/r1/c2']});
    assert.deepEqual(record.coloring[1], {color: 'blue', components: ['p/r1/c1']});
    assert.deepEqual(record.unresolvedComponents, ['p/r1/c3']);
    assert.ok(result.issues.some(issue => issue.code === 'components-unresolved'));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('重复领取幂等：同一业务记录不重复落库，未决问题保留可复核位置', async () => {
  const source = await startSource('stable-repeated-runs');
  const directory = await mkdtemp(join(tmpdir(), 'source-repeat-'));
  try {
    for (const run of [1, 2]) {
      const reopened = await openArchive(directory);
      const result = await collect({baseUrl: source.baseUrl, archive: reopened, mode: 'source'});
      assert.equal(result.complete, true);
      assert.equal(result.records[0].id, 't1/v1');
    }
    const persisted = await openArchive(directory);
    const snapshot = persisted.snapshot();
    assert.equal(snapshot.records.length, 1, '相同业务身份+内容修订只落一条');
    assert.equal(snapshot.records[0].id, 't1/v1');
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('问题状态更新后旧视点仍可回查：修订留痕而非覆盖旧记录', async () => {
  const source = await startSource('viewpoint-revision-changes');
  const directory = await mkdtemp(join(tmpdir(), 'source-revision-'));
  try {
    const firstArchive = await openArchive(directory);
    const first = await collect({baseUrl: source.baseUrl, archive: firstArchive, mode: 'source'});
    assert.equal(first.records[0].viewpointId, 'v1');
    assert.equal(first.records[0].topicRevision, 1);
    const secondArchive = await openArchive(directory);
    const second = await collect({baseUrl: source.baseUrl, archive: secondArchive, mode: 'source'});
    assert.equal(second.records[0].viewpointId, 'v2');
    assert.equal(second.records[0].topicRevision, 2);
    const persisted = (await openArchive(directory)).snapshot();
    const viewpoints = persisted.records.map(record => record.viewpointId).sort();
    assert.deepEqual(viewpoints, ['v1', 'v2'], '旧视点记录没有被新版覆盖');
    const old = persisted.records.find(record => record.viewpointId === 'v1');
    assert.equal(old.modelKey, 'p/r1');
    assert.deepEqual(old.selected, ['p/r1/c1']);
    // 每条记录都能经 evidence 回到当时的原文
    for (const record of persisted.records) {
      for (const item of record.evidence) {
        assert.ok(persisted.evidence.some(evidence => evidence.hash === item.hash && evidence.url.endsWith(item.path)));
      }
    }
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('未声明字段不自动解释为业务事实：畸形字段只产生带位置的问题', async () => {
  const routes = {
    '/issues': {topics: ['/topic/1']},
    '/topic/1': {topicId: 't1', revision: 1, viewpoints: ['/view/1'], documents: []},
    '/view/1': {id: 'v1', model: {project: 'p', revision: 'r1'}, visibility: {default: 'maybe'}, selection: ['c1'], coloring: [{color: 'red'}], snapshot: 42},
    '/models/p/r1': {components: ['c1']}
  };
  const stub = await startStub((request, body, response) => json(response, 200, routes[new URL(request.url, 'http://x').pathname]));
  const {directory, archive} = await withArchive();
  try {
    const result = await collect({baseUrl: stub.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    const codes = result.issues.map(issue => issue.code).sort();
    assert.ok(codes.includes('visibility-invalid'));
    assert.ok(codes.includes('coloring-invalid'));
    assert.ok(codes.includes('snapshot-invalid'));
    const record = result.records[0];
    assert.equal('visibility' in record, false, '畸形visibility不进入业务结果');
    assert.deepEqual(record.coloring, []);
    assert.deepEqual(record.attachments, []);
    assert.deepEqual(record.selected, ['p/r1/c1'], '独立的合法集合仍保留');
  } finally {
    await stub.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('同一模型版本被多视点共享时只索引一次，遍历保持有界', async () => {
  const source = await startSource('two-viewpoints-share-model');
  const {directory, archive} = await withArchive();
  try {
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.equal(result.records.length, 2);
    const modelRequests = source.requests().filter(item => item.path === '/models/p/r1');
    assert.equal(modelRequests.length, 1);
    const ids = result.records.map(record => record.id).sort();
    assert.deepEqual(ids, ['t1/v1', 't1/v2']);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('附件领取失败不丢失已确认的构件解释，缺口单独列出', async () => {
  const source = await startSource('attachment-missing');
  const {directory, archive} = await withArchive();
  try {
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.deepEqual(result.records[0].selected, ['p/r1/c1']);
    assert.deepEqual(result.records[0].attachments, []);
    assert.ok(result.issues.some(issue => issue.code === 'attachment-unavailable' && issue.location === '/snap/gone'));
    assert.ok(archive.snapshot().evidence.length > 0, '已收到的原文证据仍然保留');
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('所有公开情景都以真实 HTTP 完成领取并通过持久化重开校验', async () => {
  for (const scenario of fixtures) {
    const source = await startSource(scenario.name);
    const directory = await mkdtemp(join(tmpdir(), `source-all-${scenario.name}-`));
    try {
      const runs = scenario.runs ?? 1;
      let result;
      for (let run = 0; run < runs; run++) {
        result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      }
      const reopened = await openArchive(directory);
      const snapshot = reopened.snapshot();
      assert.ok(snapshot.evidence.length > 0, scenario.name);
      for (const record of snapshot.records) {
        assert.ok(record.id && typeof record.id === 'string');
        for (const attachment of record.attachments) {
          assert.ok(/^[a-f0-9]{64}$/.test(attachment.hash));
          assert.equal(digest(await reopened.raw(attachment.hash)), attachment.hash);
        }
      }
      assert.equal(Array.isArray(result.issues), true);
    } finally {
      await source.close();
      await rm(directory, {recursive: true, force: true});
    }
  }
});
