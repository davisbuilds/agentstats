import type Database from 'better-sqlite3';

// --- Tool category normalization ---

const CATEGORY_MAP: Record<string, string> = {
  Read: 'Read',
  NotebookRead: 'Read',
  Write: 'Write',
  NotebookEdit: 'Write',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  Grep: 'Search',
  Glob: 'Search',
  WebSearch: 'Search',
  WebFetch: 'Search',
  Bash: 'Bash',
  Agent: 'Agent',
  ToolSearch: 'Agent',
  Skill: 'Agent',
  AskUserQuestion: 'Other',
};

export function categorizeToolName(toolName: string): string {
  return CATEGORY_MAP[toolName] ?? 'Other';
}

// --- JSONL line types ---

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

interface ClaudeCodeLine {
  type?: string;
  parentUuid?: string | null;
  sessionId?: string;
  isSidechain?: boolean;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
  };
  // progress / system fields
  data?: Record<string, unknown>;
  subtype?: string;
}

// --- Parsed output types ---

export interface ParsedMessage {
  session_id: string;
  ordinal: number;
  role: string;
  content: string; // JSON-serialized ContentBlock[]
  timestamp: string | null;
  has_thinking: number;
  has_tool_use: number;
  content_length: number;
}

export interface ParsedToolCall {
  session_id: string;
  tool_name: string;
  category: string;
  tool_use_id: string | null;
  input_json: string | null;
  message_ordinal: number; // used to link to message after insert
}

export interface ParsedSessionMetadata {
  session_id: string;
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

export interface ParsedSession {
  messages: ParsedMessage[];
  toolCalls: ParsedToolCall[];
  metadata: ParsedSessionMetadata;
}

// --- Extract project name from file path ---

function projectFromPath(filePath: string): string | null {
  // Path pattern: ~/.claude/projects/-Users-dev-my-project/session.jsonl
  // The directory name encodes the full path with '-' as separator, prefixed with '-'.
  // e.g. "-Users-dg-mac-mini-Dev-agentmonitor" → project is "agentmonitor"
  // e.g. "-Users-dev-my-project" → project is "my-project"
  // Strategy: the encoded dir represents a filesystem path. The last path component
  // (after the last known directory separator) is the project name. We use the cwd
  // from the JSONL if available, but as fallback we decode the directory name.
  const parts = filePath.split('/');
  const projectsIdx = parts.indexOf('projects');
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
    const encodedDir = parts[projectsIdx + 1];
    // The encoded dir is a path like "-Users-dev-my-project".
    // We need to find where the last path component starts.
    // Claude Code encodes "/" as "-", so we need to figure out which "-" is a separator
    // and which is part of the name. Use a heuristic: split by known path prefixes.
    // Most reliable: look for common path patterns.

    // Try matching known patterns: -Users-<user>-<...>-<project>
    // or -home-<user>-<...>-<project>
    const match = encodedDir.match(/^-(?:Users|home)-[^-]+-(.+)$/);
    if (match) {
      // The remainder after "-Users-<username>-" may contain multiple path segments.
      // The last segment (after the last known directory separator '-' that maps to '/')
      // is the project. But we don't know which '-' are separators vs part of names.
      // Best approach: use the cwd from the JSONL data. As fallback, take everything
      // after the last major directory marker.
      const remainder = match[1];
      // Common pattern: Dev-projectname or Documents-projectname
      // Just take everything after the last known single-component directory
      const knownDirs = ['Dev', 'Documents', 'Projects', 'repos', 'code', 'src', 'work', 'projects', 'workspace', 'git'];
      for (const dir of knownDirs) {
        const dirIdx = remainder.indexOf(dir + '-');
        if (dirIdx >= 0) {
          return remainder.slice(dirIdx + dir.length + 1);
        }
      }
      // Fallback: just return the full remainder
      return remainder;
    }
  }
  return null;
}

// --- Parse JSONL content into structured messages ---

