<script lang="ts">
  import type { Message, ContentBlock } from '../../api/client';
  import { parseSessionText } from '../../session-text';

  interface Props {
    message: Message;
  }
  let { message }: Props = $props();

  let blocks = $derived.by<ContentBlock[]>(() => {
    try {
      return JSON.parse(message.content);
    } catch {
      return [{ type: 'text', text: message.content }];
    }
  });

  let thinkingExpanded = $state(false);
  let toolExpanded = $state<Record<string, boolean>>({});

  function toggleTool(id: string) {
    toolExpanded = { ...toolExpanded, [id]: !toolExpanded[id] };
  }

  const roleLabel = $derived(message.role === 'user' ? 'You' : 'Assistant');
  const roleColor = $derived(message.role === 'user' ? 'text-blue-400' : 'text-green-400');
  const borderColor = $derived(message.role === 'user' ? 'border-blue-500/20' : 'border-green-500/20');
</script>

<div class="border-l-2 {borderColor} pl-3">
  <!-- Role header -->
  <div class="flex items-center gap-2 mb-1">
    <span class="text-xs font-medium {roleColor}">{roleLabel}</span>
    {#if message.timestamp}
      <span class="text-xs text-gray-600">{new Date(message.timestamp).toLocaleTimeString()}</span>
    {/if}
    {#if message.has_thinking}
      <span class="text-xs bg-purple-900/30 text-purple-400 px-1 rounded">thinking</span>
    {/if}
    {#if message.has_tool_use}
      <span class="text-xs bg-amber-900/30 text-amber-400 px-1 rounded">tools</span>
    {/if}
  </div>

  <!-- Content blocks -->
  {#each blocks as block, i}
    {#if block.type === 'text' && block.text}
      {@const parsedText = parseSessionText(block.text)}
      {#if parsedText?.kind === 'caveat'}
        <div class="rounded border border-sky-900/60 bg-sky-950/20 px-3 py-2 text-xs text-sky-300">
          Local command transcript follows. Claude marked this output as contextual-only unless explicitly requested.
        </div>
      {:else if parsedText?.kind === 'command'}
        <div class="rounded border border-gray-800 bg-gray-900/40 px-3 py-2">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Local Command</div>
          <div class="font-mono text-sm text-gray-200">{parsedText.name || parsedText.message}</div>
          {#if parsedText.args}
            <div class="mt-1 text-xs text-gray-500 whitespace-pre-wrap break-words">{parsedText.args}</div>
          {/if}
        </div>
      {:else if parsedText?.kind === 'output'}
        <div class="rounded border border-gray-800 bg-gray-900/30 px-3 py-2">
          <div class="text-[11px] uppercase tracking-wide {parsedText.stream === 'stderr' ? 'text-red-400' : 'text-gray-500'} mb-1">
            {parsedText.stream}
          </div>
          <div class="text-sm text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
            {parsedText.text || '(no output)'}
          </div>
        </div>
      {:else}
        <div class="text-sm text-gray-300 whitespace-pre-wrap break-words leading-relaxed">
          {parsedText?.text || block.text}
        </div>
      {/if}

    {:else if block.type === 'thinking' && block.thinking}
      <div class="mt-1 mb-1">
        <button
          class="text-xs text-purple-400 hover:text-purple-300"
          onclick={() => thinkingExpanded = !thinkingExpanded}
        >
          {thinkingExpanded ? '▾' : '▸'} Thinking ({block.thinking.length} chars)
        </button>
        {#if thinkingExpanded}
          <div class="mt-1 text-xs text-gray-500 whitespace-pre-wrap bg-gray-900/50 rounded p-2 max-h-64 overflow-y-auto">
            {block.thinking}
          </div>
        {/if}
      </div>

    {:else if block.type === 'tool_use' && block.name}
      <div class="mt-1 mb-1 bg-gray-900/40 rounded p-2 border border-gray-800">
        <button
          class="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1"
          onclick={() => toggleTool(block.id || String(i))}
        >
          <span>{toolExpanded[block.id || String(i)] ? '▾' : '▸'}</span>
          <span class="font-mono">{block.name}</span>
        </button>
        {#if toolExpanded[block.id || String(i)] && block.input}
          <pre class="mt-1 text-xs text-gray-500 overflow-x-auto max-h-48 overflow-y-auto">{JSON.stringify(block.input, null, 2)}</pre>
        {/if}
      </div>

    {:else if block.type === 'tool_result'}
      <div class="mt-1 mb-1 text-xs {block.is_error ? 'text-red-400' : 'text-gray-500'} bg-gray-900/30 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
        {block.content || '(empty result)'}
      </div>
    {/if}
  {/each}
</div>
