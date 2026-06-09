import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { RagDocumentRecord, RagDocumentsRepository } from './ragDocuments';
import { ROOT_DIR } from './workspacePaths';

const GRAPH_DIR = path.join('knowledge_base', 'graph');
const GRAPH_CACHE_FILE = path.join(GRAPH_DIR, 'graph-cache.json');

const ExtractBodySchema = z.object({
  force: z.boolean().optional().default(false),
});

const SearchSchema = z.object({
  query: z.string().trim().min(1),
  max_nodes: z.coerce.number().int().min(1).max(30).optional().default(12),
  source_types: z.array(z.string().trim().min(1)).optional(),
  document_ids: z.array(z.string().trim().min(1)).optional(),
});

const DocumentParamsSchema = z.object({
  document_id: z.string().trim().min(1),
});

const NodeParamsSchema = z.object({
  node_id: z.string().trim().min(1),
});

const RelationParamsSchema = z.object({
  relation_id: z.string().trim().min(1),
});

const ListNodesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  node_type: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
});

type GraphNodeType = 'food' | 'nutrient' | 'condition' | 'population' | 'guideline' | 'document' | 'topic';
type GraphRelationType =
  | 'contains'
  | 'affects'
  | 'recommended_for'
  | 'not_recommended_for'
  | 'supports'
  | 'mentions';
type GraphSourceType = 'uploaded_knowledge' | 'mohw_news' | 'nutrition_rules';

export type KnowledgeGraphNode = {
  id: string;
  label: string;
  node_type: GraphNodeType;
  aliases: string[];
  document_ids: string[];
  source_types: GraphSourceType[];
};

export type KnowledgeGraphEdge = {
  id: string;
  source: string;
  target: string;
  relation_type: GraphRelationType;
  confidence: number;
  document_ids: string[];
  evidence_ids: string[];
};

export type KnowledgeGraphEvidence = {
  id: string;
  edge_id: string;
  document_id: string;
  document_title: string;
  source_type: GraphSourceType;
  source_path: string;
  snippet: string;
};

type KnowledgeGraphDocument = {
  id: string;
  title: string;
  source_type: GraphSourceType;
  source_path: string;
  content_hash: string;
  extracted_at: string;
  node_ids: string[];
  edge_ids: string[];
  evidence_ids: string[];
};

type KnowledgeGraphCache = {
  version: 1;
  generated_at: string;
  documents: Record<string, KnowledgeGraphDocument>;
  nodes: Record<string, KnowledgeGraphNode>;
  edges: Record<string, KnowledgeGraphEdge>;
  evidence: Record<string, KnowledgeGraphEvidence>;
};

type KnowledgeGraphSummary = {
  document_count: number;
  node_count: number;
  edge_count: number;
  evidence_count: number;
  source_counts: Record<GraphSourceType, number>;
  generated_at: string | null;
};

type KnowledgeSourceDocument = {
  id: string;
  title: string;
  sourceType: GraphSourceType;
  sourcePath: string;
  absolutePath: string;
  content: string;
};

type RouterOptions = {
  repository?: RagDocumentsRepository | null;
  rootDir?: string;
};

const emptyCache = (): KnowledgeGraphCache => ({
  version: 1,
  generated_at: new Date(0).toISOString(),
  documents: {},
  nodes: {},
  edges: {},
  evidence: {},
});