export function parseSessionMessages(
  jsonlContent: string,
  sessionId: string,
  filePath?: string,
): ParsedSession {
  const messages: ParsedMessage[] = [];
  const toolCalls: ParsedToolCall[] = [];
  let firstUserMessage: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let userMessageCount = 0;
  const parentSessionId: string | null = null;

  const lines = jsonlContent.split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let line: ClaudeCodeLine;
    try {
      line = JSON.parse(trimmed) as ClaudeCodeLine;
    } catch {
      continue; // Skip malformed lines
    }

    const lineType = line.type;
    if (!lineType) continue;

    // Only process user and assistant message lines
    if (lineType !== 'user' && lineType !== 'assistant') continue;

    const msg = line.message;
    if (!msg || !msg.role) continue;

    // Extract content blocks
    const rawContent = msg.content;
    if (rawContent == null) continue;

    // Normalize content to array of blocks
    let blocks: ContentBlock[];
    if (typeof rawContent === 'string') {
      blocks = [{ type: 'text', text: rawContent }];
    } else if (Array.isArray(rawContent)) {
      blocks = rawContent as ContentBlock[];
    } else {
      continue;
    }

    // Filter to known block types and normalize
    const normalizedBlocks: ContentBlock[] = [];
    let hasThinking = false;
    let hasToolUse = false;

    for (const block of blocks) {
      if (!block || typeof block !== 'object' || !block.type) continue;

      switch (block.type) {
        case 'text':
          normalizedBlocks.push({ type: 'text', text: block.text ?? '' });
          break;
        case 'thinking':
          normalizedBlocks.push({ type: 'thinking', text: block.thinking ?? '' });
          hasThinking = true;
          break;
        case 'tool_use':
          normalizedBlocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          hasToolUse = true;

          // Extract tool call record
          if (block.name) {
            toolCalls.push({
              session_id: sessionId,
              tool_name: block.name,
              category: categorizeToolName(block.name),
              tool_use_id: block.id ?? null,
              input_json: block.input != null ? JSON.stringify(block.input) : null,
              message_ordinal: messages.length, // current message index
            });
          }
          break;
        case 'tool_result':
          normalizedBlocks.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          });
          break;
        default:
          // Keep unknown block types as-is for forward compatibility
          normalizedBlocks.push(block);
          break;
      }
    }

    const contentJson = JSON.stringify(normalizedBlocks);
    const timestamp = line.timestamp ?? null;

    // Track timestamps for session metadata
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!endedAt || timestamp > endedAt) endedAt = timestamp;
    }

    // Track first user message
    if (msg.role === 'user') {
      userMessageCount++;
      if (firstUserMessage === null) {
        const textBlock = normalizedBlocks.find(b => b.type === 'text');
        if (textBlock?.text) {
          firstUserMessage = textBlock.text.slice(0, 200);
        }
      }
    }

    messages.push({
      session_id: sessionId,
      ordinal: messages.length,
      role: msg.role,
      content: contentJson,
      timestamp,
      has_thinking: hasThinking ? 1 : 0,
      has_tool_use: hasToolUse ? 1 : 0,
      content_length: contentJson.length,
    });
  }

  const project = filePath ? projectFromPath(filePath) : null;

  return {
    messages,
    toolCalls,
    metadata: {
      session_id: sessionId,
      project,
      agent: 'claude',
      first_message: firstUserMessage,
      started_at: startedAt,
      ended_at: endedAt,
      message_count: messages.length,
      user_message_count: userMessageCount,
      parent_session_id: parentSessionId,
      relationship_type: null,
    },
  };
}

// --- Insert parsed session into database ---

export function insertParsedSession(
  db: Database.Database,
  parsed: ParsedSession,
  filePath: string,
  fileSize: number,
  fileHash: string,
): void {
  const txn = db.transaction(() => {
    const { metadata, messages, toolCalls } = parsed;

    // Clear existing data for this session (for re-parse)
    db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(metadata.session_id);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(metadata.session_id);
    db.prepare('DELETE FROM browsing_sessions WHERE id = ?').run(metadata.session_id);

    // Insert browsing session
    db.prepare(`
      INSERT INTO browsing_sessions (id, project, agent, first_message, started_at, ended_at, message_count, user_message_count, parent_session_id, relationship_type, file_path, file_size, file_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      metadata.session_id,
      metadata.project,
      metadata.agent,
      metadata.first_message,
      metadata.started_at,
      metadata.ended_at,
      metadata.message_count,
      metadata.user_message_count,
      metadata.parent_session_id,
      metadata.relationship_type,
      filePath,
      fileSize,
      fileHash,
    );

    // Insert messages and collect their IDs for tool call linking
    const insertMsg = db.prepare(`
      INSERT INTO messages (session_id, ordinal, role, content, timestamp, has_thinking, has_tool_use, content_length)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const messageIds: number[] = [];
    for (const msg of messages) {
      const result = insertMsg.run(
        msg.session_id,
        msg.ordinal,
        msg.role,
        msg.content,
        msg.timestamp,
        msg.has_thinking,
        msg.has_tool_use,
        msg.content_length,
      );
      messageIds.push(Number(result.lastInsertRowid));
    }

    // Insert tool calls linked to their messages
    const insertTc = db.prepare(`
      INSERT INTO tool_calls (message_id, session_id, tool_name, category, tool_use_id, input_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const tc of toolCalls) {
      const messageId = messageIds[tc.message_ordinal];
      if (messageId != null) {
        insertTc.run(
          messageId,
          tc.session_id,
          tc.tool_name,
          tc.category,
          tc.tool_use_id,
          tc.input_json,
        );
      }
    }
  });

  txn();
}
