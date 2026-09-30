// UI translations: English, Portuguese (Portugal), Spanish.
// Static markup uses data-i18n / data-i18n-title / data-i18n-aria attributes;
// code calls t(key, vars). The choice is remembered per browser.

export type Lang = 'en' | 'pt-PT' | 'es';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'EN' },
  { id: 'pt-PT', label: 'PT' },
  { id: 'es', label: 'ES' },
];

const en = {
  'lang.aria': 'Language',
  'brand.tagline': 'Build · Flash · Ship',
  'label.project': 'Project',
  'btn.new': 'New',
  'btn.import': 'Import',
  'btn.export': 'Export',
  'label.target': 'Target',
  'label.top': 'Top',
  'btn.usbSetup': 'USB setup',
  'btn.usbSetup.title': 'USB setup for flashing',
  'label.files': 'Files',
  'btn.newFile': '+ New file',
  'view.board': 'Board',
  'view.text': 'Text',
  'label.output': 'Output',
  'btn.build': 'Build',
  'btn.flash': 'Flash',
  'btn.download': 'Download',
  'chk.lint': 'Lint',
  'chk.persist': 'Persist',
  'chk.persist.title': "Write to the board's flash memory so the design survives power-off",
  'btn.close': 'Close',

  'file.delete.title': 'Delete {name}',
  'file.delete.confirm': 'Delete {name}?',
  'prompt.projectName': 'Project name',
  'prompt.fileName': 'File name (e.g. counter.v)',
  'alert.invalidName': 'Invalid file name',
  'alert.importFailed': 'Import failed: {msg}',
  'err.unknownBoard': 'unknown board {board}',
  'confirm.newForBoard': 'Start a new project for this board? (Cancel keeps the current files and just changes the target.)',
  'board.downloadOnly': ' (download only)',
  'banner.noWebUsb': 'This browser cannot flash boards (no WebUSB). Use Chrome or Edge, or download the bitstream.',

  'status.ready': 'Ready',
  'status.submitting': 'Submitting…',
  'status.queued': 'Queued (position {n})',
  'status.running': 'Running: {step}',
  'status.buildOk': 'Build succeeded',
  'status.buildFailed': 'Build failed: {msg}',
  'status.flashing': 'Flashing…',
  'status.written': 'Written to flash',
  'status.loaded': 'Loaded into FPGA',
  'status.flashFailed': 'Flash failed: {msg}',
  'status.createFailed': 'Failed to create project: {msg}',
  'status.loadFailed': 'Failed to load: {msg}',

  'flash.downloadOnly': '{board} is download-only; flash it with your own tool',
  'flash.noWebUsb': 'This browser has no WebUSB. Use Chrome or Edge, or download the bitstream.',
  'flash.noDevice': 'No USB device selected.',
  'flash.exitCode': 'openFPGALoader exited with code {code}',

  'pp.title': 'Basys 3 pin planner',
  'pp.auto': 'Auto-assign by name',
  'pp.clear': 'Clear all',
  'pp.clearConfirm': 'Remove all pin assignments?',
  'pp.boardAria': 'Basys 3 board',
  'pp.hint': 'Artix-7 · click a part to assign a port',
  'pp.notUsed': '— not used —',
  'pp.inputs': 'Inputs',
  'pp.outputs': 'Outputs',
  'pp.ports': 'Ports',
  'pp.otherPorts': 'Other ports',
  'pp.onOther': '(on {sig})',
  'pp.notPort': '(not a port of {top})',
  'pp.summary': 'top: {top} · {placed}/{total} port bits placed',
  'pp.noPorts': 'top: {top} · no ports found',
  'pp.notPlaced': 'not placed yet: {list}',
  'pp.portFor': 'Port for {sig}',
  'pp.g.clk': 'Clock · 100 MHz',
  'pp.g.sw': 'Switches',
  'pp.g.led': 'LEDs',
  'pp.g.btn': 'Buttons',
  'pp.g.seg': '7-segment display',
  'pp.g.ja': 'Pmod JA',
  'pp.g.jb': 'Pmod JB',
  'pp.g.jc': 'Pmod JC',
  'pp.g.jxadc': 'Pmod JXADC',
  'pp.g.vga': 'VGA',
  'pp.g.uart': 'USB-UART',
  'pp.g.ps2': 'USB HID (PS/2)',

  'help.linux.title': 'Linux: allow the browser to open your board',
  'help.linux.run': 'Run once, then unplug and replug the board. These udev rules make the device accessible to your user:',
  'help.linux.busy': 'If flashing still fails with "access denied", the <code>ftdi_sio</code> serial driver may hold the interface; unplug/replug after closing any serial terminal.',
  'help.win.title': 'Windows: switch the JTAG interface to WinUSB',
  'help.win.step1': 'Download <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener">Zadig</a>.',
  'help.win.step2': 'Options → List All Devices. Pick your board\'s <b>Interface 0</b> (e.g. "Digilent USB Device (Interface 0)").',
  'help.win.step3': 'Select <b>WinUSB</b> and click Replace Driver.',
  'help.win.note': '<b>Note:</b> this replaces the vendor driver on that interface, so Vivado / Digilent Adept will not see the board until you reinstall their driver (Device Manager → Uninstall device, then replug).',
  'help.mac.body': 'No setup is usually needed. If the board is not listed, unplug it, close apps using its serial port, and try again.',
  'help.other.title': 'Setup',
  'help.other.body': 'Use Chrome or Edge on Linux, Windows or macOS to flash from the browser.',
};

