import { createClient } from '@supabase/supabase-js';
import { getAiApiUrl } from './aiRuntime';

export const AI_API_URL = getAiApiUrl();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';

export const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
export const isSupabaseReady = Boolean(supabase);
