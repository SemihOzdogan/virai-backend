import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4300),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_CHAT_MODEL: z.string().default('qwen2.5:7b'),
  OLLAMA_TITLE_MODEL: z.string().default('qwen2.5:3b'),
  OLLAMA_EMBEDDING_MODEL: z.string().default('embeddinggemma-2:270m'),
  CORS_ORIGIN: z.string().url().optional(),
  DATA_DIR: z.string().min(1).default('data'),
});

const result = schema.safeParse(process.env);
if (!result.success) throw new Error(`Geçersiz ortam yapılandırması: ${result.error.message}`);
export const config = {
  ...result.data,
  UPLOAD_DIRECTORY: resolve(result.data.DATA_DIR, 'uploads'),
};
