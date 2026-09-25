export type OS = 'linux' | 'windows' | 'mac' | 'other';

export function detectOS(ua: string = navigator.userAgent): OS {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'other';
}

const UDEV = `sudo tee /etc/udev/rules.d/70-fpga-webusb.rules >/dev/null <<'EOF'
# FTDI (Digilent, iCE40 boards, ...), CMSIS-DAP, DFU bootloaders
SUBSYSTEM=="usb", ATTRS{idVendor}=="0403", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="1d50", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="c251", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="1209", MODE="0666"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger`;

export function setupHelpHtml(os: OS): string {
  switch (os) {
    case 'linux':
      return `<h3>Linux: allow the browser to open your board</h3>
<p>Run once, then unplug and replug the board. These udev rules make the device accessible to your user:</p>
<pre>${UDEV}</pre>
<p>If flashing still fails with "access denied", the <code>ftdi_sio</code> serial driver may hold the interface; unplug/replug after closing any serial terminal.</p>`;
    case 'windows':
      return `<h3>Windows: switch the JTAG interface to WinUSB</h3>
<ol><li>Download <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener">Zadig</a>.</li>
<li>Options → List All Devices. Pick your board's <b>Interface 0</b> (e.g. "Digilent USB Device (Interface 0)").</li>
<li>Select <b>WinUSB</b> and click Replace Driver.</li></ol>
<p><b>Note:</b> this replaces the vendor driver on that interface, so Vivado / Digilent Adept will not see the board until you reinstall their driver (Device Manager → Uninstall device, then replug).</p>`;
    case 'mac':
      return `<h3>macOS</h3><p>No setup is usually needed. If the board is not listed, unplug it, close apps using its serial port, and try again.</p>`;
    default:
      return `<h3>Setup</h3><p>Use Chrome or Edge on Linux, Windows or macOS to flash from the browser.</p>`;
  }
}
