// Transcript - conversation replay vertical timeline
const Transcript = {
  data: null,
  sessionId: null,

  formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z'));
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  },

  formatCost(n) {
    if (!n || n === 0) return '';
    if (n < 0.01) return '<$0.01';
    return '$' + n.toFixed(3);
  },

  async load(sessionId) {
    this.sessionId = sessionId;
    const container = document.getElementById('transcript-content');
    if (!container) return;

    container.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">Loading transcript...</div>';

    try {
      const res = await fetch(`/api/sessions/${sessionId}/transcript`);
      if (!res.ok) {
        container.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">No transcript data available</div>';
        return;
      }
      this.data = await res.json();
      this.render();
    } catch {
      container.innerHTML = '<div class="text-center py-8 text-red-400 text-xs">Failed to load transcript</div>';
    }
  },

  render() {
    const container = document.getElementById('transcript-content');
    if (!container || !this.data) return;

    const { entries } = this.data;
    if (!entries || entries.length === 0) {
      container.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">No transcript entries</div>';
      return;
    }

    container.innerHTML = `
      <div class="relative pl-6">
        <!-- Timeline line -->
        <div class="absolute left-2 top-0 bottom-0 w-px bg-gray-700"></div>
        ${entries.map(e => this.renderEntry(e)).join('')}
      </div>
    `;
  },

  renderEntry(entry) {
    const time = this.formatTime(entry.timestamp);
    const { dot, bg, border, icon } = this.entryStyle(entry);

    let content = '';

    switch (entry.type) {
      case 'session_start':
        content = `<span class="text-yellow-400 font-medium">Session started</span>`;
        break;
      case 'session_end':
        content = `<span class="text-yellow-400 font-medium">Session ended</span>`;
        break;
      case 'tool_use':
        content = this.renderToolUse(entry);
        break;
      case 'response':
      case 'llm_request':
        content = this.renderResponse(entry);
        break;
      case 'error':
        content = this.renderError(entry);
        break;
      case 'file_change':
        content = this.renderFileChange(entry);
        break;
      case 'plan_step':
        content = `<span class="text-indigo-400 font-medium">Plan updated</span>${entry.detail ? `<div class="text-gray-400 mt-0.5 text-xs">${this.escapeHtml(entry.detail).slice(0, 200)}</div>` : ''}`;
        break;
      default:
        content = `<span class="text-gray-400">${entry.type}</span>${entry.detail ? `<span class="text-gray-500 ml-2">${this.escapeHtml(entry.detail).slice(0, 100)}</span>` : ''}`;
    }

    const meta = [];
    if (entry.model) meta.push(this.shortModel(entry.model));
    if (entry.tokens_in || entry.tokens_out) meta.push(`${(entry.tokens_in || 0) + (entry.tokens_out || 0)} tok`);
    if (entry.cost_usd) meta.push(this.formatCost(entry.cost_usd));
    if (entry.duration_ms) meta.push(`${entry.duration_ms}ms`);
    const metaLine = meta.length > 0 ? `<div class="text-[10px] text-gray-600 mt-0.5">${meta.join(' · ')}</div>` : '';

    return `
      <div class="relative mb-3">
        <!-- Dot -->
        <div class="absolute -left-4 top-1 w-2 h-2 rounded-full ${dot} ring-2 ring-gray-900"></div>
        <!-- Card -->
        <div class="${bg} ${border} rounded-lg px-3 py-2 text-xs">
          <div class="flex items-start gap-2">
            <span class="text-gray-500 shrink-0 w-14">${time}</span>
            <span class="shrink-0">${icon}</span>
            <div class="flex-1 min-w-0">
              ${content}
              ${metaLine}
            </div>
            ${entry.status === 'error' ? '<span class="text-red-400 shrink-0">✗</span>' : ''}
          </div>
        </div>
      </div>
    `;
  },

  renderToolUse(entry) {
    const name = entry.tool_name || 'tool';
    const detail = entry.detail ? this.escapeHtml(entry.detail).slice(0, 200) : '';
    return `
      <div>
        <span class="text-emerald-400 font-medium">${this.escapeHtml(name)}</span>
        ${entry.status === 'error' ? '<span class="text-red-400 ml-1">(failed)</span>' : ''}
        ${detail ? `<div class="text-gray-400 mt-0.5 font-mono bg-gray-800/50 rounded px-1.5 py-0.5 truncate">${detail}</div>` : ''}
      </div>
    `;
  },

  renderResponse(entry) {
    const detail = entry.detail ? this.escapeHtml(entry.detail).slice(0, 300) : '';
    return `
      <div>
        <span class="text-blue-400 font-medium">Response</span>
        ${detail ? `<div class="text-gray-300 mt-0.5 whitespace-pre-wrap break-words">${detail}</div>` : ''}
      </div>
    `;
  },

  renderError(entry) {
    const detail = entry.detail ? this.escapeHtml(entry.detail).slice(0, 300) : 'Unknown error';
    return `
      <div>
        <span class="text-red-400 font-medium">Error</span>
        <div class="text-red-300/80 mt-0.5">${detail}</div>
      </div>
    `;
  },

  renderFileChange(entry) {
    const detail = entry.detail || '';
    return `
      <div>
        <span class="text-amber-400 font-medium">File change</span>
        ${detail ? `<div class="text-gray-400 mt-0.5 font-mono">${this.escapeHtml(detail).slice(0, 150)}</div>` : ''}
      </div>
    `;
  },

  entryStyle(entry) {
    switch (entry.type) {
      case 'session_start':
      case 'session_end':
        return { dot: 'bg-yellow-400', bg: 'bg-yellow-500/5', border: 'border border-yellow-500/20', icon: '<span class="text-yellow-400">&#9679;</span>' };
      case 'tool_use':
        return {
          dot: entry.status === 'error' ? 'bg-red-400' : 'bg-emerald-400',
          bg: entry.status === 'error' ? 'bg-red-500/5' : 'bg-emerald-500/5',
          border: entry.status === 'error' ? 'border border-red-500/20' : 'border border-emerald-500/20',
          icon: '<span class="text-emerald-400">&#9654;</span>',
        };
      case 'response':
      case 'llm_request':
        return { dot: 'bg-blue-400', bg: 'bg-blue-500/5', border: 'border border-blue-500/20', icon: '<span class="text-blue-400">&#9679;</span>' };
      case 'error':
        return { dot: 'bg-red-400', bg: 'bg-red-500/10', border: 'border border-red-500/30', icon: '<span class="text-red-400">&#10007;</span>' };
      case 'file_change':
        return { dot: 'bg-amber-400', bg: 'bg-amber-500/5', border: 'border border-amber-500/20', icon: '<span class="text-amber-400">&#9998;</span>' };
      default:
        return { dot: 'bg-gray-400', bg: 'bg-gray-800/30', border: 'border border-gray-700', icon: '<span class="text-gray-400">&#9679;</span>' };
    }
  },

  shortModel(model) {
    if (!model) return '';
    return model
      .replace('claude-sonnet-4-5-20250929', 'sonnet-4.5')
      .replace('claude-opus-4-6', 'opus-4.6')
      .replace('claude-haiku-4-5-20251001', 'haiku-4.5')
      .replace(/^claude-/, 'c-')
      .replace(/^gpt-/, 'gpt-');
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