const normalizeText = (value: string): string => value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
const hashText = (value: string): string => createHash('sha1').update(value).digest('hex');
const toArrayUnique = <T>(values: T[]): T[] => Array.from(new Set(values));
const safeLower = (value: string): string => value.trim().toLowerCase();
const resolveAbsolutePath = (rootDir: string, relativePath: string): string =>
  path.resolve(rootDir, relativePath.replace(/\//g, path.sep));

const parseAdminIdentity = (req: Request): { userId: string; role: 'admin' | 'nutritionist' } | null => {
  const headerUserId = String(req.headers['x-admin-user-id'] || '').trim();
  const headerRole = String(req.headers['x-admin-role'] || '').trim().toLowerCase();
  const authorization = String(req.headers.authorization || '').trim();

  if (headerUserId && (headerRole === 'admin' || headerRole === 'nutritionist')) {
    return { userId: headerUserId, role: headerRole };
  }
  if (authorization) {
    return { userId: 'authorized-user', role: 'admin' };
  }
  return null;
};

const requireAdminIdentity = (req: Request, res: Response): { userId: string; role: 'admin' | 'nutritionist' } | null => {
  const identity = parseAdminIdentity(req);
  if (identity) return identity;
  res.status(401).json({ ok: false, error: 'admin_auth_required' });
  return null;
};

const FOOD_TERMS = ['broccoli', '花椰菜', '菠菜', '雞胸肉', '鮭魚', '蘋果', 'banana', 'oats'];
const NUTRIENT_TERMS = ['fiber', '纖維', 'vitamin c', '維生素c', 'protein', '蛋白質', 'sodium', '鈉', 'iron', '鐵'];
const CONDITION_TERMS = ['digestion', '消化', 'immunity', '免疫力', 'hypertension', '高血壓', 'diabetes', '糖尿病'];
const POPULATION_TERMS = ['adults', '成人', 'children', '兒童', 'pregnant women', '孕婦', 'elderly', '長者'];
const GUIDELINE_TERMS = ['reduce', '降低', 'avoid', '避免', 'recommended', '建議', 'should', '應'];

const TERM_TYPES: Array<{ terms: string[]; nodeType: GraphNodeType }> = [
  { terms: FOOD_TERMS, nodeType: 'food' },
  { terms: NUTRIENT_TERMS, nodeType: 'nutrient' },
  { terms: CONDITION_TERMS, nodeType: 'condition' },
  { terms: POPULATION_TERMS, nodeType: 'population' },
  { terms: GUIDELINE_TERMS, nodeType: 'guideline' },
];

const buildNodeId = (label: string, nodeType: GraphNodeType): string =>
  `${nodeType}:${safeLower(label).replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')}`;

const buildEdgeId = (sourceId: string, relationType: GraphRelationType, targetId: string): string =>
  `${sourceId}|${relationType}|${targetId}`;

const buildEvidenceId = (edgeId: string, documentId: string, snippet: string): string =>
  hashText(`${edgeId}|${documentId}|${snippet}`).slice(0, 16);

const splitIntoSentences = (content: string): string[] =>
  content
    .split(/\n+/)
    .flatMap((line) => line.split(/[。.!?]/))
    .map((part) => normalizeText(part))
    .filter((part) => part.length > 0);

const findTerms = (sentence: string, terms: string[]): string[] => {
  const lower = safeLower(sentence);
  return terms.filter((term) => lower.includes(safeLower(term)));
};

const inferNodeType = (term: string): GraphNodeType => {
  const lower = safeLower(term);
  const matched = TERM_TYPES.find(({ terms }) => terms.some((known) => safeLower(known) === lower));
  return matched?.nodeType ?? 'topic';
};

const readJsonFile = async <T>(absolutePath: string): Promise<T | null> => {
  try {
    const content = await readFile(absolutePath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
};

const writeJsonFile = async (absolutePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(value, null, 2), 'utf8');
};

const listMarkdownFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(absolutePath);
    }
  }
  return files;
};

