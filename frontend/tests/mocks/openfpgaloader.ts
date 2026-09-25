import { vi } from 'vitest';

// The real package's gen/bundle.js does `runOpenFPGALoader.requiresUSBDevice
// = [...]` -- a property on the function itself, not a separate module
// export -- so flasher.ts's `runOpenFPGALoader.requiresUSBDevice` read
// works the same way under this mock.
export const runOpenFPGALoader = Object.assign(vi.fn(), { requiresUSBDevice: [] as unknown[] });
