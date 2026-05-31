import { describe, it, expect } from 'vitest';

const { VolcengineAST2StreamingTTSDecoder } = await import('./VolcengineAST2StreamingTTSDecoder');

/**
 * These tests pin down the serialization guarantees of the streaming TTS decoder.
 *
 * WHY it matters: a single ogg-opus WASM decoder instance is shared across every
 * operation. If two sentences' operations ever run against that one decoder
 * concurrently, the new sentence's reset() can wipe decoder state while the
 * previous sentence's flush() is still draining its tail audio — the audible
 * symptom is the previous sentence losing its ending and/or garbled dubbing.
 * The operationQueue exists precisely to forbid that overlap, so we assert the
 * ORDER of decoder calls, not merely that audio came out.
 */
describe('VolcengineAST2StreamingTTSDecoder sentence serialization', () => {
  it('does not reset the next sentence until the previous sentence flush has fully completed', async () => {
    // WHY: TTSSentenceStart of sentence N+1 can arrive while sentence N's
    // finishSentence(flush) is still awaiting on the shared decoder. If
    // startSentence discards the operationQueue, the reset() races the
    // in-flight flush() against the SAME decoder, corrupting tail audio.
    // Only record decoder operations issued from sentence 2's lifecycle onward,
    // so the sentence-1 reset/decode noise does not pollute the ordering assertion.
    let recording = false;
    const calls: string[] = [];
    const record = (label: string) => {
      if (recording) calls.push(label);
    };
    let releaseFlush: (() => void) | null = null;

    const decoder = new VolcengineAST2StreamingTTSDecoder(
      async () => ({
        ready: Promise.resolve(),
        decode: async () => ({ channelData: [new Float32Array([0.5])], samplesDecoded: 1 }),
        flush: async () => {
          record('flush:start');
          // Hold the flush open to create the race window.
          await new Promise<void>((resolve) => {
            releaseFlush = resolve;
          });
          record('flush:end');
          return { channelData: [new Float32Array([0.25])], samplesDecoded: 1 };
        },
        reset: async () => {
          record('reset');
        },
        free: () => {},
      }),
      () => {}
    );

    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 50 && !predicate(); i++) {
        await Promise.resolve();
      }
    };

    await decoder.startSentence();
    await decoder.decodeChunk(new Uint8Array([1, 2, 3]));

    // Start recording right before sentence 1's flush so we capture flush+reset only.
    recording = true;

    // Sentence 1 finishing — flush is now pending (not yet released).
    const finishPromise = decoder.finishSentence();
    await waitFor(() => calls.includes('flush:start'));
    expect(calls).toContain('flush:start');

    // Sentence 2 begins before sentence 1's flush has resolved.
    const startNextPromise = decoder.startSentence();

    // Let microtasks settle: sentence 2's reset MUST NOT have run yet, because
    // the previous flush is still in flight on the shared decoder.
    await waitFor(() => calls.includes('reset'));
    expect(calls).not.toContain('reset');

    // Release the previous sentence's flush.
    releaseFlush!();
    await finishPromise;
    await startNextPromise;

    // Sentence 2's reset must come strictly AFTER the previous flush finished.
    expect(calls).toEqual(['flush:start', 'flush:end', 'reset']);
  });
});