const titleFromContent = (content: string, fallback: string): string => {
  const titleLine = content.split('\n').find((line) => line.startsWith('# '));
  return titleLine ? titleLine.replace(/^#\s+/, '').trim() : fallback;
};

const discoverLocalKnowledgeSources = async (rootDir: string): Promise<KnowledgeSourceDocument[]> => {
  const knowledgeBaseDir = path.join(rootDir, 'knowledge_base');
  const files = await listMarkdownFiles(knowledgeBaseDir);
  const sources: KnowledgeSourceDocument[] = [];

  for (const absolutePath of files) {
    const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');
    if (relativePath.startsWith('knowledge_base/uploads/')) continue;
    if (relativePath.startsWith('knowledge_base/graph/')) continue;

    const sourceType: GraphSourceType = relativePath.includes('mohw_clarifications/articles/')
      ? 'mohw_news'
      : 'nutrition_rules';
    const content = await readFile(absolutePath, 'utf8').catch(() => '');
    if (!content.trim()) continue;

    const fallbackTitle = path.basename(absolutePath, path.extname(absolutePath));
    sources.push({
      id: `file:${relativePath}`,
      title: titleFromContent(content, fallbackTitle),
      sourceType,
      sourcePath: relativePath,
      absolutePath,
      content,
    });
  }

  return sources;
};

const discoverUploadedSources = async (
  rootDir: string,
  repository?: RagDocumentsRepository | null
): Promise<KnowledgeSourceDocument[]> => {
  if (!repository) return [];
  const records = await repository.listDocuments();
  const sources: KnowledgeSourceDocument[] = [];
  for (const record of records) {
    if (!record.storagePath) continue;
    const absolutePath = resolveAbsolutePath(rootDir, record.storagePath);
    const fileInfo = await stat(absolutePath).catch(() => null);
    if (!fileInfo?.isFile()) continue;
    const content = await readFile(absolutePath, 'utf8').catch(() => '');
    if (!content.trim()) continue;
    sources.push({
      id: record.id,
      title: record.title,
      sourceType: 'uploaded_knowledge',
      sourcePath: record.storagePath,
      absolutePath,
      content,
    });
  }
  return sources;
};

const addNode = (
  cache: KnowledgeGraphCache,
  label: string,
  nodeType: GraphNodeType,
  documentId: string,
  sourceType: GraphSourceType
): KnowledgeGraphNode => {
  const id = buildNodeId(label, nodeType);
  const existing = cache.nodes[id];
  if (existing) {
    existing.document_ids = toArrayUnique([...existing.document_ids, documentId]);
    existing.source_types = toArrayUnique([...existing.source_types, sourceType]);
    if (!existing.aliases.includes(label)) existing.aliases.push(label);
    return existing;
  }

  const next: KnowledgeGraphNode = {
    id,
    label,
    node_type: nodeType,
    aliases: [label],
    document_ids: [documentId],
    source_types: [sourceType],
  };
  cache.nodes[id] = next;
  return next;
};

const addEvidenceAndEdge = (
  cache: KnowledgeGraphCache,
  params: {
    sourceNode: KnowledgeGraphNode;
    targetNode: KnowledgeGraphNode;
    relationType: GraphRelationType;
    confidence: number;
    document: KnowledgeSourceDocument;
    snippet: string;
  }
): KnowledgeGraphEdge => {
  const edgeId = buildEdgeId(params.sourceNode.id, params.relationType, params.targetNode.id);
  const evidenceId = buildEvidenceId(edgeId, params.document.id, params.snippet);

  if (!cache.evidence[evidenceId]) {
    cache.evidence[evidenceId] = {
      id: evidenceId,
      edge_id: edgeId,
      document_id: params.document.id,
      document_title: params.document.title,
      source_type: params.document.sourceType,
      source_path: params.document.sourcePath,
      snippet: params.snippet,
    };
  }

  const existing = cache.edges[edgeId];
  if (existing) {
    existing.document_ids = toArrayUnique([...existing.document_ids, params.document.id]);
    existing.evidence_ids = toArrayUnique([...existing.evidence_ids, evidenceId]);
    existing.confidence = Math.max(existing.confidence, params.confidence);
    return existing;
  }

  const next: KnowledgeGraphEdge = {
    id: edgeId,
    source: params.sourceNode.id,
    target: params.targetNode.id,
    relation_type: params.relationType,
    confidence: params.confidence,
    document_ids: [params.document.id],
    evidence_ids: [evidenceId],
  };
  cache.edges[edgeId] = next;
  return next;
};

const extractDocumentGraph = (cache: KnowledgeGraphCache, document: KnowledgeSourceDocument): KnowledgeGraphDocument => {
  const sentences = splitIntoSentences(document.content);
  const documentNode = addNode(cache, document.title, 'document', document.id, document.sourceType);
  const nodeIds = new Set<string>([documentNode.id]);
  const edgeIds = new Set<string>();
  const evidenceIds = new Set<string>();

  for (const sentence of sentences) {
    const foods = findTerms(sentence, FOOD_TERMS);
    const nutrients = findTerms(sentence, NUTRIENT_TERMS);
    const conditions = findTerms(sentence, CONDITION_TERMS);
    const populations = findTerms(sentence, POPULATION_TERMS);

    const mentionedTerms = [...foods, ...nutrients, ...conditions, ...populations];
    for (const term of mentionedTerms) {
      const node = addNode(cache, term, inferNodeType(term), document.id, document.sourceType);
      nodeIds.add(node.id);
      const edge = addEvidenceAndEdge(cache, {
        sourceNode: documentNode,
        targetNode: node,
        relationType: 'mentions',
        confidence: 0.5,
        document,
        snippet: sentence,
      });
      edgeIds.add(edge.id);
      edge.evidence_ids.forEach((id) => evidenceIds.add(id));
    }

    for (const food of foods) {
      for (const nutrient of nutrients) {
        if (!/(contain|contains|rich in|含有|富含|提供)/i.test(sentence)) continue;
        const sourceNode = addNode(cache, food, 'food', document.id, document.sourceType);
        const targetNode = addNode(cache, nutrient, 'nutrient', document.id, document.sourceType);
        nodeIds.add(sourceNode.id);
        nodeIds.add(targetNode.id);
        const edge = addEvidenceAndEdge(cache, {
          sourceNode,
          targetNode,
          relationType: 'contains',
          confidence: 0.9,
          document,
          snippet: sentence,
        });
        edgeIds.add(edge.id);
        edge.evidence_ids.forEach((id) => evidenceIds.add(id));
      }
    }

    for (const nutrient of nutrients) {
      for (const condition of conditions) {
        if (!/(support|supports|help|helps|有助於|幫助|影響|reduce|降低)/i.test(sentence)) continue;
        const sourceNode = addNode(cache, nutrient, 'nutrient', document.id, document.sourceType);
        const targetNode = addNode(cache, condition, 'condition', document.id, document.sourceType);
        nodeIds.add(sourceNode.id);
        nodeIds.add(targetNode.id);
        const edge = addEvidenceAndEdge(cache, {
          sourceNode,
          targetNode,
          relationType: 'affects',
          confidence: 0.8,
          document,
          snippet: sentence,
        });
        edgeIds.add(edge.id);
        edge.evidence_ids.forEach((id) => evidenceIds.add(id));
      }
    }

    for (const food of foods.length > 0 ? foods : nutrients) {
      for (const population of populations) {
        if (!/(recommended|recommend|適合|建議|should)/i.test(sentence)) continue;
        const sourceNode = addNode(cache, food, inferNodeType(food), document.id, document.sourceType);
        const targetNode = addNode(cache, population, 'population', document.id, document.sourceType);
        nodeIds.add(sourceNode.id);
        nodeIds.add(targetNode.id);
        const edge = addEvidenceAndEdge(cache, {
          sourceNode,
          targetNode,
          relationType: 'recommended_for',
          confidence: 0.75,
          document,
          snippet: sentence,
        });
        edgeIds.add(edge.id);
        edge.evidence_ids.forEach((id) => evidenceIds.add(id));
      }
    }

    for (const condition of conditions) {
      for (const nutrient of nutrients) {
        if (!/(avoid|避免|limit|限制|reduce|降低)/i.test(sentence)) continue;
        const sourceNode = addNode(cache, condition, 'condition', document.id, document.sourceType);
        const targetNode = addNode(cache, nutrient, 'nutrient', document.id, document.sourceType);
        nodeIds.add(sourceNode.id);
        nodeIds.add(targetNode.id);
        const edge = addEvidenceAndEdge(cache, {
          sourceNode,
          targetNode,
          relationType: 'not_recommended_for',
          confidence: 0.8,
          document,
          snippet: sentence,
        });
        edgeIds.add(edge.id);
        edge.evidence_ids.forEach((id) => evidenceIds.add(id));
      }
    }
  }

  return {
    id: document.id,
    title: document.title,
    source_type: document.sourceType,
    source_path: document.sourcePath,
    content_hash: hashText(document.content),
    extracted_at: new Date().toISOString(),
    node_ids: Array.from(nodeIds),
    edge_ids: Array.from(edgeIds),
    evidence_ids: Array.from(evidenceIds),
  };
};

const pruneDocumentFromCache = (cache: KnowledgeGraphCache, documentId: string): void => {
  const doc = cache.documents[documentId];
  if (!doc) return;
  delete cache.documents[documentId];

  for (const evidenceId of doc.evidence_ids) {
    delete cache.evidence[evidenceId];
  }

  for (const edgeId of doc.edge_ids) {
    const edge = cache.edges[edgeId];
    if (!edge) continue;
    edge.document_ids = edge.document_ids.filter((id) => id !== documentId);
    edge.evidence_ids = edge.evidence_ids.filter((id) => cache.evidence[id] != null);
    if (edge.document_ids.length === 0) delete cache.edges[edgeId];
  }

  for (const nodeId of doc.node_ids) {
    const node = cache.nodes[nodeId];
    if (!node) continue;
    node.document_ids = node.document_ids.filter((id) => id !== documentId);
    if (node.document_ids.length === 0) delete cache.nodes[nodeId];
  }
};

const buildSubgraph = (
  cache: KnowledgeGraphCache,
  query: string,
  maxNodes: number,
  sourceTypes?: string[],
  documentIds?: string[]
) => {
  const lowerQuery = safeLower(query);
  const allowedDocumentIds = new Set<string>();
  for (const [documentId, document] of Object.entries(cache.documents)) {
    if (sourceTypes?.length && !sourceTypes.includes(document.source_type)) continue;
    if (documentIds?.length && !documentIds.includes(documentId)) continue;
    allowedDocumentIds.add(documentId);
  }

  const rankedNodes = Object.values(cache.nodes)
    .filter((node) => {
      if (!node.document_ids.some((id) => allowedDocumentIds.has(id))) return false;
      return [node.label, ...node.aliases].some((value) => safeLower(value).includes(lowerQuery));
    })
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, maxNodes);

  const includedNodeIds = new Set(rankedNodes.map((node) => node.id));
  const includedEdges = Object.values(cache.edges).filter((edge) => {
    if (!edge.document_ids.some((id) => allowedDocumentIds.has(id))) return false;
    return includedNodeIds.has(edge.source) || includedNodeIds.has(edge.target);
  });

  for (const edge of includedEdges) {
    includedNodeIds.add(edge.source);
    includedNodeIds.add(edge.target);
  }

  const nodes = Array.from(includedNodeIds)
    .map((id) => cache.nodes[id])
    .filter(Boolean)
    .slice(0, maxNodes + 8);
  const edges = includedEdges.filter(
    (edge) => includedNodeIds.has(edge.source) && includedNodeIds.has(edge.target)
  );
  const evidence = toArrayUnique(edges.flatMap((edge) => edge.evidence_ids))
    .map((id) => cache.evidence[id])
    .filter(Boolean);
  const documents = toArrayUnique(edges.flatMap((edge) => edge.document_ids))
    .map((id) => cache.documents[id])
    .filter(Boolean);

  return { nodes, edges, evidence, documents };
};

