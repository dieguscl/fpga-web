# Manual WebUSB flash checklist (needs real hardware)

Run in Chrome/Edge at https://fpga.dieguscl.com (or `npm run dev` on localhost).

- [ ] Linux: udev rules from the "USB setup" dialog applied; board replugged.
- [ ] Windows: Zadig → WinUSB on the board's JTAG interface.
- [ ] Build the board's blinky template → "Build succeeded".
- [ ] Flash (SRAM) → browser shows device picker → select board → "Loaded into FPGA" → LED blinks.
- [ ] Power-cycle board → design gone (SRAM load).
- [ ] Flash with "Write to flash" → "Written to flash" → power-cycle → LED still blinks.
- [ ] Cancel the device picker → status "Flash failed: No USB device selected." and setup help opens.
- [ ] Firefox: banner says flashing is unavailable; Download still works.

Boards verified: | board | OS | SRAM | flash | date |
