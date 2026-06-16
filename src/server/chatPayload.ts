import { z } from 'zod';

export const ChatModelSourceSchema = z.enum(['auto', 'google', 'local']);
export type ChatModelSource = z.infer<typeof ChatModelSourceSchema>;

export const ChatRequestSchema = z
  .object({
    message: z.string().optional().default(''),
    thread_id: z.string().trim().min(1),
    chat_history_id: z.string().trim().min(1),
    user_id: z.string().trim().optional(),
    user_context: z
      .union([
        z.array(z.unknown()),
        z.record(z.string(), z.unknown()),
        z.null(),
      ])
      .optional()
      .default([]),
    image: z.unknown().optional(),
    image_mime_type: z.string().trim().optional(),
    imageMimeType: z.string().trim().optional(),
    is_new_conversation: z.boolean().optional().default(false),
    model_source: ChatModelSourceSchema.optional().default('auto'),
  })
  .superRefine((value, ctx) => {
    const hasMessage = value.message.trim().length > 0;
    const hasImage = value.image != null;
    if (!hasMessage && !hasImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either message or image is required.',
        path: ['message'],
      });
    }
  });

export type ChatRequestPayload = z.infer<typeof ChatRequestSchema>;