const buildNodeDetail = (cache: KnowledgeGraphCache, nodeId: string) => {
  const node = cache.nodes[nodeId];
  if (!node) return null;

  const edges = Object.values(cache.edges).filter((edge) => edge.source === nodeId || edge.target === nodeId);
  const neighbors = edges
    .map((edge) => cache.nodes[edge.source === nodeId ? edge.target : edge.source])
    .filter(Boolean);
  const evidence = toArrayUnique(edges.flatMap((edge) => edge.evidence_ids))
    .map((id) => cache.evidence[id])
    .filter(Boolean);

  return { node, edges, neighbors, evidence };
};

const listNodes = (
  cache: KnowledgeGraphCache,
  options: z.infer<typeof ListNodesSchema>
): { total: number; items: KnowledgeGraphNode[] } => {
  let items = Object.values(cache.nodes);

  if (options.node_type) {
    items = items.filter((node) => node.node_type === options.node_type);
  }

  if (options.query) {
    const lowerQuery = safeLower(options.query);
    items = items.filter((node) =>
      [node.label, ...node.aliases].some((value) => safeLower(value).includes(lowerQuery))
    );
  }

  items = items.sort((a, b) => a.label.localeCompare(b.label));
  return {
    total: items.length,
    items: items.slice(0, options.limit),
  };
};

