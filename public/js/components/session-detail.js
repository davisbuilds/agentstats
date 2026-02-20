// Session Detail - slide-over panel for session deep-dive
const SessionDetail = {
  visible: false,
  sessionId: null,
  data: null,
  activeTab: 'overview', // 'overview' | 'transcript'

  formatCost(n) {
    if (n === 0 || n == null) return '$0.00';
    if (n < 0.01) return '<$0.01';
    return '$' + n.toFixed(2);
  },

  formatNumber(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return (n || 0).toLocaleString();
  },

  formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  },

  init() {
    // Delegate click on agent cards to open detail
    document.getElementById('agent-cards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-session-id]');
      if (card) {
        this.open(card.dataset.sessionId);
      }
    });

    // Close on backdrop click or close button
    const panel = document.getElementById('session-detail-panel');
    if (panel) {
      panel.addEventListener('click', (e) => {
        if (e.target === panel || e.target.closest('#session-detail-close')) {
          this.close();
        }
      });
    }

    // Close on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) this.close();
    });
  },

  async open(sessionId) {
    this.sessionId = sessionId;
    this.visible = true;
    this.activeTab = 'overview';

    const panel = document.getElementById('session-detail-panel');
    panel.classList.remove('hidden');

    // Show loading state
    document.getElementById('session-detail-content').innerHTML =
      '<div class="flex items-center justify-center py-12 text-gray-500">Loading...</div>';

    try {
      const res = await fetch(`/api/sessions/${sessionId}?event_limit=100`);
      this.data = await res.json();
      this.render();
    } catch (err) {
      document.getElementById('session-detail-content').innerHTML =
        '<div class="text-center py-12 text-red-400">Failed to load session data</div>';
    }
  },

  switchTab(tab) {
    this.activeTab = tab;
    this.render();
    if (tab === 'transcript' && this.sessionId) {
      Transcript.load(this.sessionId);
    }
  },

  close() {
    this.visible = false;
    this.sessionId = null;
    document.getElementById('session-detail-panel').classList.add('hidden');
  },

  render() {
    const container = document.getElementById('session-detail-content');
    if (!container || !this.data) return;

    const { session, events } = this.data;
    if (!session) {
      container.innerHTML = '<div class="text-center py-12 text-gray-500">Session not found</div>';
      return;
    }

    // Aggregate tool breakdown from events
    const toolCounts = {};
    const modelCosts = {};
    let totalDuration = 0;
    let durationCount = 0;

    for (const evt of events) {
      if (evt.tool_name) {
        toolCounts[evt.tool_name] = (toolCounts[evt.tool_name] || 0) + 1;
      }
      if (evt.model && evt.cost_usd) {
        if (!modelCosts[evt.model]) modelCosts[evt.model] = 0;
        modelCosts[evt.model] += evt.cost_usd;
      }
      if (evt.duration_ms) {
        totalDuration += evt.duration_ms;
        durationCount++;
      }
    }

    const sortedTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
    const maxToolCount = sortedTools.length > 0 ? sortedTools[0][1] : 1;

    const sortedModels = Object.entries(modelCosts).sort((a, b) => b[1] - a[1]);
    const maxModelCost = sortedModels.length > 0 ? sortedModels[0][1] : 0.01;

    const agentStyle = AgentCards.getAgentStyle(session.agent_type);
    const statusStyle = AgentCards.getStatusStyle(session.status);

    const overviewActive = this.activeTab === 'overview';
    const transcriptActive = this.activeTab === 'transcript';

    container.innerHTML = `
      <!-- Header -->
      <div class="mb-4">
        <div class="flex items-center gap-3 mb-2">
          <span class="text-xs px-1.5 py-0.5 rounded ${agentStyle.badge}">${agentStyle.label}</span>
          <span class="inline-flex items-center gap-1.5 text-xs">
            <span class="w-1.5 h-1.5 rounded-full ${statusStyle.dot}"></span>
            <span class="${statusStyle.text}">${session.status}</span>
          </span>
        </div>
        <div class="text-lg font-medium text-white">${session.project || 'Unknown Project'}</div>
        ${session.branch ? `<div class="text-sm text-gray-400">${session.branch}</div>` : ''}
        <div class="text-xs text-gray-500 mt-1">
          Session: ${session.id.slice(0, 12)}... · Started ${this.formatTime(session.started_at)}
        </div>
      </div>

      <!-- Tab bar -->
      <div class="flex gap-1 mb-4 border-b border-gray-700 pb-1">
        <button data-tab="overview" class="text-xs px-3 py-1 rounded-t ${overviewActive ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}">Overview</button>
        <button data-tab="transcript" class="text-xs px-3 py-1 rounded-t ${transcriptActive ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}">Transcript</button>
      </div>

      <!-- Overview tab -->
      <div id="tab-overview" class="${overviewActive ? '' : 'hidden'}">

      <!-- Summary stats -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div class="bg-gray-800 rounded-lg p-3">
          <div class="text-xs text-gray-500">Events</div>
          <div class="text-lg font-bold text-white">${this.formatNumber(session.event_count)}</div>
        </div>
        <div class="bg-gray-800 rounded-lg p-3">
          <div class="text-xs text-gray-500">Cost</div>
          <div class="text-lg font-bold text-white">${this.formatCost(session.total_cost_usd)}</div>
        </div>
        <div class="bg-gray-800 rounded-lg p-3">
          <div class="text-xs text-gray-500">Tokens In</div>
          <div class="text-lg font-bold text-white">${this.formatNumber(session.tokens_in)}</div>
        </div>
        <div class="bg-gray-800 rounded-lg p-3">
          <div class="text-xs text-gray-500">Tokens Out</div>
          <div class="text-lg font-bold text-white">${this.formatNumber(session.tokens_out)}</div>
        </div>
      </div>

      <!-- Code changes -->
      ${session.files_edited > 0 ? `
      <div class="bg-gray-800 rounded-lg p-3 mb-6 flex items-center gap-3">
        <span class="text-sm font-medium text-gray-300">${session.files_edited} file${session.files_edited !== 1 ? 's' : ''}</span>
        ${session.lines_added ? `<span class="text-sm font-medium text-green-400">+${session.lines_added}</span>` : ''}
        ${session.lines_removed ? `<span class="text-sm font-medium text-red-400">-${session.lines_removed}</span>` : ''}
      </div>` : ''}

      <!-- Breakdowns -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <!-- Tool usage -->
        <div class="bg-gray-800 rounded-lg p-3">
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Tool Usage</div>
          ${sortedTools.length === 0 ? '<div class="text-xs text-gray-500">No tools used</div>' :
            sortedTools.slice(0, 8).map(([name, count]) => `
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs text-gray-300 w-20 truncate shrink-0">${name}</span>
                <div class="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div class="h-full bg-emerald-500 rounded-full" style="width:${Math.max(3, (count / maxToolCount) * 100)}%"></div>
                </div>
                <span class="text-xs text-gray-500 w-8 text-right shrink-0">${count}</span>
              </div>
            `).join('')}
        </div>

        <!-- Cost by model -->
        <div class="bg-gray-800 rounded-lg p-3">
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Cost by Model</div>
          ${sortedModels.length === 0 ? '<div class="text-xs text-gray-500">No cost data</div>' :
            sortedModels.map(([model, cost]) => `
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs text-gray-300 w-20 truncate shrink-0">${CostDashboard.shortModel(model)}</span>
                <div class="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div class="h-full bg-blue-500 rounded-full" style="width:${Math.max(3, (cost / maxModelCost) * 100)}%"></div>
                </div>
                <span class="text-xs text-gray-500 w-12 text-right shrink-0">${this.formatCost(cost)}</span>
              </div>
            `).join('')}
        </div>
      </div>

      <!-- Event timeline -->
      <div>
        <div class="text-xs text-gray-500 uppercase tracking-wider mb-2">Event Timeline (${events.length})</div>
        <div class="max-h-64 overflow-y-auto rounded-lg border border-gray-700">
          ${events.map(evt => this.renderEventRow(evt)).join('')}
          ${events.length === 0 ? '<div class="text-xs text-gray-500 text-center py-4">No events</div>' : ''}
        </div>
      </div>

      </div><!-- end tab-overview -->

      <!-- Transcript tab -->
      <div id="tab-transcript" class="${transcriptActive ? '' : 'hidden'}">
        <div id="transcript-content">
          <div class="text-center py-8 text-gray-500 text-xs">Loading transcript...</div>
        </div>
      </div>
    `;

    // Wire tab buttons
    container.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchTab(btn.dataset.tab);
      });
    });
  },

  renderEventRow(evt) {
    const statusIcon = evt.status === 'error'
      ? '<span class="text-red-400">✗</span>'
      : evt.status === 'timeout'
        ? '<span class="text-yellow-400">⏱</span>'
        : '<span class="text-green-400/60">✓</span>';

    let typeDisplay;
    if (evt.event_type === 'tool_use') {
      typeDisplay = `<span class="text-gray-200">${evt.tool_name || 'tool'}</span>`;
    } else if (evt.event_type === 'error') {
      typeDisplay = '<span class="text-red-400">error</span>';
    } else {
      typeDisplay = `<span class="text-gray-400">${evt.event_type}</span>`;
    }

    let detail = '';
    try {
      const meta = typeof evt.metadata === 'string' ? JSON.parse(evt.metadata) : evt.metadata;
      if (meta.command) detail = meta.command;
      else if (meta.file_path) detail = meta.file_path.split('/').pop();
      else if (meta.pattern) detail = meta.pattern;
    } catch {}

    const duration = evt.duration_ms ? `<span class="text-gray-600">${evt.duration_ms}ms</span>` : '';

    return `
      <div class="flex items-center gap-2 px-3 py-1 text-xs border-b border-gray-800/50 hover:bg-gray-800/30">
        <span class="text-gray-500 w-14 shrink-0">${this.formatTime(evt.created_at)}</span>
        <span class="w-16 shrink-0">${typeDisplay}</span>
        <span class="text-gray-400 truncate flex-1">${detail}</span>
        ${duration ? `<span class="shrink-0">${duration}</span>` : ''}
        <span class="shrink-0">${statusIcon}</span>
      </div>
    `;
  },
};
