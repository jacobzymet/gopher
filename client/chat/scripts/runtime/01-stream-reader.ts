function parseSseEvent(raw: string) {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join('\n') };
}

function whenAborted(signal?: AbortSignal | null) {
  if (!signal) return new Promise<unknown>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<unknown>((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
}

async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<StreamReadResult> {
  if (signal.aborted) return { aborted: true };
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read().then((chunk) => ({ chunk })),
      new Promise<StreamReadResult>((resolve) => {
        onAbort = () => resolve({ aborted: true });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Reveal streamed text a few code points per frame so chunks feel like a
 * typewriter. Catches up when backlog grows, and snap-flushes on end so
 * we never trail the network after the response finishes.
 */
function createStreamTyper(onPaint: (text: string, streaming: boolean) => void) {
  let target = '';
  let shown = '';
  let raf = 0;
  let inReasoning = false;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let catchingUp = false;

  function pending() {
    return target.length - shown.length;
  }

  function advance(step: number) {
    let i = shown.length;
    let taken = 0;
    while (i < target.length && taken < step) {
      const code = target.charCodeAt(i);
      // Keep surrogate pairs intact.
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < target.length) i += 2;
      else i += 1;
      taken += 1;
    }
    // Caught-up only: finish the word if a break is a few characters away.
    if (step <= 2 && i < target.length) {
      const limit = Math.min(target.length, i + 5);
      for (let j = i; j < limit; j++) {
        const ch = target.charCodeAt(j);
        if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
          i = j + 1;
          break;
        }
      }
    }
    shown = target.slice(0, i);
  }

  function tick() {
    raf = 0;
    const behind = pending();
    if (behind <= 0) return;
    // ~1–3 code points/frame when near real-time; sprint when buffered.
    let step = 1;
    if (behind > 96) step = Math.ceil(behind / 6);
    else if (behind > 32) step = 4;
    else if (behind > 10) step = 2;
    advance(step);
    onPaint(shown, true);
    if (pending() > 0) raf = requestAnimationFrame(tick);
  }

  function schedule() {
    if (reduceMotion || catchingUp) {
      shown = target;
      onPaint(shown, true);
      return;
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function closeReasoning() {
    if (!inReasoning) return;
    target += '</think>';
    inReasoning = false;
  }

  return {
    get target() { return target; },
    get shown() { return shown; },
    /** OpenAI / llama.cpp reasoning channel (separate from answer content). */
    pushReasoning(delta: string) {
      if (!delta) return;
      if (!inReasoning) {
        target += '<think>';
        inReasoning = true;
      }
      target += delta;
      schedule();
    },
    push(delta: string) {
      if (!delta) return;
      closeReasoning();
      target += delta;
      schedule();
    },
    clear() {
      target = '';
      shown = '';
      inReasoning = false;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    setCatchingUp(next: boolean) {
      catchingUp = !!next;
      if (catchingUp) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        shown = target;
        onPaint(shown, true);
      }
    },
    /** Instantly catch up — call when the SSE stream closes or aborts. */
    flush() {
      closeReasoning();
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      shown = target;
      onPaint(shown, false);
    },
  };
}

