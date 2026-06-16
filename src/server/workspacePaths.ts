import express from 'express';
import path from 'path';

export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const USERS_IMAGES_DIR = path.join(ROOT_DIR, 'users_images');
export const KNOWLEDGE_BASE_DIR = path.join(ROOT_DIR, 'knowledge_base');
export const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024);

export const AGENT_FILE = path.join(KNOWLEDGE_BASE_DIR, 'AGENT.md');
export const INDEX_FILE = path.join(KNOWLEDGE_BASE_DIR, 'SKILLS_INDEX.md');
export const LEGACY_INDEX_FILE = path.join(KNOWLEDGE_BASE_DIR, 'SKILL_INDEX.md');
export const RULES_FILE = path.join(KNOWLEDGE_BASE_DIR, 'NUTRITION_RULES.md');

export const imagesStaticMiddleware = express.static(USERS_IMAGES_DIR);
