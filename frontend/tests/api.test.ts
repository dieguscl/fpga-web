import { describe, expect, it, vi, beforeEach } from 'vitest';
import { streamEvents } from '../src/api';

describe('streamEvents', () => {
  let fakeES: any;
  let originalEventSource: any;

  beforeEach(() => {
    // Create a fake EventSource
    fakeES = {
      readyState: 0, // CONNECTING
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
      onmessage: null as any,
      onerror: null as any,
      close: vi.fn(),
    };

    originalEventSource = globalThis.EventSource;
    (globalThis as any).EventSource = vi.fn(() => fakeES);
  });

  it('closes EventSource and sends error event after 5 consecutive errors', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();

    streamEvents('test-job', onEvent, onError);

    // Simulate 5 errors
    for (let i = 0; i < 5; i++) {
      fakeES.onerror();
    }

    expect(fakeES.close).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'lost connection to the build server',
      })
    );
    expect(onError).toHaveBeenCalledWith('lost connection to the build server');
  });

  it('resets error count on message', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();

    streamEvents('test-job', onEvent, onError);

    // Simulate 3 errors
    fakeES.onerror();
    fakeES.onerror();
    fakeES.onerror();

    // Then a message (resets counter)
    fakeES.onmessage({ data: JSON.stringify({ type: 'log', line: 'test' }) });

    // Clear the onEvent calls from the message
    onEvent.mockClear();
    onError.mockClear();

    // 2 more errors should not trigger the error event
    fakeES.onerror();
    fakeES.onerror();

    expect(fakeES.close).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('closes EventSource when readyState is CLOSED', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();

    streamEvents('test-job', onEvent, onError);

    fakeES.readyState = 2; // CLOSED
    fakeES.onerror();

    expect(fakeES.close).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'lost connection to the build server',
      })
    );
  });
});
