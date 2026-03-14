<script lang="ts">
  import { getEvents } from '../../stores/monitor.svelte';
  import { timeAgo, formatDuration } from '../../format';
  import type { AgentEvent } from '../../api/client';

  const events = $derived(getEvents());

  function eventIcon(e: AgentEvent): string {
    if (e.status === 'error') return 'text-red-400';
    switch (e.event_type) {
      case 'tool_use': return 'text-blue-400';
      case 'llm_response': return 'text-purple-400';
      case 'session_start': return 'text-green-400';
      case 'session_end': return 'text-gray-400';
      case 'error': return 'text-red-400';
      default: return 'text-gray-500';
    }
  }

  function eventLabel(e: AgentEvent): string {
    if (e.event_type === 'tool_use' && e.tool_name) return `${e.event_type} > ${e.tool_name}`;
    return e.event_type;
  }

  function preview(e: AgentEvent): string {
    const meta = e.metadata;
    if (!meta) return '';
    if (typeof meta === 'string') {
      try { return (JSON.parse(meta) as Record<string, unknown>).content_preview as string || ''; } catch { return ''; }
    }
    return (meta.content_preview as string) || (meta.command as string) || (meta.file_path as string) || '';
  }
</script>

<section class="flex flex-col">
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">All Events</h2>
    <span class="text-xs text-gray-500">{events.length} events</span>
  </div>

  <div class="overflow-y-auto rounded-lg border border-gray-800 bg-gray-900/50 min-h-[200px] max-h-[50vh]">
    {#if events.length === 0}
      <div class="text-center py-12 text-gray-500">
        No events yet. POST to /api/events or run the seed script to see activity.
      </div>
    {:else}
      <div class="divide-y divide-gray-800/50">
        {#each events as event (event.id)}
          <div class="px-4 py-2 hover:bg-gray-800/30 flex items-start gap-3 text-xs">
            <span class="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 {eventIcon(event)}"></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-gray-300 font-medium">{eventLabel(event)}</span>
                <span class="text-gray-600">{event.agent_type}</span>
                {#if event.model}<span class="text-gray-600">{event.model}</span>{/if}
                {#if event.duration_ms}<span class="text-gray-600">{formatDuration(event.duration_ms)}</span>{/if}
                <span class="text-gray-600 ml-auto shrink-0">{timeAgo(event.created_at)}</span>
              </div>
              {#if preview(event)}
                <div class="text-gray-500 truncate mt-0.5">{preview(event)}</div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
