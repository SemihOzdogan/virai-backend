import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import bcrypt from 'bcryptjs';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './db/pool.js';

const { compare, hash } = bcrypt;

const app = Fastify({ logger: true });
const credentials = z.object({ email: z.string().email().transform(v => v.toLowerCase().trim()), password: z.string().min(12).max(128) });
const uuid = z.string().uuid();
const maxUploadBytes = 10 * 1024 * 1024;
const uploadDirectory = '/app/data/uploads';
await app.register(cors, { origin: config.CORS_ORIGIN ?? false });
await app.register(jwt, { secret: config.JWT_SECRET });
await app.register(multipart, { limits: { files: 1, fileSize: maxUploadBytes, fields: 0, parts: 1 } });
const auth = async (request: { jwtVerify: () => Promise<unknown> }) => request.jwtVerify();

function validationMessage(error: z.ZodError) {
  const issue = error.issues[0];
  const field = String(issue?.path[0] ?? '');

  if (field === 'email') return 'Geçerli bir e-posta adresi girin.';
  if (field === 'password' || field === 'newPassword') {
    return 'Şifre en az 12 karakter olmalıdır.';
  }
  if (field === 'displayName') return 'Ad soyad alanı boş bırakılamaz.';
  if (field === 'currentPassword') return 'Şifre değiştirmek için mevcut şifrenizi girin.';
  if (field === 'conversationId') return 'Geçerli bir sohbet seçin.';
  return issue?.message === 'Şifre değiştirmek için mevcut şifrenizi girin.'
    ? issue.message
    : 'Gönderilen bilgiler eksik veya geçersiz.';
}

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ message: validationMessage(error) });
  }
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
  if (statusCode === 401 || statusCode === 403) {
    return reply.code(statusCode).send({ message: 'Oturumunuz geçersiz. Lütfen yeniden giriş yapın.' });
  }
  return reply.code(500).send({ message: 'Sunucuda bir sorun oluştu. Lütfen daha sonra tekrar deneyin.' });
});

function splitIntoChunks(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: string[] = [];
  const size = 1200;
  const overlap = 180;
  for (let start = 0; start < normalized.length;) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf('. ', end), normalized.lastIndexOf(' ', end));
      if (boundary > start + size / 2) end = boundary + 1;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function vectorLiteral(embedding: number[]) {
  if (embedding.length !== 768 || embedding.some(value => !Number.isFinite(value))) throw new Error('Embedding boyutu geçersiz.');
  return `[${embedding.join(',')}]`;
}

function visibleModelContent(content: string) {
  // Qwen 3 can include its reasoning before this marker even when think is false.
  return content.replace(/^[\s\S]*?<\/think>\s*/i, '').trim();
}

