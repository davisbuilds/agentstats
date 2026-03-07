// --- Database row types (also used as API response shapes) ---

export interface BrowsingSessionRow {
  id: string;
  project: string | null;
  agent: string;
  first_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  user_message_count: number;
  parent_session_id: string | null;
  relationship_type: string | null;
  file_path: string | null;
  file_size: number | null;
  file_hash: string | null;
}

export interface MessageRow {
  id: number;
  session_id: string;
  ordinal: number;
  role: string;
  content: string; // JSON-serialized content blocks
  timestamp: string | null;
  has_thinking: number; // 0 or 1
  has_tool_use: number; // 0 or 1
  content_length: number;
}

export interface ToolCallRow {
  id: number;
  message_id: number;
  session_id: string;
  tool_name: string;
  category: string | null;
  tool_use_id: string | null;
  input_json: string | null;
  result_content: string | null;
  result_content_length: number | null;
  subagent_session_id: string | null;
}

// --- Aggregate query result ---

export interface CountResult {
  c: number;
}

// --- Analytics response types ---

export interface AnalyticsSummary {
  total_sessions: number;
  total_messages: number;
  total_user_messages: number;
  daily_average_sessions: number;
  daily_average_messages: number;
  date_range: {
    earliest: string | null;
    latest: string | null;
  };
}

export interface ActivityDataPoint {
  date: string;
  sessions: number;
  messages: number;
}

export interface ProjectBreakdown {
  project: string;
  session_count: number;
  message_count: number;
}

export interface ToolUsageStat {
  tool_name: string;
  category: string | null;
  count: number;
}

// --- API request params ---

export interface SessionsListParams {
  limit?: number;
  cursor?: string;
  project?: string;
  agent?: string;
  date_from?: string;
  date_to?: string;
  min_messages?: number;
  max_messages?: number;
}

export interface MessagesListParams {
  offset?: number;
  limit?: number;
}

export interface SearchParams {
  q: string;
  project?: string;
  agent?: string;
  limit?: number;
  cursor?: string;
}

export interface AnalyticsParams {
  date_from?: string;
  date_to?: string;
  project?: string;
  agent?: string;
}
