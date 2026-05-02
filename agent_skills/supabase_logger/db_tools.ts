import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey);

export const logDietTool = tool(
  async ({
    room_id,
    user_message,
    image_path,
    title,
    ai_analysis_report = "",
    diet_report,
    user_id,
    record_type = "chat",
    summary_text
  }) => {
    try {
      const summaryColumnEnabled = process.env.ENABLE_SUMMARY_COLUMN === "true";
      const looksLikeSummaryText =
        typeof ai_analysis_report === "string" &&
        /總結|摘要|summary/i.test(ai_analysis_report) &&
        (diet_report === null || diet_report === undefined);

      if (record_type === "summary") {
        if (!summaryColumnEnabled) {
          return "⚠️ 已阻擋 summary 寫入對話紀錄欄位。請先建立專用 summary 欄位後再儲存。";
        }
        if (!summary_text) {
          return "⚠️ 缺少 summary_text，無法儲存摘要。";
        }

        const summaryInsertData: any = {
          room_id,
          user_message,
          title: title || user_message.slice(0, 60),
          summary: summary_text,
          ai_analysis_report: "",
        };
        if (user_id) summaryInsertData.user_id = user_id;

        const { error: summaryInsertError } = await supabase
          .from('diet_chat_history')
          .insert([summaryInsertData]);

        if (summaryInsertError) {
          console.error("Supabase 摘要寫入錯誤:", summaryInsertError);
          return `摘要寫入失敗: ${summaryInsertError.message}`;
        }
        return "✅ 摘要已寫入 summary 欄位。";
      }

      if (looksLikeSummaryText) {
        return "⚠️ 偵測到摘要內容且無營養數據，已阻擋寫入 ai_analysis_report。";
      }
      if (!ai_analysis_report) {
        return "⚠️ 缺少 ai_analysis_report，已取消寫入。";
      }

      const insertData: any = {
        room_id,
        user_message,
        title: title || user_message.slice(0, 60),
        ai_analysis_report,
        diet_report,
      };

      if (image_path) insertData.image_path = image_path;
      if (user_id) insertData.user_id = user_id;
      if (summary_text && summaryColumnEnabled) {
        insertData.summary = summary_text;
      }

      const { data, error } = await supabase
        .from('diet_chat_history')
        .insert([insertData])
        .select();

      if (error) {
        console.error("Supabase 寫入錯誤:", error);
        return `資料寫入失敗: ${error.message}`;
      }

      return "✅ 飲食紀錄已成功儲存至雲端資料庫！";
    } catch (error: any) {
      return `系統執行錯誤: ${error.message}`;
    }
  },
  {
    name: "log_diet_history",
    description: "當你完成對話或分析後，『必須』呼叫此工具將所有結果寫入資料庫永久保存。",
    schema: z.object({
      room_id: z.string().describe("目前的對話群組 ID (通常對應 thread_id)"),
      user_message: z.string().describe("使用者最初的詢問內容"),
      image_path: z.string().optional().describe("使用者上傳的圖片路徑 (若有)"),
      title: z.string().optional().describe("本次對話標題，建議 60 字內。"),
      ai_analysis_report: z.string().optional().describe("你給予使用者的白話文結語與專業建議 (不要包含 Markdown 表格，純文字建議即可)"),
      diet_report: z.any().optional().describe("由 calculate_nutrition 工具算出來的 JSON 結構化數據 (包含各食材熱量與總和)"),
      user_id: z.string().optional().describe("使用者的 UUID (若系統目前未提供可忽略)"),
      record_type: z.enum(["chat", "summary"]).optional().describe("寫入類型。一般對話用 chat。摘要內容必須用 summary，且不會寫入對話紀錄欄位。"),
      summary_text: z.string().optional().describe("若未來已建立 summary 專用欄位，可放摘要文字。")
    })
  }
);



export const getChatHistoryTool = tool(
  async ({ room_id, limit = 5 }) => {
    const { data, error } = await supabase
      .from('diet_chat_history')
      .select('*')
      .eq('room_id', room_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return `讀取歷史失敗: ${error.message}`;
    return JSON.stringify(data);
  },
  {
    name: "get_chat_history",
    description: "讀取目前聊天室過去的飲食紀錄與分析。在給予建議前，先了解使用者今天已經攝取了多少熱量。",
    schema: z.object({
      room_id: z.string(),
      limit: z.number().optional().default(5)
    })
  }
);


export const getUserProfileTool = tool(
  async ({ user_id }) => {
    const { data, error } = await supabase
      .from('users')
      .select('nickname, height, weight, age, gender, taboo, disease')
      .eq('id', user_id)
      .single();

    if (error) return `讀取使用者資料失敗: ${error.message}`;
    return JSON.stringify(data);
  },
  {
    name: "get_user_profile",
    description: "讀取使用者的健康背景，包含體徵、忌口項目 (taboo) 與疾病史 (disease)。",
    schema: z.object({
      user_id: z.string()
    })
  }
);
