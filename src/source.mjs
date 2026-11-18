import {digest} from './archive.mjs';
import {createTransport} from './transport.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim() !== '';
const isRevision = value => isText(value) || (typeof value === 'number' && Number.isFinite(value));
const revisionText = value => String(value);

function attachmentHref(reference) {
  // 附件由链接引用；兼容来源用裸链接或带 href/url 的链接对象表达。
  if (isText(reference)) return reference;
  if (!isObject(reference)) return null;
  if (isText(reference.href)) return reference.href;
  if (isText(reference.url)) return reference.url;
  return null;
}

function attachmentExtras(reference) {
  if (!isObject(reference)) return {};
  return structuredClone(reference);
}

function parseComponent(reference, modelKey) {
  // 契约声明构件身份含 componentId；同时兼容来源以裸标识给出构件。
  // 构件身份由模型版本+构件共同确定；模型版本不明时保留原始标识，不补全出
  // 看起来可确认的限定名。
  const qualify = componentId => modelKey === null ? componentId : `${modelKey}/${componentId}`;
  if (isText(reference)) {
    const qualified = qualify(reference);
    return {componentId: reference, qualified, value: qualified};
  }
  if (!isObject(reference) || !isText(reference.componentId)) return null;
  const qualified = qualify(reference.componentId);
  // 保留着色等来源已给出的附加字段，只把构件身份限定到模型版本。
  return {
    componentId: reference.componentId,
    qualified,
    value: {...structuredClone(reference), componentId: qualified},
  };
}

/**
 * 领取新来源的问题单、视点、模型索引与附件。
 *
 * 视点是模型版本的引用，不是截图里的构件快照：selection、visibility、
 * coloring 必须分别保留。模型索引缺失时只记录无法确认的引用，绝不回退到
 * 其他版本。所有原文都经 transport 实际接收，由 archive 按内容寻址保存。
 */
