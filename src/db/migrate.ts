import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { db } from './pool.js';
const sql = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
try { await db.query(sql); console.log('Veritabanı şeması hazır.'); } finally { await db.end(); }