export type Key = keyof typeof en;

const ptPT: Record<Key, string> = {
  'lang.aria': 'Idioma',
  'brand.tagline': 'Compilar · Gravar · Enviar',
  'label.project': 'Projeto',
  'btn.new': 'Novo',
  'btn.import': 'Importar',
  'btn.export': 'Exportar',
  'label.target': 'Placa',
  'label.top': 'Topo',
  'btn.usbSetup': 'Configurar USB',
  'btn.usbSetup.title': 'Configuração USB para gravar a placa',
  'label.files': 'Ficheiros',
  'btn.newFile': '+ Novo ficheiro',
  'view.board': 'Placa',
  'view.text': 'Texto',
  'label.output': 'Resultado',
  'btn.build': 'Compilar',
  'btn.flash': 'Gravar',
  'btn.download': 'Transferir',
  'chk.lint': 'Lint',
  'chk.persist': 'Permanente',
  'chk.persist.title': 'Gravar na memória flash da placa para que o design se mantenha ao desligar',
  'btn.close': 'Fechar',

  'file.delete.title': 'Eliminar {name}',
  'file.delete.confirm': 'Eliminar {name}?',
  'prompt.projectName': 'Nome do projeto',
  'prompt.fileName': 'Nome do ficheiro (ex.: contador.v)',
  'alert.invalidName': 'Nome de ficheiro inválido',
  'alert.importFailed': 'Falha ao importar: {msg}',
  'err.unknownBoard': 'placa desconhecida {board}',
  'confirm.newForBoard': 'Criar um novo projeto para esta placa? (Cancelar mantém os ficheiros atuais e muda apenas a placa.)',
  'board.downloadOnly': ' (só transferência)',
  'banner.noWebUsb': 'Este navegador não consegue gravar placas (sem WebUSB). Use o Chrome ou o Edge, ou transfira o bitstream.',

  'status.ready': 'Pronto',
  'status.submitting': 'A enviar…',
  'status.queued': 'Em fila (posição {n})',
  'status.running': 'A executar: {step}',
  'status.buildOk': 'Compilação concluída',
  'status.buildFailed': 'A compilação falhou: {msg}',
  'status.flashing': 'A gravar…',
  'status.written': 'Gravado na flash',
  'status.loaded': 'Carregado na FPGA',
  'status.flashFailed': 'A gravação falhou: {msg}',
  'status.createFailed': 'Não foi possível criar o projeto: {msg}',
  'status.loadFailed': 'Falha ao carregar: {msg}',

  'flash.downloadOnly': '{board} só permite transferência; grave-a com a sua própria ferramenta',
  'flash.noWebUsb': 'Este navegador não tem WebUSB. Use o Chrome ou o Edge, ou transfira o bitstream.',
  'flash.noDevice': 'Nenhum dispositivo USB selecionado.',
  'flash.exitCode': 'O openFPGALoader terminou com o código {code}',

  'pp.title': 'Planeador de pinos Basys 3',
  'pp.auto': 'Atribuir por nome',
  'pp.clear': 'Limpar tudo',
  'pp.clearConfirm': 'Remover todas as atribuições de pinos?',
  'pp.boardAria': 'Placa Basys 3',
  'pp.hint': 'Artix-7 · clique num componente para lhe atribuir uma porta',
  'pp.notUsed': '— não usado —',
  'pp.inputs': 'Entradas',
  'pp.outputs': 'Saídas',
  'pp.ports': 'Portas',
  'pp.otherPorts': 'Outras portas',
  'pp.onOther': '(em {sig})',
  'pp.notPort': '(não é uma porta de {top})',
  'pp.summary': 'topo: {top} · {placed}/{total} bits de porta atribuídos',
  'pp.noPorts': 'topo: {top} · nenhuma porta encontrada',
  'pp.notPlaced': 'ainda por atribuir: {list}',
  'pp.portFor': 'Porta para {sig}',
  'pp.g.clk': 'Relógio · 100 MHz',
  'pp.g.sw': 'Interruptores',
  'pp.g.led': 'LEDs',
  'pp.g.btn': 'Botões',
  'pp.g.seg': 'Mostrador de 7 segmentos',
  'pp.g.ja': 'Pmod JA',
  'pp.g.jb': 'Pmod JB',
  'pp.g.jc': 'Pmod JC',
  'pp.g.jxadc': 'Pmod JXADC',
  'pp.g.vga': 'VGA',
  'pp.g.uart': 'USB-UART',
  'pp.g.ps2': 'USB HID (PS/2)',

  'help.linux.title': 'Linux: permitir que o navegador aceda à placa',
  'help.linux.run': 'Execute uma vez e depois desligue e volte a ligar a placa. Estas regras udev dão acesso ao dispositivo ao seu utilizador:',
  'help.linux.busy': 'Se a gravação continuar a falhar com "access denied", o controlador série <code>ftdi_sio</code> pode estar a ocupar a interface; feche qualquer terminal série e volte a ligar a placa.',
  'help.win.title': 'Windows: mudar a interface JTAG para WinUSB',
  'help.win.step1': 'Transfira o <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener">Zadig</a>.',
  'help.win.step2': 'Options → List All Devices. Escolha a <b>Interface 0</b> da sua placa (ex.: "Digilent USB Device (Interface 0)").',
  'help.win.step3': 'Selecione <b>WinUSB</b> e clique em Replace Driver.',
  'help.win.note': '<b>Nota:</b> isto substitui o controlador do fabricante nessa interface, pelo que o Vivado / Digilent Adept deixam de ver a placa até reinstalar o controlador deles (Gestor de Dispositivos → Desinstalar dispositivo e voltar a ligar).',
  'help.mac.body': 'Normalmente não é preciso configurar nada. Se a placa não aparecer, desligue-a, feche as aplicações que usam a porta série e tente de novo.',
  'help.other.title': 'Configuração',
  'help.other.body': 'Use o Chrome ou o Edge em Linux, Windows ou macOS para gravar a partir do navegador.',
};

