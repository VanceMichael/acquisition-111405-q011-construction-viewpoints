import {digest} from './archive.mjs';

const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

function createIssue(code, message, location, context) {
  const issue = {code, message, location};
  if (context !== undefined) issue.context = context;
  return issue;
}

/**
 * 新来源（问题单/视点/附件）领取。
 * 选中、显隐、着色是三套互不包含的语义集合，分别落库；无法在来源声明的模型版本上
 * 确认的构件引用进入 unresolvedComponents，绝不拿其他模型版本顶替。
 */
export async function collectSource({transport, archive}) {
  const issues = [];
  const records = [];
  // 同一模型版本在一次领取中只索引一次，负结果同样缓存，保证遍历有界。
  const modelCache = new Map();

  const safeRequest = async path => {
    try {
      return await transport.request(path);
    } catch (error) {
      return {failed: true, error, status: 0, ok: false, bytes: Buffer.alloc(0), headers: new Headers()};
    }
  };

  const readAttachment = async (href, kind) => {
    const response = await safeRequest(href);
    if (response.failed) {
      issues.push(createIssue('attachment-unavailable', '附件来源不可达或链接越界', href, {kind}));
      return null;
    }
    if (!response.ok) {
      issues.push(createIssue('attachment-unavailable', '附件响应状态异常', href, {kind, status: response.status}));
      return null;
    }
    return {
      kind,
      href,
      hash: digest(response.bytes),
      mediaType: response.headers.get('content-type') ?? null,
      byteLength: response.bytes.length
    };
  };

  // 仅按来源声明的 project/revision 取模型索引；404 就是缺失，不构造任何回退链接。
  const readModel = async (project, revision) => {
    const modelKey = `${project}/${revision}`;
    const cached = modelCache.get(modelKey);
    if (cached) return cached;
    const location = `/models/${encodeURIComponent(project)}/${encodeURIComponent(revision)}`;
    const response = await safeRequest(location);
    let model;
    if (response.failed) {
      model = {state: 'unavailable', location};
      issues.push(createIssue('model-unavailable', '模型索引来源不可达', location, {modelKey}));
    } else if (response.status === 404) {
      model = {state: 'missing', location, evidence: {path: location, hash: digest(response.bytes)}};
      issues.push(createIssue('model-missing', '来源未提供该模型版本，禁止回退到其他版本', location, {modelKey, status: 404}));
    } else if (!response.ok) {
      model = {state: 'unavailable', location, evidence: {path: location, hash: digest(response.bytes)}};
      issues.push(createIssue('model-unavailable', '模型索引响应状态异常', location, {modelKey, status: response.status}));
    } else {
      let payload;
      try {
        payload = response.json();
      } catch {
        model = {state: 'malformed', location, evidence: {path: location, hash: digest(response.bytes)}};
        issues.push(createIssue('model-malformed', '模型索引不是有效JSON', location, {modelKey}));
        modelCache.set(modelKey, model);
        return model;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || !Array.isArray(payload.components) || !payload.components.every(isNonEmptyString)) {
        model = {state: 'malformed', location, evidence: {path: location, hash: digest(response.bytes)}};
        issues.push(createIssue('model-malformed', '模型索引缺少components字符串集合', location, {modelKey}));
      } else {
        model = {
          state: 'available',
          location,
          components: new Set(payload.components),
          evidence: {path: location, hash: digest(response.bytes)}
        };
      }
    }
    modelCache.set(modelKey, model);
    return model;
  };

  const issuesResponse = await safeRequest('/issues');
  if (issuesResponse.failed || !issuesResponse.ok) {
    throw new Error(`问题单领取失败：${issuesResponse.failed ? '来源不可达' : `HTTP ${issuesResponse.status}`}`);
  }
  let directory;
  try {
    directory = issuesResponse.json();
  } catch {
    throw new Error('问题单响应不是有效JSON');
  }
  if (!directory || typeof directory !== 'object' || Array.isArray(directory) || !Array.isArray(directory.topics)) {
    throw new Error('问题单响应缺少topics集合');
  }

  const topicHrefs = [];
  directory.topics.forEach((href, index) => {
    if (!isNonEmptyString(href)) {
      issues.push(createIssue('topic-reference-invalid', '问题单中的话题链接不是非空字符串', '/issues', {index}));
    } else {
      topicHrefs.push(href);
    }
  });

  for (const topicHref of topicHrefs) {
    const topicResponse = await safeRequest(topicHref);
    if (topicResponse.failed || !topicResponse.ok) {
      issues.push(createIssue('topic-unavailable', '问题单详情不可领取', topicHref, {status: topicResponse.status}));
      continue;
    }
    let topic;
    try {
      topic = topicResponse.json();
    } catch {
      issues.push(createIssue('topic-malformed', '问题单详情不是有效JSON', topicHref));
      continue;
    }
    if (!topic || typeof topic !== 'object' || Array.isArray(topic)
      || !isNonEmptyString(topic.topicId) || !Array.isArray(topic.viewpoints)) {
      issues.push(createIssue('topic-malformed', '问题单缺少topicId或viewpoints集合', topicHref));
      continue;
    }

    const viewpointHrefs = [];
    topic.viewpoints.forEach((href, index) => {
      if (!isNonEmptyString(href)) {
        issues.push(createIssue('viewpoint-reference-invalid', '视点链接不是非空字符串', topicHref, {index}));
      } else {
        viewpointHrefs.push(href);
      }
    });

    const documentHrefs = [];
    if (topic.documents !== undefined) {
      if (Array.isArray(topic.documents) && topic.documents.every(isNonEmptyString)) {
        documentHrefs.push(...topic.documents);
      } else {
        issues.push(createIssue('topic-documents-invalid', 'documents不是链接字符串集合，不解释为业务事实', topicHref));
      }
    }
    // 问题单级附件只领取一次，再随该单的各视点记录归档引用。
    const documentAttachments = [];
    for (const documentHref of documentHrefs) {
      const attachment = await readAttachment(documentHref, 'document');
      if (attachment) documentAttachments.push(attachment);
    }

    for (const viewpointHref of viewpointHrefs) {
      const viewpointResponse = await safeRequest(viewpointHref);
      if (viewpointResponse.failed || !viewpointResponse.ok) {
        issues.push(createIssue('viewpoint-unavailable', '视点不可领取', viewpointHref, {status: viewpointResponse.status}));
        continue;
      }
      let viewpoint;
      try {
        viewpoint = viewpointResponse.json();
      } catch {
        issues.push(createIssue('viewpoint-malformed', '视点不是有效JSON', viewpointHref));
        continue;
      }
      if (!viewpoint || typeof viewpoint !== 'object' || Array.isArray(viewpoint)
        || !isNonEmptyString(viewpoint.id)
        || !viewpoint.model || typeof viewpoint.model !== 'object'
        || !isNonEmptyString(viewpoint.model.project) || !isNonEmptyString(viewpoint.model.revision)) {
        issues.push(createIssue('viewpoint-malformed', '视点缺少id或model坐标，无法建立构件身份', viewpointHref));
        continue;
      }

      const {project, revision} = viewpoint.model;
      const modelKey = `${project}/${revision}`;
      const model = await readModel(project, revision);

      // visibility：default 布尔 + exceptions 对默认值取反；结构不符就整组不解释。
      let visibilitySource = null;
      if (viewpoint.visibility !== undefined) {
        const candidate = viewpoint.visibility;
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          && typeof candidate.default === 'boolean'
          && Array.isArray(candidate.exceptions) && candidate.exceptions.every(isNonEmptyString)) {
          visibilitySource = candidate;
        } else {
          issues.push(createIssue('visibility-invalid', 'visibility结构不符合契约，不解释为业务事实', viewpointHref));
        }
      }

      // selection：协调员明确选中的构件，与可见性没有任何包含关系。
      let rawSelection = [];
      if (viewpoint.selection !== undefined) {
        if (Array.isArray(viewpoint.selection) && viewpoint.selection.every(isNonEmptyString)) {
          rawSelection = viewpoint.selection;
        } else {
          issues.push(createIssue('selection-invalid', 'selection不是构件标识字符串集合，不解释为业务事实', viewpointHref));
        }
      }

      // coloring：逐条保留颜色与构件集合，畸形条目不猜测、不入业务结果。
      let rawColoring = [];
      if (viewpoint.coloring !== undefined) {
        if (Array.isArray(viewpoint.coloring)) {
          rawColoring = viewpoint.coloring.filter(entry => {
            const wellFormed = entry && typeof entry === 'object' && !Array.isArray(entry)
              && isNonEmptyString(entry.color)
              && Array.isArray(entry.components) && entry.components.every(isNonEmptyString);
            if (!wellFormed) {
              issues.push(createIssue('coloring-invalid', 'coloring条目结构不符合契约，不解释为业务事实', viewpointHref));
            }
            return wellFormed;
          });
        } else {
          issues.push(createIssue('coloring-invalid', 'coloring不是集合，不解释为业务事实', viewpointHref));
        }
      }

      // snapshot 只可能是附件链接，永远不会被当成构件清单。
      let snapshotHref = null;
      if (viewpoint.snapshot !== undefined && viewpoint.snapshot !== null) {
        if (isNonEmptyString(viewpoint.snapshot)) {
          snapshotHref = viewpoint.snapshot;
        } else {
          issues.push(createIssue('snapshot-invalid', 'snapshot不是附件链接，且不会被当作构件清单', viewpointHref));
        }
      }

      const unresolvedSet = new Set();
      const unresolvedList = [];
      const noteUnresolved = ref => {
        if (!unresolvedSet.has(ref)) {
          unresolvedSet.add(ref);
          unresolvedList.push(ref);
        }
      };
      // 身份坐标完全由来源声明给出；是否能在该模型版本的索引中确认是另一回事。
      const qualify = componentId => {
        const ref = `${modelKey}/${componentId}`;
        if (model.state === 'available' && model.components.has(componentId)) return ref;
        noteUnresolved(ref);
        return null;
      };

      const selected = [];
      for (const componentId of rawSelection) {
        const confirmed = qualify(componentId);
        if (confirmed) selected.push(confirmed);
      }

      let visibility = undefined;
      if (visibilitySource) {
        const exceptions = [];
        for (const componentId of visibilitySource.exceptions) {
          const confirmed = qualify(componentId);
          if (confirmed) exceptions.push(confirmed);
        }
        visibility = {default: visibilitySource.default, exceptions};
      }

      const coloring = rawColoring.map(entry => ({
        color: entry.color,
        components: entry.components.map(componentId => qualify(componentId)).filter(Boolean)
      }));

      if (unresolvedList.length > 0) {
        issues.push(createIssue(
          'components-unresolved',
          '存在暂时无法确认的构件引用，请协调员补充模型或构件资料',
          viewpointHref,
          {modelKey, modelState: model.state, components: [...unresolvedList]}
        ));
      }

      const attachments = [];
      if (snapshotHref) {
        const snapshot = await readAttachment(snapshotHref, 'snapshot');
        if (snapshot) attachments.push(snapshot);
      }
      attachments.push(...documentAttachments);

      const evidence = [
        {rel: 'topic', path: topicHref, hash: digest(topicResponse.bytes)},
        {rel: 'viewpoint', path: viewpointHref, hash: digest(viewpointResponse.bytes)}
      ];
      if (model.evidence) evidence.push({rel: 'model', ...model.evidence});

      const record = {
        id: `${topic.topicId}/${viewpoint.id}`,
        topicId: topic.topicId,
        topicRevision: topic.revision,
        viewpointId: viewpoint.id,
        modelKey,
        model: {project, revision},
        selected,
        coloring,
        unresolvedComponents: unresolvedList,
        attachments,
        evidence
      };
      if (visibility) record.visibility = visibility;
      records.push(record);
    }
  }

  await archive.commit({records, exchanges: transport.exchanges, issues});
  return {
    records,
    complete: issues.length === 0,
    issues,
    evidenceCount: transport.exchanges.length
  };
}
