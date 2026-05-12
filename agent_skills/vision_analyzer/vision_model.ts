import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { tool } from '@langchain/core/tools';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

const PROJECT_ROOT = path.resolve(__dirname, '../../');

const cleanModelOutput = (raw: string): string =>
  raw.replace(/```json/gi, '').replace(/```/g, '').trim();

const messageContentToText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('')
    .trim();
};

const buildSummaryResult = (summary: string): string =>
  JSON.stringify(
    {
      summary: summary.trim() || '此圖片未辨識到食物，提供一般圖片簡介。',
    },
    null,
    2
  );

export const visionAnalyzerTool = tool(
  async ({ imagePath }) => {
    try {
      const fullPath = path.resolve(PROJECT_ROOT, imagePath);
      if (!fullPath.startsWith(PROJECT_ROOT)) {
        return 'Error: image path is outside project root.';
      }
      if (!fs.existsSync(fullPath)) {
        return JSON.stringify(
          {
            summary: `找不到圖片檔案：${imagePath}`,
          },
          null,
          2
        );
      }

      const imageBuffer = await sharp(fullPath)
        .resize({ width: 1024, height: 1024, fit: 'inside' })
        .jpeg({ quality: 82 })
        .toBuffer();

      const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

      const visionLlm = new ChatOpenAI({
        modelName: 'gemma-4-e4b',
        temperature: 0,
        maxTokens: 2048,
        apiKey: process.env.AI_API_KEY || 'dummy',
        configuration: { baseURL: process.env.AI_API_URL || 'http://localhost:8080/v1' },
      });

      const systemPrompt = [
        'You are a vision analysis assistant.',
        'Return JSON only, no markdown, no extra prose.',
        'If this image clearly contains food, return:',
        '{',
        '  "dish_name": "string",',
        '  "ingredients": [',
        '    {',
        '      "name": "string",',
        '      "estimated_weight_g": number,',
        '      "estimated_calories": "string",',
        '      "cooking_method": "string"',
        '    }',
        '  ]',
        '}',
        'If this image does not contain identifiable food, return:',
        '{',
        '  "summary": "brief image description in Traditional Chinese"',
        '}',
      ].join('\n');

      const messages = [
        new SystemMessage(systemPrompt),
        new HumanMessage({
          content: [
            { type: 'text', text: 'Analyze this image according to the JSON rules.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }),
      ];

      const response = await visionLlm.invoke(messages);
      const rawText = cleanModelOutput(messageContentToText(response.content));

      try {
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        const dishName =
          typeof parsed.dish_name === 'string' ? parsed.dish_name.trim() : '';

        if (dishName.length > 0) {
          return JSON.stringify(parsed, null, 2);
        }

        const summary =
          typeof parsed.summary === 'string' ? parsed.summary : '此圖片未辨識到食物。';
        return buildSummaryResult(summary);
      } catch {
        return buildSummaryResult(rawText || '此圖片未辨識到食物。');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return `Error analyzing image: ${message}`;
    }
  },
  {
    name: 'analyze_food_image',
    description:
      'Analyze an image path. Return food JSON (dish_name + ingredients) when food exists, otherwise return summary JSON.',
    schema: z.object({
      imagePath: z
        .string()
        .describe('Relative image path under project, e.g. users_images/user_123/lunch.jpg'),
    }),
  }
);