const es: Record<Key, string> = {
  'lang.aria': 'Idioma',
  'brand.tagline': 'Compilar · Grabar · Listo',
  'label.project': 'Proyecto',
  'btn.new': 'Nuevo',
  'btn.import': 'Importar',
  'btn.export': 'Exportar',
  'label.target': 'Placa',
  'label.top': 'Top',
  'btn.usbSetup': 'Configurar USB',
  'btn.usbSetup.title': 'Configuración USB para grabar la placa',
  'label.files': 'Archivos',
  'btn.newFile': '+ Nuevo archivo',
  'view.board': 'Placa',
  'view.text': 'Texto',
  'label.output': 'Salida',
  'btn.build': 'Compilar',
  'btn.flash': 'Grabar',
  'btn.download': 'Descargar',
  'chk.lint': 'Lint',
  'chk.persist': 'Permanente',
  'chk.persist.title': 'Grabar en la memoria flash de la placa para que el diseño se conserve al apagarla',
  'btn.close': 'Cerrar',

  'file.delete.title': 'Eliminar {name}',
  'file.delete.confirm': '¿Eliminar {name}?',
  'prompt.projectName': 'Nombre del proyecto',
  'prompt.fileName': 'Nombre del archivo (p. ej. contador.v)',
  'alert.invalidName': 'Nombre de archivo no válido',
  'alert.importFailed': 'Error al importar: {msg}',
  'err.unknownBoard': 'placa desconocida {board}',
  'confirm.newForBoard': '¿Crear un proyecto nuevo para esta placa? (Cancelar conserva los archivos actuales y solo cambia la placa.)',
  'board.downloadOnly': ' (solo descarga)',
  'banner.noWebUsb': 'Este navegador no puede grabar placas (no tiene WebUSB). Usa Chrome o Edge, o descarga el bitstream.',

  'status.ready': 'Listo',
  'status.submitting': 'Enviando…',
  'status.queued': 'En cola (posición {n})',
  'status.running': 'Ejecutando: {step}',
  'status.buildOk': 'Compilación correcta',
  'status.buildFailed': 'La compilación falló: {msg}',
  'status.flashing': 'Grabando…',
  'status.written': 'Grabado en la flash',
  'status.loaded': 'Cargado en la FPGA',
  'status.flashFailed': 'La grabación falló: {msg}',
  'status.createFailed': 'No se pudo crear el proyecto: {msg}',
  'status.loadFailed': 'Error al cargar: {msg}',

  'flash.downloadOnly': '{board} solo permite descarga; grábala con tu propia herramienta',
  'flash.noWebUsb': 'Este navegador no tiene WebUSB. Usa Chrome o Edge, o descarga el bitstream.',
  'flash.noDevice': 'No se seleccionó ningún dispositivo USB.',
  'flash.exitCode': 'openFPGALoader terminó con el código {code}',

  'pp.title': 'Planificador de pines Basys 3',
  'pp.auto': 'Asignar por nombre',
  'pp.clear': 'Borrar todo',
  'pp.clearConfirm': '¿Quitar todas las asignaciones de pines?',
  'pp.boardAria': 'Placa Basys 3',
  'pp.hint': 'Artix-7 · haz clic en un componente para asignarle un puerto',
  'pp.notUsed': '— sin usar —',
  'pp.inputs': 'Entradas',
  'pp.outputs': 'Salidas',
  'pp.ports': 'Puertos',
  'pp.otherPorts': 'Otros puertos',
  'pp.onOther': '(en {sig})',
  'pp.notPort': '(no es un puerto de {top})',
  'pp.summary': 'top: {top} · {placed}/{total} bits de puerto asignados',
  'pp.noPorts': 'top: {top} · no se encontraron puertos',
  'pp.notPlaced': 'sin asignar todavía: {list}',
  'pp.portFor': 'Puerto para {sig}',
  'pp.g.clk': 'Reloj · 100 MHz',
  'pp.g.sw': 'Interruptores',
  'pp.g.led': 'LEDs',
  'pp.g.btn': 'Botones',
  'pp.g.seg': 'Display de 7 segmentos',
  'pp.g.ja': 'Pmod JA',
  'pp.g.jb': 'Pmod JB',
  'pp.g.jc': 'Pmod JC',
  'pp.g.jxadc': 'Pmod JXADC',
  'pp.g.vga': 'VGA',
  'pp.g.uart': 'USB-UART',
  'pp.g.ps2': 'USB HID (PS/2)',

  'help.linux.title': 'Linux: permitir que el navegador acceda a la placa',
  'help.linux.run': 'Ejecútalo una vez y luego desconecta y vuelve a conectar la placa. Estas reglas udev dan acceso al dispositivo a tu usuario:',
  'help.linux.busy': 'Si la grabación sigue fallando con "access denied", el driver serie <code>ftdi_sio</code> puede estar ocupando la interfaz; cierra cualquier terminal serie y vuelve a conectar la placa.',
  'help.win.title': 'Windows: cambiar la interfaz JTAG a WinUSB',
  'help.win.step1': 'Descarga <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener">Zadig</a>.',
  'help.win.step2': 'Options → List All Devices. Elige la <b>Interface 0</b> de tu placa (p. ej. "Digilent USB Device (Interface 0)").',
  'help.win.step3': 'Selecciona <b>WinUSB</b> y haz clic en Replace Driver.',
  'help.win.note': '<b>Nota:</b> esto sustituye el driver del fabricante en esa interfaz, así que Vivado / Digilent Adept no verán la placa hasta que reinstales su driver (Administrador de dispositivos → Desinstalar el dispositivo y volver a conectarlo).',
  'help.mac.body': 'Normalmente no hace falta configurar nada. Si la placa no aparece, desconéctala, cierra las aplicaciones que usen su puerto serie y vuelve a intentarlo.',
  'help.other.title': 'Configuración',
  'help.other.body': 'Usa Chrome o Edge en Linux, Windows o macOS para grabar desde el navegador.',
};

const DICTS: Record<Lang, Record<Key, string>> = { en, 'pt-PT': ptPT, es };
const STORAGE_KEY = 'fpgaweb.lang';
const listeners: (() => void)[] = [];

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in DICTS) return saved as Lang;
  } catch {
    /* storage unavailable (private mode) */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  for (const l of nav) {
    const low = (l ?? '').toLowerCase();
    if (low.startsWith('pt')) return 'pt-PT';
    if (low.startsWith('es')) return 'es';
    if (low.startsWith('en')) return 'en';
  }
  return 'en';
}

let current: Lang = typeof window === 'undefined' ? 'en' : detect();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void): void {
  listeners.push(fn);
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const s = DICTS[current][key] ?? en[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translate static markup: data-i18n (text), data-i18n-title, data-i18n-aria. */
export function applyStatic(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n as Key)));
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle as Key)));
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria as Key)));
}

export const DICTIONARIES = DICTS;
