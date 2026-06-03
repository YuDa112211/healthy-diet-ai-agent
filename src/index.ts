import express from 'express';
import {
  ingestKnowledgeHandler,
  knowledgeJobStatusHandler,
  uploadKnowledgeHandler,
} from './server/knowledgeIngestion';
import { createRagApiRouter } from './server/ragDocuments';
import {
  syncMohwNews,
  getMohwNewsByIdHandler,
  listLocalMohwFilesHandler,
  listMohwNewsHandler,
  syncMohwNewsHandler,
} from './server/mohwNews';
import { ragSearchHandler } from './server/ragSearch';
import {
  AI_API_URL,
  approveHandler,
  chatHandler,
  corsMiddleware,
  errorHandler,
  generateTitleHandler,
  imagesStaticMiddleware,
  isSupabaseReady,
  jsonBodyParser,
  pingHandler,
  requestLoggerMiddleware,
  REQUEST_BODY_LIMIT,
  urlencodedBodyParser,
} from './serverHandlers';

const app = express();
const PORT = Number(process.env.PORT) || 8001;
const MOHW_NEWS_SYNC_ENABLED = String(process.env.MOHW_NEWS_SYNC_ENABLED || 'false').toLowerCase() === 'true';
const MOHW_NEWS_SYNC_RUN_ON_START =
  String(process.env.MOHW_NEWS_SYNC_RUN_ON_START || 'false').toLowerCase() === 'true';
const MOHW_NEWS_SYNC_INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.MOHW_NEWS_SYNC_INTERVAL_MINUTES || 360)
);

app.use(corsMiddleware);
app.use(jsonBodyParser);
app.use(urlencodedBodyParser);
app.use(requestLoggerMiddleware);
app.use('/images', imagesStaticMiddleware);
app.use(createRagApiRouter());

app.post('/api/chat', chatHandler);
app.post('/api/approve', approveHandler);
app.post('/api/generate_title', generateTitleHandler);
app.post('/api/admin/knowledge/upload', uploadKnowledgeHandler);
app.post('/api/admin/knowledge/ingest/:id', ingestKnowledgeHandler);
app.get('/api/admin/knowledge/jobs/:jobId', knowledgeJobStatusHandler);
app.post('/api/news/sync', syncMohwNewsHandler);
app.get('/api/news', listMohwNewsHandler);
app.get('/api/news/:id', getMohwNewsByIdHandler);
app.get('/api/news-files', listLocalMohwFilesHandler);
app.get('/api/rag/search', ragSearchHandler);
app.post('/api/rag/search', ragSearchHandler);
app.get('/ping', pingHandler);

app.use(errorHandler);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\nDiet Manager Agent Server started');
  console.log(`Thread-based memory ready (Supabase): ${isSupabaseReady}`);
  console.log(`API URL: http://localhost:${PORT}/api/chat`);
  console.log(`LLM base URL: ${AI_API_URL}`);
  console.log(`Request body limit: ${REQUEST_BODY_LIMIT}`);
  console.log(
    `MOHW news auto-sync: enabled=${MOHW_NEWS_SYNC_ENABLED} intervalMin=${MOHW_NEWS_SYNC_INTERVAL_MINUTES} runOnStart=${MOHW_NEWS_SYNC_RUN_ON_START}`
  );
});

let mohwSyncRunning = false;
const runMohwSyncSafely = async (trigger: 'startup' | 'interval'): Promise<void> => {
  if (mohwSyncRunning) {
    console.log(`[MOHW] Skip ${trigger} sync: previous sync still running.`);
    return;
  }
  mohwSyncRunning = true;
  try {
    const result = await syncMohwNews();
    console.log(
      `[MOHW] ${trigger} sync done. total=${result.total}, new=${result.newCount}, updated=${result.updatedCount}, generatedAt=${result.generatedAt}`
    );
  } catch (error) {
    console.error(`[MOHW] ${trigger} sync failed:`, error);
  } finally {
    mohwSyncRunning = false;
  }
};

if (MOHW_NEWS_SYNC_ENABLED) {
  const intervalMs = MOHW_NEWS_SYNC_INTERVAL_MINUTES * 60 * 1000;
  setInterval(() => {
    void runMohwSyncSafely('interval');
  }, intervalMs);

  if (MOHW_NEWS_SYNC_RUN_ON_START) {
    void runMohwSyncSafely('startup');
  }
}

server.on('error', (error) => {
  console.error('[SERVER] Listen error:', error);
});

server.on('close', () => {
  console.error('[SERVER] HTTP server closed.');
});

if (typeof (server as { ref?: () => void }).ref === 'function') {
  (server as { ref: () => void }).ref();
}

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[PROCESS] Uncaught Exception:', error);
});
