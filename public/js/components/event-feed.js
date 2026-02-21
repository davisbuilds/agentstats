// Global Event Feed - chronological list of all events
const EventFeed = {
  events: [],
  MAX_EVENTS: 200,
  isScrolledToBottom: true,
  pendingCount: 0,

  agentLabels: {
    claude_code: { text: 'Claude', class: 'text-orange-400' },
    codex: { text: 'Codex', class: 'text-emerald-400' },
  },

  init() {
    const feed = document.getElementById('event-feed');
    feed.addEventListener('scroll', () => {
      const threshold = 50;
      this.isScrolledToBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - threshold;
      if (this.isScrolledToBottom && this.pendingCount > 0) {
        this.pendingCount = 0;
        document.getElementById('new-events-badge').classList.add('hidden');
      }
    });

    document.getElementById('new-events-badge').addEventListener('click', () => {
      feed.scrollTop = 0;
      this.pendingCount = 0;
      document.getElementById('new-events-badge').classList.add('hidden');
    });
  },

  initFromData(events) {
    this.events = events.slice(0, this.MAX_EVENTS);
    this.renderAll();
  },

  addEvent(event) {
    this.events.unshift(event);
    if (this.events.length > this.MAX_EVENTS) {
      this.events.pop();
    }

    const placeholder = document.getElementById('no-events-placeholder');
    if (placeholder) placeholder.classList.add('hidden');

    const list = document.getElementById('event-list');
    const html = this.renderEventRow(event);
    list.insertAdjacentHTML('afterbegin', html);

    // Remove excess DOM nodes
    while (list.children.length > this.MAX_EVENTS) {
      list.lastChild.remove();
    }

    // Handle scroll
    const feed = document.getElementById('event-feed');
    if (feed.scrollTop < 10) {
      // Already at top, stay there
    } else {
      this.pendingCount++;
      const badge = document.getElementById('new-events-badge');
      badge.textContent = `${this.pendingCount} new event${this.pendingCount !== 1 ? 's' : ''} ↑`;
      badge.classList.remove('hidden');
    }

    document.getElementById('event-count-label').textContent = `${this.events.length} events`;
  },

  formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  },

  getAgentLabel(agentType) {
    return this.agentLabels[agentType] || { text: agentType, class: 'text-blue-400' };
  },

  statusIcon(event) {
    if (event.event_type === 'user_prompt') return '<span class="text-violet-400">▸</span>';
    if (event.status === 'error') return '<span class="text-red-400">✗</span>';
    if (event.status === 'timeout') return '<span class="text-yellow-400">⏱</span>';
    return '<span class="text-green-400/60">✓</span>';
  },

  eventTypeDisplay(event) {
    if (event.event_type === 'tool_use') {
      return `<span class="text-gray-200 font-medium">${event.tool_name || 'tool'}</span>`;
    }
    if (event.event_type === 'user_prompt') {
      return `<span class="text-violet-400 font-medium">prompt</span>`;
    }
    const colors = {
      response: 'text-blue-400',
      error: 'text-red-400',
      session_start: 'text-yellow-400',
      session_end: 'text-yellow-400',
    };
    return `<span class="${colors[event.event_type] || 'text-gray-400'}">${event.event_type}</span>`;
  },

  eventDetail(event) {
    try {
      const meta = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
      if (meta.message && event.event_type === 'user_prompt') return meta.message;
      if (meta.command) return meta.command;
      if (meta.file_path) return meta.file_path.split('/').pop();
      if (meta.pattern) return meta.pattern;
      if (meta.query) return meta.query;
    } catch {}
    return '';
  },

  renderEventRow(event) {
    const agent = this.getAgentLabel(event.agent_type);
    const detail = this.eventDetail(event);
    return `
      <div class="flex items-center gap-3 px-4 py-1.5 text-xs hover:bg-gray-800/30 transition-colors">
        <span class="text-gray-500 w-16 shrink-0">${this.formatTime(event.created_at)}</span>
        <span class="${agent.class} w-14 shrink-0">${agent.text}</span>
        <span class="text-gray-500 w-20 shrink-0 truncate">${event.project || ''}</span>
        <span class="w-20 shrink-0">${this.eventTypeDisplay(event)}</span>
        <span class="text-gray-400 truncate flex-1">${detail}</span>
        <span class="shrink-0">${this.statusIcon(event)}</span>
      </div>`;
  },

  renderAll() {
    const placeholder = document.getElementById('no-events-placeholder');
    const list = document.getElementById('event-list');

    if (this.events.length === 0) {
      placeholder.classList.remove('hidden');
      list.innerHTML = '';
      return;
    }

    placeholder.classList.add('hidden');
    list.innerHTML = this.events.map(e => this.renderEventRow(e)).join('');
    document.getElementById('event-count-label').textContent = `${this.events.length} events`;
  },
};
