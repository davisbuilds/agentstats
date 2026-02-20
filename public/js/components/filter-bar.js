// Filter Bar - populates from /api/filter-options, applies to all views
const FilterBar = {
  state: {
    agentType: '',
    eventType: '',
    toolName: '',
    project: '',
    branch: '',
    timeRange: '',
    options: null,
  },

  listeners: [],

  onChange(fn) {
    this.listeners.push(fn);
  },

  emit() {
    const filters = this.getActiveFilters();
    for (const fn of this.listeners) fn(filters);
  },

  getActiveFilters() {
    const f = {};
    if (this.state.agentType) f.agent_type = this.state.agentType;
    if (this.state.eventType) f.event_type = this.state.eventType;
    if (this.state.toolName) f.tool_name = this.state.toolName;
    if (this.state.project) f.project = this.state.project;
    if (this.state.branch) f.branch = this.state.branch;
    if (this.state.timeRange) f.since = this.timeRangeToISO(this.state.timeRange);
    return f;
  },

  timeRangeToISO(range) {
    if (!range) return '';
    const now = Date.now();
    const map = {
      '1h': 3600000,
      '6h': 21600000,
      '24h': 86400000,
      '7d': 604800000,
    };
    const ms = map[range];
    if (!ms) return '';
    return new Date(now - ms).toISOString();
  },

  buildQueryString() {
    const filters = this.getActiveFilters();
    const params = new URLSearchParams();
    for (const [key, val] of Object.entries(filters)) {
      if (val) params.set(key, val);
    }
    return params.toString();
  },

  async init() {
    try {
      const res = await fetch('/api/filter-options');
      this.state.options = await res.json();
    } catch {
      this.state.options = { agent_types: [], event_types: [], tool_names: [], models: [], projects: [], branches: [] };
    }
    this.render();
  },

  makeSelect(id, label, options, stateKey) {
    const optionsHtml = options.map(o => {
      const val = typeof o === 'object' ? o.value : o;
      const text = typeof o === 'object' ? o.label : o;
      return `<option value="${val}"${this.state[stateKey] === val ? ' selected' : ''}>${text}</option>`;
    }).join('');
    return `
      <select id="${id}" class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500 min-w-[100px]">
        <option value="">${label}</option>
        ${optionsHtml}
      </select>`;
  },

  render() {
    const container = document.getElementById('filter-bar');
    if (!container) return;
    const opts = this.state.options || {};

    container.innerHTML = `
      ${this.makeSelect('filter-agent', 'All Agents', opts.agent_types || [], 'agentType')}
      ${this.makeSelect('filter-event', 'All Events', opts.event_types || [], 'eventType')}
      ${this.makeSelect('filter-tool', 'All Tools', opts.tool_names || [], 'toolName')}
      ${this.makeSelect('filter-project', 'All Projects', opts.projects || [], 'project')}
      ${this.makeSelect('filter-branch', 'All Branches', opts.branches || [], 'branch')}
      <select id="filter-time" class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500 min-w-[100px]">
        <option value="">All Time</option>
        <option value="1h"${this.state.timeRange === '1h' ? ' selected' : ''}>Last 1h</option>
        <option value="6h"${this.state.timeRange === '6h' ? ' selected' : ''}>Last 6h</option>
        <option value="24h"${this.state.timeRange === '24h' ? ' selected' : ''}>Last 24h</option>
        <option value="7d"${this.state.timeRange === '7d' ? ' selected' : ''}>Last 7d</option>
      </select>
      <button id="filter-clear" class="text-xs text-gray-500 hover:text-gray-300 transition-colors ${this.hasActiveFilter() ? '' : 'hidden'}">Clear</button>
    `;

    this.attachListeners();
  },

  hasActiveFilter() {
    return !!(this.state.agentType || this.state.eventType || this.state.toolName || this.state.project || this.state.branch || this.state.timeRange);
  },

  attachListeners() {
    const bind = (id, key) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', (e) => {
        this.state[key] = e.target.value;
        this.render();
        this.emit();
      });
    };
    bind('filter-agent', 'agentType');
    bind('filter-event', 'eventType');
    bind('filter-tool', 'toolName');
    bind('filter-project', 'project');
    bind('filter-branch', 'branch');
    bind('filter-time', 'timeRange');

    const clear = document.getElementById('filter-clear');
    if (clear) clear.addEventListener('click', () => {
      this.state.agentType = '';
      this.state.eventType = '';
      this.state.toolName = '';
      this.state.project = '';
      this.state.branch = '';
      this.state.timeRange = '';
      this.render();
      this.emit();
    });
  },
};