const findDocumentById = async (
  rootDir: string,
  repository: RagDocumentsRepository | null | undefined,
  documentId: string
): Promise<KnowledgeSourceDocument | null> => {
  const uploaded = await discoverUploadedSources(rootDir, repository);
  const uploadMatch = uploaded.find((doc) => doc.id === documentId);
  if (uploadMatch) return uploadMatch;

  const locals = await discoverLocalKnowledgeSources(rootDir);
  return locals.find((doc) => doc.id === documentId) ?? null;
};

const discoverAllKnowledgeSources = async (
  rootDir: string,
  repository: RagDocumentsRepository | null | undefined
): Promise<KnowledgeSourceDocument[]> => {
  const [uploaded, locals] = await Promise.all([
    discoverUploadedSources(rootDir, repository),
    discoverLocalKnowledgeSources(rootDir),
  ]);
  return [...uploaded, ...locals];
};

const summarizeCache = (cache: KnowledgeGraphCache): KnowledgeGraphSummary => {
  const sourceCounts: Record<GraphSourceType, number> = {
    uploaded_knowledge: 0,
    nutrition_rules: 0,
    mohw_news: 0,
  };

  for (const document of Object.values(cache.documents)) {
    sourceCounts[document.source_type] += 1;
  }

  return {
    document_count: Object.keys(cache.documents).length,
    node_count: Object.keys(cache.nodes).length,
    edge_count: Object.keys(cache.edges).length,
    evidence_count: Object.keys(cache.evidence).length,
    source_counts: sourceCounts,
    generated_at: cache.generated_at || null,
  };
};