export function createSourceCollector({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const records = [];
  const issues = [];
  const unresolved = [];
  const unresolvedSeen = new Set();
  const models = new Map();
  const attachments = new Map();
  let complete = true;

  const absolute = path => new URL(path, transport.origin).href;
  const safeAbsolute = path => {
    if (!isText(path)) return null;
    try { return absolute(path); } catch { return null; }
  };

  function issue(code, message, details = {}) {
    complete = false;
    issues.push({code, message, ...details});
  }

  function gap(entry) {
    complete = false;
    const key = `${entry.kind}\u0000${entry.topicId ?? ''}\u0000${entry.viewpointId ?? ''}\u0000${entry.modelKey ?? ''}\u0000${entry.reference ?? ''}`;
    if (unresolvedSeen.has(key)) return;
    unresolvedSeen.add(key);
    const {suppressIssue = false, ...details} = entry;
    unresolved.push(details);
    if (suppressIssue) return;
    const label = entry.kind === 'model' ? '模型版本' : entry.kind === 'component' ? '构件' : '附件';
    issues.push({
      code: `unresolved-${entry.kind}`,
      message: `${label} ${entry.reference ?? '(未给出)'} 暂时无法确认：${entry.reason}`,
      url: entry.url ?? null,
      method: 'GET',
      status: entry.status ?? null,
      topicId: entry.topicId ?? null,
      viewpointId: entry.viewpointId ?? null,
      modelKey: entry.modelKey ?? null,
      reference: entry.reference ?? null,
      role: entry.role ?? null,
      reason: entry.reason,
    });
  }

  async function requestJson(path, {label, code, ...context}) {
    let response;
    try {
      response = await transport.request(path);
    } catch (error) {
      issue(`${code}-request-failed`, `${label}请求失败：${error.message}`, {
        url: safeAbsolute(path), method: 'GET', status: null, ...context,
      });
      return {ok: false, status: null, payload: null};
    }
    if (!response.ok) {
      issue(`${code}-unavailable`, `${label}返回 HTTP ${response.status}`, {
        url: safeAbsolute(path), method: 'GET', status: response.status, ...context,
      });
      return {ok: false, status: response.status, payload: null};
    }
    try {
      return {ok: true, status: response.status, payload: response.json()};
    } catch {
      issue(`${code}-invalid-json`, `${label}不是有效 JSON`, {
        url: safeAbsolute(path), method: 'GET', status: response.status, ...context,
      });
      return {ok: false, status: response.status, payload: null};
    }
  }

  async function loadModel(project, revision, context) {
    const key = `${project}\u0000${revisionText(revision)}`;
    if (models.has(key)) return models.get(key);
    const modelKey = `${project}/${revisionText(revision)}`;
    const path = `/models/${encodeURIComponent(project)}/${encodeURIComponent(revisionText(revision))}`;
    const model = {modelKey, path, url: safeAbsolute(path), components: null, status: null};
    models.set(key, model);

    const outcome = await requestJson(path, {
      label: `模型索引 ${modelKey}`, code: 'model', ...context, modelKey,
    });
    model.status = outcome.status;
    if (!outcome.ok) {
      return model;
    }
    const payload = outcome.payload;
    if (!isObject(payload) || !Array.isArray(payload.components)) {
      issue('model-invalid-shape', `模型索引 ${modelKey} 缺少 components 数组`, {
        url: model.url, method: 'GET', status: 200, ...context, modelKey,
      });
      return model;
    }
    const components = new Set();
    for (const component of payload.components) {
      const componentId = isText(component) ? component : isObject(component) && isText(component.componentId) ? component.componentId : null;
      if (componentId !== null) components.add(componentId);
      else issue('model-component-invalid', `模型索引 ${modelKey} 含无效构件标识`, {
        url: model.url, method: 'GET', status: 200, ...context, modelKey, value: component,
      });
    }
    // 只有来源明确返回 200 且结构有效时才把该索引视为可确认的构件全集。
    model.components = components;
    return model;
  }

  async function loadAttachment(reference, context) {
    const href = attachmentHref(reference);
    const extras = attachmentExtras(reference);
    if (!href) {
      issue('attachment-reference-invalid', '附件引用缺少可用链接', {...context, value: reference});
      return null;
    }
    if (attachments.has(href)) return attachments.get(href);

    let url;
    try {
      url = absolute(href);
    } catch {
      issue('attachment-reference-invalid', '附件引用无法解析为来源地址', {...context, href, value: reference});
      attachments.set(href, null);
      return null;
    }

    let response;
    try {
      response = await transport.request(href);
    } catch (error) {
      issue('attachment-request-failed', `附件请求失败：${error.message}`, {
        ...context, ...extras, href, url, method: 'GET', status: null,
      });
      attachments.set(href, null);
      return null;
    }
    if (!response.ok) {
      issue('attachment-unavailable', `附件返回 HTTP ${response.status}`, {
        ...context, ...extras, href, url, method: 'GET', status: response.status,
      });
      attachments.set(href, null);
      return null;
    }
    const metadata = {
      ...extras,
      href,
      url,
      method: 'GET',
      status: response.status,
      contentType: response.headers.get('content-type') ?? null,
      size: response.bytes.length,
      hash: digest(response.bytes),
    };
    attachments.set(href, metadata);
    return metadata;
  }

  async function collectTopic(topicHref) {
    const outcome = await requestJson(topicHref, {label: '问题单', code: 'topic', reference: topicHref});
    if (!outcome.ok) return;
    const topic = outcome.payload;
    if (!isObject(topic)) {
      issue('topic-invalid-shape', '问题单不是对象', {url: safeAbsolute(topicHref), method: 'GET', status: 200, reference: topicHref});
      return;
    }
    if (!isText(topic.topicId)) {
      issue('topic-id-missing', '问题单缺少 topicId', {url: safeAbsolute(topicHref), method: 'GET', status: 200, reference: topicHref});
      return;
    }
    const topicId = topic.topicId;
    let topicRevision = null;
    if (isRevision(topic.revision)) topicRevision = topic.revision;
    else issue('topic-revision-missing', `问题单 ${topicId} 缺少可确认的 revision`, {
      url: safeAbsolute(topicHref), method: 'GET', status: 200, topicId,
    });

    let documents = [];
    if (!Array.isArray(topic.documents)) {
      issue('topic-documents-missing', `问题单 ${topicId} 缺少 documents 数组`, {
        url: safeAbsolute(topicHref), method: 'GET', status: 200, topicId,
      });
    } else {
      for (const document of topic.documents) {
        const metadata = await loadAttachment(document, {topicId, role: 'document'});
        documents.push(metadata ?? {
          ...attachmentExtras(document),
          href: attachmentHref(document),
          url: safeAbsolute(attachmentHref(document) ?? ''),
          resolved: false,
        });
      }
    }

    if (!Array.isArray(topic.viewpoints)) {
      issue('topic-viewpoints-missing', `问题单 ${topicId} 缺少 viewpoints 数组`, {
        url: safeAbsolute(topicHref), method: 'GET', status: 200, topicId,
      });
      return;
    }
    const seen = new Set();
    for (const viewpointHref of topic.viewpoints) {
      if (!isText(viewpointHref)) {
        issue('viewpoint-reference-invalid', `问题单 ${topicId} 含无效视点引用`, {
          url: safeAbsolute(topicHref), method: 'GET', status: 200, topicId, value: viewpointHref,
        });
        continue;
      }
      if (seen.has(viewpointHref)) continue;
      seen.add(viewpointHref);
      await collectViewpoint({topicId, topicRevision, viewpointHref, documents});
    }
  }

  async function collectViewpoint({topicId, topicRevision, viewpointHref, documents}) {
    const outcome = await requestJson(viewpointHref, {
      label: '视点', code: 'viewpoint', topicId, reference: viewpointHref,
    });
    if (!outcome.ok) return;
    const viewpoint = outcome.payload;
    if (!isObject(viewpoint)) {
      issue('viewpoint-invalid-shape', '视点不是对象', {
        url: safeAbsolute(viewpointHref), method: 'GET', status: 200, topicId, reference: viewpointHref,
      });
      return;
    }
    if (!isText(viewpoint.id)) {
      issue('viewpoint-id-missing', `问题单 ${topicId} 的视点缺少 id`, {
        url: safeAbsolute(viewpointHref), method: 'GET', status: 200, topicId, reference: viewpointHref,
      });
      return;
    }
    const viewpointId = viewpoint.id;
    const context = {topicId, viewpointId, reference: viewpointHref};

    let model = null;
    let modelKey = null;
    let project = null;
    let modelRevision = null;
    if (isObject(viewpoint.model) && isText(viewpoint.model.project) && isRevision(viewpoint.model.revision)) {
      project = viewpoint.model.project;
      modelRevision = revisionText(viewpoint.model.revision);
      modelKey = `${project}/${modelRevision}`;
      model = await loadModel(project, modelRevision, {topicId, viewpointId, reference: viewpointHref});
      if (model.components === null) {
        // 模型缺口在 issues 中已有 model-* 记录，此处只单列到 unresolved 供补资料。
        gap({
          kind: 'model', modelKey, topicId, viewpointId,
          reference: modelKey,
          url: model.url,
          status: model.status,
          reason: model.status === 200 ? 'model-unconfirmed' : 'model-unavailable',
          suppressIssue: true,
        });
      }
    } else {
      issue('viewpoint-model-missing', `视点 ${viewpointId} 缺少可确认的模型版本`, {
        url: safeAbsolute(viewpointHref), method: 'GET', status: 200, ...context,
      });
      gap({
        kind: 'model', modelKey: null, topicId, viewpointId,
        reference: null,
        url: safeAbsolute(viewpointHref),
        status: 200,
        reason: 'model-version-missing',
        suppressIssue: true,
      });
    }

    // 只列出构件无法确认的引用，供协调员补资料；这些引用不进入 selected 等集合。
    const unresolvedComponents = [];
    const addUnresolved = qualified => {
      if (!unresolvedComponents.includes(qualified)) unresolvedComponents.push(qualified);
    };

    function resolveComponents(references, role) {
      if (!Array.isArray(references)) {
        issue('viewpoint-array-missing', `视点 ${viewpointId} 缺少 ${role} 数组`, {
          url: safeAbsolute(viewpointHref), method: 'GET', status: 200, ...context, role,
        });
        return [];
      }
      const resolved = [];
      const seen = new Set();
      for (const reference of references) {
        const parsed = parseComponent(reference, modelKey);
        if (!parsed) {
          issue('component-reference-invalid', `视点 ${viewpointId} 的 ${role} 含无效构件引用`, {
            url: safeAbsolute(viewpointHref), method: 'GET', status: 200, ...context, role, value: reference,
          });
          continue;
        }
        const confirmedComponents = model?.components ?? null;
        if (confirmedComponents === null || !confirmedComponents.has(parsed.componentId)) {
          addUnresolved(parsed.qualified);
          gap({
            kind: 'component', modelKey, topicId, viewpointId, role,
            reference: parsed.qualified,
            url: model?.url ?? safeAbsolute(viewpointHref),
            status: model?.status ?? null,
            reason: confirmedComponents === null ? 'model-unconfirmed' : 'not-in-model-revision',
          });
          continue;
        }
        const identity = parsed.qualified;
        if (seen.has(identity)) continue;
        seen.add(identity);
        resolved.push(parsed.value);
      }
      return resolved;
    }

    const selection = resolveComponents(viewpoint.selection, 'selection');
    let visibility = null;
    if (isObject(viewpoint.visibility) && typeof viewpoint.visibility.default === 'boolean') {
      visibility = {
        default: viewpoint.visibility.default,
        exceptions: resolveComponents(viewpoint.visibility.exceptions, 'visibility.exceptions'),
      };
    } else {
      issue('viewpoint-visibility-invalid', `视点 ${viewpointId} 缺少可确认的 visibility`, {
        url: safeAbsolute(viewpointHref), method: 'GET', status: 200, ...context,
      });
    }
    const coloring = resolveComponents(viewpoint.coloring, 'coloring');

    let snapshot = null;
    if (viewpoint.snapshot !== undefined && viewpoint.snapshot !== null) {
      snapshot = await loadAttachment(viewpoint.snapshot, {...context, role: 'snapshot'});
      if (snapshot === null) {
        snapshot = {
          ...attachmentExtras(viewpoint.snapshot),
          href: attachmentHref(viewpoint.snapshot),
          url: safeAbsolute(attachmentHref(viewpoint.snapshot) ?? ''),
          resolved: false,
        };
      }
    }

    records.push({
      id: `topic:${encodeURIComponent(topicId)}/viewpoint:${encodeURIComponent(viewpointId)}`,
      topicId,
      topicRevision,
      viewpointId,
      modelKey,
      model: modelKey === null ? null : {project, revision: modelRevision},
      modelRevision,
      selected: selection,
      visibility,
      coloring,
      unresolvedComponents,
      documents,
      snapshot,
    });
  }

  async function run() {
    const outcome = await requestJson('/issues', {label: '问题单索引', code: 'issues'});
    if (!outcome.ok) return;
    const index = outcome.payload;
    if (!isObject(index) || !Array.isArray(index.topics)) {
      issue('issues-invalid-shape', '问题单索引缺少 topics 数组', {
        url: safeAbsolute('/issues'), method: 'GET', status: 200,
      });
      return;
    }
    const seen = new Set();
    for (const topicHref of index.topics) {
      if (!isText(topicHref)) {
        issue('topic-reference-invalid', '问题单索引含无效引用', {
          url: safeAbsolute('/issues'), method: 'GET', status: 200, value: topicHref,
        });
        continue;
      }
      if (seen.has(topicHref)) continue;
      seen.add(topicHref);
      await collectTopic(topicHref);
    }
  }

  return {
    async collect() {
      try {
        await run();
      } catch (error) {
        // 已安全领取的部分仍可落库；未解释完的缺口明确留在 issues 中。
        issue('source-collection-failed', `来源领取中断：${error.message}`, {});
      }
      await archive.commit({records, exchanges: transport.exchanges, issues});
      return {records, complete, issues, unresolved, evidenceCount: transport.exchanges.length};
    },
  };
}
