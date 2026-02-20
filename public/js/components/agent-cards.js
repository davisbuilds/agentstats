// Agent Cards - per-session live activity cards (PRIMARY component)
const AgentCards = {
  sessions: new Map(), // sessionId -> { session, events[] }
  MAX_EVENTS_PER_CARD: 8,

  agentColors: {
    claude_code: { label: 'Claude Code', border: 'border-l-purple-500', badge: 'bg-purple-500/20 text-purple-300', dot: 'text-purple-400' },
    codex: { label: 'Codex', border: 'border-l-emerald-500', badge: 'bg-emerald-500/20 text-emerald-300', dot: 'text-emerald-400' },
    default: { label: 'Agent', border: 'border-l-blue-500', badge: 'bg-blue-500/20 text-blue-300', dot: 'text-blue-400' },
  },

  statusColors: {
    active: { dot: 'bg-green-400', text: 'text-green-400', border: 'border-l-green-500' },
    idle: { dot: 'bg-yellow-400', text: 'text-yellow-400', border: 'border-l-yellow-500' },
    ended: { dot: 'bg-gray-500', text: 'text-gray-500', border: 'border-l-gray-600' },
  },

  formatCost(n) {
    if (n === 0 || n == null) return '$0.00';
    if (n < 0.01) return '<$0.01';
    return '$' + n.toFixed(2);
  },

  getAgentStyle(agentType) {
    return this.agentColors[agentType] || this.agentColors.default;
  },

  getStatusStyle(status) {
    return this.statusColors[status] || this.statusColors.active;
  },

  initFromData(sessions, events) {
    // Group events by session
    const eventsBySession = new Map();
    for (const evt of events) {
      if (!eventsBySession.has(evt.session_id)) {
        eventsBySession.set(evt.session_id, []);
      }
      eventsBySession.get(evt.session_id).push(evt);
    }

    for (const session of sessions) {
      const sessionEvents = (eventsBySession.get(session.id) || []).slice(0, this.MAX_EVENTS_PER_CARD);
      this.sessions.set(session.id, { session, events: sessionEvents });
    }
    this.renderAll();
  },

  handleEvent(event) {
    const sessionId = event.session_id;
    if (!this.sessions.has(sessionId)) {
      // New session
      this.sessions.set(sessionId, {
        session: {
          id: sessionId,
          agent_type: event.agent_type,
          project: event.project,
          branch: event.branch,
          status: 'active',
          started_at: event.created_at,
          last_event_at: event.created_at,
          event_count: 0,
          tokens_in: 0,
          tokens_out: 0,
          files_edited: 0,
          _editedFiles: new Set(),
        },
        events: [],
      });
    }

    const entry = this.sessions.get(sessionId);
    entry.session.last_event_at = event.created_at;
    entry.session.status = 'active';
    entry.session.event_count = (entry.session.event_count || 0) + 1;
    entry.session.tokens_in = (entry.session.tokens_in || 0) + (event.tokens_in || 0);
    entry.session.tokens_out = (entry.session.tokens_out || 0) + (event.tokens_out || 0);
    entry.session.total_cost_usd = (entry.session.total_cost_usd || 0) + (event.cost_usd || 0);
    if (event.project) entry.session.project = event.project;
    if (event.branch) entry.session.branch = event.branch;

    // Prepend event, keep max
    entry.events.unshift(event);
    if (entry.events.length > this.MAX_EVENTS_PER_CARD) {
      entry.events.pop();
    }

    // Track unique files edited (seed from server count on first incremental update)
    if (['Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_stdin'].includes(event.tool_name) && event.metadata?.file_path) {
      if (!entry.session._editedFiles) {
        entry.session._editedFiles = new Set();
        // Preserve server-side count as a baseline
        entry.session._filesEditedBaseline = entry.session.files_edited || 0;
      }
      entry.session._editedFiles.add(event.metadata.file_path);
      entry.session.files_edited = Math.max(
        entry.session._filesEditedBaseline || 0,
        entry.session._editedFiles.size,
      );
    }

    // Claude Code sessions go idle on session_end; other agents end immediately
    if (event.event_type === 'session_end') {
      entry.session.status = event.agent_type === 'claude_code' ? 'idle' : 'ended';
    }

    this.renderAll();
  },

  handleSessionUpdate() {
    // Re-fetch sessions to get updated statuses
    // For now just re-render with current data
    this.renderAll();
  },

  formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  },

  formatRelativeTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z'));
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
  },

  formatDuration(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z'));
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return '<1m';
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ${diffMin % 60}m`;
  },

  getNowLine(entry) {
    const { session, events } = entry;
    const latestEvent = events[0];
    if (!latestEvent) return { label: 'Waiting...', detail: '' };

    if (session.status === 'active') {
      if (latestEvent.event_type === 'tool_use') {
        const toolLabel = latestEvent.tool_name || 'tool';
        let detail = '';
        try {
          const meta = typeof latestEvent.metadata === 'string' ? JSON.parse(latestEvent.metadata) : latestEvent.metadata;
          if (meta.command) detail = meta.command;
          else if (meta.file_path) detail = meta.file_path.split('/').pop();
          else if (meta.pattern) detail = meta.pattern;
          else if (meta.query) detail = meta.query;
        } catch {}
        return { label: `Running ${toolLabel}`, detail };
      }
      if (latestEvent.event_type === 'response') {
        return { label: 'Processing response...', detail: '' };
      }
      return { label: `${latestEvent.event_type}`, detail: '' };
    }

    // Idle or ended
    if (latestEvent.event_type === 'tool_use') {
      return { label: `Last: ${latestEvent.tool_name || 'tool'}`, detail: this.formatRelativeTime(latestEvent.created_at) };
    }
    return { label: `Last: ${latestEvent.event_type}`, detail: this.formatRelativeTime(latestEvent.created_at) };
  },

  statusBadge(status) {
    const style = this.getStatusStyle(status);
    return `<span class="inline-flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full ${style.dot}"></span><span class="${style.text}">${status.charAt(0).toUpperCase() + status.slice(1)}</span></span>`;
  },

  eventStatusIcon(event) {
    if (event.status === 'error') return '<span class="text-red-400">✗</span>';
    if (event.status === 'timeout') return '<span class="text-yellow-400">⏱</span>';
    return '<span class="text-green-400/60">✓</span>';
  },

  eventTypeBadge(event) {
    if (event.event_type === 'tool_use') {
      return `<span class="text-gray-200">${event.tool_name || 'tool'}</span>`;
    }
    if (event.event_type === 'response') {
      return '<span class="text-blue-400">response</span>';
    }
    if (event.event_type === 'error') {
      return '<span class="text-red-400">error</span>';
    }
    return `<span class="text-yellow-400">${event.event_type}</span>`;
  },

  eventDetail(event) {
    try {
      const meta = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
      if (meta.command) return meta.command;
      if (meta.file_path) return meta.file_path.split('/').pop();
      if (meta.pattern) return meta.pattern;
      if (meta.query) return meta.query;
    } catch {}
    return '';
  },

  renderCard(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return '';

    const { session, events } = entry;
    const agentStyle = this.getAgentStyle(session.agent_type);
    const statusStyle = this.getStatusStyle(session.status);
    const nowLine = this.getNowLine(entry);
    const isActive = session.status === 'active';

    const eventsHtml = events.map(evt => {
      const detail = this.eventDetail(evt);
      return `
        <div class="flex items-center gap-2 text-xs py-0.5">
          <span class="text-gray-500 w-10 shrink-0">${this.formatTime(evt.created_at)}</span>
          <span class="w-16 shrink-0">${this.eventTypeBadge(evt)}</span>
          <span class="text-gray-400 truncate flex-1">${detail}</span>
          <span class="shrink-0">${this.eventStatusIcon(evt)}</span>
        </div>`;
    }).join('');

    return `
      <div class="bg-gray-900 rounded-lg border border-gray-700 border-l-4 ${statusStyle.border} overflow-hidden" data-session-id="${sessionId}">
        <!-- Card Header -->
        <div class="px-4 pt-3 pb-2">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs px-1.5 py-0.5 rounded ${agentStyle.badge}">${agentStyle.label}</span>
            ${this.statusBadge(session.status)}
          </div>
          <div class="text-sm font-medium text-gray-100">
            ${session.project || session.id.slice(0, 12) + '...'} ${session.branch ? `/ <span class="text-gray-400">${session.branch}</span>` : ''}
          </div>
          <div class="text-xs text-gray-500 mt-0.5">
            ${session.event_count || 0} events${session.files_edited ? ` · ${session.files_edited} file${session.files_edited !== 1 ? 's' : ''} edited` : ''}${session.total_cost_usd ? ` · ${this.formatCost(session.total_cost_usd)}` : ''} · ${this.formatDuration(session.started_at)}
          </div>
        </div>

        <!-- NOW Line -->
        <div class="px-4 py-2 bg-gray-800/50 border-y border-gray-800">
          <div class="flex items-center gap-2">
            ${isActive ? '<span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>' : '<span class="w-1.5 h-1.5 rounded-full bg-gray-500"></span>'}
            <span class="text-sm ${isActive ? 'text-white font-medium' : 'text-gray-400'}">${isActive ? 'NOW' : ''}: ${nowLine.label}</span>
          </div>
          ${nowLine.detail ? `<div class="text-xs text-gray-500 mt-0.5 ml-3.5 truncate">▸ ${nowLine.detail}</div>` : ''}
        </div>

        <!-- Mini Event Feed -->
        <div class="px-4 py-2 max-h-48 overflow-y-auto">
          ${eventsHtml || '<div class="text-xs text-gray-500 py-1">No events yet</div>'}
        </div>
      </div>`;
  },

  renderAll() {
    const container = document.getElementById('agent-cards');
    const placeholder = document.getElementById('no-agents-placeholder');
    const countLabel = document.getElementById('agent-card-count');

    if (this.sessions.size === 0) {
      placeholder.classList.remove('hidden');
      countLabel.textContent = '0 sessions';
      // Clear cards but keep placeholder
      const cards = container.querySelectorAll('[data-session-id]');
      cards.forEach(c => c.remove());
      return;
    }

    placeholder.classList.add('hidden');

    // Sort: active first, then idle, then ended; within each group by last_event_at desc
    const sorted = [...this.sessions.entries()].sort(([, a], [, b]) => {
      const statusOrder = { active: 0, idle: 1, ended: 2 };
      const aOrder = statusOrder[a.session.status] ?? 1;
      const bOrder = statusOrder[b.session.status] ?? 1;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (b.session.last_event_at || '').localeCompare(a.session.last_event_at || '');
    });

    const html = sorted.map(([id]) => this.renderCard(id)).join('');
    // Remove old cards and render new ones
    const existingCards = container.querySelectorAll('[data-session-id]');
    existingCards.forEach(c => c.remove());
    container.insertAdjacentHTML('beforeend', html);

    countLabel.textContent = `${this.sessions.size} session${this.sessions.size !== 1 ? 's' : ''}`;
  },
};
