import { z } from 'zod';

export const ChatModelSourceSchema = z.enum(['auto', 'google', 'local']);
export type ChatModelSource = z.infer<typeof ChatModelSourceSchema>;

const ChatAttachmentSchema = z
  .object({
    kind: z.string().trim().optional(),
    name: z.string().trim().optional(),
    mime_type: z.string().trim().optional(),
    mimeType: z.string().trim().optional(),
    data_url: z.string().trim().optional(),
    dataUrl: z.string().trim().optional(),
    base64: z.string().trim().optional(),
    url: z.string().trim().optional(),
    path: z.string().trim().optional(),
  })
  .passthrough();

export const ChatRequestSchema = z
  .object({
    message: z.string().optional().default(''),
    thread_id: z.string().trim().min(1),
    chat_history_id: z.string().trim().min(1).optional(),
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
    attachments: z.array(ChatAttachmentSchema).optional().default([]),
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
