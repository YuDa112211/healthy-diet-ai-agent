import { createClient } from '@supabase/supabase-js';

export const AI_API_URL = process.env.AI_API_URL || 'http://100.113.105.18:8080/v1';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';

export const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
export const isSupabaseReady = Boolean(supabase);
