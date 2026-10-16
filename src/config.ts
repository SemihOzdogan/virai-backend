import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4300),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // Local development can use OLLAMA_BASE_URL. Render Blueprints provide the
  // private Ollama service address as OLLAMA_HOSTPORT instead.
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_HOSTPORT: z.string().min(1).optional(),
  OLLAMA_CHAT_MODEL: z.string().default('qwen2.5:7b'),
  OLLAMA_TITLE_MODEL: z.string().default('qwen2.5:3b'),
  OLLAMA_EMBEDDING_MODEL: z.string().default('embeddinggemma-2:270m'),
  CORS_ORIGIN: z.string().url().optional(),
});

const result = schema.safeParse(process.env);
if (!result.success) throw new Error(`Geçersiz ortam yapılandırması: ${result.error.message}`);
export const config = {
  ...result.data,
  OLLAMA_BASE_URL: result.data.OLLAMA_BASE_URL
    ?? (result.data.OLLAMA_HOSTPORT ? `http://${result.data.OLLAMA_HOSTPORT}` : 'http://host.docker.internal:11434'),
};
