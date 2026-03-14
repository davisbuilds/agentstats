<script lang="ts">
  import { getFilterOptions, getFilters, setFilters } from '../../stores/monitor.svelte';
  import type { SelectOption } from '../../api/client';

  const options = $derived(getFilterOptions());
  const filters = $derived(getFilters());

  interface Props {
    onchange: (filters: Record<string, string>) => void;
  }
  let { onchange }: Props = $props();

  function handleChange(key: string, value: string) {
    const next = { ...filters };
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    setFilters(next);
    onchange(next);
  }

  function optionValue(option: string | SelectOption): string {
    return typeof option === 'string' ? option : option.value;
  }

  function optionLabel(option: string | SelectOption): string {
    return typeof option === 'string' ? option : option.label;
  }

  const filterDefs: Array<{ key: string; label: string; optionsKey: keyof typeof options }> = [
    { key: 'agent_type', label: 'Agent', optionsKey: 'agent_types' },
    { key: 'event_type', label: 'Event', optionsKey: 'event_types' },
    { key: 'tool_name', label: 'Tool', optionsKey: 'tool_names' },
    { key: 'model', label: 'Model', optionsKey: 'models' },
    { key: 'project', label: 'Project', optionsKey: 'projects' },
    { key: 'branch', label: 'Branch', optionsKey: 'branches' },
    { key: 'source', label: 'Source', optionsKey: 'sources' },
  ];
</script>

<div class="flex items-center gap-2 flex-wrap">
  {#each filterDefs as def}
    {@const opts = options[def.optionsKey] as Array<string | SelectOption> || []}
    {#if opts.length > 0}
      <select
        class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-gray-500"
        value={filters[def.key] || ''}
        onchange={(e) => handleChange(def.key, (e.target as HTMLSelectElement).value)}
      >
        <option value="">All {def.label}s</option>
        {#each opts as opt}
          <option value={optionValue(opt)}>{optionLabel(opt)}</option>
        {/each}
      </select>
    {/if}
  {/each}
  {#if Object.keys(filters).length > 0}
    <button
      class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      onclick={() => { setFilters({}); onchange({}); }}
    >Clear</button>
  {/if}
</div>