export const createKnowledgeGraphRouter = (options: RouterOptions = {}): Router => {
  const router = Router();
  const rootDir = options.rootDir || ROOT_DIR;
  const repository = options.repository ?? null;
  const cachePath = path.join(rootDir, GRAPH_CACHE_FILE);

  const readCache = async (): Promise<KnowledgeGraphCache> => (await readJsonFile<KnowledgeGraphCache>(cachePath)) || emptyCache();

  const writeCache = async (cache: KnowledgeGraphCache): Promise<void> => {
    cache.generated_at = new Date().toISOString();
    await writeJsonFile(cachePath, cache);
  };

  router.post('/api/graph/extract-all', async (req, res, next) => {
    try {
      const payload = ExtractBodySchema.parse(req.body ?? {});
      const sources = await discoverAllKnowledgeSources(rootDir, repository);
      const existingCache = payload.force ? emptyCache() : await readCache();
      const cache = payload.force ? emptyCache() : existingCache;

      if (payload.force) {
        for (const document of sources) {
          const extracted = extractDocumentGraph(cache, document);
          cache.documents[document.id] = extracted;
        }
      } else {
        const seen = new Set<string>();
        for (const document of sources) {
          seen.add(document.id);
          const contentHash = hashText(document.content);
          const existing = cache.documents[document.id];
          if (existing && existing.content_hash === contentHash) {
            continue;
          }
          pruneDocumentFromCache(cache, document.id);
          const extracted = extractDocumentGraph(cache, document);
          cache.documents[document.id] = extracted;
        }

        for (const documentId of Object.keys(cache.documents)) {
          if (!seen.has(documentId)) {
            pruneDocumentFromCache(cache, documentId);
          }
        }
      }

      await writeCache(cache);
      res.json({
        ok: true,
        force: payload.force,
        summary: summarizeCache(cache),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/graph/status', async (_req, res, next) => {
    try {
      const cache = await readCache();
      const summary = summarizeCache(cache);
      res.json({
        ok: true,
        ready: summary.document_count > 0,
        summary,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/graph/documents/:document_id/extract', async (req, res, next) => {
    try {
      if (!requireAdminIdentity(req, res)) return;
      const params = DocumentParamsSchema.parse(req.params);
      const payload = ExtractBodySchema.parse(req.body ?? {});
      const document = await findDocumentById(rootDir, repository, params.document_id);
      if (!document) {
        res.status(404).json({ ok: false, error: 'document_not_found' });
        return;
      }

      const cache = await readCache();
      const existing = cache.documents[document.id];
      const contentHash = hashText(document.content);
      if (!payload.force && existing && existing.content_hash === contentHash) {
        res.json({
          ok: true,
          cached: true,
          document: existing,
          nodes: existing.node_ids.map((id) => cache.nodes[id]).filter(Boolean),
          edges: existing.edge_ids.map((id) => cache.edges[id]).filter(Boolean),
          evidence: existing.evidence_ids.map((id) => cache.evidence[id]).filter(Boolean),
        });
        return;
      }

      pruneDocumentFromCache(cache, document.id);
      const extracted = extractDocumentGraph(cache, document);
      cache.documents[document.id] = extracted;
      await writeCache(cache);

      res.json({
        ok: true,
        cached: false,
        document: extracted,
        nodes: extracted.node_ids.map((id) => cache.nodes[id]).filter(Boolean),
        edges: extracted.edge_ids.map((id) => cache.edges[id]).filter(Boolean),
        evidence: extracted.evidence_ids.map((id) => cache.evidence[id]).filter(Boolean),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/graph/documents/:document_id', async (req, res, next) => {
    try {
      if (!requireAdminIdentity(req, res)) return;
      const params = DocumentParamsSchema.parse(req.params);
      const cache = await readCache();
      const document = cache.documents[params.document_id];
      if (!document) {
        res.status(404).json({ ok: false, error: 'graph_document_not_found' });
        return;
      }
      res.json({
        ok: true,
        document,
        nodes: document.node_ids.map((id) => cache.nodes[id]).filter(Boolean),
        edges: document.edge_ids.map((id) => cache.edges[id]).filter(Boolean),
        evidence: document.evidence_ids.map((id) => cache.evidence[id]).filter(Boolean),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/graph/search', async (req, res, next) => {
    try {
      const payload = SearchSchema.parse(req.body ?? {});
      const cache = await readCache();
      const result = buildSubgraph(
        cache,
        payload.query,
        payload.max_nodes,
        payload.source_types,
        payload.document_ids
      );
      res.json({
        ok: true,
        query: payload.query,
        nodes: result.nodes,
        edges: result.edges,
        evidence: result.evidence,
        documents: result.documents,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/graph/nodes', async (req, res, next) => {
    try {
      const query = ListNodesSchema.parse(req.query);
      const cache = await readCache();
      const result = listNodes(cache, query);
      res.json({
        ok: true,
        total: result.total,
        items: result.items,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/graph/nodes/:node_id', async (req, res, next) => {
    try {
      const params = NodeParamsSchema.parse(req.params);
      const cache = await readCache();
      const result = buildNodeDetail(cache, params.node_id);
      if (!result) {
        res.status(404).json({ ok: false, error: 'graph_node_not_found' });
        return;
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/graph/relations/:relation_id/evidence', async (req, res, next) => {
    try {
      const params = RelationParamsSchema.parse(req.params);
      const cache = await readCache();
      const edge = cache.edges[params.relation_id];
      if (!edge) {
        res.status(404).json({ ok: false, error: 'graph_relation_not_found' });
        return;
      }
      const evidence = edge.evidence_ids.map((id) => cache.evidence[id]).filter(Boolean);
      res.json({ ok: true, relation: edge, evidence });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
