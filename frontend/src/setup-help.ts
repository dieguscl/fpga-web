import { t } from './i18n';

export type OS = 'linux' | 'windows' | 'mac' | 'other';

export function detectOS(ua: string = navigator.userAgent): OS {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'other';
}

const UDEV = `sudo tee /etc/udev/rules.d/70-fpga-webusb.rules >/dev/null <<'EOF'
# FTDI (Digilent, iCE40 boards, ...)
SUBSYSTEM=="usb", ATTRS{idVendor}=="0403", MODE="0666"
# Altera USB-Blaster
SUBSYSTEM=="usb", ATTRS{idVendor}=="09fb", MODE="0666"
# ARM CMSIS-DAP, Colorlight
SUBSYSTEM=="usb", ATTRS{idVendor}=="0d28", MODE="0666"
# pid.codes DFU boards
SUBSYSTEM=="usb", ATTRS{idVendor}=="1209", MODE="0666"
# OpenMoko DFU
SUBSYSTEM=="usb", ATTRS{idVendor}=="1d50", MODE="0666"
# Numato
SUBSYSTEM=="usb", ATTRS{idVendor}=="2a19", MODE="0666"
# Keil CMSIS-DAP
SUBSYSTEM=="usb", ATTRS{idVendor}=="c251", MODE="0666"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger`;

// Translations may contain markup (links, <b>, <code>); they are static strings from i18n.ts, never user input.
export function setupHelpHtml(os: OS): string {
  switch (os) {
    case 'linux':
      return `<h3>${t('help.linux.title')}</h3>
<p>${t('help.linux.run')}</p>
<pre>${UDEV}</pre>
<p>${t('help.linux.busy')}</p>`;
    case 'windows':
      return `<h3>${t('help.win.title')}</h3>
<ol><li>${t('help.win.step1')}</li>
<li>${t('help.win.step2')}</li>
<li>${t('help.win.step3')}</li></ol>
<p>${t('help.win.note')}</p>`;
    case 'mac':
      return `<h3>macOS</h3><p>${t('help.mac.body')}</p>`;
    default:
      return `<h3>${t('help.other.title')}</h3><p>${t('help.other.body')}</p>`;
  }
}