function cleanReplyForUser(content: string) {
  const withoutSourceSection = content
    .replace(/\n{0,2}(?:#{1,6}\s*)?(?:kaynak(?:lar)?|source(?:s)?|referans(?:lar)?)\s*:?\s*\n[\s\S]*$/i, '')
    .replace(/^\s*\[\d+(?:\s*,\s*\d+)*\]\s+.*(?:\.pdf|\.docx|\.txt|\.md).*(?:alıntı|kaynak|source).*$/gim, '');
  return withoutSourceSection
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function generateConversationTitle(transcript: string) {
  const text = transcript.toLocaleLowerCase('tr-TR');
  const topics: Array<[RegExp, string]> = [
    [/kaç yaş|yaşında|doğum/, 'Yaş bilgisi'],
    [/üniversite|okul|eğitim|mezun/, 'Eğitim geçmişi'],
    [/tecrübe|deneyim|çalış|pozisyon|iş geçmiş/, 'İş deneyimi'],
    [/yetkinlik|beceri|teknoloji|teknik/, 'Teknik yetkinlikler'],
    [/proje|uygulama/, 'Proje deneyimi'],
    [/uygun|birim|departman|rol/, 'Pozisyon uygunluğu'],
  ];
  const match = topics.find(([pattern]) => pattern.test(text));
  if (match) return match[1];
  const firstQuestion = transcript.split('\n').find(line => line.startsWith('Kullanıcı:'))?.replace('Kullanıcı:', '').trim() ?? '';
  const words = firstQuestion.split(/\s+/).filter(word => word.length > 2 && !/^(hangi|nedir|nasıl|olan|için|gibi|bir|ile|ve|bu|şu)$/i.test(word));
  return words.slice(0, 3).join(' ').replace(/^./, char => char.toLocaleUpperCase('tr-TR')) || 'Sohbet konusu';
}

async function embed(inputs: string[]) {
  const response = await fetch(`${config.OLLAMA_BASE_URL}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.OLLAMA_EMBEDDING_MODEL, input: inputs }),
  });
  if (!response.ok) throw new Error('Yerel embedding modeli kullanılamıyor. Ollama açık mı?');
  const body = await response.json() as { embeddings?: number[][] };
  if (!body.embeddings || body.embeddings.length !== inputs.length) throw new Error('Embedding yanıtı geçersiz.');
  return body.embeddings;
}

async function extractText(buffer: Buffer, extension: string) {
  if (extension === '.txt' || extension === '.md') return buffer.toString('utf8');
  if (extension === '.docx') return (await mammoth.extractRawText({ buffer })).value;
  if (extension === '.pdf') {
    const parser = new PDFParse({ data: buffer });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
  }
  throw new Error('Yalnızca TXT, MD, PDF ve DOCX dosyaları desteklenir.');
}

async function generateReply(userId: string, conversationId: string, question: string, mode: 'general' | 'interview') {
  const today = new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'long', timeZone: 'Europe/Istanbul',
  }).format(new Date());
  const questionEmbedding = (await embed([question]))[0];
  const sources = await db.query<{name: string; content: string}>(
    `SELECT d.name, dc.content FROM document_chunks dc JOIN documents d ON d.id=dc.document_id
     WHERE d.user_id=$1 AND d.conversation_id=$2 AND d.status='ready' ORDER BY dc.embedding <=> $3::vector LIMIT 3`,
    [userId, conversationId, vectorLiteral(questionEmbedding)]);
  const history = await db.query<{role: 'user' | 'assistant'; content: string}>(
    "SELECT role,content FROM messages WHERE conversation_id=$1 AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 6", [conversationId]);
  const context = sources.rows.length
    ? sources.rows.map(item => `Dosya: ${item.name}\n${item.content.slice(0, 850)}`).join('\n\n')
    : 'Bu kullanıcı için henüz kaynak doküman yok.';
  const system = mode === 'interview'
    ? 'Sen Türkçe konuşan destekleyici bir iş görüşmesi mülakatçısısın. Kullanıcı adaydır. Her yanıtta kısa geri bildirim ver ve yalnızca bir sonraki açık uçlu soruyu sor.'
    : 'Sen Türkçe konuşan yardımsever bir asistansın.';
  const response = await fetch(`${config.OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: config.OLLAMA_CHAT_MODEL, stream: false, think: false, messages: [
      { role: 'system', content: `${system}\n\nBugünün tarihi ${today}. Yaş, süre, kıdem, tarih farkı veya “şu an” içeren bir soru sorulursa bu tarihi esas al ve hesabı açıkça yap; dokümandaki eski tarihi bugünün tarihi gibi kabul etme.\n\nYanıtını yalnızca Türkçe yaz. Kullanıcının sorusu veya kaynak doküman başka dilde olsa bile yanıtı Türkçe ver; yalnızca özel adları ve teknik terimleri gerektiğinde özgün dilinde koru.\n\nSen belge odaklı bir RAG asistanısın. Genel, klişe veya belgeden çıkarılmamış öneriler verme. Her yanıtta kaynaklardan en az iki somut ayrıntı kullan: teknoloji adı, proje/pozisyon adı, süre, sorumluluk, başarı veya doğrudan beceri. Kullanıcı karşılaştırma ya da “en güçlü” gibi bir soru sorarsa ölçütünü belirt, sonucu maddeler halinde sırala ve her maddeyi belgedeki kanıtla gerekçelendir. Yanıtta kaynak numarası, dipnot veya “[1]” benzeri işaretler gösterme. Bağlamda kanıt yoksa varsayım yapma; eksik olduğunu açıkça söyle.\n\nDoküman bağlamı:\n${context}` },
      ...history.rows.reverse().map(item => ({ role: item.role, content: visibleModelContent(item.content).slice(0, 800) })),
    ], options: { num_ctx: 4096, num_predict: 400, temperature: 0.3 }, keep_alive: '10m' }),
  });
  if (!response.ok) throw new Error('Yerel sohbet modeli kullanılamıyor. Ollama açık mı?');
  const body = await response.json() as { message?: { content?: string } };
  const reply = body.message?.content && cleanReplyForUser(visibleModelContent(body.message.content));
  if (!reply) throw new Error('Yerel model boş yanıt verdi.');
  return reply;
}

app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok', database: 'connected' }; });
app.post('/v1/auth/register', async (request, reply) => {
  const body = credentials.extend({ displayName: z.string().trim().min(1).max(80) }).parse(request.body);
  try {
    const result = await db.query<{id: string; email: string; display_name: string}>(
      'INSERT INTO users (email,password_hash,display_name) VALUES ($1,$2,$3) RETURNING id,email,display_name',
      [body.email, await hash(body.password, 12), body.displayName]);
    const user = result.rows[0];
    return reply.code(201).send({ token: await reply.jwtSign({ userId: user.id, email: user.email }), user: { id: user.id, email: user.email, name: user.display_name } });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return reply.code(409).send({ message: 'Bu e-posta zaten kayıtlı.' });
    throw error;
  }
});
app.post('/v1/auth/login', async (request, reply) => {
  const body = credentials.parse(request.body);
  const result = await db.query<{id: string; email: string; display_name: string; password_hash: string}>('SELECT id,email,display_name,password_hash FROM users WHERE email=$1', [body.email]);
  const user = result.rows[0];
  if (!user || !(await compare(body.password, user.password_hash))) return reply.code(401).send({ message: 'E-posta veya şifre doğru değil.' });
  return { token: await reply.jwtSign({ userId: user.id, email: user.email }), user: { id: user.id, email: user.email, name: user.display_name } };
});
app.get('/v1/me', { onRequest: [auth] }, async (request, reply) => {
  const result = await db.query<{id: string; email: string; display_name: string}>(
    'SELECT id,email,display_name FROM users WHERE id=$1', [request.user.userId]);
  const user = result.rows[0];
  if (!user) return reply.code(401).send({ message: 'Oturum geçersiz. Lütfen yeniden giriş yapın.' });
  return { user: { id: user.id, email: user.email, name: user.display_name } };
});
app.patch('/v1/me', { onRequest: [auth] }, async (request, reply) => {
  const body = z.object({
    displayName: z.string().trim().min(1).max(80),
    currentPassword: z.string().min(12).max(128).optional(),
    newPassword: z.string().min(12).max(128).optional(),
  }).refine(value => !value.newPassword || Boolean(value.currentPassword), {
    message: 'Şifre değiştirmek için mevcut şifrenizi girin.', path: ['currentPassword'],
  }).parse(request.body);
  const current = await db.query<{password_hash: string}>('SELECT password_hash FROM users WHERE id=$1', [request.user.userId]);
  if (!current.rows[0]) return reply.code(401).send({ message: 'Oturum geçersiz. Lütfen yeniden giriş yapın.' });
  if (body.newPassword && !(await compare(body.currentPassword!, current.rows[0].password_hash))) {
    return reply.code(401).send({ message: 'Mevcut şifre doğru değil.' });
  }
  const result = await db.query<{id: string; email: string; display_name: string}>(
    'UPDATE users SET display_name=$1, password_hash=COALESCE($2,password_hash), updated_at=now() WHERE id=$3 RETURNING id,email,display_name',
    [body.displayName, body.newPassword ? await hash(body.newPassword, 12) : null, request.user.userId]);
  const user = result.rows[0];
  return { user: { id: user.id, email: user.email, name: user.display_name } };
});
app.get('/v1/documents', { onRequest: [auth] }, async request => {
  const result = await db.query('SELECT id,name,mime_type,status,created_at,updated_at FROM documents WHERE user_id=$1 ORDER BY created_at DESC', [request.user.userId]);
  return { documents: result.rows };
});
app.post('/v1/documents', { onRequest: [auth] }, async (request, reply) => {
  const { conversationId, originalName } = z.object({
    conversationId: uuid,
    originalName: z.string().trim().min(1).max(255).optional(),
  }).parse(request.query ?? {});
  const conversation = await db.query('SELECT id FROM conversations WHERE id=$1 AND user_id=$2', [conversationId, request.user.userId]);
  if (!conversation.rows[0]) return reply.code(404).send({ message: 'Sohbet bulunamadı.' });
  const file = await request.file();
  if (!file?.filename) return reply.code(400).send({ message: 'Bir dosya seçin.' });
  const fileName = basename(originalName ?? file.filename).replace(/\\\\/g, '');
  if (!fileName) return reply.code(400).send({ message: 'Geçerli bir dosya adı gerekli.' });
  const extension = extname(fileName).toLowerCase();
  if (!['.txt', '.md', '.pdf', '.docx'].includes(extension)) return reply.code(415).send({ message: 'Yalnızca TXT, MD, PDF ve DOCX dosyaları desteklenir.' });
  const buffer = await file.toBuffer();
  if (file.file.truncated || buffer.length === 0) return reply.code(400).send({ message: `Dosya boş veya ${maxUploadBytes / 1024 / 1024} MB sınırını aşıyor.` });
  const client = await db.connect();
  let documentId: string | undefined;
  try {
    const text = await extractText(buffer, extension);
    const chunks = splitIntoChunks(text);
    if (!chunks.length) return reply.code(422).send({ message: 'Dosyadan okunabilir metin çıkarılamadı.' });
    const embeddings = await embed(chunks);
    await client.query('BEGIN');
    const created = await client.query<{id: string}>('INSERT INTO documents (user_id,conversation_id,name,mime_type,storage_path,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [request.user.userId, conversationId, fileName, file.mimetype || 'application/octet-stream', `pending/${Date.now()}`, 'processing']);
    documentId = created.rows[0].id;
    const storagePath = join(uploadDirectory, `${documentId}${extension}`);
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(storagePath, buffer, { flag: 'wx' });
    await client.query('UPDATE documents SET storage_path=$1,status=$2,updated_at=now() WHERE id=$3', [storagePath, 'ready', documentId]);
    for (let index = 0; index < chunks.length; index += 1) {
      await client.query('INSERT INTO document_chunks (document_id,chunk_index,content,embedding) VALUES ($1,$2,$3,$4::vector)', [documentId, index, chunks[index], vectorLiteral(embeddings[index])]);
    }
    await client.query('COMMIT');
    return reply.code(201).send({ document: { id: documentId, name: fileName, status: 'ready', chunkCount: chunks.length } });
  } catch (error) {
    await client.query('ROLLBACK');
    request.log.error(error, 'Document processing failed');
    return reply.code(422).send({ message: error instanceof Error ? error.message : 'Dosya işlenemedi.' });
  } finally { client.release(); }
});
app.delete('/v1/documents/:documentId', { onRequest: [auth] }, async (request, reply) => {
  const { documentId } = z.object({ documentId: uuid }).parse(request.params);
  const result = await db.query<{id: string; storage_path: string}>('DELETE FROM documents WHERE id=$1 AND user_id=$2 RETURNING id,storage_path', [documentId, request.user.userId]);
  if (!result.rows[0]) return reply.code(404).send({ message: 'Doküman bulunamadı.' });
  await rm(result.rows[0].storage_path, { force: true }).catch(() => undefined);
  return reply.code(204).send();
});
app.post('/v1/documents/:documentId/open-url', { onRequest: [auth] }, async (request, reply) => {
  const { documentId } = z.object({ documentId: uuid }).parse(request.params);
  const result = await db.query('SELECT id FROM documents WHERE id=$1 AND user_id=$2', [documentId, request.user.userId]);
  if (!result.rows[0]) return reply.code(404).send({ message: 'Doküman bulunamadı.' });
  const accessToken = await reply.jwtSign(
    { userId: request.user.userId, email: request.user.email },
    { expiresIn: '5m' },
  );
  return { url: `/v1/documents/${documentId}/download?accessToken=${encodeURIComponent(accessToken)}` };
});
app.get('/v1/documents/:documentId/download', async (request, reply) => {
  const { documentId } = z.object({ documentId: uuid }).parse(request.params);
  const { accessToken } = z.object({ accessToken: z.string().min(1) }).parse(request.query ?? {});
  try {
    const session = await app.jwt.verify<{ userId: string; email: string }>(accessToken);
    const result = await db.query<{ name: string; mime_type: string; storage_path: string }>(
      'SELECT name,mime_type,storage_path FROM documents WHERE id=$1 AND user_id=$2',
      [documentId, session.userId],
    );
    const document = result.rows[0];
    if (!document) return reply.code(404).send({ message: 'Doküman bulunamadı.' });
    reply
      .header('Content-Type', document.mime_type)
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`);
    return reply.send(createReadStream(document.storage_path));
  } catch {
    return reply.code(401).send({ message: 'Doküman bağlantısının süresi dolmuş.' });
  }
});
app.get('/v1/conversations', { onRequest: [auth] }, async request => {
  const result = await db.query('SELECT id,title,mode,created_at,updated_at FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50', [request.user.userId]);
  return { conversations: result.rows };
});
app.post('/v1/conversations', { onRequest: [auth] }, async (request, reply) => {
  const body = z.object({ title: z.string().trim().min(1).max(60).default('Yeni sohbet'), mode: z.enum(['general','interview']).default('general') }).parse(request.body ?? {});
  const result = await db.query('INSERT INTO conversations (user_id,title,mode) VALUES ($1,$2,$3) RETURNING id,title,mode,created_at,updated_at', [request.user.userId, body.title, body.mode]);
  return reply.code(201).send({ conversation: result.rows[0] });
});
app.get('/v1/conversations/:conversationId/messages', { onRequest: [auth] }, async request => {
  const { conversationId } = z.object({ conversationId: uuid }).parse(request.params);
  const result = await db.query('SELECT m.id,m.role,m.content,m.created_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=$1 AND c.user_id=$2 ORDER BY m.created_at', [conversationId, request.user.userId]);
  return { messages: result.rows };
});
app.post('/v1/conversations/:conversationId/messages', { onRequest: [auth] }, async (request, reply) => {
  const { conversationId } = z.object({ conversationId: uuid }).parse(request.params);
  const body = z.object({ content: z.string().trim().min(1).max(6000) }).parse(request.body);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const conversation = await client.query<{id: string; mode: 'general' | 'interview'; title: string}>(
      'SELECT id,mode,title FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE', [conversationId, request.user.userId]);
    if (!conversation.rows[0]) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ message: 'Sohbet bulunamadı.' });
    }
    const message = await client.query<{id: string; role: string; content: string; created_at: Date}>(
      "INSERT INTO messages (conversation_id,role,content) VALUES ($1,'user',$2) RETURNING id,role,content,created_at",
      [conversationId, body.content]);
    await client.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversationId]);
    await client.query('COMMIT');
    try {
      const content = await generateReply(request.user.userId, conversationId, body.content, conversation.rows[0].mode);
      const assistant = await db.query<{id: string; role: string; content: string; created_at: Date}>(
        "INSERT INTO messages (conversation_id,role,content) VALUES ($1,'assistant',$2) RETURNING id,role,content,created_at", [conversationId, content]);
      await db.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversationId]);
      return reply.code(201).send({ messages: [message.rows[0], assistant.rows[0]] });
    } catch (error) {
      request.log.error(error, 'Local chat generation failed');
      const failureMessage = error instanceof Error && error.name === 'TimeoutError'
        ? 'Yerel model 60 saniye içinde yanıt veremedi. Lütfen soruyu daha kısa biçimde yeniden deneyin.'
        : 'Yerel model şu anda yanıt üretemedi. Ollama uygulamasının açık olduğundan emin olup tekrar deneyin.';
      const assistant = await db.query<{id: string; role: string; content: string; created_at: Date}>(
        "INSERT INTO messages (conversation_id,role,content) VALUES ($1,'assistant',$2) RETURNING id,role,content,created_at",
        [conversationId, failureMessage]);
      await db.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conversationId]);
      return reply.code(201).send({ messages: [message.rows[0], assistant.rows[0]], warning: error instanceof Error ? error.message : 'Yanıt üretilemedi.' });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});
app.post('/v1/conversations/:conversationId/generate-title', { onRequest: [auth] }, async (request, reply) => {
  const { conversationId } = z.object({ conversationId: uuid }).parse(request.params);
  const conversation = await db.query<{title: string}>(
    'SELECT title FROM conversations WHERE id=$1 AND user_id=$2', [conversationId, request.user.userId]);
  if (!conversation.rows[0]) return reply.code(404).send({ message: 'Sohbet bulunamadı.' });
  if (conversation.rows[0].title !== 'Yeni sohbet') return { title: conversation.rows[0].title };
  const messages = await db.query<{role: string; content: string}>(
    "SELECT role,content FROM messages WHERE conversation_id=$1 AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 10", [conversationId]);
  if (!messages.rows.length) return { title: 'Yeni sohbet' };
  const transcript = messages.rows.reverse().map(item => `${item.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${item.content}`).join('\n');
  const title = generateConversationTitle(transcript);
  if (title !== 'Yeni sohbet') await db.query('UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 AND title=$3', [title, conversationId, 'Yeni sohbet']);
  return { title };
});
app.patch('/v1/conversations/:conversationId', { onRequest: [auth] }, async (request, reply) => {
  const { conversationId } = z.object({ conversationId: uuid }).parse(request.params);
  const body = z.object({ title: z.string().trim().min(1).max(60) }).parse(request.body);
  const result = await db.query('UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING id,title,mode,created_at,updated_at', [body.title, conversationId, request.user.userId]);
  if (!result.rows[0]) return reply.code(404).send({ message: 'Sohbet bulunamadı.' });
  return { conversation: result.rows[0] };
});
app.delete('/v1/conversations/:conversationId', { onRequest: [auth] }, async (request, reply) => {
  const { conversationId } = z.object({ conversationId: uuid }).parse(request.params);
  const result = await db.query('DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id', [conversationId, request.user.userId]);
  if (!result.rows[0]) return reply.code(404).send({ message: 'Sohbet bulunamadı.' });
  return reply.code(204).send();
});
app.addHook('onClose', async () => db.end());
try { await app.listen({ host: config.HOST, port: config.PORT }); } catch (error) { app.log.error(error); process.exit(1); }
