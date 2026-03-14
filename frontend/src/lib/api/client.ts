// --- V1 API types (existing Monitor tab) ---

export interface Stats {
  total_events: number;
  active_sessions: number;
  live_sessions: number;
  total_sessions: number;
  active_agents: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  tool_breakdown: Record<string, number>;
  agent_breakdown: Record<string, number>;
  model_breakdown: Record<string, number>;
  branches: string[];
  usage_monitor?: UsageMonitorData[];
}

export interface UsageMonitorData {
  agent_type: string;
  limitType: string;
  session: { tokens: number; limit: number; percent: number };
  extended: { tokens: number; limit: number; percent: number };
  weekly: { tokens: number; limit: number; percent: number };
}

export interface AgentEvent {
  id: number;
  event_id?: string;
  session_id: string;
  agent_type: string;
  event_type: string;
  tool_name?: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  model?: string;
  cost_usd?: number;
  project?: string;
  branch?: string;
  duration_ms?: number;
  created_at: string;
  client_timestamp?: string;
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface Session {
  id: string;
  agent_id: string;
  agent_type: string;
  project?: string;
  branch?: string;
  status: string;
  started_at: string;
  ended_at?: string;
  last_event_at: string;
  metadata?: Record<string, unknown>;
}

export interface CostData {
  timeline: Array<{ date: string; cost: number }>;
  by_project: Array<{ project: string; cost: number }>;
  by_model: Array<{ model: string; cost: number }>;
}

export interface ToolStats {
  tools: Array<{
    tool_name: string;
    total_calls: number;
    error_count: number;
    error_rate: number;
    avg_duration_ms: number;
    by_agent: Record<string, number>;
  }>;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface FilterOptions {
  agent_types: string[];
  event_types: string[];
  tool_names: string[];
  models: string[];
  projects: string[];
  branches: SelectOption[];
  sources: string[];
}

// --- V2 API types (Session browser) ---

export interface BrowsingSession {
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
}

export interface Message {
  id: number;
  session_id: string;
  ordinal: number;
  role: string;
  content: string; // JSON string of content blocks
  timestamp: string | null;
  has_thinking: number;
  has_tool_use: number;
  content_length: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  is_error?: boolean;
  tool_use_id?: string;
}

export interface SearchResult {
  session_id: string;
  message_id: number;
  message_ordinal: number;
  message_role: string;
  snippet: string;
}

export interface AnalyticsSummary {
  total_sessions: number;
  total_messages: number;
  total_user_messages: number;
  daily_average_sessions: number;
  daily_average_messages: number;
  date_range: { earliest: string | null; latest: string | null };
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

// --- API client ---

type Filters = Record<string, string>;

interface RawCostData {
  timeline?: Array<{ bucket: string; cost_usd: number }>;
  by_project?: Array<{ project: string; cost_usd: number }>;
  by_model?: Array<{ model: string; cost_usd: number }>;
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

async function checkedJson<T>(res: Response, context: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${context} failed (${res.status}): ${body}`);
  }
  return res.json();
}

// V1 endpoints (Monitor tab)

export async function fetchStats(filters: Filters = {}): Promise<Stats> {
  const res = await fetch(`/api/stats${qs(filters)}`);
  return checkedJson(res, 'fetchStats');
}

export async function fetchEvents(filters: Filters = {}, limit = 100): Promise<{ events: AgentEvent[]; total: number }> {
  const res = await fetch(`/api/events${qs({ ...filters, limit })}`);
  return checkedJson(res, 'fetchEvents');
}

export async function fetchSessions(filters: Filters = {}): Promise<{ sessions: Session[]; total: number }> {
  const res = await fetch(`/api/sessions${qs(filters)}`);
  return checkedJson(res, 'fetchSessions');
}

export async function fetchFilterOptions(): Promise<FilterOptions> {
  const res = await fetch('/api/filter-options');
  return checkedJson(res, 'fetchFilterOptions');
}

export async function fetchCostData(filters: Filters = {}): Promise<CostData> {
  const res = await fetch(`/api/stats/cost${qs(filters)}`);
  const data = await checkedJson<RawCostData>(res, 'fetchCostData');
  return {
    timeline: Array.isArray(data.timeline)
      ? data.timeline.map((item) => ({
          date: item.bucket,
          cost: item.cost_usd,
        }))
      : [],
    by_project: Array.isArray(data.by_project)
      ? data.by_project.map((item) => ({
          project: item.project,
          cost: item.cost_usd,
        }))
      : [],
    by_model: Array.isArray(data.by_model)
      ? data.by_model.map((item) => ({
          model: item.model,
          cost: item.cost_usd,
        }))
      : [],
  };
}

export async function fetchToolStats(filters: Filters = {}): Promise<ToolStats> {
  const res = await fetch(`/api/stats/tools${qs(filters)}`);
  return checkedJson(res, 'fetchToolStats');
}

export async function fetchSessionDetail(id: string, eventLimit = 10): Promise<{ session: Session; events: AgentEvent[] }> {
  const res = await fetch(`/api/sessions/${id}?event_limit=${eventLimit}`);
  return checkedJson(res, 'fetchSessionDetail');
}

export async function fetchTranscript(id: string): Promise<{ transcript: Array<{ role: string; content: string; timestamp?: string }> }> {
  const res = await fetch(`/api/sessions/${id}/transcript`);
  return checkedJson(res, 'fetchTranscript');
}

// V2 endpoints (Session browser)

export async function fetchBrowsingSessions(params: Record<string, string | number | undefined> = {}): Promise<{ data: BrowsingSession[]; total: number; cursor?: string }> {
  const res = await fetch(`/api/v2/sessions${qs(params)}`);
  return checkedJson(res, 'fetchBrowsingSessions');
}

export async function fetchBrowsingSession(id: string): Promise<BrowsingSession> {
  const res = await fetch(`/api/v2/sessions/${id}`);
  return checkedJson(res, 'fetchBrowsingSession');
}

export async function fetchMessages(sessionId: string, params: { offset?: number; limit?: number } = {}): Promise<{ data: Message[]; total: number }> {
  const res = await fetch(`/api/v2/sessions/${sessionId}/messages${qs(params)}`);
  return checkedJson(res, 'fetchMessages');
}

export async function fetchSessionChildren(id: string): Promise<{ data: BrowsingSession[] }> {
  const res = await fetch(`/api/v2/sessions/${id}/children`);
  return checkedJson(res, 'fetchSessionChildren');
}

export async function searchMessages(params: { q: string; project?: string; agent?: string; limit?: number; cursor?: string }): Promise<{ data: SearchResult[]; total: number; cursor?: string }> {
  const res = await fetch(`/api/v2/search${qs(params)}`);
  return checkedJson(res, 'searchMessages');
}

export async function fetchAnalyticsSummary(params: Record<string, string | undefined> = {}): Promise<AnalyticsSummary> {
  const res = await fetch(`/api/v2/analytics/summary${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsSummary');
}

export async function fetchAnalyticsActivity(params: Record<string, string | undefined> = {}): Promise<{ data: ActivityDataPoint[] }> {
  const res = await fetch(`/api/v2/analytics/activity${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsActivity');
}

export async function fetchAnalyticsProjects(params: Record<string, string | undefined> = {}): Promise<{ data: ProjectBreakdown[] }> {
  const res = await fetch(`/api/v2/analytics/projects${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsProjects');
}

export async function fetchAnalyticsTools(params: Record<string, string | undefined> = {}): Promise<{ data: ToolUsageStat[] }> {
  const res = await fetch(`/api/v2/analytics/tools${qs(params)}`);
  return checkedJson(res, 'fetchAnalyticsTools');
}

export async function fetchV2Projects(): Promise<{ data: string[] }> {
  const res = await fetch('/api/v2/projects');
  return checkedJson(res, 'fetchV2Projects');
}

export async function fetchV2Agents(): Promise<{ data: string[] }> {
  const res = await fetch('/api/v2/agents');
  return checkedJson(res, 'fetchV2Agents');
}
